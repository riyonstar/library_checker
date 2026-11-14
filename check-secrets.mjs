// 秘密情報がファイルに直書きされていないかを確認します。  実行: node check-secrets.mjs
// 手元で実行するのは任意です(ターミナル不要)。GitHub Actions(check.yml)が push のたびに自動実行します。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const SKIP_FILES = new Set(['check-secrets.mjs', 'test-worker.mjs', 'SECRETS.md', 'README.md', 'IPHONE-SETUP.md', 'data.js', 'books.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler']);
const TEXT = /\.(js|mjs|json|html|css|toml|md|yml|yaml|txt|py|example)$|^\.(gitignore|dev\.vars)$/;

const RULES = [
  [/CALIL_APPKEY\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/, 'CALIL_APPKEY に値が書かれています'],
  [/VAPID_PRIVATE_KEY\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/, 'VAPID_PRIVATE_KEY に値が書かれています'],
  [/appkey=[0-9A-Za-z]{16,}/i, 'URLにAPIキーらしき値があります'],
  [/"d"\s*:\s*"[A-Za-z0-9_-]{43}"/, 'ECの秘密鍵(JWKのd)らしき値があります'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '秘密鍵ファイルの内容があります'],
  [/(?:VAPID|APPKEY|API_?KEY|SECRET|TOKEN)[A-Z_]*\s*[:=]\s*["']?[A-Za-z0-9_\-]{32,}/i, 'キー/トークンらしき長い値が代入されています'],
];

const problems = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); continue; }
    if (SKIP_FILES.has(name) && d === dir) continue;
    if (name === '.dev.vars') { problems.push(`${p}: .dev.vars が存在します(コミットしないでください。.gitignore済みか確認)`); continue; }
    if (!TEXT.test(name)) continue;
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [re, msg] of RULES) if (re.test(line)) problems.push(`${p.replace(dir + '/', '')}:${i + 1}: ${msg}`);
    });
  }
})(dir);

if (problems.length) { console.error('✖ 秘密情報の可能性があります:\n' + problems.map((x) => '  ' + x).join('\n')); process.exit(1); }
console.log('✔ 秘密情報の直書きは見つかりませんでした');
