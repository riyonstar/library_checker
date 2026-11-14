// バックエンド(worker.js)の単体テスト。 実行: node test-worker.mjs
// ネットワークには一切出ません(fetch / KV はモック)。
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as W from './worker.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  -', name); }
  catch (e) { fail++; console.log('  NG  -', name, '\n      ', e.message); }
}

const libs = JSON.parse(readFileSync(new URL('./libraries.json', import.meta.url))).libraries.filter((l) => l.enabled);
const chuo = libs.find((l) => l.id === 'kita-chuo');
const higashi = libs.find((l) => l.id === 'kita-higashijujo');
const books = JSON.parse(readFileSync(new URL('./books.json', import.meta.url))).books;

class MemKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = '' } = {}) { return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }
}

console.log('■ 状態マッピング');
await t('貸出可→在架', () => assert.equal(W.mapCalilStatus('貸出可').status, 'available'));
await t('貸出中→貸出中', () => assert.equal(W.mapCalilStatus('貸出中').status, 'lent'));
await t('予約中→貸出中(取り置き)', () => assert.equal(W.mapCalilStatus('予約中').status, 'lent'));
for (const v of ['館内のみ', '蔵書あり', '準備中', '休館中', '行方不明', '']) {
  await t(`「${v}」→不明(貸出中にしない)`, () => assert.equal(W.mapCalilStatus(v).status, 'unknown'));
}

console.log('■ 1冊×1館の判定(通信失敗を貸出中にしない)');
const learned = new Set(['中央', '東十条']);
await t('在架', () => assert.equal(W.resolveForLibrary([{ status: 'OK', libkey: { 中央: '貸出可', 東十条: '貸出中' } }], chuo, learned).status, 'available'));
await t('貸出中', () => assert.equal(W.resolveForLibrary([{ status: 'OK', libkey: { 中央: '貸出可', 東十条: '貸出中' } }], higashi, learned).status, 'lent'));
await t('Error は不明', () => assert.equal(W.resolveForLibrary([{ status: 'Error', libkey: {} }], chuo, learned).status, 'unknown'));
await t('Running(未完了)は不明', () => assert.equal(W.resolveForLibrary([{ status: 'Running', libkey: {} }], chuo, learned).status, 'unknown'));
await t('ISBNなしは不明', () => assert.equal(W.resolveForLibrary([], chuo, learned).status, 'unknown'));
await t('複数ISBN: 片方貸出中・片方在架 → 在架', () => assert.equal(W.resolveForLibrary([{ status: 'OK', libkey: { 中央: '貸出中' } }, { status: 'OK', libkey: { 中央: '貸出可' } }], chuo, learned).status, 'available'));
await t('複数ISBN: 貸出中+片方がError → 貸出中と断言せず不明', () => assert.equal(W.resolveForLibrary([{ status: 'OK', libkey: { 中央: '貸出中' } }, { status: 'Error', libkey: {} }], chuo, learned).status, 'unknown'));
await t('蔵書なし(館キー学習済み)は不明+owned=false', () => {
  const r = W.resolveForLibrary([{ status: 'OK', libkey: { 東十条: '貸出可' } }], chuo, learned);
  assert.equal(r.status, 'unknown'); assert.equal(r.owned, false);
});
await t('館キー未学習のとき「蔵書なし」と断言しない', () => {
  const r = W.resolveForLibrary([{ status: 'OK', libkey: { 別館: '貸出可' } }], chuo, new Set());
  assert.equal(r.status, 'unknown'); assert.equal(r.code, 'unmatched');
});

console.log('■ 状態変化の検知(貸出中→在架だけ)');
await t('lent→available で通知', () => assert.equal(W.detectTransition({ lastKnown: 'lent' }, 'available').notify, true));
await t('available→available は通知しない', () => assert.equal(W.detectTransition({ lastKnown: 'available' }, 'available').notify, false));
await t('初回の在架は通知しない', () => assert.equal(W.detectTransition(null, 'available').notify, false));
await t('lent→unknown→available でも通知(unknownで状態を上書きしない)', () => {
  let r = W.detectTransition({ lastKnown: 'lent' }, 'unknown');
  assert.equal(r.notify, false); assert.equal(r.next.lastKnown, 'lent');
  r = W.detectTransition(r.next, 'available');
  assert.equal(r.notify, true);
});
await t('available→unknown→available は通知しない', () => {
  let r = W.detectTransition({ lastKnown: 'available' }, 'unknown');
  r = W.detectTransition(r.next, 'available');
  assert.equal(r.notify, false);
});
await t('在架のまま繰り返しても再通知しない / 在架→貸出中→在架で再通知', () => {
  let s = { lastKnown: 'lent' };
  let r = W.detectTransition(s, 'available'); assert.equal(r.notify, true); s = r.next;
  r = W.detectTransition(s, 'available'); assert.equal(r.notify, false); s = r.next;
  r = W.detectTransition(s, 'lent'); assert.equal(r.notify, false); s = r.next;
  r = W.detectTransition(s, 'available'); assert.equal(r.notify, true);
});

console.log('■ ISBN / NDL パーサ');
await t('ISBN10→13変換', () => assert.equal(W.toIsbn13('4834000826'), '9784834000825'));
await t('ISBN13そのまま・ハイフン除去', () => assert.equal(W.toIsbn13('978-4-8340-0082-5'), '9784834000825'));
await t('不正ISBNはnull', () => assert.equal(W.toIsbn13('abc'), null));
const sampleXml = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><channel>
<item><title>ぐりとぐら</title><dc:creator>なかがわ りえこ 大村 百合子</dc:creator><dc:publisher>福音館書店</dc:publisher><dc:identifier xsi:type="dcndl:ISBN">9784834000825</dc:identifier></item>
<item><title>ぐりとぐらのおきゃくさま</title><dc:creator>なかがわ りえこ</dc:creator><dc:publisher>福音館書店</dc:publisher><dc:identifier xsi:type="dcndl:ISBN">9784834000818</dc:identifier></item>
<item><title>ぐりとぐら (こどものとも傑作集)</title><dc:creator>中川 李枝子</dc:creator><dc:publisher>福音館書店</dc:publisher><dc:identifier xsi:type="dcndl:ISBN">4-8340-0082-6</dc:identifier></item>
<item><title>ぐりとぐら</title><dc:creator>別の人</dc:creator><dc:publisher>別の出版社</dc:publisher><dc:identifier xsi:type="dcndl:ISBN">9780000000002</dc:identifier></item>
</channel></rss>`;
await t('RSSをパースできる', () => { const it = W.parseNdlOpenSearch(sampleXml); assert.equal(it.length, 4); assert.equal(it[0].isbns[0], '9784834000825'); });
await t('書名+出版社が合う版だけ拾う(別の本・無関係な版は除外)', () => {
  const book = books.find((b) => b.title === 'ぐりとぐら');
  const ids = W.pickIsbns(book, W.parseNdlOpenSearch(sampleXml));
  assert.ok(ids.includes('9784834000825'), JSON.stringify(ids));
  assert.ok(!ids.includes('9784834000818'), 'おきゃくさまを含めてはいけない');
  assert.ok(!ids.includes('9780000000002'));
});

console.log('■ VAPID(Web Push署名)');
await t('JWTがES256で正しく署名される(公開鍵で検証)', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pubRaw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const env = { VAPID_PUBLIC_KEY: pubRaw.toString('base64url'), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: 'mailto:test@example.com' };
  const jwt = await W.vapidJwt(env, 'https://web.push.apple.com', 1_700_000_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com'); assert.equal(claims.sub, 'mailto:test@example.com');
  const ok = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});

console.log('■ VAPID鍵の自動生成(秘密鍵はKVにだけ保存)');
await t('初回に生成→KVに保存→2回目は同じ鍵・公開鍵APIから取得できる・環境変数不要', async () => {
  const env = { KV: new MemKV(), ALLOWED_ORIGIN: 'https://me.github.io' };
  const ctx = { env };
  assert.equal(await W.getVapid(ctx, { create: false }), null);
  const a = await W.getVapid(ctx);
  const b = await W.getVapid(ctx);
  assert.equal(a.pub, b.pub); assert.equal(a.priv, b.priv);
  assert.equal(W.b64urlDecode(a.pub).length, 65);
  const jwt = await W.vapidJwt({ VAPID_PUBLIC_KEY: a.pub, VAPID_PRIVATE_KEY: a.priv }, 'https://web.push.apple.com');
  assert.equal(jwt.split('.').length, 3);
  const res = await W.route(new Request('https://w.example/api/vapid-public-key', { headers: { Origin: 'https://me.github.io' } }), env, {});
  assert.equal((await res.json()).key, a.pub);
  const h = await (await W.route(new Request('https://w.example/api/health'), { ...env, BOOKS_URL: 'x', LIBRARIES_URL: 'x' }, {})).json();
  assert.equal(h.config.vapid, true);
  assert.ok(!JSON.stringify(h).includes(a.priv), '秘密鍵が応答に含まれてはいけない');
});

console.log('■ API(カーリルをモックして end-to-end)');
function makeEnv(extra = {}) {
  return { KV: new MemKV(), CALIL_APPKEY: 'SECRET_KEY_123', ALLOWED_ORIGIN: 'https://me.github.io', BOOKS_URL: 'https://x/books.json', LIBRARIES_URL: 'https://x/libraries.json', ...extra };
}
function fakeFetch(handlers, log = []) {
  return async (url, opts) => {
    log.push(String(url));
    for (const [re, fn] of handlers) if (re.test(String(url))) return fn(String(url), opts);
    return new Response('not found', { status: 404 });
  };
}
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status });
const staticHandlers = () => [
  [/x\/books\.json/, () => jres(JSON.parse(readFileSync(new URL('./books.json', import.meta.url))))],
  [/x\/libraries\.json/, () => jres(JSON.parse(readFileSync(new URL('./libraries.json', import.meta.url))))],
];
const noSleep = async () => {};
const post = (path, body, origin = 'https://me.github.io') => new Request('https://w.example' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });

await t('CORS: 許可オリジンだけ許可', async () => {
  const env = makeEnv();
  const ok = await W.route(new Request('https://w.example/api/health', { headers: { Origin: 'https://me.github.io' } }), env, { fetch: fakeFetch(staticHandlers()), sleep: noSleep });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://me.github.io');
  const ng = await W.route(new Request('https://w.example/api/health', { headers: { Origin: 'https://evil.example' } }), env, { fetch: fakeFetch(staticHandlers()), sleep: noSleep });
  assert.equal(ng.headers.get('Access-Control-Allow-Origin'), null);
});

await t('在架/貸出中の取得 + APIキーが応答・エラーに出ない + ポーリング', async () => {
  const env = makeEnv();
  const log = [];
  let polled = 0;
  const handlers = [
    ...staticHandlers(),
    [/ndlsearch/, () => new Response(sampleXml)],
    [/api\.calil\.jp\/check\?appkey=.*isbn=/, () => jres({ session: 'S1', continue: 1, books: { 9784834000825: { Tokyo_Kita: { status: 'Running', libkey: {} } } } })],
    [/api\.calil\.jp\/check\?appkey=.*session=S1/, () => { polled++; return jres({ session: 'S1', continue: 0, books: { 9784834000825: { Tokyo_Kita: { status: 'OK', libkey: { 中央: '貸出可', 東十条: '貸出中' } } } } }); }],
  ];
  const res = await W.route(post('/api/availability', { items: [{ id: 'k-2A-01' }] }), env, { fetch: fakeFetch(handlers, log), sleep: noSleep });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const r = body.results['k-2A-01'];
  assert.equal(r['kita-chuo'].status, 'available');
  assert.equal(r['kita-higashijujo'].status, 'lent');
  assert.equal(polled, 1);
  assert.ok(!JSON.stringify(body).includes('SECRET_KEY_123'));
  assert.ok(r['kita-chuo'].checkedAt);
});

await t('上流が落ちたら必ず不明(貸出中にしない)・エラーにキーが出ない', async () => {
  const env = makeEnv();
  const handlers = [...staticHandlers(), [/push\.example/, () => new Response(null, { status: 201 })], [/ndlsearch/, () => new Response(sampleXml)], [/api\.calil\.jp/, () => new Response('boom', { status: 503 })]];
  const res = await W.route(post('/api/availability', { items: [{ id: 'k-2A-01' }], fresh: true }), env, { fetch: fakeFetch(handlers), sleep: noSleep });
  const body = await res.json();
  for (const lib of ['kita-chuo', 'kita-higashijujo']) {
    assert.equal(body.results['k-2A-01'][lib].status, 'unknown');
    assert.equal(body.results['k-2A-01'][lib].error, 'upstream');
  }
  assert.ok(!JSON.stringify(body).includes('SECRET_KEY_123'));
});

await t('APIキー未設定でも内部情報を漏らさず不明を返す/エラー応答', async () => {
  const env = makeEnv({ CALIL_APPKEY: '' });
  const handlers = [...staticHandlers(), [/ndlsearch/, () => new Response(sampleXml)]];
  const res = await W.route(post('/api/availability', { items: [{ id: 'k-2A-01' }] }), env, { fetch: fakeFetch(handlers), sleep: noSleep });
  const body = await res.json();
  assert.equal(body.results['k-2A-01']['kita-chuo'].status, 'unknown');
  assert.equal(body.results['k-2A-01']['kita-chuo'].error, 'no_key');
});

await t('ISBN未解決の本は不明(ISBN不明)', async () => {
  const env = makeEnv();
  const handlers = [...staticHandlers(), [/ndlsearch/, () => new Response('<rss><channel></channel></rss>')], [/api\.calil\.jp/, () => jres({ continue: 0, books: {} })]];
  const res = await W.route(post('/api/availability', { items: [{ id: 'k-2A-01' }] }), env, { fetch: fakeFetch(handlers), sleep: noSleep });
  const body = await res.json();
  assert.equal(body.results['k-2A-01']['kita-chuo'].status, 'unknown');
  assert.equal(body.results['k-2A-01']['kita-chuo'].error, 'no_isbn');
});

await t('定期チェック: 貸出中→在架を1回だけ通知し、在架のままなら再通知しない/ 在架→貸出中→在架で再通知', async () => {
  const env = makeEnv({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' });
  // 購読を登録
  const syncRes = await W.route(post('/api/sync', { subscription: { endpoint: 'https://push.example/abc' }, favorites: [{ id: 'k-2A-01', title: 'ぐりとぐら', isbns: [] }], libs: ['kita-chuo'] }), env, { fetch: fakeFetch(staticHandlers()), sleep: noSleep });
  const sync = await syncRes.json();
  assert.equal(sync.ok, true);
  let state = '貸出中';
  const handlers = () => [
    ...staticHandlers(), [/push\.example/, () => new Response(null, { status: 201 })], [/ndlsearch/, () => new Response(sampleXml)],
    [/api\.calil\.jp\/check/, () => jres({ continue: 0, books: { 9784834000825: { Tokyo_Kita: { status: 'OK', libkey: { 中央: state, 東十条: '貸出中' } } } } })],
  ];
  const run = async (s) => { state = s; const ctx = { env, fetch: fakeFetch(handlers()), sleep: noSleep, budget: { left: 40, use() { if (this.left-- <= 0) throw new Error('budget'); } } }; return W.runScheduled(ctx); };
  let r = await run('貸出中'); assert.equal(r.transitions, 0);
  r = await run('貸出可'); assert.equal(r.transitions, 1);
  r = await run('貸出可'); assert.equal(r.transitions, 0, '在架のままなら再通知しない');
  r = await run('貸出中'); assert.equal(r.transitions, 0);
  r = await run('貸出可'); assert.equal(r.transitions, 1, '在架→貸出中→在架 で再通知');
  const pull = await (await W.route(post('/api/notifications/pull', { sub: sync.sub }), env, { fetch: fakeFetch(staticHandlers()), sleep: noSleep })).json();
  assert.equal(pull.messages.length, 2);
  assert.ok(pull.messages[0].body.includes('ぐりとぐら') && pull.messages[0].body.includes('北区中央図書館'));
  const pull2 = await (await W.route(post('/api/notifications/pull', { sub: sync.sub }), env, { fetch: fakeFetch(staticHandlers()), sleep: noSleep })).json();
  assert.equal(pull2.messages.length, 0, '取得後はクリアされる');
});

await t('定期チェック中に通信失敗(不明)が挟まっても誤通知・誤状態化しない', async () => {
  const env = makeEnv();
  await W.route(post('/api/sync', { subscription: { endpoint: 'https://push.example/zzz' }, favorites: [{ id: 'k-2A-01', title: 'ぐりとぐら' }], libs: ['kita-chuo'] }), env, { fetch: fakeFetch(staticHandlers()), sleep: noSleep });
  let mode = 'lent';
  const handlers = () => [
    ...staticHandlers(), [/push\.example/, () => new Response(null, { status: 201 })], [/ndlsearch/, () => new Response(sampleXml)],
    [/api\.calil\.jp\/check/, () => mode === 'down' ? new Response('x', { status: 500 }) : jres({ continue: 0, books: { 9784834000825: { Tokyo_Kita: { status: 'OK', libkey: { 中央: mode === 'lent' ? '貸出中' : '貸出可' } } } } })],
  ];
  const run = async () => W.runScheduled({ env, fetch: fakeFetch(handlers()), sleep: noSleep, budget: { left: 40, use() { if (this.left-- <= 0) throw new Error('budget'); } } });
  mode = 'lent'; await run();
  mode = 'down'; let r = await run(); assert.equal(r.transitions, 0);
  mode = 'avail'; r = await run(); assert.equal(r.transitions, 1, '貸出中→(通信失敗)→在架 は通知する');
  mode = 'down'; await run();
  mode = 'avail'; r = await run(); assert.equal(r.transitions, 0, '在架→(通信失敗)→在架 は通知しない');
});

await t('レート制限・入力検証', async () => {
  const env = makeEnv();
  const bad = await W.route(post('/api/availability', { items: [] }), env, { fetch: fakeFetch(staticHandlers()), sleep: noSleep });
  assert.equal(bad.status, 400);
  const bad2 = await W.route(post('/api/sync', { subscription: { endpoint: 'http://insecure' } }), env, { fetch: fakeFetch(staticHandlers()), sleep: noSleep });
  assert.equal(bad2.status, 400);
});

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
