# Phase 3 管理者承認

Phase 3はテストSpreadsheetにboundした管理用Apps Scriptです。本番Spreadsheet、本番Apps Script、公開`data_url`、公開Userscriptには導入しません。

## ○反映

installable onEdit triggerは「申請一覧」のA列と交差する編集だけを対象にします。複数行貼付ではevent valueを使わず、A列とM列を再読込して上から順に処理します。自動対象は`A=○`かつ`M=未処理`だけです。

各行は`ScriptLock.tryLock(3000)`で直列化し、lock取得後にA:S、formula、`kkj`を再読込します。1行が失敗しても後続行を処理します。

状態は次の5種類だけです。

- `未処理`: ○反映前
- `反映済`: kkj反映と申請一覧更新が完了
- `却下`: 管理者が手動設定。自動処理・recovery対象外
- `要確認`: stale、入力、表構造、競合など人間判断が必要
- `エラー`: lockやGoogle serviceなど一時的な技術障害

## change

反映前にMD5一意性、I/J難易度、現在のkkj level、表順序を再検証します。現在levelがIと違う場合は上書きせず`STALE_CURRENT_LEVEL` / `要確認`です。F/Gはchangeでは使用せず、kkj title/artistを変更しません。

kkj commentへ`yyyy.M.d 旧→新`を` / `区切りで追記します。同じ履歴が既にあれば追加しません。level変更後は対象level block末尾へ`moveRows`し、最終行番号を処理メモへ保存します。

移動が固定行またはbasic filterの見出しを跨ぐ場合、固定行数とfilter範囲・列条件を一時退避します。移動後は元の固定行数とfilterを復元し、通常の行移動ではこれらに触れません。移動後のDeveloper Metadataは古いオブジェクト参照を再利用せず、request_idで再検索します。

## new

○時点のF/Gセルを採用します。式が設定されたF/Gは`CELL_FORMULA_NOT_ALLOWED`、先頭末尾空白・制御文字・長さ違反は`CELL_TEXT_INVALID`、非NFCは`CELL_TEXT_NOT_NORMALIZED`として`要確認`へ停止します。内部空白は変更しません。

A:Eへ次の5値だけをSheets Advanced Serviceの`RAW`で書きます。

```text
level, title, artist, md5, ""
```

`=`, `+`, `-`, `@`で始まる文字列も式として評価しません。対象level blockがなければ現在の公開順で次のblock直前へ挿入します。同じMD5が先に追加済みなら`CHART_ALREADY_EXISTS` / `要確認`です。

## 表順序

Phase 3の順序は現在のkkj / 公開JSON実順序です。

```text
0..9, 10-, 10, 10+, 11-, 11, 11+, 12-, 12, 12+,
13, 13+, 14, 15, 16, ★★4?, ★★5?, ★★6?, ★★7?, ?
```

反映前後に次を検査します。

- 全levelが公開順序内
- 同じlevelが1つの連続block
- blockが昇順
- 内部空行なし
- 全MD5が32桁hex
- MD5重複なし

壊れた表は自動修正せず`TABLE_ORDER_INVALID`または`CHART_DUPLICATED`で停止します。

## Developer Metadataとrecovery

処理対象kkj行へkey `appamada_apply`のPROJECT metadataを付けます。valueはrequest_id、申請種別、申請行、元/先level、change履歴だけで、認証情報を含みません。

成功順序はkkj更新、申請一覧を`反映済`へ更新、metadata削除です。中断時はmetadataをrequest_idで申請一覧へ照合します。

- 申請が`反映済`: 一致metadataだけ削除
- changeがtarget level + 履歴済み: 正しいblock位置へ移動してfinalize
- changeがoriginal level: 履歴を重複させず再開
- newが完全一致: finalize
- newがblank row: A:EをRAW書込みしてfinalize
- その他の部分データ: `RECOVERY_FAILED` / `要確認`、上書き・metadata削除なし

テスト専用Script Property `TEST_FAIL_AFTER_MASTER_WRITE`、`TEST_FAIL_AFTER_APPLICATION_UPDATE`、`TEST_FAIL_AFTER_BLANK_INSERT`へ`true`または対象request_idを設定すると中断を再現できます。試験後は必ず削除します。未設定時は通常処理へ影響しません。

## retry

自動retry対象は`LOCK_TIMEOUT`と`GOOGLE_SERVICE_ERROR`だけです。開始直前にS列を加算し、最大3回です。上限後は`エラー`のまま処理メモを`自動再試行上限到達`へ更新します。`要確認`、`却下`、`反映済`は回収しません。

15分triggerはplanned metadata回収後にretryable errorを処理します。試験では`runScheduledRecovery()`を手動実行できます。

## 管理メニュー

`onOpen`はデータ変更をせず「不放逸管理」メニューだけを追加します。

- 選択行を再処理
- 一時エラー行を再処理
- ○済み未完了行を確認
- 中断トランザクションを回収
- MD5重複を検査
- レベル順序を検査
- Trigger状態を確認

`setupAdminTriggers()`はinstallable onEditと15分triggerを、同handlerの重複がない場合だけ作ります。`setupAdminSheetValidation()`は申請一覧A列を空欄/○運用に設定します。

## 管理者手順

新規申請:

1. F/Gを確認し、Notes/Illustration削除や表記統一を行う。
2. Jを確認する。
3. Aへ○を入力する。
4. Mが`反映済`、N/Oが更新されたことを確認する。

変更申請:

1. I/Jとコメントを確認する。
2. Aへ○を入力する。
3. Mが`反映済`、kkj行が対象blockへ移動したことを確認する。

却下はMを`却下`へ変更します。再検討する場合だけMを`未処理`へ戻してから○を再処理します。エラーは対象行を選択し「不放逸管理」→「選択行を再処理」を使用します。

## 主なerror code

`STALE_CURRENT_LEVEL`, `TABLE_ORDER_INVALID`, `CELL_FORMULA_NOT_ALLOWED`,
`CELL_TEXT_INVALID`, `CELL_TEXT_NOT_NORMALIZED`, `METADATA_CONFLICT`,
`RECOVERY_FAILED`, `GOOGLE_SERVICE_ERROR`, `LOCK_TIMEOUT`,
`CHART_ALREADY_EXISTS`, `CHART_DUPLICATED`。

構造化ログはtimestamp、request_id、application_type、action、application_row、md5、result、error_codeを記録し、Cookieやユーザー名を追加保存しません。

## テスト環境へのbound

`apps-script/admin`を本番ではないテストSpreadsheetへboundします。`.clasp.json`、Spreadsheet ID、Script ID、認証情報、test flag値はcommitしません。Phase 4の明示指示までは本番へ導入しません。

## Phase 3テスト結果（2026-08-11）

- Node: 既存Phase 1/2を含む111件すべて成功
- build/smoke: ローカル生成物とEOL正規化した固定公開distが一致、3件成功
- change: 上下、`0↔16`、通常↔特殊、`?↔通常`を実Spreadsheetで確認
- new: block有無、先頭、末尾、特殊、F/G管理者修正値を確認
- 防御: stale、same level、new競合、kkj MD5重複、表順序破損、F/G formula、title/artist長超過を確認
- RAW: `=`, `+`, `-`, `@`で始まるtitle/artistが数式にならないことを確認
- 複数行○、却下無視、一時エラーretryを確認
- fault injection: change更新後、new blank行挿入後、申請一覧更新後の復旧とmetadata掃除を確認
- comment履歴の二重追記なしを確認
- 固定行・filter見出しを跨ぐ移動後もfilter範囲が復元されることを確認
- 最終監査: MD5重複0、level block分断0、planned metadata残存0
- trigger: installable onEditと15分回収が各1件であることを確認

統合テストは開始時に`kkj`と「申請一覧」を同一Spreadsheet内へコピーし、`finally`で元のシート名へ復元します。実行ガード用Script Propertiesとfault injection値は試験後に削除済みです。
