# 哲学喫茶API サーバー

哲学者61人とのAI会話をClaude API経由で実現するバックエンドです。

このREADMEは「パソコンなし・ブラウザだけ」でRenderにデプロイする手順です。

---

## 1. GitHubにアップロードする

1. https://github.com にアクセスしてログイン（アカウントがなければ新規登録）
2. 右上の「+」→「New repository」
   - Repository name: `philo-app-server`（好きな名前でOK）
   - Public / Private どちらでも可（Privateでも次のRender連携は問題なくできます）
   - 「Create repository」を押す
3. 作成後の画面で「uploading an existing file」というリンクをクリック
   （もしくは「Add file」→「Upload files」）
4. この `server` フォルダの中身を**そのまま全部**ドラッグ＆ドロップ
   - 対象: `server.js` `promptBuilder.js` `package.json` `philosophers.json`
     `.gitignore` `.env.example` `README.md`
   - **`.env`ファイルは絶対にアップロードしないこと**（今回は最初から入っていないので大丈夫です）
5. 下の「Commit changes」ボタンを押してアップロード完了

## 2. Renderにデプロイする

1. https://render.com にアクセスして「Get Started」→ GitHubアカウントで登録（カード情報は不要）
2. ダッシュボードで「New +」→「Web Service」
3. 「Connect a repository」で、さっき作った `philo-app-server` を選ぶ
   （初回は「GitHubを連携する」許可を求められるので許可する）
4. 設定画面が出るので、以下を確認・入力:
   - **Name**: 好きな名前（例: `philo-app-api`）→ これが公開URLの一部になる
   - **Region**: どこでもOK（迷ったら Singapore や Oregon など）
   - **Branch**: `main`
   - **Root Directory**: 空欄のままでOK（server.jsが直下にある前提）
   - **Build Command**: `npm install`（自動入力されるはず）
   - **Start Command**: `npm start`（自動入力されるはず）
   - **Instance Type**: 「Free」を選択
5. さらに下にスクロールして「Environment Variables」セクションで
   「Add Environment Variable」を押し、以下を追加:
   - Key: `ANTHROPIC_API_KEY`
   - Value: 実際のAPIキー（`sk-ant-...`）
6. 「Create Web Service」を押すとデプロイが始まる（数分かかります）
7. 成功すると、ダッシュボード上部に
   `https://（さっき決めた名前）.onrender.com` という公開URLが表示される

## 3. 動作確認

デプロイ完了後、そのURLの末尾に `/api/philosophers` を付けてブラウザでアクセスしてみる:

```
https://（あなたのサービス名）.onrender.com/api/philosophers
```

61人分のJSONデータがズラッと表示されれば成功です。

※ 無料プランは15分アクセスがないとスリープするので、しばらく触っていないと
　最初の1回だけ応答に30〜60秒ほどかかります。2回目以降は普通の速度で動きます。

## 4. アプリ側の接続先を変更する

`アプリ.html` 内の `API_BASE` を、ローカル用の `http://localhost:3000` から
このRenderのURLに書き換える必要があります。URLが決まったら教えてください、
その部分を直します。

---

## エンドポイント一覧（参考）

### GET /api/philosophers
61人分の哲学者データをJSONで返す。

### POST /api/chat
哲学者との会話を1ターン進める。

### POST /api/summarize
会話ログを渡すと「今日の問い」「気づき」を要約して返す。
