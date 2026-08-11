# appamada-tools

BMS難易度表「不放逸」とBMSIRを連携するUserscriptの開発リポジトリです。TampermonkeyとViolentmonkeyで、次のBMSIR譜面ページを対象にします。

- `https://bms-ir.org/new/song*`
- `https://www.bms-ir.org/new/song*`

## 実装範囲

- Phase 1: BMSIR parser、難易度定数、fixture test、公開Userscript基盤
- Phase 2: 右クリック投稿UI、lookup/submit client、Standalone Apps Script API、申請一覧へのRAW書込み
- Phase 3: テストSpreadsheet向け管理者承認、kkj順序維持、Developer Metadata recovery

Phase 2/3はテスト環境専用です。Phase 3管理処理は`apps-script/admin`にありますが、本番Spreadsheet、本番Apps Script、公開`data_url`には導入しません。運用は[Phase 3 管理者承認](docs/phase3-admin.md)を参照してください。

## 開発

対応するNode.jsを用意し、依存関係を導入します。

```sh
npm install
```

テスト、ビルド、dist smoke testをまとめて実行します。

```sh
npm run check
```

個別にも実行できます。

```sh
npm test
npm run build
npm run smoke
```

通常の`npm run build`はgit管理外の`.local/appamada_bmsir_submit.public-check.user.js`へ生成し、`npm run smoke`で固定済み公開distとEOL正規化後の内容を比較します。これにより`npm run check`はtracked public distを変更しません。

公開releaseを明示的に再生成する場合だけ`npm run build:public`を使用します。公開生成物は`dist/appamada_bmsir_submit.user.js`です。

## Phase 2テストUserscript

公開distはPhase 1安定版のまま維持します。Phase 2版はテストWeb App URLを環境変数から注入し、git管理外の`.local`へ生成します。

```sh
APPAMADA_API_URL="https://script.google.com/macros/s/TEST_DEPLOYMENT_ID/exec" npm run build:test
npm run smoke:test
```

PowerShellでは次のように設定します。

```powershell
$env:APPAMADA_API_URL = "https://script.google.com/macros/s/TEST_DEPLOYMENT_ID/exec"
npm.cmd run build:test
npm.cmd run smoke:test
```

生成物は`.local/appamada_bmsir_submit.test.user.js`です。API URL未設定またはGoogle Web App以外のURLではbuildが失敗します。

Apps Script APIとテストSpreadsheetの準備は[Phase 2 API](docs/phase2-api.md)、実環境確認は[Phase 2 PoC](docs/phase2-poc.md)を参照してください。

## 秘密情報

BMSIR Cookie、セッション、localStorage、API token、Spreadsheet ID、Google credentials、テストWeb App URLを取得・保存・commitしません。`.local`、`.env`、`.clasp.json`、credentials/secrets系ファイルはGit管理から除外します。
