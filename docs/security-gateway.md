# 申請受付の保護（0.4.8）

2026-10-22、Userscript 0.4.8を公開。申請受付は `https://appamada-submission-gateway.monsta3228gsl.workers.dev/api`。公開Userscriptの更新・導入URLは従来どおり。

## 変更点と互換性

申請者が自由に入力できるBMSIR名・プレイヤーIDを回数制限の根拠にしない。受付WorkerがCloudflareの送信元IPを用途別HMACで変換し、その送信元ごとのDurable Objectで試行数を原子的に管理する。生IPはGASへ転送せず、DOにも保存しない。

- 同じ送信元の申請試行: 60回/600秒。同じ送信元・MD5の試行: 10回/600秒。
- 名前・ID・User-Agent・対象MD5を変えても送信元全体の枠を変更できない。共有IPの利用者は枠を共有する。
- lookupは180回/600秒で別枠。申請本文の最大32KiB、上流応答64KiB、上流通信8秒の上限を設定。
- Workerは固定設定のGASだけへ転送し、リダイレクトもGoogleの所定ホストに限定する。
- WorkerからGASへは、時刻・送信元ハッシュ・申請本文をHMAC-SHA256署名したenvelopeを送る。GASは署名と±5分の時刻を検証し、未署名の直接POSTを拒否する。署名の再送は既存request_idの冪等処理で重複書込みを防ぐ。
- GASの送信元制限も署名済み送信元ハッシュを使う。正常な申請の共通受付枠は譜面存在・内容の検査後に消費し、無効な試行はWorker側の送信元枠で抑える。
- new/change/deleteの本文、JSON結果、申請一覧A:S、RAW書込み、管理者の承認・反映、難易度順、削除済み判定は維持。
- 保存済み提案のキーとデータ形式は変更しない。受付の設定・認証エラーでも提案はpendingとして保持し、内容を変更せず再試行できる。
- 旧0.4.7の直接申請には、従来から再試行対象の`SUBMISSIONS_DISABLED`を返して保存を維持する。無署名の受付は開けない。0.4.8への更新後に保存済みの提案を再送する。
- 過去のクライアントで4種類のgatewayエラーだけを理由にrejectedになった有効な本人の提案は、読み出し時にpendingへ戻す。元payload・request_id・試行回数を保持し、receipt・取消・他アカウント・入力不備による拒否は優先する。読み出しだけでは保存内容を書き換えず、通常の送信処理で次の試行を保存する。
- BMSIR名とプレイヤーIDは引き続き自己申告であり、この受付保護はBMSIRアカウントの本人確認を保証しない。承認時に本人確認済み情報として扱わない。

## 設定

Worker設定は `gateway/wrangler.jsonc`。D1/R2や既存リサイクルセンターのWorkerを利用・変更しない独立した受付である。Durable ObjectsのSQLite bindingが1種類必要。

Workerに必要なsecrets:

- `GAS_API_URL`: 既存Standalone APIのHTTPS `/macros/s/.../exec` URL。
- `GATEWAY_SHARED_SECRET`: 暗号学的にランダムな32文字以上の共有鍵。GAS Script Propertiesにも同じ値を設定する。

これらは既定値を空欄にした `gateway/.dev.vars.example` を参考に、ローカルならignore対象の `.dev.vars`、本番ならCloudflare secretsとGAS Script Propertiesへ設定する。実値をソース・配布物・ログへ書かない。

GASは `Gateway.gs` を含むAPIソース一式が必要。`GATEWAY_SHARED_SECRET` が未設定・短い場合は申請を拒否し、lookupは維持する。署名を省略できる互換モードは設けていない。

公開版の `APPAMADA_API_URL` は、実際に設定した受付WorkerのHTTPS `https://<worker>.<account>.workers.dev/api` とする。build時にそのホストだけをUserscriptの `@connect` へ追加し、ワイルドカード許可は使わない。`build:public` は受付Worker以外のURLを拒否する。

## 切替と利用者の更新

**WorkerとGASの設定、Userscriptの更新をそろえる。** 切替中は`SUBMIT_ENABLED=false`で受付を停止し、lookupは維持する。Workerと署名を検証するGASを準備した後、公開distを生成・検査して0.4.8を公開し、設定と公開GETを確認してから受付を再開する。署名検証を外す互換モードや、旧版の無署名申請を受け付ける期間は設けない。

利用者は同じブラウザとUserscriptマネージャーで公開Userscriptを通常更新する。スクリプトや保存領域を削除しない。新しい受付先への接続許可が表示された場合は承認し、ログイン中のBMSIR譜面ページを再読み込みする。旧版で送信待ちになった提案は更新後に再送される。ブラウザや端末を変えても保存データは自動移行しない。

今回の確認範囲は、ローカル環境での通常申請・重複排除・保存済み提案の再送と、実公開受付のGETによる読み取りまで。本人のBMSIRログイン環境、Userscriptマネージャーの更新・接続許可画面、実機からのnew/change/delete申請は未確認。本番へ確認用の架空申請は追加していない。

## ローカル検証

```sh
npm ci --ignore-scripts
npm run check
npm run test:gateway
npm audit --ignore-scripts
```

`check` は既存の管理・申請・UI・保存済み提案の回帰と署名検証、候補build、DOM smokeを実行する。公開distは0.4.8のmetadataと正確な接続権限を検査し、受付URLと対応する追加接続権限以外が候補と全文一致することを要求する。ソース変更時は、設定済みURLで`build:public`を再生成して最終検査する。

`test:gateway` はMiniflare/Workerdの実WorkerとSQLite DO、GASのfake Sheetsを接続する。外向き通信を全てローカルスタブへ置き換え、並列試行上限、HMAC互換、通常申請・冪等性、上限、Origin、外部へのリダイレクト拒否を確認する。エミュレーターへのloopback接続権限が必要な環境がある。

ローカル用の候補のみを生成する場合は `npm run build:gateway-check`。生成先は `.local/appamada_bmsir_submit.gateway-check.user.js`。実際の公開URL・認証設定は含めていないので、利用者への配布用ではない。

## 変更ファイル

API: `Api.gs`, `Gateway.gs`, `RateLimit.gs`, `Submit.gs`。受付: `gateway/worker.js`, `gateway/wrangler.jsonc`, `gateway/.dev.vars.example`。クライアント: `src/api-client.js`, `src/outbox.js`, `src/ui.js`, `src/userscript-header.txt`。buildと依存: build scripts、package.json/lock、ignore設定。テスト: GAS harness、gateway認証・実Worker・build回帰、outbox回帰、dist smoke。公開サイトの使い方・更新履歴には、利用者向けの変更点と更新時の操作を記載する。
