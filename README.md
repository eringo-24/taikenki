# 体験記チェッカー デプロイ手順

ファイル構成（index.htmlがルート直下にあります。以前の「public/」フォルダは廃止しました）：
```
taikenki-checker/
├── index.html
├── css/
│   └── style.css
├── js/
│   ├── rules.js
│   ├── rule-engine.js
│   ├── gemini-client.js
│   ├── app.js
│   └── image-editor.js
├── functions/
│   └── _middleware.js      ← Basic認証（全ページに自動適用。静的ファイルとしては配信されない）
├── .assetsignore            ← functions/やREADME.mdを配信対象から除外する設定
├── .gitignore
└── README.md
```

---

## 方法A：GitHub + Cloudflare Pages（推奨・チーム運用向け）

### 1. GitHubにリポジトリを作る
https://github.com/new でリポジトリを作成（Privateを推奨）。

### 2. このフォルダの中身をそのままpushする
```
cd taikenki-checker
git init
git add .
git commit -m "初回コミット"
git branch -M main
git remote add origin https://github.com/【あなたのアカウント】/taikenki-checker.git
git push -u origin main
```

### 3. Cloudflareダッシュボードで連携する
1. https://dash.cloudflare.com/ にログイン
2. 「Workers & Pages」→「Create」→「Pages」タブ→「Connect to Git」
3. 対象のGitHubリポジトリを選択
4. ビルド設定：
   - Framework preset: **None**
   - Build command: **空欄のまま**
   - Build output directory: **空欄のまま、または `/`**
     （index.htmlがリポジトリ直下にあるため、以前のように`public`と指定する必要はありません）
5. 「Save and Deploy」

### 4. ユーザー名・パスワードを設定する
Pagesプロジェクト →「Settings」→「Environment variables」→「Add variable」で
`CHECKER_USER` / `CHECKER_PASS` を追加し、**必ず「Encrypt」にチェック**を入れて保存。
保存後、Deploymentsタブから最新のデプロイを「Retry deployment」してください。

### 5. 以後の更新方法
ファイルを書き換えて
```
git add .
git commit -m "更新内容のメモ"
git push
```
するだけです。

---

## 方法B：CLIから直接デプロイ（GitHub不要）

`taikenki-checker`フォルダの中（index.htmlがある階層）で実行してください。
以前は`./public`を指定していましたが、フォルダ構成を変更したため`.`（カレントディレクトリ）を指定します。

```
npm install -g wrangler
wrangler login

cd taikenki-checker
wrangler pages project create taikenki-checker
wrangler pages deploy . --project-name=taikenki-checker

wrangler pages secret put CHECKER_USER --project-name=taikenki-checker
wrangler pages secret put CHECKER_PASS --project-name=taikenki-checker

wrangler pages deploy . --project-name=taikenki-checker
```

`.assetsignore`があるため、`functions/`・`README.md`・`.gitignore`は静的ファイルとしてはアップロードされず、
`functions/`だけはWranglerによって自動的にPages Functions（Basic認証）として正しく組み込まれます。

**注意（ダッシュボードからの直接アップロードは使わないでください）**：
Cloudflareダッシュボードの「Drag and drop」「ZIPをアップロード」機能は、`functions`フォルダに対応していません
（"Pages functions are not supported." のエラーになります）。デプロイは必ず上記のWrangler CLI、
またはGitHub連携（方法A）で行ってください。

---

## 補足
- Gemini APIキーは各ユーザーが自分のブラウザで入力するだけで、サーバー側には送信・保存されません。
- 「誰がいつアクセスしたか」を個別に記録したい場合は、Cloudflare Access（メールのワンタイムPINログイン、50人まで無料）への切り替えも可能です。
