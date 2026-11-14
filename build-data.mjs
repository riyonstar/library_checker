// books.json / libraries.json から data.js を作るスクリプト。
// 使い方:  node build-data.mjs
// index.html を file:// で直接開いたときは fetch() が使えないため、
// データを <script> で読める data.js にまとめています(中身は books.json + libraries.json と同じ)。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const books = JSON.parse(readFileSync(join(dir, 'books.json'), 'utf8'));
const libraries = JSON.parse(readFileSync(join(dir, 'libraries.json'), 'utf8'));
const out =
  '/* 自動生成: node build-data.mjs  (books.json と libraries.json を編集したら再実行) */\n' +
  'self.APP_DATA = ' + JSON.stringify({ books, libraries }) + ';\n';
writeFileSync(join(dir, 'data.js'), out);
console.log(`data.js を生成しました: 書籍 ${books.books.length} 冊 / 図書館 ${libraries.libraries.length} 館`);
