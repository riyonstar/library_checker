// くもんの推薦図書の「ISBN」と「表紙画像」を、一度だけ集めて、リポジトリに保存するスクリプト。
// GitHub Actions の「bake」から実行します(インターネットに出られるため)。
//   - ISBN: 国立国会図書館サーチ(日本語版=978-4 だけ採用)→ books.json の isbn に書き込む
//   - 表紙: openBD → 国立国会図書館 → Amazon → Google ブックス(「画像なし」の灰色の絵は除外)→ covers/<id>.jpg
// すでに集めた本は飛ばします。何度実行しても安全です(足りない本だけ再挑戦)。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pickIsbns, parseNdlOpenSearch, toIsbn13, normText } from './worker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash('sha1').update(buf).digest('hex');
const UA = { 'User-Agent': 'kita-library-checker-bake/1.0 (personal use)' };
const DEADLINE = Date.now() + (Number(process.env.BAKE_MINUTES) || 100) * 60 * 1000;

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { console.log('(sharp なし: 画像は加工せず保存します)'); }

async function get(url, { retries = 4, text = false, json = false, ms = 20000 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
      const r = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' }); clearTimeout(t);
      if (r.status === 429 || r.status >= 500) { await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) return null;
      if (text) return await r.text();
      if (json) return await r.json();
      return Buffer.from(await r.arrayBuffer());
    } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}

function isbn10(i13) {
  if (!/^978\d{10}$/.test(i13)) return null;
  const core = i13.slice(3, 12); let s = 0;
  for (let i = 0; i < 9; i++) s += Number(core[i]) * (10 - i);
  const c = (11 - (s % 11)) % 11; return core + (c === 10 ? 'X' : String(c));
}

/* ---------- ISBN ---------- */
async function ndl(params, cnt) {
  const u = new URL('https://ndlsearch.ndl.go.jp/api/opensearch');
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  u.searchParams.set('cnt', String(cnt));
  await sleep(1100);
  const x = await get(u.toString(), { text: true, retries: 6 });
  return x == null ? null : parseNdlOpenSearch(x);
}
async function findIsbns(book) {
  const first = book.authors?.find((a) => !a.role)?.name || book.authors?.[0]?.name || '';
  const title = book.searchTitle || book.title;
  const attempts = first
    ? [[{ title, creator: first, publisher: book.publisher }, 30], [{ title, publisher: book.publisher }, 100], [{ title }, 100]]
    : [[{ title, publisher: book.publisher }, 100], [{ title }, 100]];
  for (const [p, cnt] of attempts) {
    const items = await ndl(p, cnt);
    if (items == null) return null;       // 通信できなかった(今回は判断しない)
    const got = pickIsbns(book, items).filter((i) => !englishIsbns.has(i));
    if (got.length) return got;
  }
  return [];
}

/* ---------- ISBN(2段目): Google ブックスで、書名・著者・出版社が合う日本語の本を探す ---------- */
const englishIsbns = new Set();
let googleDead = 0;
async function googleFind(book) {
  if (googleDead >= 5) return null;
  const title = String(book.searchTitle || book.title).replace(/[（(]\d+冊[）)]/g, '').trim();
  const au = String(book.author || '').split(/[ 　・（(、,]/)[0];
  const q = `intitle:${title}` + (au ? `+inauthor:${au}` : '');
  await sleep(1200);
  const j = await get('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q).replace(/%2B/g, '+') + '&langRestrict=ja&printType=books&maxResults=20', { json: true, retries: 2 });
  if (!j) { googleDead++; return null; }
  googleDead = 0;
  const tq = normText(title), aq = normText(au);
  const stripPub = (x) => normText(x).replace(/株式会社|有限会社|出版部|出版社|出版|発行所|発行/g, '');
  const pq = stripPub(book.publisher || '');
  const isbns = []; let thumb = null;
  for (const it of (j.items || [])) {
    const v = it.volumeInfo || {};
    if (v.language && v.language !== 'ja') continue;
    const t = normText(v.title || '');
    if (!(t === tq || (t.startsWith(tq) && /^[0-9一二三四五六七八九十上中下巻第]+$/.test(t.slice(tq.length))))) continue;
    const np = stripPub(v.publisher || '');
    const hit = (aq.length >= 2 && (v.authors || []).some((a) => normText(a).includes(aq))) || (pq.length >= 2 && np.length >= 2 && (np.includes(pq) || pq.includes(np)));
    if (!hit) continue;
    for (const idf of (v.industryIdentifiers || [])) { const x = toIsbn13(idf.identifier); if (x && /^9784/.test(x) && !isbns.includes(x) && !englishIsbns.has(x)) isbns.push(x); }
    if (!thumb && v.imageLinks && v.imageLinks.thumbnail) thumb = v.imageLinks.thumbnail.replace(/^http:/, 'https:');
  }
  return { isbns: isbns.slice(0, 4), thumb };
}
async function fromUrl(url) {
  const buf = await get(url, { retries: 1 });
  if (!buf || buf.length < 800) return null;
  if (sharp) { try { const m = await sharp(buf).metadata(); if (Math.min(m.width, m.height) < 100) return null; return await sharp(buf).resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 82 }).toBuffer(); } catch { return null; } }
  return buf[0] === 0xff && buf[1] === 0xd8 ? buf : null;
}

/* ---------- 表紙 ---------- */
const gUrl = (isbn, z) => `https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=${z}`;
const phRef = {};
async function placeholder(z) {
  if (!(z in phRef)) { const b = await get(gUrl('0000000000', z), { retries: 1 }); phRef[z] = b ? sha(b) : null; }
  return phRef[z];
}
async function candidates(isbn) {
  const list = [];
  const j = await get('https://api.openbd.jp/v1/get?isbn=' + isbn, { json: true, retries: 1 });
  const c = j && j[0] && j[0].summary && j[0].summary.cover; if (c) list.push([c, 0]);
  list.push([`https://cover.openbd.jp/${isbn}.jpg`, 0], [`https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg`, 0]);
  const a = isbn10(isbn); if (a) list.push([`https://images-na.ssl-images-amazon.com/images/P/${a}.09.LZZZZZZZ.jpg`, 0], [`https://m.media-amazon.com/images/P/${a}.09.LZZZZZZZ.jpg`, 0]);
  for (const z of [3, 2, 1]) list.push([gUrl(isbn, z), z]);
  return list;
}
const badCovers = new Set();   // 「画像なし」など、複数の本で同じになってしまう画像(sha1)
async function coverFor(isbns) {
  for (const isbn of isbns.slice(0, 3)) {
    for (const [url, z] of await candidates(isbn)) {
      await sleep(250);
      const buf = await get(url, { retries: 1 });
      if (!buf || buf.length < 800) continue;
      if (z && sha(buf) === await placeholder(z)) continue;      // Google の「画像なし」
      if (sharp) {
        try {
          const m = await sharp(buf).metadata();
          if (Math.min(m.width, m.height) < 100) continue;
          const out = await sharp(buf).rotate().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 82 }).toBuffer();
          if (badCovers.has(sha(out))) continue;
          return out;
        } catch { continue; }
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && !badCovers.has(sha(buf))) return buf;       // sharp なし: JPEG のみ採用
    }
  }
  return null;
}

/* ---------- 本体 ---------- */
export async function main() {
  const file = new URL('./books.json', import.meta.url);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(new URL('./covers/', import.meta.url), { recursive: true });
  // 手入力のISBN(任意): manual-isbn.json に { "本のID": "ISBN" } の形で書くと、最優先で使う
  const mf = new URL('./manual-isbn.json', import.meta.url);
  const manualNote = [];
  if (existsSync(mf)) {
    const man = JSON.parse(readFileSync(mf, 'utf8'));
    for (const b of data.books) {
      if (!man[b.id]) continue;
      const l = [].concat(man[b.id]).map(toIsbn13).filter(Boolean);
      if (!l.length) continue;
      // 取り違え防止: openBD に載っていれば、書名か出版社のどちらかは合っているか確認する(両方違えば採用しない)
      const j = await get('https://api.openbd.jp/v1/get?isbn=' + l[0], { json: true, retries: 1 });
      const sm = j && j[0] && j[0].summary;
      if (sm) {
        const t = normText(String(b.searchTitle || b.title).replace(/[（(]\d+冊[）)]/g, '')), ot = normText(sm.title || '');
        const titleOk = ot.includes(t) || (ot.length >= 2 && t.includes(ot));
        const pq = normText(b.publisher || '').replace(/出版|株式会社/g, ''), op = normText(sm.publisher || '').replace(/出版|株式会社/g, '');
        const pubOk = pq.length >= 2 && op.length >= 2 && (op.includes(pq) || pq.includes(op));
        if (!titleOk && !pubOk) { manualNote.push(`${b.id}\t${b.title}\t手入力 ${l[0]} は openBD の「${sm.title}(${sm.publisher})」と合わないため不採用`); continue; }
      } else manualNote.push(`${b.id}\t${b.title}\t手入力 ${l[0]} は openBD に載っていないため、確認できないまま採用`);
      b.isbn = l.length === 1 ? l[0] : l;
    }
  }
  // (1) 同じ画像が4冊以上で使われていたら「画像なし」などの代わりの絵とみなし、削除してやり直す
  const byHash = new Map();
  for (const f of readdirSync(new URL('./covers/', import.meta.url))) {
    if (!f.endsWith('.jpg')) continue;
    const h = sha(readFileSync(new URL('./covers/' + f, import.meta.url)));
    (byHash.get(h) || byHash.set(h, []).get(h)).push(f);
  }
  let removedPh = 0;
  for (const [h, files] of byHash) if (files.length >= 4) {
    badCovers.add(h);
    for (const f of files) { unlinkSync(new URL('./covers/' + f, import.meta.url)); removedPh++; }
  }
  if (removedPh) { for (const b of data.books) if (b.cover && !existsSync(new URL('./' + b.cover, import.meta.url))) delete b.cover; console.log(`代わりの絵と思われる画像を ${removedPh} 枚削除しました(取り直します)`); }
  // (2) 英語版(英語でたのしむ福音館の絵本 など)のISBNを除く: openBD の書名に英単語があり、本の書名にはない場合
  const manualIds = existsSync(mf) ? new Set(Object.keys(JSON.parse(readFileSync(mf, 'utf8')))) : new Set();
  const allIsbns = [...new Set(data.books.filter((b) => !manualIds.has(b.id)).flatMap((b) => [].concat(b.isbn || []).map(toIsbn13).filter(Boolean)))];
  const ob = new Map();
  for (let i = 0; i < allIsbns.length; i += 50) {
    const j = await get('https://api.openbd.jp/v1/get?isbn=' + allIsbns.slice(i, i + 50).join(','), { json: true, retries: 2, ms: 30000 });
    (j || []).forEach((x) => { if (x && x.summary) ob.set(x.summary.isbn, x); });
    await sleep(300);
  }
  const latin = /[A-Za-z]{3,}/;
  let droppedEn = 0;
  for (const b of data.books) {
    if (manualIds.has(b.id) || !b.isbn) continue;
    const old = [].concat(b.isbn).map(toIsbn13).filter(Boolean);
    const keep = old.filter((i) => { const x = ob.get(i); if (!x) return true; const en = latin.test(x.summary.title || '') && !latin.test(b.title); if (en) { englishIsbns.add(i); } return !en; });
    if (keep.length !== old.length) {
      droppedEn += old.length - keep.length;
      if (keep.length) b.isbn = keep.length === 1 ? keep[0] : keep; else b.isbn = null;
      const p = new URL(`./covers/${b.id}.jpg`, import.meta.url);
      if (existsSync(p)) unlinkSync(p);
      delete b.cover;
    }
  }
  if (droppedEn) console.log(`英語版と思われる ISBN を ${droppedEn} 件除きました(表紙を取り直します)`);
  const missingIsbn = [], missingCover = [];
  let n = 0;
  for (const b of data.books) {
    if (Date.now() > DEADLINE) { console.log('時間切れ: ここまでを保存します。もう一度実行すると続きから集めます。'); break; }
    const path = new URL(`./covers/${b.id}.jpg`, import.meta.url);
    const have = existsSync(path);
    let isbns = (Array.isArray(b.isbn) ? b.isbn : [b.isbn]).map(toIsbn13).filter(Boolean);
    if (!isbns.length) {
      const got = await findIsbns(b);
      if (got && got.length) { b.isbn = got.length === 1 ? got[0] : got; isbns = got; }
    }
    let thumb = null;
    if (!isbns.length) {
      const g = await googleFind(b);
      if (g) { thumb = g.thumb; if (g.isbns.length) { b.isbn = g.isbns.length === 1 ? g.isbns[0] : g.isbns; isbns = g.isbns; } }
    }
    if (!isbns.length && thumb && !have) {      // ISBNは分からないが、Google に表紙はある
      const img = await fromUrl(thumb);
      if (img) { writeFileSync(path, img); b.cover = `covers/${b.id}.jpg`; }
    }
    if (!isbns.length) missingIsbn.push(b);
    if (isbns.length && !have) {
      const img = await coverFor(isbns);
      if (img) { writeFileSync(path, img); b.cover = `covers/${b.id}.jpg`; }
      else missingCover.push(b);
    } else if (have) b.cover = `covers/${b.id}.jpg`;
    if (++n % 25 === 0) { writeFileSync(file, JSON.stringify(data, null, 1) + '\n'); console.log(`${n}/${data.books.length} 冊処理`); }
  }
  writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
  const lines = [
    `集計: 全${data.books.length}冊 / ISBNあり ${data.books.filter((b) => b.isbn).length} / 表紙あり ${data.books.filter((b) => b.cover).length}`,
    '', '【手入力ISBNの確認結果(問題があるものだけ)】', ...manualNote,
    '', '【ISBNが分からなかった本】', ...missingIsbn.map((b) => `${b.id}\t${b.title}\t${b.publisher || ''}`),
    '', '【ISBNは分かったが表紙が見つからなかった本】', ...missingCover.map((b) => `${b.id}\t${b.title}\t${[].concat(b.isbn).join(',')}`),
  ];
  writeFileSync(new URL('./bake-report.txt', import.meta.url), lines.join('\n') + '\n');
  console.log(lines[0]);
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) await main();
