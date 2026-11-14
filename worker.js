/**
 * 北区 図書館在架チェッカー バックエンド (Cloudflare Workers / 無料プランで動作)
 *
 * 役割
 *  1. PWA からの在架状況リクエストを受け、カーリル図書館API(蔵書検索)へ問い合わせる
 *     → APIキーはこの Worker の「シークレット」に置き、ブラウザには一切出さない
 *     → CORS もここで解決(GitHub Pages のオリジンだけ許可)
 *  2. 書名→ISBN の解決(国立国会図書館サーチ OpenSearch) ※結果は KV にキャッシュ
 *  3. お気に入りの本を定期チェック(Cron)し、「貸出中 → 在架」への変化だけを検知
 *  4. Web Push(ペイロードなし/VAPID)で端末を起こし、端末側(Service Worker)が通知本文を取りに来る
 *
 * 必要な設定(README参照)
 *   シークレット : CALIL_APPKEY のみ(Cloudflareの画面で登録)。VAPID鍵は初回に自動生成されKVにだけ保存される
 *   変数         : VAPID_SUBJECT, ALLOWED_ORIGIN, BOOKS_URL, LIBRARIES_URL
 *   KV           : KV
 *
 * 重要な方針
 *   - 通信エラー・判定不能は必ず "unknown"(不明)。"lent"(貸出中)にはしない。
 *   - 通知は「前回の既知状態=lent」かつ「今回=available」のときだけ。在架のままなら再通知しない。
 */

export const STATUS = { AVAILABLE: 'available', LENT: 'lent', UNKNOWN: 'unknown' };

const CALIL_CHECK = 'https://api.calil.jp/check';
const NDL_OPENSEARCH = 'https://ndlsearch.ndl.go.jp/api/opensearch';

const AVAIL_CACHE_SEC = 10 * 60;      // 画面からの問い合わせは10分キャッシュ(結果に実際の確認時刻を付けて返す)
const MIN_REFETCH_SEC = 120;          // どれだけ「最新」を連打されても同じ本は2分に1回しかカーリルへ聞かない
const ISBN_CACHE_SEC = 30 * 24 * 3600;
const ISBN_NEG_CACHE_SEC = 24 * 3600;
const MAX_ITEMS_PER_REQUEST = 30;
const MAX_ISBN_PER_BOOK = 4;
const CALIL_BATCH = 40;               // 1セッションで問い合わせるISBN数(上限は100)
const CALIL_POLL_MS = 2200;           // 仕様: ポーリングは2秒以上あける
const CALIL_MAX_POLLS = 12;
const SUBREQUEST_BUDGET = 40;         // 無料プランの上限(50)に余裕を持たせる
const MAX_PENDING = 20;

/* ------------------------------------------------------------------ */
/* ユーティリティ                                                      */
/* ------------------------------------------------------------------ */
const enc = encodeURIComponent;
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export function nowIso() { return new Date().toISOString(); }

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function corsHeaders(env, req) {
  const allow = env.ALLOWED_ORIGIN || '';
  const origin = req.headers.get('Origin') || '';
  let value = '';
  if (allow === '*') value = '*';
  else if (allow) {
    const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.includes(origin)) value = origin;
  }
  const h = { 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
  if (value) h['Access-Control-Allow-Origin'] = value;
  return h;
}

export function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const p = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(p);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* 状態マッピング(カーリルの8分類 → 在架/貸出中/不明)                    */
/* ------------------------------------------------------------------ */
export function mapCalilStatus(v) {
  switch (v) {
    case '貸出可': return { status: STATUS.AVAILABLE, detail: '' };
    case '貸出中': return { status: STATUS.LENT, detail: '' };
    case '予約中': return { status: STATUS.LENT, detail: '予約の取り置き中(すぐには借りられません)' };
    case '館内のみ': return { status: STATUS.UNKNOWN, detail: '館内閲覧のみ(貸出不可の資料)' };
    case '蔵書あり': return { status: STATUS.UNKNOWN, detail: '蔵書はありますが貸出状況は確認できません' };
    case '準備中': return { status: STATUS.UNKNOWN, detail: '整理中・準備中' };
    case '休館中': return { status: STATUS.UNKNOWN, detail: '休館中' };
    default: return { status: STATUS.UNKNOWN, detail: `図書館システムの値「${String(v).slice(0, 20)}」は判定できません` };
  }
}

const RANK = { [STATUS.AVAILABLE]: 3, [STATUS.LENT]: 2, [STATUS.UNKNOWN]: 1 };

/**
 * 1冊(複数ISBN)×1館 の最終判定。純粋関数(テスト対象)。
 * perIsbn: [{ isbn, status:'OK'|'Cache'|'Running'|'Error'|undefined, libkey:{館キー:状態} }]
 * lib: libraries.json の1館   learned: 過去に観測した館キーの集合(Set)
 */
export function resolveForLibrary(perIsbn, lib, learned = new Set()) {
  const aliases = lib.calil?.libkeys || [];
  if (!perIsbn.length) return { status: STATUS.UNKNOWN, detail: 'ISBNを特定できていないため確認できません', owned: null, code: 'no_isbn' };

  let best = null;          // 在架 > 貸出中 > 不明(蔵書あり系)
  let anyOk = false;
  let anyIncomplete = false;
  let anyKeyMatched = false;
  let anyOtherKeys = false;

  for (const r of perIsbn) {
    if (!r || (r.status !== 'OK' && r.status !== 'Cache')) { anyIncomplete = true; continue; }
    anyOk = true;
    const keys = r.libkey || {};
    const names = Object.keys(keys);
    if (names.length) anyOtherKeys = true;
    for (const a of aliases) {
      if (Object.prototype.hasOwnProperty.call(keys, a)) {
        anyKeyMatched = true;
        const m = mapCalilStatus(keys[a]);
        if (!best || RANK[m.status] > RANK[best.status]) best = m;
      }
    }
  }

  if (best) {
    // 在架が見つかれば確定。それ以外は取得が欠けていたら断言しない
    if (best.status === STATUS.AVAILABLE) return { ...best, owned: true };
    if (anyIncomplete && best.status === STATUS.LENT) {
      // 別ISBNの結果が未取得 → その版に在架があるかもしれないので「貸出中」と断言しない
      return { status: STATUS.UNKNOWN, detail: '一部の版の確認が完了していません', owned: true, code: 'partial' };
    }
    return { ...best, owned: true };
  }
  if (!anyOk) return { status: STATUS.UNKNOWN, detail: '図書館の情報を取得できませんでした', owned: null, code: 'upstream' };
  if (anyIncomplete) return { status: STATUS.UNKNOWN, detail: '一部の版の確認が完了していません', owned: null, code: 'partial' };

  // 全ISBN取得成功だが、この館の館キーが無い
  const aliasEverSeen = aliases.some((a) => learned.has(a));
  if (!aliasEverSeen) {
    return { status: STATUS.UNKNOWN, detail: '館名の照合が未確認です(設定の確認が必要)', owned: null, code: 'unmatched' };
  }
  void anyKeyMatched; void anyOtherKeys;
  return { status: STATUS.UNKNOWN, detail: 'この図書館には蔵書がありません(または未登録)', owned: false, code: 'not_owned' };
}

/** 「貸出中 → 在架」だけを検知する。unknown では lastKnown を更新しない(通信失敗を状態変化と誤認しない) */
export function detectTransition(prevState, currentStatus) {
  const last = prevState?.lastKnown || null;
  const next = { lastKnown: last, lastStatus: currentStatus };
  let notify = false;
  if (currentStatus === STATUS.AVAILABLE || currentStatus === STATUS.LENT) {
    if (last === STATUS.LENT && currentStatus === STATUS.AVAILABLE) notify = true;
    next.lastKnown = currentStatus;
  }
  return { notify, next };
}

/* ------------------------------------------------------------------ */
/* ISBN 解決(NDLサーチ OpenSearch)                                     */
/* ------------------------------------------------------------------ */
export function normText(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・･\-－—ー!！?？、。,，.．:：;；'"“”「」『』()（）\[\]〔〕<>＜＞～~／/]/g, '');
}

function xmlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function toIsbn13(raw) {
  const d = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (d.length === 13 && /^97[89]\d{10}$/.test(d)) return d;
  if (d.length === 10 && /^\d{9}[\dX]$/.test(d)) {
    const core = '978' + d.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    return core + String((10 - (sum % 10)) % 10);
  }
  return null;
}

/** NDL OpenSearch(RSS 2.0) を寛容にパース */
export function parseNdlOpenSearch(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      const out = [];
      const r = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
      let x;
      while ((x = r.exec(block))) out.push(xmlUnescape(x[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()));
      return out;
    };
    const ids = [];
    const idRe = /<dc:identifier([^>]*)>([\s\S]*?)<\/dc:identifier>/g;
    let im;
    while ((im = idRe.exec(block))) {
      const attrs = im[1] || '';
      const val = xmlUnescape(im[2].trim());
      if (/ISBN/i.test(attrs) || /^(97[89])?[\d-]{9,17}[\dXx]?$/.test(val)) {
        const i13 = toIsbn13(val);
        if (i13) ids.push(i13);
      }
    }
    items.push({
      title: (pick('title')[0] || '').trim(),
      creator: pick('dc:creator').join(' ') || pick('author').join(' '),
      publisher: pick('dc:publisher').join(' '),
      isbns: [...new Set(ids)],
    });
  }
  return items;
}

export function pickIsbns(book, items) {
  const q = normText(book.searchTitle || book.title);
  if (q.length < 2) return [];
  const authorNames = (book.authors || []).map((a) => normText(a.name)).filter((n) => n.length >= 2);
  const pubQ = normText(book.publisher).replace(/株式会社|出版部/g, '');
  const scored = [];
  for (const it of items) {
    if (!it.isbns.length) continue;
    // 書名の一致: 「全体」または「副題(: / ( など)より前」が検索書名と一致。巻数(1,2,上,下…)の付加だけ許す。
    // 例) 「ぐりとぐら」に対して「ぐりとぐらのおきゃくさま」は別の本なので除外する
    const variants = [normText(it.title), normText(String(it.title).split(/[:：\/／(（\[［〔【]/)[0])];
    const titleOk = variants.some((v) => v === q || (v.startsWith(q) && /^[0-9一二三四五六七八九十上中下巻第]+$/.test(v.slice(q.length))));
    if (!titleOk) continue;
    const c = normText(it.creator);
    const creatorHit = authorNames.some((n) => c.includes(n));
    const pubHit = !!pubQ && normText(it.publisher).includes(pubQ);
    const score = 1 + (creatorHit ? 2 : 0) + (pubHit ? 2 : 0);
    if (score < 3) continue;   // 書名だけ一致では採用しない(別の同名本を避ける)
    scored.push({ score, pubHit, isbns: it.isbns });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  for (const s of scored) for (const i of s.isbns) if (!out.includes(i)) out.push(i);
  return out.slice(0, MAX_ISBN_PER_BOOK);
}

async function ndlFetch(ctx, params) {
  const u = new URL(NDL_OPENSEARCH);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  u.searchParams.set('cnt', '20');
  u.searchParams.set('mediatype', '1');
  ctx.budget.use();
  const res = await ctx.fetch(u.toString(), { headers: { 'User-Agent': 'kita-library-checker/1.0 (personal PWA)' } });
  if (!res.ok) throw new Error(`NDL ${res.status}`);
  return parseNdlOpenSearch(await res.text());
}

/** 返り値: ISBN配列(空配列=確かに見つからなかった) / null=今回は解決できなかった(通信失敗・予算切れ。キャッシュしない) */
export async function resolveIsbns(ctx, book) {
  const key = `isbn:${book.id}`;
  const cached = await ctx.env.KV.get(key, 'json');
  if (cached && (cached.isbns.length || Date.now() - cached.at < ISBN_NEG_CACHE_SEC * 1000)) return cached.isbns;
  // カーリルへの問い合わせ用に予算を残す
  if (ctx.budget.left < 14) return null;
  let isbns = [];
  try {
    const first = book.authors?.find((a) => !a.role)?.name || book.authors?.[0]?.name || '';
    let items = await ndlFetch(ctx, { title: book.searchTitle || book.title, creator: first });
    isbns = pickIsbns(book, items);
    if (!isbns.length && ctx.budget.left >= 14) {
      items = await ndlFetch(ctx, { title: book.searchTitle || book.title, publisher: book.publisher });
      isbns = pickIsbns(book, items);
    }
  } catch (e) { return null; }
  await ctx.env.KV.put(key, JSON.stringify({ isbns, at: Date.now() }), { expirationTtl: isbns.length ? ISBN_CACHE_SEC : ISBN_NEG_CACHE_SEC });
  return isbns;
}

/* ------------------------------------------------------------------ */
/* カーリル図書館API                                                    */
/* ------------------------------------------------------------------ */
class Budget {
  constructor(n) { this.left = n; }
  use() { if (this.left <= 0) throw new Error('subrequest budget exhausted'); this.left--; }
}

async function calilGet(ctx, url) {
  ctx.budget.use();
  const res = await ctx.fetch(url);
  if (!res.ok) throw new Error(`Calil HTTP ${res.status}`);
  return res.json();
}

/** isbn 配列 × systemId → { isbn: {status, libkey} } と、完了したか */
export async function calilCheck(ctx, isbns, systemId) {
  const key = ctx.env.CALIL_APPKEY;
  if (!key) throw new Error('CALIL_APPKEY が未設定です');
  const out = {};
  let complete = true;
  for (let i = 0; i < isbns.length; i += CALIL_BATCH) {
    const batch = isbns.slice(i, i + CALIL_BATCH);
    let data = await calilGet(ctx, `${CALIL_CHECK}?appkey=${enc(key)}&isbn=${batch.join(',')}&systemid=${enc(systemId)}&format=json&callback=no`);
    let polls = 0;
    while (data.continue === 1 && polls < CALIL_MAX_POLLS) {
      await ctx.sleep(CALIL_POLL_MS);
      data = await calilGet(ctx, `${CALIL_CHECK}?appkey=${enc(key)}&session=${enc(data.session)}&format=json&callback=no`);
      polls++;
    }
    if (data.continue === 1) complete = false;
    for (const isbn of batch) {
      const b = data.books?.[isbn] || data.books?.[isbn.replace(/-/g, '')];
      out[isbn] = b?.[systemId] ? { status: b[systemId].status, libkey: b[systemId].libkey || {} } : { status: 'Error', libkey: {} };
    }
  }
  return { results: out, complete };
}

async function learnedKeys(env) {
  const v = await env.KV.get('learned-libkeys', 'json');
  return new Set(v || []);
}
async function learnKeys(env, learned, results) {
  let changed = false;
  for (const r of Object.values(results)) {
    if (r.status !== 'OK' && r.status !== 'Cache') continue;
    for (const k of Object.keys(r.libkey || {})) if (!learned.has(k)) { learned.add(k); changed = true; }
  }
  if (changed) await env.KV.put('learned-libkeys', JSON.stringify([...learned].slice(0, 500)));
}

/**
 * items: [{id, isbns:[...]}]  libs: enabled libraries  →  { id: { libId: record } }
 * 失敗時も必ず unknown(+error)を返す。
 */
export async function checkItems(ctx, items, libs) {
  const checkedAt = nowIso();
  const out = {};
  const systems = [...new Set(libs.map((l) => l.calil.systemId))];
  const allIsbns = [...new Set(items.flatMap((i) => i.isbns || []))];
  const perSystem = {};
  let learned = await learnedKeys(ctx.env);
  const systemError = {};
  // APIキー未設定: カーリルへは問い合わせず、全て「不明(キー未設定)」にする(貸出中とは絶対にしない)
  if (!ctx.env.CALIL_APPKEY) {
    for (const it of items) {
      out[it.id] = {};
      for (const lib of libs) out[it.id][lib.id] = { status: STATUS.UNKNOWN, detail: 'バックエンドにカーリルのAPIキーが未設定のため確認できません', error: 'no_key', checkedAt, owned: null };
    }
    return out;
  }
  for (const sys of systems) {
    if (!allIsbns.length) { perSystem[sys] = { results: {}, complete: true }; continue; }
    try {
      perSystem[sys] = await calilCheck(ctx, allIsbns, sys);
      await learnKeys(ctx.env, learned, perSystem[sys].results);
    } catch (e) {
      perSystem[sys] = { results: {}, complete: false };
      systemError[sys] = String(e.message || e).replace(/appkey=[^&\s]+/g, 'appkey=***');
    }
  }
  for (const it of items) {
    out[it.id] = {};
    for (const lib of libs) {
      const sys = lib.calil.systemId;
      if (it.isbns === null) {
        out[it.id][lib.id] = { status: STATUS.UNKNOWN, detail: 'ISBNの照会が保留中です。少し待ってからもう一度確認してください', error: 'deferred', checkedAt, owned: null };
        continue;
      }
      if (systemError[sys]) {
        out[it.id][lib.id] = { status: STATUS.UNKNOWN, detail: '図書館の情報を取得できませんでした', error: 'upstream', checkedAt, owned: null };
        continue;
      }
      const sysRes = perSystem[sys];
      const perIsbn = it.isbns.map((isbn) => ({ isbn, ...(sysRes.results[isbn] || { status: 'Error', libkey: {} }) }));
      const r = resolveForLibrary(perIsbn, lib, learned);
      out[it.id][lib.id] = { status: r.status, detail: r.detail, owned: r.owned, checkedAt, error: ['no_isbn', 'upstream', 'partial', 'unmatched'].includes(r.code) ? r.code : null };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* データ読み込み(books.json / libraries.json は GitHub Pages から取得)     */
/* ------------------------------------------------------------------ */
async function loadJson(ctx, urlVar, cacheKey) {
  const cached = await ctx.env.KV.get(cacheKey, 'json');
  if (cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.data;
  const url = ctx.env[urlVar];
  if (!url) throw new Error(`${urlVar} が未設定です`);
  ctx.budget.use();
  const res = await ctx.fetch(url);
  if (!res.ok) throw new Error(`${urlVar} 取得失敗 ${res.status}`);
  const data = await res.json();
  await ctx.env.KV.put(cacheKey, JSON.stringify({ at: Date.now(), data }), { expirationTtl: 7 * 24 * 3600 });
  return data;
}
export async function loadBooks(ctx) {
  const d = await loadJson(ctx, 'BOOKS_URL', 'cache:books');
  return new Map(d.books.map((b) => [b.id, b]));
}
export async function loadLibraries(ctx) {
  const d = await loadJson(ctx, 'LIBRARIES_URL', 'cache:libraries');
  return d.libraries.filter((l) => l.enabled);
}

/* ------------------------------------------------------------------ */
/* 簡易レート制限(KV, ベストエフォート)                                   */
/* ------------------------------------------------------------------ */
async function rateLimit(env, req, cost) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const hour = Math.floor(Date.now() / 3600000);
  const key = `rl:${await sha256Hex(ip)}:${hour}`;
  const cur = Number(await env.KV.get(key)) || 0;
  if (cur + cost > 600) return false;
  await env.KV.put(key, String(cur + cost), { expirationTtl: 7200 });
  return true;
}

/* ------------------------------------------------------------------ */
/* /api/availability                                                    */
/* ------------------------------------------------------------------ */
async function handleAvailability(ctx, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const reqItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS_PER_REQUEST) : [];
  if (!reqItems.length) return json({ error: 'no_items' }, 400);
  if (!(await rateLimit(ctx.env, req, reqItems.length))) return json({ error: 'rate_limited', message: 'アクセスが多すぎます。しばらくしてからお試しください' }, 429);

  const libs = await loadLibraries(ctx);
  const wanted = Array.isArray(body.libs) && body.libs.length ? libs.filter((l) => body.libs.includes(l.id)) : libs;
  const books = await loadBooks(ctx);
  const fresh = !!body.fresh;

  const results = {};
  const toCheck = [];
  for (const it of reqItems) {
    const id = String(it.id || '');
    // キャッシュ判定(強制更新でも MIN_REFETCH_SEC 以内なら上流へ聞かない)
    const cached = await ctx.env.KV.get(`av:${id}`, 'json');
    if (cached) {
      const age = (Date.now() - cached.at) / 1000;
      const limit = fresh ? MIN_REFETCH_SEC : AVAIL_CACHE_SEC;
      if (age < limit && wanted.every((l) => cached.libs?.[l.id])) { results[id] = cached.libs; continue; }
    }
    let isbns = [];
    if (books.has(id)) isbns = await resolveIsbns(ctx, books.get(id));
    else if (Array.isArray(it.isbns)) isbns = it.isbns.map(toIsbn13).filter(Boolean).slice(0, MAX_ISBN_PER_BOOK);
    toCheck.push({ id, isbns });
  }
  if (toCheck.length) {
    const checked = await checkItems(ctx, toCheck, wanted);
    for (const it of toCheck) {
      results[it.id] = checked[it.id];
      const anyReal = Object.values(checked[it.id]).some((r) => r.error !== 'upstream' && r.error !== 'deferred' && r.error !== 'no_key');
      if (anyReal) await ctx.env.KV.put(`av:${it.id}`, JSON.stringify({ at: Date.now(), libs: checked[it.id] }), { expirationTtl: AVAIL_CACHE_SEC * 2 });
    }
  }
  // 返却に ISBN(カーリルへのリンク用)も付ける
  const isbnMap = {};
  for (const it of reqItems) {
    const id = String(it.id || '');
    const c = await ctx.env.KV.get(`isbn:${id}`, 'json');
    isbnMap[id] = c?.isbns || (Array.isArray(it.isbns) ? it.isbns.map(toIsbn13).filter(Boolean) : []);
  }
  return json({ source: 'calil', results, isbns: isbnMap, serverTime: nowIso() });
}

/* ------------------------------------------------------------------ */
/* /api/search (NDLサーチで自由検索 → ISBN付きの候補を返す)               */
/* ------------------------------------------------------------------ */
async function handleSearch(ctx, req) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  if (q.length < 2) return json({ error: 'query_too_short' }, 400);
  if (!(await rateLimit(ctx.env, req, 3))) return json({ error: 'rate_limited' }, 429);
  try {
    const items = await ndlFetch(ctx, { any: q });
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (!it.isbns.length) continue;
      const k = normText(it.title) + '|' + normText(it.creator);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id: `isbn-${it.isbns[0]}`, title: it.title, author: it.creator, publisher: it.publisher, isbns: it.isbns.slice(0, MAX_ISBN_PER_BOOK) });
      if (out.length >= 20) break;
    }
    return json({ source: 'ndl', items: out });
  } catch (e) {
    return json({ error: 'upstream', message: '書籍情報の検索に失敗しました' }, 502);
  }
}

/* ------------------------------------------------------------------ */
/* Web Push (VAPID, ペイロードなし)                                      */
/* ------------------------------------------------------------------ */
export async function vapidJwt(env, audience, now = Math.floor(Date.now() / 1000)) {
  const pub = b64urlDecode(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY が不正です');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const te = new TextEncoder();
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64urlEncode(te.encode(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://example.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * VAPID鍵の取得。環境変数(任意)があればそれを使い、無ければ Cloudflare KV から取得。
 * KV にも無ければ初回だけ Worker 内で生成して KV にのみ保存する。
 * → 秘密鍵は Cloudflare の外(GitHub・端末・チャット)に一度も出ない。人が扱う必要もない。
 */
export async function getVapid(ctx, { create = true } = {}) {
  const e = ctx.env;
  if (e.VAPID_PRIVATE_KEY && e.VAPID_PUBLIC_KEY) return { pub: e.VAPID_PUBLIC_KEY, priv: e.VAPID_PRIVATE_KEY };
  const saved = await e.KV.get('vapid-keys', 'json');
  if (saved?.pub && saved?.priv) return saved;
  if (!create) return null;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const v = { pub: b64urlEncode(raw), priv: jwk.d };
  await e.KV.put('vapid-keys', JSON.stringify(v));
  return v;
}

async function sendPush(ctx, sub) {
  const v = await getVapid(ctx);
  const aud = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt({ VAPID_PUBLIC_KEY: v.pub, VAPID_PRIVATE_KEY: v.priv, VAPID_SUBJECT: ctx.env.VAPID_SUBJECT || String(ctx.env.ALLOWED_ORIGIN || '').split(',')[0].trim() }, aud);
  ctx.budget.use();
  const res = await ctx.fetch(sub.endpoint, {
    method: 'POST',
    headers: { TTL: '86400', Urgency: 'normal', Authorization: `vapid t=${jwt}, k=${v.pub}`, 'Content-Length': '0' },
  });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}

/* ------------------------------------------------------------------ */
/* 購読(お気に入り同期)                                                  */
/* ------------------------------------------------------------------ */
async function handleSync(ctx, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const endpoint = body?.subscription?.endpoint;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000) return json({ error: 'bad_subscription' }, 400);
  const hash = await sha256Hex(endpoint);
  const key = `sub:${hash}`;
  const prev = (await ctx.env.KV.get(key, 'json')) || { pending: [], notified: {}, createdAt: nowIso() };
  const favs = (Array.isArray(body.favorites) ? body.favorites : []).slice(0, 100).map((f) => ({
    id: String(f.id).slice(0, 40),
    isbns: Array.isArray(f.isbns) ? f.isbns.map(toIsbn13).filter(Boolean).slice(0, MAX_ISBN_PER_BOOK) : [],
    title: String(f.title || '').slice(0, 80),
  }));
  const libs = (Array.isArray(body.libs) ? body.libs : []).map(String).slice(0, 20);
  const sub = { ...prev, endpoint, favorites: favs, libs, updatedAt: nowIso() };
  await ctx.env.KV.put(key, JSON.stringify(sub));
  return json({ ok: true, sub: hash, favorites: favs.length });
}

async function handleUnsubscribe(ctx, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const hash = String(body.sub || '');
  if (!/^[0-9a-f]{64}$/.test(hash)) return json({ error: 'bad_request' }, 400);
  await ctx.env.KV.delete(`sub:${hash}`);
  return json({ ok: true });
}

async function handlePull(ctx, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const hash = String(body.sub || '');
  if (!/^[0-9a-f]{64}$/.test(hash)) return json({ error: 'bad_request' }, 400);
  const sub = await ctx.env.KV.get(`sub:${hash}`, 'json');
  if (!sub) return json({ messages: [] });
  const messages = sub.pending || [];
  if (messages.length) await ctx.env.KV.put(`sub:${hash}`, JSON.stringify({ ...sub, pending: [] }));
  return json({ messages });
}

async function handleHealth(ctx) {
  const learned = [...(await learnedKeys(ctx.env))];
  let libs = [];
  try { libs = await loadLibraries(ctx); } catch (e) { /* ignore */ }
  const matched = libs.map((l) => ({ id: l.id, name: l.name, matchedAlias: (l.calil.libkeys || []).find((a) => learned.includes(a)) || null }));
  return json({
    ok: true,
    time: nowIso(),
    config: {
      calilKey: !!ctx.env.CALIL_APPKEY,
      vapid: !!(await getVapid(ctx, { create: false })),
      booksUrl: !!ctx.env.BOOKS_URL,
      librariesUrl: !!ctx.env.LIBRARIES_URL,
      allowedOrigin: ctx.env.ALLOWED_ORIGIN || null,
    },
    // 初回は空。検索が1度でも成功すると、カーリルが返した館キーが貯まる
    learnedLibkeys: learned,
    libraryMatch: matched,
  });
}

/* ------------------------------------------------------------------ */
/* 定期チェック(Cron)                                                    */
/* ------------------------------------------------------------------ */
export async function runScheduled(ctx) {
  const summary = { subs: 0, books: 0, transitions: 0, pushed: 0, errors: [] };
  const libs = await loadLibraries(ctx);
  const books = await loadBooks(ctx);

  // 購読の読み込み
  const subs = [];
  let cursor;
  do {
    const page = await ctx.env.KV.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const s = await ctx.env.KV.get(k.name, 'json');
      if (s) subs.push({ name: k.name, ...s });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  summary.subs = subs.length;
  if (!subs.length) return summary;

  // 対象の本 = 全購読のお気に入りの和集合(重複排除 → 図書館への負荷を最小化)
  const wantedBooks = new Map();
  for (const s of subs) for (const f of s.favorites || []) if (!wantedBooks.has(f.id)) wantedBooks.set(f.id, f);
  const items = [];
  for (const f of wantedBooks.values()) {
    let isbns = [];
    try {
      if (books.has(f.id)) isbns = await resolveIsbns(ctx, books.get(f.id));
      else isbns = f.isbns || [];
    } catch (e) { summary.errors.push(`isbn:${f.id}`); }
    items.push({ id: f.id, isbns, title: f.title || books.get(f.id)?.title || f.id });
  }
  summary.books = items.length;

  let checked;
  try { checked = await checkItems(ctx, items, libs); } catch (e) { summary.errors.push(String(e.message || e)); return summary; }

  // 状態比較 → 「貸出中→在架」だけ通知
  const events = []; // {bookId,title,libId,libName}
  for (const it of items) {
    for (const lib of libs) {
      const rec = checked[it.id]?.[lib.id];
      if (!rec) continue;
      const stKey = `state:${it.id}:${lib.id}`;
      const prev = await ctx.env.KV.get(stKey, 'json');
      const { notify, next } = detectTransition(prev, rec.status);
      await ctx.env.KV.put(stKey, JSON.stringify({ ...next, checkedAt: rec.checkedAt, changedAt: next.lastStatus !== prev?.lastStatus ? rec.checkedAt : prev?.changedAt || rec.checkedAt }));
      if (notify) events.push({ bookId: it.id, title: it.title, libId: lib.id, libName: lib.shortName || lib.name, at: rec.checkedAt });
    }
  }
  summary.transitions = events.length;

  // 購読者ごとに通知を積み、プッシュを送る
  for (const s of subs) {
    const mine = events.filter((e) => (s.favorites || []).some((f) => f.id === e.bookId) && (!s.libs?.length || s.libs.includes(e.libId)));
    if (!mine.length) continue;
    const pending = [...(s.pending || [])];
    for (const e of mine) {
      const nid = `${e.bookId}:${e.libId}:${e.at}`;
      if (pending.some((p) => p.id === nid) || s.notified?.[`${e.bookId}:${e.libId}`] === e.at) continue;
      pending.push({ id: nid, bookId: e.bookId, libId: e.libId, title: `📚 本が借りられます`, body: `「${e.title}」が${e.libName}で在架になりました。`, at: e.at });
      s.notified = { ...(s.notified || {}), [`${e.bookId}:${e.libId}`]: e.at };
    }
    const trimmed = pending.slice(-MAX_PENDING);
    let gone = false;
    try {
      const r = await sendPush(ctx, s);
      if (r.ok) summary.pushed++;
      if (r.gone) gone = true;
    } catch (err) { summary.errors.push('push'); }
    if (gone) await ctx.env.KV.delete(s.name);
    else await ctx.env.KV.put(s.name, JSON.stringify({ endpoint: s.endpoint, favorites: s.favorites, libs: s.libs, createdAt: s.createdAt, updatedAt: s.updatedAt, pending: trimmed, notified: s.notified }));
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* エントリポイント                                                      */
/* ------------------------------------------------------------------ */
function makeCtx(env, over = {}) {
  return { env, fetch: over.fetch || ((...a) => fetch(...a)), sleep: over.sleep || sleepReal, budget: new Budget(SUBREQUEST_BUDGET) };
}

export async function route(req, env, over = {}) {
  const url = new URL(req.url);
  const cors = corsHeaders(env, req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ctx = makeCtx(env, over);
  try {
    // ブラウザ以外(許可オリジン外)からの利用を弾く(CORSは読み取りだけを防ぐので、書き込み系はOriginも確認)
    let res;
    if (url.pathname === '/api/health' && req.method === 'GET') res = await handleHealth(ctx);
    else if (url.pathname === '/api/availability' && req.method === 'POST') res = await handleAvailability(ctx, req);
    else if (url.pathname === '/api/vapid-public-key' && req.method === 'GET') res = json({ key: (await getVapid(ctx)).pub });
    else if (url.pathname === '/api/search' && req.method === 'GET') res = await handleSearch(ctx, req);
    else if (url.pathname === '/api/sync' && req.method === 'POST') res = await handleSync(ctx, req);
    else if (url.pathname === '/api/unsubscribe' && req.method === 'POST') res = await handleUnsubscribe(ctx, req);
    else if (url.pathname === '/api/notifications/pull' && req.method === 'POST') res = await handlePull(ctx, req);
    else res = json({ error: 'not_found' }, 404);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  } catch (e) {
    const msg = String(e?.message || e).replace(/appkey=[^&\s]+/g, 'appkey=***');
    const res = json({ error: 'server_error', message: msg.includes('未設定') ? msg : '内部エラーが発生しました' }, 500);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
}

export default {
  fetch(req, env) { return route(req, env); },
  async scheduled(event, env, execCtx) {
    execCtx.waitUntil(runScheduled(makeCtx(env)).then((s) => console.log(JSON.stringify(s))));
  },
};
