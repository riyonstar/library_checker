/* 図書館の本を探す(北区) - PWA 本体
 * 画面・お気に入り・状態履歴・状態変化検知・アプリ内通知・Web Push登録を担当。
 * 図書館名はすべて libraries.json(→data.js)から取得し、ここには書かない。
 */
(() => {
'use strict';

/* ================= 設定・データ ================= */
const APP_VERSION = '2026-11-19 g(表紙とISBNを保存)';
const CFG = self.APP_CONFIG || {};
const BACKEND = (CFG.BACKEND_URL || '').replace(/\/+$/, '');
const HAS_BACKEND = !!BACKEND;

const STATUS = {
  available: { icon: '🟢', label: '在架', cls: 'st-available' },
  lent:      { icon: '🔴', label: '貸出中', cls: 'st-lent' },
  unknown:   { icon: '⚪', label: '不明', cls: 'st-unknown' },
};
const LEVEL_COLORS = ['#7a2e2e','#8b4a24','#8a6a1c','#5f6b25','#2f5a45','#1f5c63','#35507a','#4a4486','#6e3f7d','#8d3d63','#6a3b2b','#3f5e34','#46464f'];

let BOOKS = [], BOOK_BY_ID = new Map(), LIBS = [], LEVELS = [], PROVIDER = {};
const EXT = new Map(); // 検索で見つけた(推薦図書以外の)本。お気に入りに入れると端末に控えを保存

/* ================= 端末内ストレージ =================
 * 認証情報は保存しない。お気に入りは将来のクラウド同期に備え
 * Favorite {bookId, addedAt, book?} の形で保持する。 */
const store = {
  get(key, def) {
    try { const v = localStorage.getItem('kitalib.' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) { try { localStorage.setItem('kitalib.' + key, JSON.stringify(val)); return true; } catch { return false; } },
  del(key) { try { localStorage.removeItem('kitalib.' + key); } catch { /* noop */ } },
};

const state = {
  fav: store.get('fav', {}),            // { [bookId]: {bookId, addedAt, book?} }
  history: store.get('history', []),    // AvailabilityHistory[]
  notifs: store.get('notifs', []),      // Notification[]
  settings: store.get('settings', {}),  // { libs:[], mock:null|bool, level, pushOn }
  isbns: store.get('isbns', {}),        // { bookId: [isbn13...] } (カーリルへのリンク・表紙用)
  read: store.get('read', {}),          // { bookId: true } 「読んだ」チェック
  noCover: store.get('nocover', {}),    // { bookId: true } 表紙が見つからなかった本(次回から探さない)
  custom: store.get('custom', {}),      // { bookId: {book, level, addedAt} } 検索から推薦図書リストに追加した本
  loading: new Set(),                   // 確認中の本ID
  progress: null,                       // 一括確認の進捗表示
};
const persist = {
  fav: () => store.set('fav', state.fav),
  history: () => store.set('history', state.history.slice(-400)),
  notifs: () => store.set('notifs', state.notifs.slice(-100)),
  settings: () => store.set('settings', state.settings),
  isbns: () => store.set('isbns', state.isbns),
  read: () => store.set('read', state.read),
  custom: () => store.set('custom', state.custom),
  noCover: () => store.set('nocover', state.noCover),
};
const OTHER = 'other';                                   // 「推薦図書以外」のラベル
const levelLabel = (lv) => (lv === OTHER ? '推薦図書以外' : lv);
const customBooks = (level) => Object.values(state.custom).filter((c) => c.level === level).sort((x, y) => (x.addedAt || '').localeCompare(y.addedAt || '')).map((c) => EXT.get(c.book.id) || c.book);
const FILTER_DEFAULT = { lib: 'all', status: 'all', read: 'all' };
const filters = () => ({ ...FILTER_DEFAULT, ...(state.settings.filters || {}) });

/* ================= モード(モック/実データ) ================= */
function useMock() {
  if (!HAS_BACKEND) return true;                 // バックエンド未設定 → 必ずモック
  return state.settings.mock === true;           // 設定画面でデモ用に切替可
}
const mode = () => (useMock() ? 'mock' : 'live');
const availKey = () => 'avail.' + mode();
let availDB = {};
function loadAvail() { availDB = store.get(availKey(), {}); }
function saveAvail() { store.set(availKey(), availDB); }

/* ================= ユーティリティ ================= */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・･\-－ー!！?？、。,，.．:：;；'"“”「」『』()（）\[\]〔〕]/g, '');
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toIsbn10(i13) {
  if (!/^978\d{10}$/.test(i13 || '')) return null;
  const core = i13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const c = (11 - (sum % 11)) % 11;
  return core + (c === 10 ? 'X' : String(c));
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
const nowIso = () => new Date().toISOString();
const levelColor = (lv) => (lv === OTHER ? '#4a5a6a' : LEVEL_COLORS[Math.max(0, LEVELS.indexOf(lv)) % LEVEL_COLORS.length]);

/* ================= データ参照 ================= */
function getBook(id) {
  return BOOK_BY_ID.get(id) || EXT.get(id) || state.fav[id]?.book || null;
}
function enabledLibs() { return LIBS.filter((l) => l.enabled); }
function selectedLibs() {
  const sel = state.settings.libs;
  const en = enabledLibs();
  const picked = en.filter((l) => !sel || sel.includes(l.id));
  return picked.length ? picked : en;
}
const isFav = (id) => !!state.fav[id];
const lastKnown = (rec) => rec?.lastKnown || null;

/* ================= 在架データ(モック) =================
 * ※モックの値は実際の図書館とは無関係。画面では必ず「仮」と表示する。 */
function hash32(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mockRecord(bookId, libId) {
  const tick = store.get('mocktick', 0);
  const base = hash32(bookId + '|' + libId);
  const slot = Math.floor((tick + (base % 5)) / 2);
  const r = hash32(bookId + '|' + libId + '|' + slot) % 100;
  const checkedAt = nowIso();
  if (r < 38) return { status: 'available', detail: '', error: null, owned: true, source: 'mock', checkedAt };
  if (r < 76) return { status: 'lent', detail: '', error: null, owned: true, source: 'mock', checkedAt };
  if (r < 88) return { status: 'unknown', detail: '通信失敗のシミュレーション(モック)', error: 'mock-fail', owned: null, source: 'mock', checkedAt };
  return { status: 'unknown', detail: 'この図書館には蔵書がありません(モックの疑似データ)', error: null, owned: false, source: 'mock', checkedAt };
}

/* ================= バックエンド通信(実データ) ================= */
async function api(path, { method = 'GET', body, timeout = 70000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(BACKEND + path, {
      method, signal: ctl.signal, mode: 'cors', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* noop */ }
    if (!res.ok) { const e = new Error(data?.message || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('応答がありませんでした(タイムアウト)');
    throw e;
  } finally { clearTimeout(timer); }
}
const failRec = (reason) => ({ status: 'unknown', detail: '図書館の情報を取得できませんでした', reason, error: 'upstream', owned: null, source: 'calil', checkedAt: nowIso() });

/* ================= 状態の反映・履歴・変化検知 =================
 * 通知は「前回の既知状態が貸出中」かつ「今回が在架」のときだけ。
 * 不明(通信失敗など)は lastKnown を上書きしないので、失敗を挟んでも誤検知しない。 */
function applyRecord(bookId, libId, inc) {
  const byBook = (availDB[bookId] = availDB[bookId] || {});
  const prev = byBook[libId] || null;
  const prevKnown = lastKnown(prev);
  const rec = { ...inc, lastKnown: prevKnown };
  const known = (inc.status === 'available' || inc.status === 'lent') && !inc.error;
  if (known) {
    rec.lastKnown = { status: inc.status, at: inc.checkedAt };
    if (!prevKnown || prevKnown.status !== inc.status) {
      state.history.push({ bookId, libraryId: libId, previousStatus: prevKnown?.status || null, currentStatus: inc.status, checkedAt: inc.checkedAt, source: inc.source });
    }
    if (prevKnown?.status === 'lent' && inc.status === 'available' && isFav(bookId)) {
      const book = getBook(bookId); const lib = LIBS.find((l) => l.id === libId);
      addNotification({
        id: `${bookId}:${libId}:${inc.checkedAt}`, bookId, libId, source: inc.source,
        title: '📚 本が借りられます' + (inc.source === 'mock' ? '(モック)' : ''),
        body: `「${book?.title || bookId}」が${lib?.shortName || lib?.name || ''}で在架になりました。`,
        at: inc.checkedAt,
      });
    }
  }
  byBook[libId] = rec;
}

function addNotification(n) {
  if (state.notifs.some((x) => x.id === n.id)) return;
  state.notifs.push({ ...n, read: false });
  persist.notifs();
  updateBell();
  toast(n.body);
}
function unreadCount() { return state.notifs.filter((n) => !n.read).length; }
function updateBell() {
  const c = unreadCount(); const b = $('#bell-badge');
  if (!b) return;
  b.hidden = c === 0; b.textContent = c > 9 ? '9+' : String(c);
}

/* ================= 確認(取得)処理 ================= */
async function checkBooks(ids, { quiet = false } = {}) {
  ids = [...new Set(ids)].filter((id) => getBook(id));
  if (!ids.length) return;
  const libs = selectedLibs();
  const total = ids.length; let done = 0;
  ids.forEach((id) => state.loading.add(id));
  state.progress = { done, total };
  refreshAllCards(); renderProgress();
  const mockMode = useMock();
  if (mockMode) store.set('mocktick', store.get('mocktick', 0) + 1);

  const finish = (chunk) => { chunk.forEach((id) => state.loading.delete(id)); done += chunk.length; state.progress = done >= total ? null : { done, total }; chunk.forEach(updateCards); renderProgress(); };

  if (mockMode) {
    await new Promise((r) => setTimeout(r, 450));
    for (const id of ids) for (const lib of libs) applyRecord(id, lib.id, mockRecord(id, lib.id));
    saveAvail(); persist.history(); finish(ids);
    afterCheck(quiet);
    return;
  }
  const CH = 8;
  for (let i = 0; i < ids.length; i += CH) {
    const chunk = ids.slice(i, i + CH);
    try {
      const items = chunk.map((id) => ({ id, isbns: BOOK_BY_ID.has(id) ? undefined : (getBook(id)?.isbns || []) }));
      const res = await api('/api/availability', { method: 'POST', body: { items, libs: libs.map((l) => l.id), fresh: true } });
      for (const id of chunk) {
        if (res.isbns?.[id]?.length) state.isbns[id] = res.isbns[id];
        for (const lib of libs) {
          const r = res.results?.[id]?.[lib.id];
          applyRecord(id, lib.id, r ? { ...r, source: 'calil' } : failRec('応答にこの館の結果がありませんでした'));
        }
      }
    } catch (e) {
      for (const id of chunk) for (const lib of libs) applyRecord(id, lib.id, failRec(e.message));
      if (!quiet) toast('図書館の情報を取得できませんでした');
    }
    saveAvail(); persist.history(); persist.isbns();
    finish(chunk);
  }
  afterCheck(quiet);
}
function afterCheck() {
  syncPush();
  // 絞り込み中は、確認で変わった状態に合わせて一覧を更新する
  if (parseRoute().name === 'kumon' && filtersActive() && !state.progress) renderRoute({ keepScroll: true });
}

/* ================= 表示パーツ ================= */
function recOf(bookId, libId) { return availDB[bookId]?.[libId] || null; }

const ERR_LABEL = {
  upstream: '情報取得失敗', 'mock-fail': '情報取得失敗(疑似)', deferred: '確認待ち',
  no_isbn: 'ISBN未特定', no_key: 'APIキー未設定', partial: '一部未確認', unmatched: '館名の照合未確認',
};

function chipHtml(bookId, libId) {
  if (state.loading.has(bookId)) return '<span class="st loading" role="status">⏳ 確認中…</span>';
  const rec = recOf(bookId, libId);
  const st = STATUS[rec?.status || 'unknown'];
  const mock = rec?.source === 'mock' ? '<span class="mock" title="モックの仮データ">仮</span>' : '';
  return `<span class="st ${st.cls}"><span aria-hidden="true">${st.icon}</span>${st.label}${mock}</span>`;
}

function libRowHtml(bookId, lib, { detailed = false } = {}) {
  const rec = recOf(bookId, lib.id);
  let note = '';
  if (!state.loading.has(bookId)) {
    if (!rec) note = '<div class="lib-row-detail">未確認です。「最新情報を確認」を押してください。</div>';
    else {
      const parts = [];
      if (rec.error) {
        parts.push(`<span class="fail">${esc(ERR_LABEL[rec.error] || '情報取得失敗')}</span>`);
        if (rec.detail) parts.push(esc(rec.detail));
        const lk = lastKnown(rec);
        if (lk) parts.push(`前回の確認結果: ${STATUS[lk.status].icon}${STATUS[lk.status].label}(${fmtTime(lk.at)})<span class="stale"> ※現在の状態とは限りません</span>`);
      } else if (rec.detail) parts.push(esc(rec.detail));
      if (!rec.error && rec.source === 'calil' && Date.now() - Date.parse(rec.checkedAt) > 60 * 60 * 1000) parts.push('<span class="stale">古い情報の可能性があります</span>');
      if (detailed && rec.reason) parts.push(`(原因: ${esc(rec.reason)})`);
      if (parts.length) note = `<div class="lib-row-detail">${parts.join(' ／ ')}</div>`;
    }
  }
  if (detailed) {
    return `<div class="lib-block"><div class="lname">${esc(lib.name)}</div><div class="big">${chipHtml(bookId, lib.id)}</div>${note}<div class="muted">最終確認: ${rec ? (rec.error ? esc(fmtTime(rec.checkedAt)) + '(情報取得失敗)' : esc(fmtTime(rec.checkedAt))) : '未確認'}</div></div>`;
  }
  return `<div class="lib-row"><span class="lname">${esc(lib.shortName || lib.name)}</span>${chipHtml(bookId, lib.id)}</div>${note}`;
}
function libRowsHtml(bookId) { return selectedLibs().map((l) => libRowHtml(bookId, l)).join('') + lastTimeHtml(bookId); }
function lastTimeHtml(bookId) {
  const t = selectedLibs().map((l) => recOf(bookId, l.id)?.checkedAt).filter(Boolean).sort().pop();
  return `<div class="lib-row-detail">最終確認: ${t ? esc(fmtTime(t)) : '未確認'}</div>`;
}

/* ---- 表紙 ----
 * 別アプリ(絵本ラベルメーカー)と同じ方法で探す: openBD → 国立国会図書館 → Google ブックス。
 * 日本語版(ISBNが 978-4 で始まるもの)だけを使う。Google の「画像なし」の灰色の絵は表紙として使わない。
 * 見つけた表紙は端末(キャッシュ)に保存し、次からは通信しない。 */
const COVER_CACHE = 'kitalib-cover-img';
const coverKey = (id) => 'https://cover.local/' + encodeURIComponent(id);
const jpIsbns = (l) => (l || []).filter((i) => /^9784/.test(i));
const coverIsbns = (b) => jpIsbns(state.isbns[b.id] || b.isbns || []).slice(0, 4);
const coverUrlMap = new Map();      // 本ID → 画面に出す一時URL
const coverInflight = new Set();
const NO_COVER_TTL = 24 * 3600 * 1000;
const noCoverFresh = (id) => state.noCover[id] && Date.now() - Number(state.noCover[id]) < NO_COVER_TTL;
const NONE_BOX = '<span>📕<br>表紙<br>なし</span>';
const staticBad = new Set();   // 保存済み画像が読めなかった本(その場合は探して取る)
function coverHtml(b) {
  if (b.cover && !staticBad.has(b.id)) return `<div class="cover" data-cover="${esc(b.id)}" data-done="1"><img class="cover-img" data-static="1" src="${esc(b.cover)}" alt="${esc(b.title)}の表紙" loading="lazy" decoding="async"></div>`;
  const u = coverUrlMap.get(b.id);
  if (u) return `<div class="cover" data-cover="${esc(b.id)}" data-done="1"><img class="cover-img" src="${esc(u)}" alt="${esc(b.title)}の表紙" decoding="async"></div>`;
  if (noCoverFresh(b.id)) return `<div class="cover none" data-cover="${esc(b.id)}" data-done="1">${NONE_BOX}</div>`;
  return `<div class="cover wait" data-cover="${esc(b.id)}"></div>`;
}
document.addEventListener('error', (ev) => {
  const i = ev.target;
  if (!(i instanceof HTMLImageElement) || !i.dataset.static) return;
  const el = i.closest('.cover'); const id = el?.dataset.cover; if (!id) return;
  staticBad.add(id); el.classList.add('wait'); el.innerHTML = ''; delete el.dataset.done; hydrateCovers(true);
}, true);
function paintCover(id, url) {
  $$(`.cover[data-cover="${CSS.escape(id)}"]`).forEach((el) => {
    el.dataset.done = '1'; el.classList.remove('wait');
    if (url) { el.classList.remove('none'); el.innerHTML = `<img class="cover-img" src="${esc(url)}" alt="" decoding="async">`; }
    else { el.classList.add('none'); el.innerHTML = NONE_BOX; }
  });
}
function isbn10Of(i13) {
  if (!/^978\d{10}$/.test(i13)) return null;
  let sum = 0; for (let i = 0; i < 9; i++) sum += Number(i13[3 + i]) * (10 - i);
  const c = (11 - (sum % 11)) % 11; return i13.slice(3, 12) + (c === 10 ? 'X' : String(c));
}
const proxiedImg = (url) => 'https://images.weserv.nl/?url=' + encodeURIComponent(url.replace(/^https?:\/\//, ''));
async function fetchTo(url, ms = 9000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }); } finally { clearTimeout(t); }
}
const FNV = (buf) => { const b = new Uint8Array(buf); let h = 2166136261; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); } return b.length + ':' + (h >>> 0); };
const phCache = {};
function placeholderSigs(z) {   // Google が「画像なし」のときに返す絵(実在しないISBNで取得して見本にする)
  return (phCache[z] ||= (async () => {
    const url = `https://books.google.com/books/content?vid=ISBN0000000000&printsec=frontcover&img=1&zoom=${z}`;
    const sigs = [];
    for (const u of [url, proxiedImg(url)]) { try { const r = await fetchTo(u, 8000); if (r.ok) sigs.push(FNV(await r.arrayBuffer())); } catch { /* 次へ */ } }
    return sigs;
  })());
}
function decodeImg(blob) {
  return new Promise((resolve, reject) => {
    const u = URL.createObjectURL(blob); const im = new Image();
    im.onload = () => { URL.revokeObjectURL(u); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(u); reject(new Error('decode')); };
    im.src = u;
  });
}
const coverNet = { ok: false };   // 通信ができた(=「見つからない」が本当に見つからない)かどうか
/** 画像を取って、正しい表紙なら { img } を返す。z は Google の拡大段階(見本比較に使う) */
async function loadCover(url, z) {
  const refs = z ? await placeholderSigs(z) : [];
  for (const u of [url, proxiedImg(url)]) {
    try {
      const r = await fetchTo(u, 10000);
      coverNet.ok = true;
      if (!r.ok) { if (r.status === 403 && u === url) continue; return null; }
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 800 || refs.includes(FNV(buf))) return null;
      const img = await decodeImg(new Blob([buf], { type: r.headers.get('content-type') || 'image/jpeg' }));
      if (Math.min(img.naturalWidth, img.naturalHeight) < 100) return null;
      return { img };
    } catch { /* 直接取れない(CORS等)→ プロキシ経由で再試行 */ }
  }
  return null;
}
async function coverFromIsbn(isbn) {
  const cands = [];
  try {
    const r = await fetchTo('https://api.openbd.jp/v1/get?isbn=' + isbn, 8000);
    const j = r.ok ? await r.json() : null; const c = j && j[0] && j[0].summary && j[0].summary.cover;
    coverNet.ok = true; if (c) cands.push([c, 0]);
  } catch { /* 次へ */ }
  cands.push([`https://cover.openbd.jp/${isbn}.jpg`, 0], [`https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg`, 0]);
  const a10 = isbn10Of(isbn); if (a10) cands.push([`https://images-na.ssl-images-amazon.com/images/P/${a10}.09.LZZZZZZZ.jpg`, 0]);
  for (const z of [2, 1]) cands.push([`https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=${z}`, z]);
  for (const [u, z] of cands) { const r = await loadCover(u, z); if (r) return r; }
  return null;
}
let googleApiDead = false;
/** ISBNが分からない本: 書名・著者・出版社が合う日本語の本を Google ブックスで探す */
async function coverFromTitle(b) {
  if (googleApiDead) return null;
  try {
    const q = `intitle:"${b.title}"` + (b.author ? `+inauthor:"${String(b.author).split(/[ 　、,]/)[0]}"` : '');
    const r = await fetchTo('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q).replace(/%2B/g, '+') + '&langRestrict=ja&maxResults=10', 9000);
    if (r.status === 429 || r.status === 403) { googleApiDead = true; return null; }
    if (!r.ok) return null;
    coverNet.ok = true;
    const j = await r.json();
    const tq = norm(b.title), pq = norm(b.publisher || ''), aq = norm((b.author || '').split(/[ 　、,]/)[0]);
    for (const it of (j.items || [])) {
      const v = it.volumeInfo || {};
      if (v.language && v.language !== 'ja') continue;
      const t = norm(v.title || '');
      if (!(t === tq || (t.startsWith(tq) && /^[0-9一二三四五六七八九十上中下巻第]+$/.test(t.slice(tq.length))))) continue;
      const hit = (aq && (v.authors || []).some((a) => norm(a).includes(aq))) || (pq.length >= 2 && norm(v.publisher || '').includes(pq));
      if (!hit) continue;
      for (const idf of (v.industryIdentifiers || [])) if (idf.type === 'ISBN_13' && /^9784/.test(idf.identifier)) { const x = await coverFromIsbn(idf.identifier); if (x) return x; }
      const th = v.imageLinks && v.imageLinks.thumbnail;
      if (th) { const x = await loadCover(th.replace(/^http:/, 'https:'), 0); if (x) return x; }
    }
  } catch { /* 次へ */ }
  return null;
}
function toJpegBlob(img, max = 600) {
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}
async function cacheGet(id) { try { const c = await caches.open(COVER_CACHE); const r = await c.match(coverKey(id)); return r ? await r.blob() : null; } catch { return null; } }
async function cachePut(id, blob) { try { const c = await caches.open(COVER_CACHE); await c.put(coverKey(id), new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })); } catch { /* 保存できなくても表示はする */ } }
/** その本の表紙の Blob(保存済み→なければ探す)。見つからなければ null */
async function getCoverBlob(b, { allowTitle = true } = {}) {
  const hit = await cacheGet(b.id); if (hit) return hit;
  coverNet.ok = false;
  let found = null;
  for (const isbn of coverIsbns(b).slice(0, 2)) { found = await coverFromIsbn(isbn); if (found) break; }
  if (!found && allowTitle) found = await coverFromTitle(b);
  if (!found) { if (coverNet.ok) { state.noCover[b.id] = Date.now(); persist.noCover(); } return null; }
  const blob = await toJpegBlob(found.img); if (!blob) return null;
  await cachePut(b.id, blob); delete state.noCover[b.id];
  return blob;
}
/** 表示中の表紙を埋める(保存済みは即表示、なければ3冊ずつ探す) */
let hydrateTimer = 0, hydrateTitle = false;
function hydrateCovers(allowTitle = false) {
  hydrateTitle = hydrateTitle || allowTitle;
  clearTimeout(hydrateTimer);
  hydrateTimer = setTimeout(async () => {
    const withTitle = hydrateTitle; hydrateTitle = false;
    const ids = [...new Set($$('#view .cover[data-cover]:not([data-done])').map((el) => el.dataset.cover))].filter((id) => !coverInflight.has(id));
    let i = 0;
    const work = async () => {
      for (;;) {
        const id = ids[i++]; if (!id) return;
        const b = getBook(id); if (!b) continue;
        if (b.cover && !staticBad.has(id)) continue;
        coverInflight.add(id);
        try {
          const cached = await cacheGet(id);
          if (cached) { const u = URL.createObjectURL(cached); coverUrlMap.set(id, u); paintCover(id, u); continue; }
          if (noCoverFresh(id)) { paintCover(id, null); continue; }
          const hasIsbn = coverIsbns(b).length > 0;
          if (!hasIsbn && !withTitle) continue;   // ISBN調べが終わるまで待つ
          const blob = await getCoverBlob(b, { allowTitle: true });
          if (blob) { const u = URL.createObjectURL(blob); coverUrlMap.set(id, u); paintCover(id, u); } else if (noCoverFresh(id)) paintCover(id, null);
        } finally { coverInflight.delete(id); }
      }
    };
    await Promise.all([work(), work(), work()]);
  }, 60);
}
function setCoverFor(id) {
  $$(`[data-book="${CSS.escape(id)}"] .book-main`).forEach((el) => {
    if (el.querySelector('.cover')) return;
    const b = getBook(id); if (!b) return;
    el.insertAdjacentHTML('afterbegin', coverHtml(b));
  });
  hydrateCovers();
}
const coverTried = new Set();
let coverRun = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 表示中の本のうち、ISBNが分かっていないものを、Workerに問い合わせて表紙を出す(少しずつ・混雑時は待つ) */
async function ensureCovers() {
  const run = ++coverRun;
  if (!['kumon', 'search', 'favorites'].includes(parseRoute().name)) return;
  hydrateCovers();
  if (!HAS_BACKEND || useMock()) { hydrateCovers(true); return; }
  let todo = currentVisibleIds().filter((id) => BOOK_BY_ID.has(id) && !isbnsOf(BOOK_BY_ID.get(id)).length && !coverTried.has(id));
  let busyCount = 0;
  for (let round = 0; todo.length && round < 40; round++) {
    if (run !== coverRun) return;
    let res;
    try { res = await api('/api/isbns', { method: 'POST', body: { ids: todo.slice(0, 80), resolve: round > 0 }, timeout: 40000 }); } catch { break; }
    if (run !== coverRun) return;
    for (const [id, list] of Object.entries(res.isbns || {})) if (list.length && !(state.isbns[id] || []).length) { state.isbns[id] = list; setCoverFor(id); }
    persist.isbns();
    todo = todo.filter((id) => !(state.isbns[id] || []).length);
    if (round === 0) continue;
    if (res.busy) { if (++busyCount >= 3) break; await sleep(8000); } else if (res.pending <= 0) break; else await sleep(900);
  }
  todo.forEach((id) => coverTried.add(id));
  hydrateCovers(true);
}

function bookCardHtml(b) {
  const meta = [];
  const lv = b.isKumonRecommended ? b.level : (b.customLevel || null);
  if (lv) meta.push(`<span class="lv">${esc(levelLabel(lv))}</span>`);
  const au = b.author ? `著者：${esc(b.author)}` : '';
  const others = (b.contributors || []).length ? ` ${esc(b.contributors.join(' '))}` : '';
  const pub = b.publisher ? ` ／ ${esc(b.publisher)}` : '';
  const fav = isFav(b.id);
  const read = !!state.read[b.id];
  const spine = b.isKumonRecommended ? levelColor(b.level) : (b.customLevel ? levelColor(b.customLevel) : '#4a5a6a');
  return `<article class="book" data-book="${esc(b.id)}" style="--spine:${spine}">
    <div class="spine" aria-hidden="true"></div>
    <div class="book-body">
      <a class="book-link" href="#/book/${encodeURIComponent(b.id)}">
        <h3 class="book-title">${esc(b.title)}</h3>
        <div class="book-meta">${meta.join('')}${au}${others}${pub}${b.isNewIn2026 ? '<span class="new">新</span>' : ''}</div>
      </a>
      <div class="book-main">${coverHtml(b)}<div class="lib-rows">${libRowsHtml(b.id)}</div></div>
      ${state.custom[b.id] ? `<button class="mini-btn" data-unadd="${esc(b.id)}">✕ このリストから外す</button>` : ''}
    </div>
    <div class="side-btns">
      <button class="fav-btn" data-fav="${esc(b.id)}" aria-pressed="${fav}" aria-label="${fav ? 'お気に入りを解除' : 'お気に入りに追加'}">${fav ? '❤️' : '♡'}<span>${fav ? '登録済' : 'お気に入り'}</span></button>
      <button class="read-btn" data-read="${esc(b.id)}" aria-pressed="${read}" aria-label="${read ? '読んだを取り消す' : '読んだにする'}"><span aria-hidden="true">${read ? '☑' : '☐'}</span>読んだ</button>
    </div>
  </article>`;
}

function updateCards(bookId) {
  $$(`[data-book="${CSS.escape(bookId)}"] .lib-rows`).forEach((el) => { el.innerHTML = libRowsHtml(bookId); });
  const route = parseRoute();
  if (route.name === 'book' && route.id === bookId) renderRoute();
  setCoverFor(bookId);
}
function refreshAllCards() { $$('[data-book]').forEach((el) => updateCards(el.dataset.book)); }
function renderProgress() {
  const el = $('#progress'); if (!el) return;
  const p = state.progress;
  el.textContent = p ? `確認中… (${p.done}/${p.total})` : '';
  $$('[data-check]').forEach((b) => { b.disabled = !!p; });
}

/* ================= 画面 ================= */
const view = () => $('#view');

function checkButton(label = '最新情報を確認') {
  return `<button class="btn small" data-check="1">🔄 ${label}</button><span class="updated" id="progress" role="status"></span>`;
}

function homeView() {
  const favCount = Object.keys(state.fav).length;
  return `
  <section class="hero">
    <h1>読みたい本、いま借りられる？</h1>
    <form class="searchbox" id="home-search" role="search">
      <input type="search" name="q" placeholder="本のタイトル・著者名で検索" aria-label="本のタイトル・著者名で検索" enterkeyhint="search" autocomplete="off">
      <button class="btn" type="submit" aria-label="検索">🔍</button>
    </form>
  </section>
  <nav class="menu" aria-label="メニュー">
    <a class="m1" href="#/kumon"><span class="em" aria-hidden="true">📚</span>くもんの推薦図書<small>${BOOKS.length}冊</small></a>
    <a class="m2" href="#/search"><span class="em" aria-hidden="true">🔍</span>本を検索<small>書名・著者名</small></a>
    <a class="m3" href="#/favorites"><span class="em" aria-hidden="true">❤️</span>お気に入り<small>${favCount}冊</small></a>
    <a class="m4" href="#/libraries"><span class="em" aria-hidden="true">🏛</span>図書館<small>${selectedLibs().map((l) => esc(l.shortName || l.name)).join('・')}</small></a>
    <a class="m5" href="#/labels"><span class="em" aria-hidden="true">🖨</span>表紙ラベル印刷<small>25mm角・A4のPDF</small></a>
  </nav>
  ${unreadCount() ? `<div class="notice" style="margin-top:14px">🔔 未読の通知が${unreadCount()}件あります。<a href="#/notifications">見る</a></div>` : ''}
  <p class="muted on-wood" style="margin:14px 4px">対象: ${selectedLibs().map((l) => esc(l.name)).join('、')}。「貸出中」→「在架」になったら、お気に入りの本をお知らせします。</p>`;
}

function passFilters(b) {
  const f = filters();
  if (f.read === 'read' && !state.read[b.id]) return false;
  if (f.read === 'unread' && state.read[b.id]) return false;
  if (f.status !== 'all') {
    const libs = f.lib === 'all' ? selectedLibs() : enabledLibs().filter((l) => l.id === f.lib);
    // 未確認の本は「不明」として扱う
    if (!libs.some((l) => (recOf(b.id, l.id)?.status || 'unknown') === f.status)) return false;
  }
  return true;
}
const filtersActive = () => { const f = filters(); return f.lib !== 'all' || f.status !== 'all' || f.read !== 'all'; };
function filterBarHtml() {
  const f = filters();
  const sel = (key, opts) => `<select data-filter="${key}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${f[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<div class="filters" role="group" aria-label="絞り込み">
    <label><span>図書館</span>${sel('lib', [['all', 'すべて'], ...enabledLibs().map((l) => [l.id, l.shortName || l.name])])}</label>
    <label><span>在架状況</span>${sel('status', [['all', 'すべて'], ['available', '在架'], ['lent', '貸出中'], ['unknown', '不明']])}</label>
    <label><span>読んだ</span>${sel('read', [['all', 'すべて'], ['read', '読んだ'], ['unread', '読んでない']])}</label>
  </div>`;
}

function kumonView(route) {
  const levels = [...LEVELS, OTHER];
  const asked = route.q.get('level');
  const level = levels.includes(asked) ? asked : (levels.includes(state.settings.level) ? state.settings.level : LEVELS[0]);
  state.settings.level = level; persist.settings();
  const all = [...BOOKS.filter((b) => b.level === level), ...customBooks(level)];
  const list = all.filter(passFilters);
  return `
  <h1 class="page-title">📚 くもんの推薦図書</h1>
  <div class="chips" role="group" aria-label="レベル">${levels.map((lv) => `<button class="chip" data-level="${esc(lv)}" aria-pressed="${lv === level}">${esc(levelLabel(lv))}</button>`).join('')}</div>
  <div class="toolbar">${checkButton()} <button class="btn small secondary" data-label-open="lv:${esc(level)}">🖨 ラベル印刷</button></div>
  ${filterBarHtml()}
  <h2 class="shelf-title">${level === OTHER ? '推薦図書以外' : 'レベル ' + esc(level)}（${filtersActive() ? `${list.length}/${all.length}` : all.length}冊）</h2>
  ${filtersActive() ? '<p class="muted on-wood" style="margin:0 4px 8px">絞り込み中です。まだ確認していない本は「不明」として扱います。</p>' : ''}
  <div class="shelf-list">${list.map(bookCardHtml).join('')}</div>
  ${!all.length ? '<p class="empty">まだ本がありません。<br>「検索」で本を探して、このリストに追加できます。</p>' : (!list.length ? '<p class="empty">条件に合う本がありません。</p>' : '')}`;
}

function searchLocal(q) {
  const terms = String(q || '').normalize('NFKC').split(/[\s　]+/).map(norm).filter(Boolean);
  if (!terms.length) return [];
  return BOOKS.filter((b) => { const hay = b._n; return terms.every((t) => hay.includes(t)); });
}

function searchView(route) {
  const q = route.q.get('q') || '';
  const res = q ? searchLocal(q) : [];
  const shown = res.slice(0, 80);
  return `
  <h1 class="page-title">🔍 本を検索</h1>
  <form class="searchbox" id="search-form" role="search">
    <input type="search" name="q" value="${esc(q)}" placeholder="本のタイトル・著者名で検索" aria-label="本のタイトル・著者名で検索" enterkeyhint="search" autocomplete="off">
    <button class="btn" type="submit" aria-label="検索">🔍</button>
  </form>
  ${q ? `<div class="toolbar" style="margin-top:12px"><span class="grow on-wood">くもんの推薦図書: ${res.length}件${res.length > shown.length ? '(先頭80件を表示)' : ''}</span>${shown.length ? checkButton() : ''}</div>` : '<p class="empty">書名または著者名を入力してください。<br>例: ぐりとぐら ／ 宮沢賢治</p>'}
  <div class="shelf-list">${shown.map(bookCardHtml).join('')}</div>
  ${q && !res.length ? '<p class="empty">推薦図書には見つかりませんでした。</p>' : ''}
  ${q ? extSearchBlock(q) : ''}`;
}
let extState = { q: null, items: null, error: null, busy: false };
/* 検索で見つけた本を、推薦図書のリスト(5A・4A…または「推薦図書以外」)に追加する */
function addRowHtml(b) {
  const c = state.custom[b.id];
  if (c) return `<div class="add-row">✅ 「${esc(levelLabel(c.level))}」に追加済み <button class="btn secondary small" data-unadd="${esc(b.id)}">リストから外す</button></div>`;
  return `<div class="add-row"><label><span>追加先</span><select data-add-level="${esc(b.id)}">${[OTHER, ...LEVELS].map((lv) => `<option value="${esc(lv)}">${esc(levelLabel(lv))}</option>`).join('')}</select></label><button class="btn small" data-add="${esc(b.id)}">推薦図書に追加</button></div>`;
}
function addToList(id, level) {
  const b = getBook(id); if (!b || BOOK_BY_ID.has(id)) return;
  const book = { id: b.id, title: b.title, author: b.author, publisher: b.publisher, isbns: b.isbns || [], isKumonRecommended: false, authors: [], contributors: [] };
  state.custom[id] = { book, level, addedAt: nowIso() };
  EXT.set(id, { ...book, customLevel: level });
  persist.custom();
  toast(`「${levelLabel(level)}」に追加しました`);
  renderRoute({ keepScroll: true });
}
function removeFromList(id) {
  if (!state.custom[id]) return;
  delete state.custom[id]; persist.custom();
  const e = EXT.get(id); if (e) delete e.customLevel;
  toast('リストから外しました');
  renderRoute({ keepScroll: true });
}
function toggleRead(id) {
  if (state.read[id]) delete state.read[id]; else state.read[id] = true;
  persist.read();
  const on = !!state.read[id];
  $$(`[data-read="${CSS.escape(id)}"]`).forEach((btn) => {
    btn.setAttribute('aria-pressed', on); btn.setAttribute('aria-label', on ? '読んだを取り消す' : '読んだにする');
    const ic = btn.querySelector('span'); if (ic) ic.textContent = on ? '☑' : '☐';
  });
  if (parseRoute().name === 'kumon' && filters().read !== 'all') renderRoute({ keepScroll: true });
}
function extSearchBlock(q) {
  if (useMock()) return `<div class="notice">🧪 モックモードでは、くもんの推薦図書の中だけを検索します。(推薦図書以外も検索するには、バックエンドの接続が必要です)</div>`;
  if (extState.q === q && extState.items) {
    return `<h2 class="shelf-title">図書館全体からの検索結果(国立国会図書館サーチ)</h2>
      ${extState.items.length ? `<div class="toolbar">${checkButton()}</div>` : ''}
      <div class="shelf-list" id="ext-list">${extState.items.map((b) => `<div class="ext-item">${bookCardHtml(b)}${addRowHtml(b)}</div>`).join('') || '<p class="empty">見つかりませんでした。</p>'}</div>`;
  }
  return `<div style="margin-top:14px"><button class="btn secondary block" id="ext-search" ${extState.busy ? 'disabled' : ''}>${extState.busy ? '検索中…' : '🌐 推薦図書以外も探す(図書館全体)'}</button>${extState.error ? `<p class="fail" style="margin-top:8px">${esc(extState.error)}</p>` : ''}</div>`;
}

function favoritesView() {
  const favs = Object.values(state.fav).sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  return `
  <h1 class="page-title">❤️ お気に入り</h1>
  ${favs.length ? `<div class="toolbar">${checkButton()}</div>
  <p class="muted on-wood" style="margin:0 4px 10px">「貸出中」→「在架」になると通知します。前回の状態と比べて判定します。</p>
  <div class="shelf-list">${favs.map((f) => { const b = getBook(f.bookId); return b ? bookCardHtml(b) : ''; }).join('')}</div>`
  : '<p class="empty">まだお気に入りがありません。<br>本の右にある ♡ をタップして登録できます。</p>'}`;
}

function librariesView() {
  const live = !useMock();
  return `
  <h1 class="page-title">🏛 図書館・設定</h1>
  <section class="panel"><h2>対象の図書館</h2>
    ${LIBS.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map((l) => `
      <div class="lib-card ${l.enabled ? '' : 'off'}"><label><input type="checkbox" data-lib="${esc(l.id)}" ${l.enabled ? '' : 'disabled'} ${l.enabled && selectedLibs().some((x) => x.id === l.id) ? 'checked' : ''}><span>${esc(l.name)}${l.enabled ? '' : '<br><span class="muted">今後対応予定</span>'}</span></label></div>`).join('')}
    <p class="muted">図書館の追加は libraries.json に1件足すだけで行えます(README参照)。</p>
  </section>

  <section class="panel"><h2>データの取得元</h2>
    ${HAS_BACKEND ? `
      <p>${live ? '🌐 <b>実データ</b>(カーリル図書館API経由)で確認しています。' : '🧪 <b>モック</b>(動作確認用の仮データ)を表示中です。'}</p>
      <label class="lib-card"><span style="flex:1">デモ用のモックデータを使う</span><input type="checkbox" id="mock-toggle" ${useMock() ? 'checked' : ''} style="width:26px;height:26px"></label>
      <p class="muted">バックエンド: <span id="be-status">確認中…</span></p>
    ` : `
      <p>🧪 現在は <b>モックデータ</b>です(実際の図書館とは無関係の仮の状態)。</p>
      <p class="muted">実データ接続には、バックエンド(worker.js)を公開し、<code>config.js</code> の <code>BACKEND_URL</code> にそのURLを書く必要があります。手順は README を参照してください。</p>`}
    <p class="muted">蔵書情報の出典: <a href="${esc(CFG.ATTRIBUTION?.url || 'https://calil.jp/')}" target="_blank" rel="noopener">${esc(CFG.ATTRIBUTION?.name || 'カーリル図書館API')}</a></p>
  </section>

  <section class="panel"><h2>通知</h2>
    <p id="push-status" class="muted">確認中…</p>
    <div class="row-actions" id="push-actions"></div>
    <p class="muted">プッシュ通知が使えない環境でも、アプリを開いたときに「貸出中→在架」の変化を確認し、🔔 に表示します(アプリ内通知)。</p>
  </section>

  <section class="panel"><h2>端末内のデータ</h2>
    <p class="muted">お気に入り ${Object.keys(state.fav).length}冊 ／ 状態履歴 ${state.history.length}件 ／ 通知 ${state.notifs.length}件</p>
    <div class="row-actions"><button class="btn secondary small" id="clear-data">お気に入り・履歴を削除</button></div>
  </section>`;
}

function notificationsView() {
  const list = state.notifs.slice().sort((a, b) => b.at.localeCompare(a.at));
  const html = `
  <h1 class="page-title">🔔 通知</h1>
  <section class="panel">${list.length ? list.map((n) => `<div class="notif ${n.read ? '' : 'unread'}"><div>${esc(n.title)}</div><div>${esc(n.body)}</div><div class="when">${esc(fmtTime(n.at))}${n.source === 'mock' ? ' ・モック' : ''}${n.bookId ? ` ・<a href="#/book/${encodeURIComponent(n.bookId)}">本を見る</a>` : ''}</div></div>`).join('') : '<p class="muted">通知はまだありません。</p>'}</section>`;
  state.notifs.forEach((n) => { n.read = true; }); persist.notifs(); updateBell();
  return html;
}


/* ISBNを自動で特定できなかった本のために、ISBNを手入力して登録する欄 */
function isbnFormHtml(b, libs) {
  if (!HAS_BACKEND || useMock() || !b.isKumonRecommended) return '';
  const missing = libs.some((l) => recOf(b.id, l.id)?.error === 'no_isbn');
  const cur = (state.isbns[b.id] || []).join(' ');
  return `<details class="isbn-box" ${missing ? 'open' : ''}>
    <summary>${missing ? '⚠ ISBNを手入力して登録する' : 'ISBNを手入力する(任意)'}</summary>
    <p class="muted">ISBNを特定できないと、在架を確認できません。図書館の蔵書検索や本の裏表紙などでISBN(10桁または13桁)を調べて入力してください。複数あるときはスペースで区切ります(最大4つ)。空欄で登録すると取り消せます。</p>
    <form id="isbn-form" data-book="${esc(b.id)}" class="searchbox">
      <input type="text" name="isbn" inputmode="numeric" placeholder="例: 4-251-00111-7" value="${esc(missing ? '' : cur)}" aria-label="ISBN" autocomplete="off">
      <button class="btn" type="submit">登録</button>
    </form>
  </details>`;
}

function bookView(id) {
  const b = getBook(id);
  if (!b) return '<p class="empty">本が見つかりません。<br><a href="#/kumon" class="btn secondary" style="margin-top:12px">推薦図書へ</a></p>';
  const libs = selectedLibs();
  const fav = isFav(b.id);
  const isbn13 = (state.isbns[b.id] || b.isbns || [])[0];
  const i10 = toIsbn10(isbn13);
  const hist = state.history.filter((h) => h.bookId === b.id && h.source === (useMock() ? 'mock' : 'calil')).slice(-8).reverse();
  return `
  <section class="panel" style="--spine:${b.isKumonRecommended ? levelColor(b.level) : '#4a5a6a'}">
    <h1 class="detail-title">${esc(b.title)}</h1>
    <dl class="kv">
      <dt>著者</dt><dd>${esc(b.author || '(記載なし)')}${(b.contributors || []).length ? '<br><span class="muted">' + esc(b.contributors.join(' ／ ')) + '</span>' : ''}</dd>
      <dt>出版社</dt><dd>${esc(b.publisher || '(不明)')}</dd>
      ${b.isKumonRecommended ? `<dt>推薦</dt><dd>📚 くもんのすいせん図書(2026年度版 レベル ${esc(b.level)}・${b.order}番目)${b.isNewIn2026 ? ' <span class="new" style="background:#fff0b8;border:1px solid #c9a24b;border-radius:4px;padding:0 5px;font-size:12px;font-weight:700">新しく入った本</span>' : ''}</dd>` : ''}
    </dl>
    <div class="row-actions">
      <button class="btn ${fav ? 'secondary' : ''}" data-fav="${esc(b.id)}" aria-pressed="${fav}">${fav ? '❤️ お気に入りを解除' : '♡ お気に入りに追加'}</button>
    </div>
  </section>
  <section class="panel" data-book="${esc(b.id)}">
    <h2>図書館の在架状況</h2>
    ${libs.map((l) => libRowHtml(b.id, l, { detailed: true })).join('')}
    <div class="toolbar" style="margin-top:8px"><button class="btn" data-check="1">🔄 最新情報を確認</button><span class="muted" id="progress" role="status"></span></div>
    <div class="row-actions">
      ${i10 ? `<a class="btn secondary small" href="https://calil.jp/book/${esc(i10)}" target="_blank" rel="noopener">北区図書館で詳しく見る(カーリル)</a>` : ''}
      ${libs[0]?.officialUrl ? `<a class="btn secondary small" href="${esc(libs[0].officialUrl)}" target="_blank" rel="noopener">北区立図書館の公式サイト</a>` : ''}
    </div>
    ${useMock() ? '<div class="notice">🧪 モックモード: 上の状態は動作確認用の仮データです。実際の図書館の状況ではありません。</div>' : ''}
    ${isbnFormHtml(b, libs)}
  </section>
  ${hist.length ? `<section class="panel"><h2>状態の履歴</h2><ul class="hist">${hist.map((h) => { const lib = LIBS.find((l) => l.id === h.libraryId); const p = h.previousStatus ? STATUS[h.previousStatus] : null; const c = STATUS[h.currentStatus]; return `<li>${esc(lib?.shortName || h.libraryId)}: ${p ? p.icon + p.label : '初回'} → ${c.icon}${c.label}<span class="muted">(${esc(fmtTime(h.checkedAt))})</span></li>`; }).join('')}</ul></section>` : ''}`;
}

/* ================= ルーティング ================= */
/* ================= 表紙ラベル印刷(25mm角・A4・PDF) ================= */
const labelUi = { src: 'fav', sel: null, mode: 'contain', cut: true, busy: false, result: null };
const labelSources = () => [['fav', 'お気に入り'], ['read', '読んだ本'], ...LEVELS.map((lv) => [`lv:${lv}`, `推薦図書 ${lv}`]), ['lv:other', '推薦図書以外(追加した本)']];
const isbnsOf = (b) => jpIsbns(state.isbns[b.id] || b.isbns || []);
function labelCandidates(src) {
  if (src === 'fav') return Object.keys(state.fav).map(getBook).filter(Boolean);
  if (src === 'read') return Object.keys(state.read).map(getBook).filter(Boolean);
  const lv = src.replace(/^lv:/, '');
  return [...BOOKS.filter((b) => b.level === lv), ...customBooks(lv)];
}
function labelsView() {
  const lay = self.Labels.layout();
  const list = labelCandidates(labelUi.src);
  if (!labelUi.sel) labelUi.sel = new Set(list.map((b) => b.id));
  const picked = list.filter((b) => labelUi.sel.has(b.id));
  const pages = Math.max(1, Math.ceil(picked.length / lay.perPage));
  const r = labelUi.result;
  return `
  <h1 class="page-title">🖨 表紙ラベル印刷</h1>
  <section class="panel">
    <p>選んだ本の表紙を、<b>25mm角</b>のラベルにして、A4のPDFを作ります(1ページ ${lay.perPage}枚 = ${lay.cols}列×${lay.rows}行)。印刷は <b>「100%(実際のサイズ)」</b>で行ってください(「用紙に合わせる」だと25mmになりません)。</p>
    <label class="lab-field"><span>本の選び方</span>
      <select data-label-src>${labelSources().map(([v, l]) => `<option value="${esc(v)}" ${labelUi.src === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <div class="lab-actions">
      <button class="btn small secondary" data-label-all>すべて選ぶ</button>
      <button class="btn small secondary" data-label-none>すべて外す</button>
      <span class="muted">${picked.length}/${list.length}冊 → ${pages}ページ</span>
    </div>
    ${list.length ? `<ul class="lab-list">${list.map((b) => `<li><label class="lab-row"><input type="checkbox" data-label-pick="${esc(b.id)}" ${labelUi.sel.has(b.id) ? 'checked' : ''}><span>${esc(b.title)}${isbnsOf(b).length ? '' : '<small>(ISBN未確認)</small>'}</span></label></li>`).join('')}</ul>` : '<p class="empty" style="color:inherit;padding:10px 0">この選び方には、本がありません。</p>'}
    <fieldset class="lab-opts"><legend>表紙の入れ方</legend>
      <label><input type="radio" name="label-mode" value="contain" ${labelUi.mode === 'contain' ? 'checked' : ''}> 表紙全体を入れる(余白は白)</label>
      <label><input type="radio" name="label-mode" value="crop" ${labelUi.mode === 'crop' ? 'checked' : ''}> 正方形に切り抜く(はみ出しは切れます)</label>
      <label><input type="checkbox" id="label-cut" ${labelUi.cut ? 'checked' : ''}> 切り取り線を入れる</label>
    </fieldset>
    <button class="btn block" data-label-make ${labelUi.busy || !picked.length ? 'disabled' : ''}>${labelUi.busy ? '作成中…' : '📄 PDFを作る'}</button>
    <p class="muted" id="label-progress" role="status"></p>
    ${r ? labelResultHtml(r) : ''}
    <p class="muted" style="margin-top:10px">表紙は Google ブックスの画像です。取得できない場合は、画像を中継するサービス(images.weserv.nl)を経由します(画像のURL=ISBNが送られます。書名や利用者の情報は送りません)。</p>
  </section>`;
}
function labelResultHtml(r) {
  const skipped = r.skipped.length ? `<details class="lab-skip" open><summary>⚠ ${r.skipped.length}冊は含まれていません</summary><ul>${r.skipped.map((s) => `<li>${esc(s.b.title)} <small>— ${esc(s.why)}</small></li>`).join('')}</ul></details>` : '';
  if (r.empty) return `<div class="notice">表紙を取得できた本がありませんでした。</div>${skipped}`;
  return `<div class="lab-result"><p>✅ ${r.count}枚・${r.pages}ページのPDFができました。</p>
    <div class="lab-actions"><a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">📄 PDFを開く(印刷)</a><a class="btn secondary" href="${esc(r.url)}" download="${esc(r.name)}">保存</a></div>
    <div class="lab-thumbs" aria-label="仕上がりの確認">${r.thumbs.map((t) => `<img src="${esc(t)}" alt="">`).join('')}</div></div>${skipped}`;
}
/* 表示中の本のうち、ISBNが分かっていないものを Worker に調べてもらう(少しずつ・混雑時は待つ) */
async function fillIsbns(ids, onTick) {
  let todo = ids.filter((id) => !(state.isbns[id] || []).length);
  let busy = 0;
  for (let round = 0; todo.length && round < 60; round++) {
    let res;
    try { res = await api('/api/isbns', { method: 'POST', body: { ids: todo.slice(0, 80), resolve: round > 0 }, timeout: 40000 }); } catch { break; }
    for (const [id, list] of Object.entries(res.isbns || {})) if (list.length) state.isbns[id] = list;
    persist.isbns();
    todo = todo.filter((id) => !(state.isbns[id] || []).length);
    if (onTick) onTick(todo.length);
    if (round === 0) continue;
    if (res.busy) { if (++busy >= 3) break; await sleep(8000); } else if (res.pending <= 0) break; else await sleep(900);
  }
}
async function makeLabels() {
  if (labelUi.busy) return;
  const list = labelCandidates(labelUi.src).filter((b) => labelUi.sel.has(b.id));
  if (!list.length) { toast('本を選んでください'); return; }
  if (labelUi.result?.url) URL.revokeObjectURL(labelUi.result.url);
  labelUi.busy = true; labelUi.result = null; renderRoute({ keepScroll: true });
  const prog = (t) => { const el = $('#label-progress'); if (el) el.textContent = t; };
  const skipped = [];
  try {
    const need = list.filter((b) => !isbnsOf(b).length && BOOK_BY_ID.has(b.id));
    if (need.length && HAS_BACKEND && !useMock()) await fillIsbns(need.map((b) => b.id), (n) => prog(`ISBNを調べています… 残り${n}冊`));
    const ready = [];
    for (const b of list) { const isbns = isbnsOf(b); if (isbns.length) ready.push({ b, isbns }); else skipped.push({ b, why: 'ISBNが分かりません' }); }
    const out = new Array(ready.length);
    let next = 0, done = 0;
    const worker = async () => {
      for (;;) {
        const i = next++; if (i >= ready.length) return;
        const { b, isbns } = ready[i];
        let img = null;
        try { const cb = await getCoverBlob(b, { allowTitle: true }); if (cb) img = await decodeImg(cb); } catch { /* 下で再試行 */ }
        if (!img) img = await self.Labels.fetchCover(isbns);
        if (img) out[i] = { b, image: self.Labels.toSquare(img, labelUi.mode) }; else skipped.push({ b, why: '表紙画像が見つかりません' });
        prog(`表紙を取得中… ${++done}/${ready.length}`);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const got = out.filter(Boolean);
    if (!got.length) labelUi.result = { empty: true, skipped };
    else {
      const { bytes, pageCount } = self.Labels.buildPdf(got, { cutLines: labelUi.cut });
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      labelUi.result = { url, pages: pageCount, count: got.length, skipped, thumbs: got.map((x) => x.image), name: `ehon-labels-${new Date().toISOString().slice(0, 10)}.pdf` };
    }
  } catch (e) { toast('PDFを作れませんでした: ' + (e.message || e)); }
  finally { labelUi.busy = false; if (parseRoute().name === 'labels') renderRoute({ keepScroll: true }); }
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  const name = parts[0] || 'home';
  if (name === 'book') return { name, id: decodeURIComponent(parts[1] || ''), q };
  return { name, q };
}
const TABS = { home: 'home', kumon: 'kumon', search: 'search', favorites: 'favorites', libraries: 'libraries', labels: null, book: null, notifications: null };

function renderRoute({ keepScroll = false } = {}) {
  const route = parseRoute();
  const map = { home: homeView, kumon: kumonView, search: searchView, favorites: favoritesView, libraries: librariesView, labels: labelsView, notifications: notificationsView };
  let html;
  if (route.name === 'book') html = bookView(route.id);
  else html = (map[route.name] || homeView)(route);
  const y = window.scrollY;
  view().innerHTML = html;
  if (!keepScroll) window.scrollTo(0, 0); else window.scrollTo(0, y);
  $$('.tabbar a').forEach((a) => { if (a.dataset.tab === (TABS[route.name] ?? '')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  renderProgress();
  onRouteShown(route);
}

function onRouteShown(route) {
  if (route.name === 'libraries') { updatePushUi(); if (HAS_BACKEND) pingBackend(); }
  // 実データ時: 詳細・お気に入りを開いたときは、古い(または未確認の)ものだけ自動で確認
  const stale = (id) => selectedLibs().some((l) => { const r = recOf(id, l.id); return !r || Date.now() - Date.parse(r.checkedAt) > 15 * 60 * 1000; });
  if (!useMock() && route.name === 'book' && getBook(route.id) && stale(route.id) && !state.loading.has(route.id)) checkBooks([route.id], { quiet: true });
  if (!useMock() && route.name === 'favorites') { const ids = Object.keys(state.fav).filter(stale); if (ids.length) checkBooks(ids, { quiet: true }); }
  // モック時は一覧を開いたとき、未確認の本だけ自動で仮データを入れる(動作確認用)
  if (useMock() && ['kumon', 'search', 'favorites'].includes(route.name)) {
    const ids = $$('[data-book]').map((el) => el.dataset.book).filter((id) => !recOf(id, selectedLibs()[0]?.id));
    if (ids.length) { ids.forEach((id) => selectedLibs().forEach((l) => applyRecord(id, l.id, mockRecord(id, l.id)))); saveAvail(); persist.history(); refreshAllCards(); }
  }
  if (['kumon', 'search', 'favorites'].includes(route.name)) ensureCovers();
  view().focus({ preventScroll: true });
}

/* ================= イベント ================= */
function currentVisibleIds() {
  return [...new Set($$('#view [data-book]').map((el) => el.dataset.book))];
}
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, a');
  if (!t) return;
  if (t.dataset.fav) { ev.preventDefault(); toggleFav(t.dataset.fav); return; }
  if (t.dataset.read) { ev.preventDefault(); toggleRead(t.dataset.read); return; }
  if (t.dataset.add) { ev.preventDefault(); const s = document.querySelector(`select[data-add-level="${CSS.escape(t.dataset.add)}"]`); addToList(t.dataset.add, s ? s.value : OTHER); return; }
  if (t.dataset.unadd) { ev.preventDefault(); removeFromList(t.dataset.unadd); return; }
  if (t.dataset.labelOpen) { ev.preventDefault(); labelUi.src = t.dataset.labelOpen; labelUi.sel = null; labelUi.result = null; location.hash = '#/labels'; return; }
  if (t.dataset.labelAll !== undefined) { ev.preventDefault(); labelUi.sel = new Set(labelCandidates(labelUi.src).map((b) => b.id)); renderRoute({ keepScroll: true }); return; }
  if (t.dataset.labelNone !== undefined) { ev.preventDefault(); labelUi.sel = new Set(); renderRoute({ keepScroll: true }); return; }
  if (t.dataset.labelMake !== undefined) { ev.preventDefault(); await makeLabels(); return; }
  if (t.dataset.check) {
    ev.preventDefault();
    // 画面に表示されている(絞り込み後の)本だけを確認する
    await checkBooks(currentVisibleIds()); return;
  }
  if (t.dataset.level) { location.hash = `#/kumon?level=${encodeURIComponent(t.dataset.level)}`; return; }
  if (t.id === 'ext-search') { await runExtSearch(); return; }
  if (t.id === 'clear-data') {
    if (confirm('お気に入り・状態履歴・通知を、この端末から削除します。よろしいですか?')) {
      state.fav = {}; state.history = []; state.notifs = []; availDB = {}; persist.fav(); persist.history(); persist.notifs(); saveAvail(); updateBell(); syncPush(); renderRoute();
      toast('削除しました');
    }
  }
  if (t.id === 'push-enable') { await enablePush(); return; }
  if (t.id === 'push-disable') { await disablePush(); return; }
});
document.addEventListener('submit', async (ev) => {
  const f = ev.target;
  if (f.id === 'isbn-form') {
    ev.preventDefault();
    const id = f.dataset.book;
    const val = new FormData(f).get('isbn').toString().trim();
    try {
      const res = await api('/api/isbn', { method: 'POST', body: { id, isbns: val } });
      if (res.isbns?.length) state.isbns[id] = res.isbns; else delete state.isbns[id];
      persist.isbns();
      delete availDB[id]; saveAvail();
      toast(res.isbns?.length ? 'ISBNを登録しました。確認します…' : '手入力のISBNを取り消しました');
      if (res.isbns?.length) await checkBooks([id], { quiet: true }); else renderRoute({ keepScroll: true });
    } catch (e) { toast(e.message || '登録に失敗しました'); }
    return;
  }
  if (f.id === 'home-search' || f.id === 'search-form') {
    ev.preventDefault();
    const q = new FormData(f).get('q').toString().trim();
    extState = { q: null, items: null, error: null, busy: false };
    location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
    if (location.hash === `#/search?q=${encodeURIComponent(q)}`) renderRoute();
  }
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset?.labelSrc !== undefined) { labelUi.src = t.value; labelUi.sel = null; labelUi.result = null; renderRoute({ keepScroll: true }); return; }
  if (t.dataset?.labelPick) { if (t.checked) labelUi.sel.add(t.dataset.labelPick); else labelUi.sel.delete(t.dataset.labelPick); renderRoute({ keepScroll: true }); return; }
  if (t.name === 'label-mode') { labelUi.mode = t.value; return; }
  if (t.id === 'label-cut') { labelUi.cut = t.checked; return; }
  if (t.dataset?.filter) {
    state.settings.filters = { ...filters(), [t.dataset.filter]: t.value }; persist.settings();
    renderRoute({ keepScroll: true });
    return;
  }
  if (t.dataset?.lib) {
    const ids = $$('input[data-lib]:checked').map((i) => i.dataset.lib);
    if (!ids.length) { t.checked = true; toast('少なくとも1館を選んでください'); return; }
    state.settings.libs = ids; persist.settings(); syncPush(); toast('対象の図書館を変更しました');
  }
  if (t.id === 'mock-toggle') {
    state.settings.mock = t.checked; persist.settings(); loadAvail(); renderRoute(); toast(t.checked ? 'モックデータに切り替えました' : '実データに切り替えました');
    updateBanner();
  }
});

function toggleFav(id) {
  const b = getBook(id); if (!b) return;
  if (state.fav[id]) {
    delete state.fav[id]; toast('お気に入りを解除しました');
  } else {
    state.fav[id] = { bookId: id, addedAt: nowIso(), ...(b.isKumonRecommended ? {} : { book: { id: b.id, title: b.title, author: b.author, publisher: b.publisher, isbns: b.isbns || [], isKumonRecommended: false, authors: [], contributors: [] } }) };
    toast('お気に入りに追加しました');
    // 一度も確認していない本だけ、登録時にいまの状態を保存(これが「前回の状態」になる)。確認済みなら取り直さない
    if (!selectedLibs().some((l) => recOf(id, l.id))) checkBooks([id], { quiet: true });
  }
  persist.fav();
  $$(`[data-fav="${CSS.escape(id)}"]`).forEach((btn) => {
    const on = isFav(id);
    btn.setAttribute('aria-pressed', on);
    if (btn.classList.contains('fav-btn')) { btn.innerHTML = `${on ? '❤️' : '♡'}<span>${on ? '登録済' : 'お気に入り'}</span>`; btn.setAttribute('aria-label', on ? 'お気に入りを解除' : 'お気に入りに追加'); }
    else { btn.textContent = on ? '❤️ お気に入りを解除' : '♡ お気に入りに追加'; btn.classList.toggle('secondary', on); }
  });
  const r = parseRoute();
  if (r.name === 'favorites') renderRoute({ keepScroll: true });
  syncPush();
}

async function runExtSearch() {
  const q = parseRoute().q.get('q') || '';
  extState = { q, items: null, error: null, busy: true }; renderRoute({ keepScroll: true });
  try {
    const res = await api('/api/search?q=' + encodeURIComponent(q), { timeout: 30000 });
    const items = (res.items || []).filter((x) => !BOOK_BY_ID.has(x.id)).map((x) => ({ id: x.id, title: x.title, author: x.author, publisher: x.publisher, isbns: x.isbns, isKumonRecommended: false, authors: [], contributors: [] }));
    items.forEach((b) => EXT.set(b.id, b));
    extState = { q, items, error: null, busy: false };
  } catch (e) { extState = { q: null, items: null, error: `検索できませんでした(${e.message})`, busy: false }; }
  renderRoute({ keepScroll: true });
}

/* ================= バナー ================= */
function updateBanner() {
  const el = $('#mode-banner');
  if (useMock()) {
    el.className = 'mode-banner mock';
    el.innerHTML = `🧪 <b>モックモード</b>：表示中の在架状況は動作確認用の<b>仮データ</b>です。実際の図書館の状況ではありません。${HAS_BACKEND ? '' : '<br><small>実データ接続にはバックエンド(BACKEND_URL)の設定が必要です</small>'}`;
  } else { el.className = 'mode-banner live'; el.innerHTML = '🌐 実データ(カーリル図書館API)で確認しています'; }
  el.hidden = false;
}

/* ================= Web Push / 通知 ================= */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || (self.matchMedia && matchMedia('(display-mode: standalone)').matches);
let swReg = null;

function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function b64ToU8(b64) { const p = '='.repeat((4 - (b64.length % 4)) % 4); const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
async function sha256Hex(text) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }

async function getSub() { try { const reg = swReg || (await navigator.serviceWorker.ready); return await reg.pushManager.getSubscription(); } catch { return null; } }

async function updatePushUi() {
  const st = $('#push-status'), act = $('#push-actions');
  if (!st) return;
  let msg = '', btns = '';
  if (useMock()) msg = '🧪 モックモード中は、実際のプッシュ通知は送られません(アプリ内通知の動作確認のみ)。';
  else if (!HAS_BACKEND) msg = 'プッシュ通知にはバックエンドの設定(BACKEND_URL)が必要です。いまは「アプリ内通知」だけ使えます。';
  else if (!pushSupported()) msg = isIOS && !isStandalone()
    ? 'iPhoneでは、Safariの共有ボタンから「ホーム画面に追加」して、ホーム画面のアイコンから開くとプッシュ通知を使えます(iOS 16.4以降)。'
    : 'このブラウザはプッシュ通知に対応していません。「アプリ内通知」だけ使えます。';
  else {
    const sub = await getSub();
    if (sub && Notification.permission === 'granted') { msg = '✅ プッシュ通知は有効です。お気に入りが「貸出中→在架」になるとお知らせします。'; btns = '<button class="btn secondary small" id="push-disable">通知をオフにする</button>'; }
    else if (Notification.permission === 'denied') msg = '通知がブロックされています。端末の設定でこのアプリの通知を許可してください。';
    else if (isIOS && !isStandalone()) msg = 'iPhoneでは、ホーム画面に追加したアプリから開いて、通知をオンにしてください。';
    else { msg = '「貸出中→在架」をプッシュ通知で受け取れます(無料)。'; btns = '<button class="btn small" id="push-enable">🔔 プッシュ通知をオンにする</button>'; }
  }
  st.textContent = msg; act.innerHTML = btns;
}

async function enablePush() {
  try {
    const reg = swReg || (await navigator.serviceWorker.ready);
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('通知が許可されませんでした'); updatePushUi(); return; }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8((await api('/api/vapid-public-key', { timeout: 15000 })).key) });
    state.settings.pushOn = true; persist.settings();
    await syncPush(true);
    toast('プッシュ通知をオンにしました');
  } catch (e) { toast('通知をオンにできませんでした: ' + e.message); }
  updatePushUi();
}
async function disablePush() {
  try {
    const sub = await getSub();
    if (sub) { const h = await sha256Hex(sub.endpoint); try { await api('/api/unsubscribe', { method: 'POST', body: { sub: h }, timeout: 15000 }); } catch { /* noop */ } await sub.unsubscribe(); }
    state.settings.pushOn = false; persist.settings(); toast('プッシュ通知をオフにしました');
  } catch (e) { toast('オフにできませんでした: ' + e.message); }
  updatePushUi();
}
let syncTimer;
function syncPush(now = false) {
  clearTimeout(syncTimer);
  const run = async () => {
    if (!HAS_BACKEND || useMock() || !state.settings.pushOn || !pushSupported() || Notification.permission !== 'granted') return;
    const sub = await getSub(); if (!sub) return;
    const favorites = Object.values(state.fav).map((f) => { const b = getBook(f.bookId); return { id: f.bookId, title: b?.title || '', isbns: BOOK_BY_ID.has(f.bookId) ? undefined : (b?.isbns || []) }; });
    try { await api('/api/sync', { method: 'POST', body: { subscription: { endpoint: sub.endpoint }, favorites, libs: selectedLibs().map((l) => l.id) }, timeout: 20000 }); } catch { /* 次回また同期 */ }
  };
  if (now) return run();
  syncTimer = setTimeout(run, 800);
}
/** サーバーが積んだ通知(プッシュ受信時に取り損ねた分)を取り込む */
async function pullServerNotifications() {
  if (!HAS_BACKEND || useMock() || !pushSupported() || Notification.permission !== 'granted') return;
  const sub = await getSub(); if (!sub) return;
  try {
    const res = await api('/api/notifications/pull', { method: 'POST', body: { sub: await sha256Hex(sub.endpoint) }, timeout: 15000 });
    (res.messages || []).forEach((m) => addNotification({ id: m.id, bookId: m.bookId, libId: m.libId, title: m.title, body: m.body, at: m.at, source: 'calil' }));
  } catch { /* noop */ }
}
async function pingBackend() {
  const el = $('#be-status'); if (!el) return;
  try { const h = await api('/api/health', { timeout: 10000 }); el.textContent = h.config?.calilKey ? '接続OK' : '接続OK(APIキー未設定)'; }
  catch (e) { el.textContent = '接続できません(' + e.message + ')'; }
}

/* ================= 起動 ================= */
async function loadData() {
  let d = null;
  // 公開(http/https)時は JSON を直接読む → books.json / libraries.json を編集するだけで反映される(data.js の再生成は不要)
  if (/^https?:$/.test(location.protocol)) {
    try {
      const [books, libraries] = await Promise.all([fetch('books.json').then((r) => r.json()), fetch('libraries.json').then((r) => r.json())]);
      d = { books, libraries };
    } catch { d = null; }
  }
  // index.html を直接開いたとき(file://)や読み込み失敗時は data.js を使う
  if (!d) d = self.APP_DATA;
  if (!d) throw new Error('data');
  BOOKS = d.books.books;
  for (const b of BOOKS) if (b.isbn && !b.isbns) b.isbns = [].concat(b.isbn);   // bake で保存済みのISBN
  LIBS = d.libraries.libraries; PROVIDER = d.libraries.provider || {};
  BOOKS.forEach((b) => { b._n = norm([b.title, b.searchTitle, b.author, (b.contributors || []).join(' '), b.publisher].join(' ')); });
  BOOK_BY_ID = new Map(BOOKS.map((b) => [b.id, b]));
  LEVELS = [...new Set(BOOKS.map((b) => b.level))];
}

async function boot() {
  try { await loadData(); } catch (e) { $('#view').innerHTML = '<p class="empty">データを読み込めませんでした。</p>'; return; }
  Object.values(state.custom).forEach((c) => { if (!BOOK_BY_ID.has(c.book.id)) EXT.set(c.book.id, { ...c.book, customLevel: c.level }); });
  loadAvail(); updateBanner(); updateBell();
  $('#attribution').innerHTML = `くもんのすいせん図書 2026年度版(公文教育研究会)の掲載図書より作成 ／ 蔵書情報: <a href="${esc(CFG.ATTRIBUTION?.url || 'https://calil.jp/')}" target="_blank" rel="noopener">${esc(CFG.ATTRIBUTION?.name || 'カーリル図書館API')}</a><br><small>画面の版: ${esc(APP_VERSION)}</small>`;
  window.addEventListener('hashchange', () => renderRoute());
  renderRoute();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pullServerNotifications(); });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    try { swReg = await navigator.serviceWorker.register('service-worker.js'); } catch { /* 登録できなくてもアプリは動く */ }
    pullServerNotifications();
    navigator.serviceWorker.addEventListener?.('message', (ev) => { if (ev.data?.type === 'pull') pullServerNotifications(); });
  }
  // 開発・動作確認用の入り口(コンソールから状態を確認できる)
  self.KL = { state, applyRecord, mockRecord, checkBooks, store, STATUS, mode, useMock };
}
boot();
})();
