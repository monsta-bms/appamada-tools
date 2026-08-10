# Phase 2 API

Phase 2はテスト用Standalone Apps Script Web Appと、本番Spreadsheetのコピーだけを使用します。本番Apps Script、本番Spreadsheet、公式`kkj`は変更しません。

## 構成

Apps Script sourceは`apps-script/api`にあります。

- `Api.gs`: `doGet` / `doPost`、JSON境界、固定error応答
- `Config.gs`: headers、LEVEL、Script Properties
- `Validation.gs`: payload、URL、文字数、制御文字
- `Lookup.gs`: `kkj` D列完全一致lookup、短期cache
- `Submit.gs`: lock内の冪等性・検査・保存フロー
- `RateLimit.gs`: 10分bucketのbest-effort制限
- `SheetStore.gs`: A:S schema、明示setup、RAW append
- `Logging.gs`: 個人情報を増やさない構造化診断ログ

## Script Properties

必須:

- `SPREADSHEET_ID`: テストSpreadsheet ID

任意のテストoverride:

- `USER_LIMIT`（default `60`）
- `USER_MD5_LIMIT`（default `10`）
- `GLOBAL_LIMIT`（default `500`）

overrideはrate limit試験後に削除します。値は正の整数だけを許可します。

## テストSpreadsheet

本番Spreadsheetのコピーを使用し、`kkj`と`申請一覧`を用意します。初回だけApps Script editorから`setupApplicationSheet()`を明示実行できます。

この関数は`申請一覧`がなければ作成し、次のA:S headerと1行freezeを設定します。既存headerが違う場合は変更せず`SHEET_SCHEMA_INVALID`で停止します。

```text
反映,申請種別,投稿日時,BMSIRユーザー名,BMSIRプレイヤーID,曲名,artist,md5,
投稿時現難易度,難易度案,コメント,IR URL,状態,反映日時,処理メモ,
request_id,client_version,エラーコード,再試行回数
```

Phase 2ではA列を常に空欄で追加し、onEditや○処理を作りません。

新規譜面申請のF列「曲名」とG列「artist」には、投稿時点のBMSIR DOMから取得した値を初期値として保存します。これらのセルは管理者が○反映前に手修正できる運用とし、保護やBMSIR値への再固定は行いません。BMSIRのartistにはNotes / Illustration等が含まれ得るため、将来の○反映処理はBMSIR取得値ではなく、反映時点のF/Gセル内容を`kkj`へ使用する契約です。

## lookup

```http
GET /exec?action=lookup&md5=<32hex>
```

`kkj` D列を完全一致検索し、0件、1件、複数を区別します。登録済みは120秒、未登録は30秒だけCacheServiceへ保存します。lookupは投稿rate limitへ含めません。

## submit

```http
POST /exec
Content-Type: text/plain;charset=UTF-8
```

bodyはJSONです。`change`はtitle/artist/current levelをclientから受けず、`kkj`から再取得します。`new`だけBMSIR parser由来title/artistを送ります。

処理順序:

1. payload validation
2. `ScriptLock.tryLock(3000)`
3. A:S schema検査
4. P列request_id完全一致
5. 同一payloadなら`deduplicated: true`
6. rate limit
7. cacheを使わない`kkj`再確認
8. 申請行作成
9. Sheets Advanced Service `valueInputOption: RAW`でA:Sへ保存

同じrequest_idと異なるpayloadは`REQUEST_ID_CONFLICT`です。冪等再送はrate countより前に返します。

## deploy手順

1. テストSpreadsheetのURLまたはIDを確定する。
2. Googleアカウントで`clasp login`する。
3. `apps-script/api`でStandalone project `appamada-feedback-api-test`を作成する。
4. sourceと`appsscript.json`をpushする。
5. Apps Script Project SettingsのScript Propertiesへ`SPREADSHEET_ID`を設定する。
6. editorから`setupApplicationSheet()`を1回実行し、権限を承認する。
7. Web Appとして「実行ユーザー: deploy者」「アクセス: Anyone」でdeployする。
8. `/exec` URLを`APPAMADA_API_URL`へ一時設定してtest Userscriptをbuildする。

`.clasp.json`、Spreadsheet ID、Web App URL、認証情報はcommitしません。

## 固定error code

`BAD_REQUEST`, `APPLICATION_TYPE_INVALID`, `LOGIN_NAME_MISSING`, `PLAYER_ID_INVALID`,
`MD5_INVALID`, `MD5_MISMATCH`, `IR_URL_INVALID`, `CHART_NOT_FOUND`,
`CHART_DUPLICATED`, `CHART_ALREADY_EXISTS`, `CURRENT_LEVEL_UNSUPPORTED`,
`TITLE_REQUIRED`, `TITLE_TOO_LONG`, `ARTIST_REQUIRED`, `ARTIST_TOO_LONG`,
`LEVEL_REQUIRED`, `LEVEL_INVALID`, `SAME_AS_CURRENT`, `COMMENT_TOO_LONG`,
`CLIENT_VERSION_INVALID`, `REQUEST_ID_INVALID`, `REQUEST_ID_CONFLICT`,
`RATE_LIMITED`, `LOCK_TIMEOUT`, `SHEET_NOT_FOUND`, `SHEET_SCHEMA_INVALID`,
`WRITE_FAILED`, `INTERNAL_ERROR`。
