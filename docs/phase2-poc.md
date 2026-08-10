# Phase 2 PoC

## 自動確認

`npm test`で次を検証します。

- Phase 1 parser / LEVEL regression
- API clientのlookup、cache、in-flight統合、network、timeout、invalid JSON、Google redirect
- `LOCK_TIMEOUT`だけを同じrequest_idで最大3回retry
- title/artist限定context menu、Shift bypass、Escape、outside click
- change ↑↓、step boundary、special、normal grid
- new 29-level grid、500 code points、loading、二重送信防止
- Apps Script lookup/change/new、全主要validation、ScriptLock、rate override
- request_id dedup/conflict、A:S schema、RAW option、structured log

`npm run check`はunit test、Phase 1 public build、public dist smokeを実行します。

2026-08-11のローカル実行結果:

- unit test: 82 PASS / 0 FAIL
- Phase 1 public dist smoke: 3 PASS / 0 FAIL
- Phase 2 test bundle smoke: 1 PASS / 0 FAIL
- Phase 1 public dist SHA-256: `60F2554EE805F61CBB1A61C14BC080FB01A8D90BF7E531929B668CEBEE032AA9`（Phase 1から不変）

Phase 2 test bundleは次で別途確認します。

```powershell
$env:APPAMADA_API_URL = "https://script.google.com/macros/s/TEST_DEPLOYMENT_ID/exec"
npm.cmd run build:test
npm.cmd run smoke:test
```

## Google integration checklist

2026-08-11時点ではclaspがGoogle未認証で、テスト用Spreadsheet IDも未指定です。そのためGoogle project作成、test Web App deploy、実Spreadsheet書込み、実API latency測定は未実施です。本番Spreadsheet / Apps Scriptを代用していません。

テストWeb AppとテストSpreadsheetが用意できたら、次を実測します。

- lookup: registered / missing / malformed
- change: success / same level / missing chart
- new: success / existing chart / title+artist保存
- common: dedup / conflict / long comment / invalid level / invalid IR URL
- RAW: `=1+1`, `+84`, `=HYPERLINK(...)`がformulaにならない
- rate: test override `USER_LIMIT=3`、試験後削除
- lookup latency: same MD5 cold/warm各10回以上、p50/p95

## Browser/UserScript Manager manual test

Google test Web Appが未deployのため、以下の実機4環境は未実施です。自動DOM/UI testの成功を実機PASSの代用にはしません。

各環境で`.local/appamada_bmsir_submit.test.user.js`を一時インストールします。

1. BMSIRへログインする。
2. 対象譜面ページでtitleまたはartistを右クリックする。
3. Shift+右クリックで通常menuが出ることを確認する。
4. change/newのlookup分岐、level選択、コメント、送信を確認する。
5. DevTools NetworkでCookieを伴う独自通信がなく、Google responseを取得できることを確認する。
6. テストSpreadsheetの申請一覧へ1行だけ追加されたことを確認する。
7. 同じ送信のretryでrequest_idが変わらないことを確認する。

対象4環境:

- Chrome + Tampermonkey
- Firefox + Tampermonkey
- Chrome + Violentmonkey
- Firefox + Violentmonkey

実機で確認していない組合せはPASSと記録しません。

## 本番分離

- public `dist/appamada_bmsir_submit.user.js`はPhase 1 SHA-256を維持
- test bundleとWeb App URLは`.local`だけ
- 本番Spreadsheet、本番Apps Script、`monsta-bms/appamada`は変更しない
- 公式反映、○、kkj更新、onEdit、recoveryはPhase 3まで実装しない
