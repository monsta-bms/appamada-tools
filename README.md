# appamada-tools

BMS難易度表「不放逸」とBMSIRを連携するUserscriptの開発リポジトリです。TampermonkeyとViolentmonkeyで、次のBMSIR譜面ページを対象にします。

- `https://bms-ir.org/new/song*`
- `https://www.bms-ir.org/new/song*`

## 実装範囲

- Phase 1: BMSIR parser、難易度定数、fixture test、公開Userscript基盤
- Phase 2: 右クリック投稿UI、lookup/submit client、Standalone Apps Script API、申請一覧へのRAW書込み
- Phase 3: 管理者承認、kkj順序維持、Developer Metadata recovery
- Phase 4: 本番Standalone API、管理処理、キルスイッチ、production Userscript

Phase 4でproduction導入済みです。運用は[Phase 3 管理者承認](docs/phase3-admin.md)と[Phase 4 production rollout](docs/phase4-production.md)を参照してください。非公開の本番識別子はsourceやdocsへ保存せず、公開受付URLをdist生成時に注入します。

### 0.4.8

申請受付の連続送信対策を強化し、開発用依存関係を更新しました。新規譜面・難易度変更・削除の申請と、ブラウザへ保存した提案を引き続き利用できます。

既に導入済みの場合は、同じブラウザとUserscriptマネージャーで[公開Userscript](https://raw.githubusercontent.com/monsta-bms/appamada-tools/main/dist/appamada_bmsir_submit.user.js)を0.4.8以降へ更新してください。スクリプトや保存データを削除する必要はありません。新しい申請受付先への接続許可を求められた場合は承認し、ログイン中のBMSIR譜面ページを再読み込みしてください。旧版は更新まで送信待ちとなり、保存済みの提案は更新後に同じ内容で再送されます。

### 0.4.7

通信不調時にも通常と同じ申請画面を利用できます。現在難易度を取得できない場合は↑ / ↓を無効にし、レベルを直接選択します。提案はUserscript専用のブラウザ保存領域へ保存され、BMS-IRのログイン中の譜面ページを開いている間、回復後に順番に送信されます。右クリックの「保存した提案」から状態確認・再送・控えの書き出しができます。

送信前にも保存し、応答が失われた場合は同じrequest_idと送信内容で再送します。受付済みの重複送信と登録済み譜面への新規提案は、既存APIの判定を使用します。本番Apps Script・Spreadsheetの変更は不要です。送信待ち・送信済み・受付不可を区別し、申請種別は自動変換しません。

自動送信は1回最大5件・1件ずつ、失敗時は30秒～5分の間隔を置きます。投稿数の制限はサーバー指定の待ち時間を優先します。提案はプレイヤーIDごとに分け、1アカウント最大200件です。送信結果が不明な提案は、受付済みの可能性があるため取り消せません。送信済み・受付不可の控えは手動で消せます。ブラウザを閉じている間は送信できず、拡張機能や保存領域の削除で未送信の提案を失う可能性があります。

`tests/outbox.test.js`では再起動、通信復旧、保存失敗、二重送信、登録済み新規提案の拒否、RAW書込み、投稿制限、複数タブ、別アカウントを検証します。サーバー処理は既存Apps Scriptソースをローカルで実行し、本番への架空投稿は行いません。Firefox + Tampermonkey実機の確認は自動テストとは別です。

### 0.4.5

BMS-IRの現行譜面ページ構造への対応を維持しつつ、譜面ページを開いた直後に登録状況を先読みして申請画面を開くまでの待ち時間を短縮しました。Apps Script API側もサービス呼び出し回数を削減しています。

### 0.4.3

BMS-IRの現行譜面ページ構造に対応し、曲名・artistの右クリックメニューが初期化されない問題を修正しました。BMS-IRの暗色フォームCSSがモーダルへ干渉しないよう閉じるボタンとコメント欄の配色も局所的に固定しています。旧DOM fallbackと、個人情報や曲情報を含めないfatal parse診断ログを維持しています。

## 開発

### 申請受付の保護（0.4.8）

公開版は0.4.8です。署名を検証する受付API、必要な設定、互換性、検証手順と実環境での確認範囲は[申請受付の保護](docs/security-gateway.md)を参照してください。
開発用の候補は`.local`へ生成し、通常の申請・管理処理・保存済み提案とあわせて検証します。

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

通常の`npm run build`は安全なplaceholder URLを使ってgit管理外の`.local/appamada_bmsir_submit.public-check.user.js`へ生成し、`npm run smoke`でmetadata、構文、起動時通信、保存済み提案の再送を検査します。公開distは、受付URLと対応する接続許可以外が現行候補と一致することも確認します。`npm run check`はtracked public distを変更しません。ソースを変更した場合は、公開前に`build:public`でdistを再生成してから最終検査してください。

公開releaseを明示的に再生成する場合だけ`npm run build:public`を使用します。公開生成物は`dist/appamada_bmsir_submit.user.js`です。

## Production release

公開distは申請受付WorkerのURLを環境変数から注入して明示生成します。

```powershell
$env:APPAMADA_API_URL = "https://appamada-submission-gateway.monsta3228gsl.workers.dev/api"
npm.cmd run build:public
npm.cmd run smoke
```

生成物は`dist/appamada_bmsir_submit.user.js`です。0.4.8以降の公開生成には設定済み受付WorkerのHTTPS `/api` URLが必要です。本番へ反映する前に[切替の前提](docs/security-gateway.md)を確認してください。

## Phase 2テストUserscript

Phase 2版はテストWeb App URLを環境変数から注入し、git管理外の`.local`へ生成します。

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
