/* アプリ設定(公開されても問題ない値だけを書くこと。APIキー・秘密鍵は絶対に書かない)
 *
 * BACKEND_URL     : Cloudflare Worker(worker.js)のURL。例 "https://kita-library.<あなた>.workers.dev"
 *                   空のままなら「モックモード」(仮データ)で動きます。
 */
(self.APP_CONFIG = {
  BACKEND_URL: "",
  // 画面に表示する図書館データの出典
  ATTRIBUTION: { name: "カーリル図書館API", url: "https://calil.jp/" }
});
