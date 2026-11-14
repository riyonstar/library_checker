# iPhoneだけで公開・設定する手順(ターミナル不要)

## 先に:秘密情報が公開GitHubに入らないようにする3つの仕組み

1. **書く場所をなくしてある(設計)**
   - カーリルのAPIキー → **Cloudflareの画面にだけ**入力する。GitHubには置かない。
   - Web Pushの秘密鍵 → **Worker が自動で作り、Cloudflare内にだけ保存**する。あなたは見ない・扱わない。
   - GitHub Secrets に入れるのは Cloudflare用のトークンとアカウントIDの2つだけ(コードのファイルには出ない)。
   - どのファイルにも、キーを書く欄はありません。
2. **最初は非公開(Private)のリポジトリで始める(手順)**
   自動チェックが緑になってから公開(Public)に切り替えます。チェック前の内容は誰にも見えません。
3. **自動チェック(GitHub Actions)**
   push のたびに「キーらしき値の直書き」を検査します。ターミナルでの実行は不要です。

> 限界も正直に書きます。自動チェックは push の**後**に走るので、公開リポジトリに誰かが(あなた自身が)キーを貼ってしまえば、防ぐことはできず「検知」しかできません。だから①キーはCloudflareの画面以外に貼らない、②最初はPrivateで始める、の2つを守ってください。万一貼ってしまったら、**カーリルのキーを再発行**します(Gitの履歴からは消せないため)。

---

## A. GitHubに置く(Privateで開始)
1. GitHubで新規リポジトリを作成。**Private** を選ぶ。名前は例:`library-app`。
2. `library-app.zip` を iPhone の「ファイル」アプリで展開する(zipをタップ)。
3. リポジトリの Add file → Upload files で、展開したフォルダの**中身をすべて**選んでアップロード(`workflow-*.txt` も含めて全部。フォルダは作らない)。Commit。
4. 画面の Add file → Create new file で、ファイル名欄に `.github/workflows/check.yml` と入力(`/` を打つとフォルダになる)。本文に `workflow-check.yml.txt` の中身を貼り付けて Commit。
5. 同じ方法で `.github/workflows/deploy-worker.yml` を作り、`workflow-deploy-worker.yml.txt` の中身を貼り付けて Commit。
6. Actions タブで `check` が **緑✓** になることを確認。赤✗なら、ログに「どのファイルの何行目」が出ます(値そのものは出ません)。

## B. 公開する(チェックが緑のあと)
7. Settings → General の一番下 Danger Zone → Change visibility → **Public**。
8. Settings → Pages → Branch を `main`、フォルダ `/ (root)` にして Save。数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で開けます。
9. iPhoneのSafariでそのURLを開き、モックモードで動作確認。
10. (任意・おすすめ)Settings → Code security で **Secret scanning と Push protection** をオンにする。

## C. バックエンド(Cloudflare・無料)
11. Cloudflareの無料アカウントを作る。
12. 画面で **KV** を作る(Storage & Databases → KV → Create)。表示される **ID** を控える(IDは秘密ではありません)。
13. APIトークンを作る(My Profile → API Tokens → 「Edit Cloudflare Workers」テンプレート)。**アカウントID** も控える。
14. GitHubの Settings → Secrets and variables → Actions で、次の2つを登録(画面に直接入力):`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
15. GitHubで `wrangler.toml` を開き(鉛筆アイコンで編集)、次を自分の値に書き換えて Commit:
    `ALLOWED_ORIGIN`(`https://<ユーザー名>.github.io`)/ `BOOKS_URL` / `LIBRARIES_URL` / KVの `id`
16. Actions タブ → `deploy-worker` → Run workflow。成功すると Worker が公開されます。URLは Cloudflare の Workers & Pages で確認できます(`https://kita-library.<…>.workers.dev`)。
17. `config.js` を開いて `BACKEND_URL` に、そのWorkerのURLを書いて Commit。

## D. APIキーを登録(Cloudflareの画面だけ)
18. カーリルのAPIキーを取得する(https://calil.jp/doc/api_ref.html )。
19. Cloudflare → Workers & Pages → `kita-library` → Settings → Variables and Secrets → 追加 → 種類は **Secret**、名前 `CALIL_APPKEY`、値にキーを貼る → Deploy。
    (キーはこの入力欄にだけ貼ります。チャットやGitHubには貼りません。)

## E. 接続の確認
20. Safariで `https://<Worker URL>/api/health` を開く。
    - `calilKey` が `true`
    - `libraryMatch` の2館で `matchedAlias` が入っている。`null` なら、アプリで何冊か確認したあとにもう一度開き、`learnedLibkeys` に出た実際の館名を `libraries.json` の `calil.libkeys` に追記して Commit(`data.js` の更新は不要です)。
21. アプリの「図書館」画面で「実データ」表示になっていることを確認。数冊で「最新情報を確認」を押し、**北区の公式サイトの表示と一致するか**を見比べる。
22. プッシュ通知: Safariの共有 → ホーム画面に追加 → そのアイコンから開く → 「図書館」画面で通知をオン(iOS 16.4以降)。

## 注意
- 手順の画面名は、私の知識に基づく案内です(このセッションでは各サービスの画面を実際には操作していません)。表記が違う場合は近い項目を探すか、画面に出たメッセージを教えてください(キーの値は貼らないでください)。
- キーを登録する前は、在架は「⚪不明(APIキー未設定)」と表示されます。貸出中とは表示されません。
