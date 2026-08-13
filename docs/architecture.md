# Architecture

Phase 2のテスト申請経路は次の構成です。

```text
BMSIR
  ↓
Userscript
  ↓
Standalone Apps Script API
  ↓
申請一覧

テストSpreadsheetのkkj（read only）
  ↓ lookup
Standalone Apps Script API

申請一覧
  ↓ 管理者がA列へ○
bound Apps Script（Phase 3 / テスト環境）
  ↓ change/new/delete・順序検証・recovery
テストSpreadsheetのkkj
```

UserscriptはBMSIR Cookieやsessionを取得せず、ページDOMから取得したログインユーザーと譜面情報だけを使用します。通信は`anonymous: true`の`GM_xmlhttpRequest`で行い、Google ContentServiceのredirect後にtextをJSONとして解釈します。

parserはglobal `document` / `location`へ直接依存せず、`parseBmsirPage(document, pageUrl)`としてfixtureと実ページの両方から呼び出せます。URL、DOM、MD5三値をfail closedで検証し、原因は固定error codeで返します。

Standalone Apps ScriptはテストSpreadsheet IDをScript Propertiesから取得します。submitはScriptLock内でA:S schema、request_id、rate limit、kkj状態を検査し、Google Sheets Advanced Serviceの`valueInputOption: RAW`で申請一覧へ保存します。

公開`dist/appamada_bmsir_submit.user.js`はproduction API URLをbuild時に注入します。テストSpreadsheet、テストWeb App、本番環境をソース上で混在させません。

管理者反映経路はSpreadsheet-bound Apps Scriptで実行します。changeは行移動、newは行挿入、deleteはMD5一意性と投稿時現難易度を再検証したうえで該当行を削除します。`ADMIN_APPLY_ENABLED`が明示的に`true`でない場合は書込みません。
新規譜面のBMSIR title/artistは申請一覧F/G列の初期値に留め、管理者による修正を許容します。Phase 3の○反映では反映時点のF/Gセル値を正として`kkj`へ使用します。
