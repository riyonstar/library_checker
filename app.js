/* 図書館の本を探す(北区) - PWA 本体
 * 画面・お気に入り・状態履歴・状態変化検知・アプリ内通知・Web Push登録を担当。
 * 図書館名はすべて libraries.json(→data.js)から取得し、ここには書かない。
 */
(() => {
'use strict';

/* ================= 設定・データ ================= */
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
  isbns: store.get('isbns', {}),        // { bookId: [isbn13...] } (カーリルへのリンク用)
  loading: new Set(),                   // 確認中の本ID
  progress: null,                       // 一括確認の進捗表示
};
const persist = {
  fav: () => store.set('fav', state.fav),
  history: () => store.set('history', state.history.slice(-400)),
  notifs: () => store.set('notifs', state.notifs.slice(-100)),
  settings: () => store.set('settings', state.settings),
  isbns: () => store.set('isbns', state.isbns),
};

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
const levelColor = (lv) => LEVEL_COLORS[Math.max(0, LEVELS.indexOf(lv)) % LEVEL_COLORS.length];

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
function afterCheck() { syncPush(); }

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

function bookCardHtml(b) {
  const meta = [];
  if (b.isKumonRecommended) meta.push(`<span class="lv">${esc(b.level)}</span>`);
  const au = b.author ? `著者：${esc(b.author)}` : '';
  const others = (b.contributors || []).length ? ` ${esc(b.contributors.join(' '))}` : '';
  const pub = b.publisher ? ` ／ ${esc(b.publisher)}` : '';
  const fav = isFav(b.id);
  return `<article class="book" data-book="${esc(b.id)}" style="--spine:${b.isKumonRecommended ? levelColor(b.level) : '#4a5a6a'}">
    <div class="spine" aria-hidden="true"></div>
    <div class="book-body">
      <a class="book-link" href="#/book/${encodeURIComponent(b.id)}">
        <h3 class="book-title">${esc(b.title)}</h3>
        <div class="book-meta">${meta.join('')}${au}${others}${pub}${b.isNewIn2026 ? '<span class="new">新</span>' : ''}</div>
      </a>
      <div class="lib-rows">${libRowsHtml(b.id)}</div>
    </div>
    <button class="fav-btn" data-fav="${esc(b.id)}" aria-pressed="${fav}" aria-label="${fav ? 'お気に入りを解除' : 'お気に入りに追加'}">${fav ? '❤️' : '♡'}<span>${fav ? '登録済' : 'お気に入り'}</span></button>
  </article>`;
}

function updateCards(bookId) {
  $$(`[data-book="${CSS.escape(bookId)}"] .lib-rows`).forEach((el) => { el.innerHTML = libRowsHtml(bookId); });
  const route = parseRoute();
  if (route.name === 'book' && route.id === bookId) renderRoute();
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
  </nav>
  ${unreadCount() ? `<div class="notice" style="margin-top:14px">🔔 未読の通知が${unreadCount()}件あります。<a href="#/notifications">見る</a></div>` : ''}
  <p class="muted on-wood" style="margin:14px 4px">対象: ${selectedLibs().map((l) => esc(l.name)).join('、')}。「貸出中」→「在架」になったら、お気に入りの本をお知らせします。</p>`;
}

function kumonView(route) {
  const level = LEVELS.includes(route.q.get('level')) ? route.q.get('level') : (LEVELS.includes(state.settings.level) ? state.settings.level : LEVELS[0]);
  state.settings.level = level; persist.settings();
  const list = BOOKS.filter((b) => b.level === level);
  return `
  <h1 class="page-title">📚 くもんの推薦図書</h1>
  <div class="chips" role="group" aria-label="レベル">${LEVELS.map((lv) => `<button class="chip" data-level="${esc(lv)}" aria-pressed="${lv === level}">${esc(lv)}</button>`).join('')}</div>
  <div class="toolbar">${checkButton()}</div>
  <h2 class="shelf-title">レベル ${esc(level)}（${list.length}冊）</h2>
  <div class="shelf-list">${list.map(bookCardHtml).join('')}</div>`;
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
function extSearchBlock(q) {
  if (useMock()) return `<div class="notice">🧪 モックモードでは、くもんの推薦図書の中だけを検索します。(推薦図書以外も検索するには、バックエンドの接続が必要です)</div>`;
  if (extState.q === q && extState.items) {
    return `<h2 class="shelf-title">図書館全体からの検索結果(国立国会図書館サーチ)</h2>
      ${extState.items.length ? `<div class="toolbar">${checkButton()}</div>` : ''}
      <div class="shelf-list" id="ext-list">${extState.items.map(bookCardHtml).join('') || '<p class="empty">見つかりませんでした。</p>'}</div>`;
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
  </section>
  ${hist.length ? `<section class="panel"><h2>状態の履歴</h2><ul class="hist">${hist.map((h) => { const lib = LIBS.find((l) => l.id === h.libraryId); const p = h.previousStatus ? STATUS[h.previousStatus] : null; const c = STATUS[h.currentStatus]; return `<li>${esc(lib?.shortName || h.libraryId)}: ${p ? p.icon + p.label : '初回'} → ${c.icon}${c.label}<span class="muted">(${esc(fmtTime(h.checkedAt))})</span></li>`; }).join('')}</ul></section>` : ''}`;
}

/* ================= ルーティング ================= */
function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  const name = parts[0] || 'home';
  if (name === 'book') return { name, id: decodeURIComponent(parts[1] || ''), q };
  return { name, q };
}
const TABS = { home: 'home', kumon: 'kumon', search: 'search', favorites: 'favorites', libraries: 'libraries', book: null, notifications: null };

function renderRoute({ keepScroll = false } = {}) {
  const route = parseRoute();
  const map = { home: homeView, kumon: kumonView, search: searchView, favorites: favoritesView, libraries: librariesView, notifications: notificationsView };
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
  if (t.dataset.check) { ev.preventDefault(); await checkBooks(currentVisibleIds()); return; }
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
document.addEventListener('submit', (ev) => {
  const f = ev.target;
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
    // 登録時にいまの状態を保存(これが「前回の状態」になる)
    checkBooks([id], { quiet: true });
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
  BOOKS = d.books.books; LIBS = d.libraries.libraries; PROVIDER = d.libraries.provider || {};
  BOOKS.forEach((b) => { b._n = norm([b.title, b.searchTitle, b.author, (b.contributors || []).join(' '), b.publisher].join(' ')); });
  BOOK_BY_ID = new Map(BOOKS.map((b) => [b.id, b]));
  LEVELS = [...new Set(BOOKS.map((b) => b.level))];
}

async function boot() {
  try { await loadData(); } catch (e) { $('#view').innerHTML = '<p class="empty">データを読み込めませんでした。</p>'; return; }
  loadAvail(); updateBanner(); updateBell();
  $('#attribution').innerHTML = `くもんのすいせん図書 2026年度版(公文教育研究会)の掲載図書より作成 ／ 蔵書情報: <a href="${esc(CFG.ATTRIBUTION?.url || 'https://calil.jp/')}" target="_blank" rel="noopener">${esc(CFG.ATTRIBUTION?.name || 'カーリル図書館API')}</a>`;
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
