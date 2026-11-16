/*
 * 表紙ラベルの印刷(25mm角・A4・PDF)。外部ライブラリなし。
 * 別アプリ「絵本ラベルメーカー」の仕組み(pdf.js / imaging.js / cover.js)を、このアプリ向けにまとめたものです。
 *
 *  - 表紙画像は Google ブックスから取得(その本のISBNを順に試す)
 *  - canvas で正方形の JPEG にして、PDF に埋め込む(1辺ちょうど 25mm)
 *  - 画像を canvas に描くには CORS が必要。直接取得できないときだけ、画像プロキシ(images.weserv.nl)経由で再試行する
 *    (その場合、ISBN入りの画像URLがそのプロキシに送られます。書名・利用者の情報は送りません)
 */
(function (root) {
  'use strict';

  const MM = 72 / 25.4;            // 1mm = 2.8346pt
  const PAGE = { w: 210, h: 297 }; // A4 縦 (mm)
  const SIZE = 25;                 // ラベル 1 辺 (mm)
  const GAP = 2;                   // ラベル間 (mm)
  const MARGIN = 10;               // 最低余白 (mm)
  const OUT_SIZE = 480;            // 25mm 角に対して約 490dpi

  function layout() {
    const cols = Math.floor((PAGE.w - MARGIN * 2 + GAP) / (SIZE + GAP));
    const rows = Math.floor((PAGE.h - MARGIN * 2 + GAP) / (SIZE + GAP));
    const gridW = cols * SIZE + (cols - 1) * GAP;
    const gridH = rows * SIZE + (rows - 1) * GAP;
    return { size: SIZE, gap: GAP, cols, rows, perPage: cols * rows, left: (PAGE.w - gridW) / 2, top: (PAGE.h - gridH) / 2, pageW: PAGE.w, pageH: PAGE.h };
  }

  /* ---------------- 画像の取得 ---------------- */
  async function fetchTimeout(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { signal: ctrl.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }); } finally { clearTimeout(t); }
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.src = src;
    });
  }
  const proxied = (url) => 'https://images.weserv.nl/?url=' + encodeURIComponent(url.replace(/^https?:\/\//, ''));
  const coverUrls = (isbn) => [3, 2, 1].map((z) => `https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=${z}`);

  async function tryLoad(url) {
    for (const u of [url, proxied(url)]) {
      try {
        const r = await fetchTimeout(u, 9000);
        if (!r.ok) continue;
        const blob = await r.blob();
        if (blob.size < 800) continue;
        const obj = URL.createObjectURL(blob);
        try {
          const img = await loadImage(obj);
          if (Math.min(img.naturalWidth, img.naturalHeight) < 100) continue;   // 「画像なし」の小さな絵などは使わない
          return img;
        } finally { setTimeout(() => URL.revokeObjectURL(obj), 1500); }
      } catch (e) { /* 次の経路へ */ }
    }
    return null;
  }

  /** その本のISBN(最大2つ)から表紙画像を探す。なければ null */
  async function fetchCover(isbns) {
    for (const isbn of (isbns || []).slice(0, 2)) {
      for (const u of coverUrls(isbn)) {
        const img = await tryLoad(u);
        if (img) return img;
      }
    }
    return null;
  }

  /* ---------------- 正方形への書き出し ---------------- */
  function renderSquare(img, zoom, size = OUT_SIZE) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const scale = (size / Math.min(w, h)) * zoom;
    const dw = w * scale, dh = h * scale;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, size / 2 - dw / 2, size / 2 - dh / 2, dw, dh);
    return c.toDataURL('image/jpeg', 0.92);
  }
  /** mode: 'contain'=表紙全体を欠けなく(余白は白) / 'crop'=正方形に切り抜く(短辺基準) */
  function toSquare(img, mode) {
    const zoom = mode === 'crop' ? 1 : Math.min(img.naturalWidth, img.naturalHeight) / Math.max(img.naturalWidth, img.naturalHeight);
    return renderSquare(img, zoom);
  }

  /* ---------------- PDF の生成 ---------------- */
  function dataUrlToBytes(u) {
    const bin = atob(u.slice(u.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function jpegInfo(b) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9] };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    throw new Error('JPEG として解釈できませんでした');
  }
  const f3 = (n) => n.toFixed(3);
  const pad10 = (n) => String(n).padStart(10, '0');
  const utf16Hex = (s) => '<FEFF' + [...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '>';

  /** @param {{image:string}[]} items image は正方形 JPEG(dataURL)  @param {{cutLines?:boolean}} opts */
  function buildPdf(items, opts = {}) {
    const lay = layout();
    const n = items.length;
    const pageCount = Math.max(1, Math.ceil(n / lay.perPage));
    const enc = new TextEncoder();
    const chunks = []; const offsets = []; let offset = 0;
    const push = (u8) => { chunks.push(u8); offset += u8.length; };
    const str = (s) => push(enc.encode(s));
    const begin = (id) => { offsets[id] = offset; str(id + ' 0 obj\n'); };
    const end = () => str('endobj\n');
    const imgId = (i) => 4 + i;
    const pageId = (p) => 4 + n + p * 2;
    const contId = (p) => 5 + n + p * 2;

    push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    begin(1); str('<< /Type /Catalog /Pages 2 0 R >>\n'); end();
    begin(2); str('<< /Type /Pages /Count ' + pageCount + ' /Kids [' + Array.from({ length: pageCount }, (_, p) => pageId(p) + ' 0 R').join(' ') + '] >>\n'); end();
    begin(3); str('<< /Title ' + utf16Hex('絵本ラベル 25mm') + ' /Creator (Kita Library Checker) >>\n'); end();

    for (let i = 0; i < n; i++) {
      const bytes = dataUrlToBytes(items[i].image);
      const info = jpegInfo(bytes);
      const cs = info.comps === 1 ? 'DeviceGray' : info.comps === 4 ? 'DeviceCMYK' : 'DeviceRGB';
      begin(imgId(i));
      str('<< /Type /XObject /Subtype /Image /Width ' + info.w + ' /Height ' + info.h + ' /ColorSpace /' + cs + ' /BitsPerComponent 8 /Filter /DCTDecode' + (info.comps === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '') + ' /Length ' + bytes.length + ' >>\nstream\n');
      push(bytes); str('\nendstream\n'); end();
    }

    const sizePt = SIZE * MM;
    for (let p = 0; p < pageCount; p++) {
      const slice = items.slice(p * lay.perPage, (p + 1) * lay.perPage);
      const cells = slice.map((_, k) => {
        const col = k % lay.cols, row = Math.floor(k / lay.cols);
        return { x: (lay.left + col * (SIZE + GAP)) * MM, y: (lay.pageH - (lay.top + row * (SIZE + GAP)) - SIZE) * MM, idx: p * lay.perPage + k, k };
      });
      let c = '';
      if (opts.cutLines) {
        // 線は画像の外側に出す(線幅 0.25pt の半分だけ外へ)。画像の 25mm は変えない。
        c += 'q 0.55 G 0.25 w\n';
        for (const t of cells) c += f3(t.x - 0.125) + ' ' + f3(t.y - 0.125) + ' ' + f3(sizePt + 0.25) + ' ' + f3(sizePt + 0.25) + ' re S\n';
        c += 'Q\n';
      }
      for (const t of cells) c += 'q ' + f3(sizePt) + ' 0 0 ' + f3(sizePt) + ' ' + f3(t.x) + ' ' + f3(t.y) + ' cm /Im' + t.k + ' Do Q\n';
      const content = enc.encode(c);
      begin(pageId(p));
      str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f3(PAGE.w * MM) + ' ' + f3(PAGE.h * MM) + '] /Resources << /XObject << ' + cells.map((t) => '/Im' + t.k + ' ' + imgId(t.idx) + ' 0 R').join(' ') + ' >> >> /Contents ' + contId(p) + ' 0 R >>\n');
      end();
      begin(contId(p)); str('<< /Length ' + content.length + ' >>\nstream\n'); push(content); str('\nendstream\n'); end();
    }

    const total = 4 + n + pageCount * 2;
    const xref = offset;
    str('xref\n0 ' + total + '\n0000000000 65535 f \n');
    for (let id = 1; id < total; id++) str(pad10(offsets[id]) + ' 00000 n \n');
    str('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

    const out = new Uint8Array(offset);
    let pos = 0;
    for (const ch of chunks) { out.set(ch, pos); pos += ch.length; }
    return { bytes: out, pageCount };
  }

  root.Labels = { MM, SIZE, GAP, layout, fetchCover, toSquare, buildPdf, jpegInfo };
})(self);
