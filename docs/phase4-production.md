# Phase 4 production rollout

Phase 4はGate制で進めます。各Gateが合格するまで次の本番変更を行いません。Spreadsheet ID、Script ID、Web App URL、認証情報は文書やGitへ記録しません（公開Userscriptへ最終API URLを注入する工程だけを除く）。

## Gate記録

- Gate 1: 本番Spreadsheet／bound Apps Script／公開JSONのバックアップ、権限・trigger・deployment・表構造監査を完了
- Gate 2: 新しい本番コピーでchange/new、防御、RAW、復旧、順序・filter保持、最終監査を完了。MD5重複0、level block分断0、planned metadata残存0
- Gate 3: 本番bound Apps Scriptへ管理処理を導入し、既存`doGet`不変、申請一覧A:S、管理Property停止、installable trigger各1を確認して完了
- Gate 4: 本番Standalone APIを別projectへ導入し、停止状態のlookup／submit拒否、候補Userscript実通信、一時的なproduction submit smokeと行削除、公開前監査を完了

公開前の最終監査では、公開JSON 11,984件、不正MD5 0、MD5重複0、level block 29、block分断0を確認しました。開始前snapshotとraw SHA-256が一致し、申請一覧はA:Sの19列headerだけです。candidateの実機確認ではmenu、parser、lookup、change/new modal、level操作、停止中表示、production submitを確認しました。smoke行は削除し、kkjへは反映していません。

## キルスイッチ

Standalone API:

- `SUBMIT_ENABLED=true`: submitを受け付ける
- 未設定または`false`: lookupは維持し、submitを`SUBMISSIONS_DISABLED`で拒否する

bound管理処理:

- `ADMIN_APPLY_ENABLED=true`: onEdit、手動再処理、recoveryによる反映を許可する
- 未設定または`false`: すべての反映・回収書込みを停止する。検査メニューは維持する

初回導入時は両方とも`false`にします。緊急停止はまず両Propertyを`false`へ変更し、必要なら公開Userscriptの配布も停止します。再開前に未処理／○済み行、planned metadata、MD5重複、level順序、trigger状態を検査します。

## 公開前条件

本番公開は、停止状態でのlookup、submit拒否、管理反映拒否、既存`doGet`維持を確認した後に行います。候補Userscriptでchange/newの実送信を確認し、管理者反映経路は本番コピーのdry-runで検証してからキルスイッチを有効化します。本番kkjへの架空反映は行いません。失敗時は有効化せず、直前backupと既存deploymentを保持したまま原因を調査します。

Userscript Managerは低いversionへ自動downgradeしない場合があります。公開後の緊急停止版／安全版は、公開中のversionより高いversion（0.3.0に対して0.3.1など）で配布します。
