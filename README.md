# appamada-tools

BMS難易度表「不放逸」とBMSIRを連携するUserscriptの開発リポジトリです。TampermonkeyとViolentmonkeyで、次のBMSIR譜面ページを対象にします。

- `https://bms-ir.org/new/song*`
- `https://www.bms-ir.org/new/song*`

## Phase 1の範囲

Phase 1は、ログインユーザーと譜面情報を正確に読み取るparser、難易度定数、fixture test、配布用Userscriptのビルド基盤だけを実装しています。投稿UI、Apps Script API、Spreadsheetへの書込み、外部通信はまだ接続していません。

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

生成物は `dist/appamada_bmsir_submit.user.js` です。GitHub Raw URLからTampermonkeyまたはViolentmonkeyへインストールできます。

## 秘密情報

BMSIR Cookie、セッション、localStorage、API token、Spreadsheet ID、Google credentialsを取得・保存・commitしません。`.env`、`.clasp.json`、credentials/secrets系ファイルはGit管理から除外します。
