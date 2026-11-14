# 秘密情報の置き場所(まとめ)

手順は **IPHONE-SETUP.md**(iPhoneだけで完結)を見てください。ここは「何をどこに置くか」の一覧です。

| 値 | 秘密? | 置き場所 |
|---|---|---|
| `CALIL_APPKEY`(カーリルのAPIキー) | **秘密** | **Cloudflareの画面(Worker → Settings → Variables and Secrets → Secret)だけ**。GitHubには置かない |
| Web Pushの秘密鍵 | **秘密** | Worker が初回に自動生成し、Cloudflare KVにだけ保存。人は扱わない |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | **秘密** | GitHub Secrets だけ(デプロイ用) |
| `BACKEND_URL`、`ALLOWED_ORIGIN`、`BOOKS_URL`、KVのID | 公開OK | `config.js` / `wrangler.toml` |

```
iPhone/PWA(キーなし) → Worker(キーを保持) → カーリルAPI
```

## 守ること
- キーは **Cloudflareの入力欄以外に貼らない**(チャット・GitHubのファイル・コメント・Issueも不可)。
- 最初は **Privateリポジトリ**で始め、`check`(自動チェック)が緑になってから Public にする。
- 万一貼ってしまったら、カーリルのキーを**再発行**してCloudflareのSecretを差し替える(Gitの履歴から消しても、一度公開されたものは安全とは言えません)。

## 自動チェックについて
- `check.yml`(`workflow-check.yml.txt` の内容)が push のたびに `check-secrets.mjs` を実行します。手元での実行は不要です。
- 検査は push の**後**に走るため、公開後の貼り間違いは「防止」ではなく「検知」です。
- ログには場所(ファイル名・行番号)だけが出て、値は出力されません。

## キー未登録でも動くこと
- 画面、検索、お気に入り、履歴・変化検知、アプリ内通知(モック)。
- Worker をデプロイすれば、書名→ISBN解決と推薦図書以外の検索も動く。
- 在架状況は「⚪不明(APIキー未設定)」と表示し、貸出中とは表示しない。
