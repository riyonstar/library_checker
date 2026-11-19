// くもんの推薦図書の「ISBN」と「表紙画像」を、一度だけ集めて、リポジトリに保存するスクリプト。
// GitHub Actions の「bake」から実行します(インターネットに出られるため)。
//   - ISBN: 国立国会図書館サーチ(日本語版=978-4 だけ採用)→ books.json の isbn に書き込む
//   - 表紙: openBD → 国立国会図書館 → Amazon → Google ブックス(「画像なし」の灰色の絵は除外)→ covers/<id>.jpg
// すでに集めた本は飛ばします。何度実行しても安全です(足りない本だけ再挑戦)。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pickIsbns, parseNdlOpenSearch, toIsbn13 } from './worker.js';

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
    const got = pickIsbns(book, items);
    if (got.length) return got;
  }
  return [];
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
          return await sharp(buf).rotate().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 82 }).toBuffer();
        } catch { continue; }
      }
      if (buf[0] === 0xff && buf[1] === 0xd8) return buf;       // sharp なし: JPEG のみ採用
    }
  }
  return null;
}

/* ---------- 本体 ---------- */
export async function main() {
  const file = new URL('./books.json', import.meta.url);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(new URL('./covers/', import.meta.url), { recursive: true });
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
    '', '【ISBNが分からなかった本】', ...missingIsbn.map((b) => `${b.id}\t${b.title}\t${b.publisher || ''}`),
    '', '【ISBNは分かったが表紙が見つからなかった本】', ...missingCover.map((b) => `${b.id}\t${b.title}\t${[].concat(b.isbn).join(',')}`),
  ];
  writeFileSync(new URL('./bake-report.txt', import.meta.url), lines.join('\n') + '\n');
  console.log(lines[0]);
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) await main();
