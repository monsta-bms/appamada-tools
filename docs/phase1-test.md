# Phase 1 test

## 自動テスト

`npm test`は次を検証します。

- `#user`直下リンクだけを使うログインユーザー判定
- 通知件数、表示機種form、言語formからの独立
- login/logout/profile異常と固定error code
- BMSIR譜面URLと32桁MD5
- URL `songmd5`、`ranking_key`、`hash`の三者一致
- `#box > h1`と直後の`h2`
- title/artistの必須・Unicode code point上限
- 内部空白、Notes/Illustration、NFC、HTML entityの保持
- LEVEL集合、↑↓遷移、特殊難易度、重複なし

`npm run smoke`は生成済みUserscriptについて、metadata先頭、対象`@match`、version、`document-idle`、`noframes`、構文、source map/test code混入なしを確認します。
さらに、生成bundleをログイン済み／未ログインfixture上で実行し、例外、DOM変更、`fetch`、`GM_xmlhttpRequest`、`GM_addStyle`呼出しがないことを確認します。

## 一括確認

```sh
npm run check
```

## 実ページsmoke test

1. `npm run build`を実行する。
2. `dist/appamada_bmsir_submit.user.js`をTampermonkeyまたはViolentmonkeyへ読み込む。
3. ログイン中に対象BMSIR譜面ページを開く。
4. ページ表示が変わらず、外部通信が発生せず、JavaScript例外がないことを確認する。
5. Phase 1はUIを追加しないため、通常状態ではconsole出力がないことを確認する。

Chrome/Firefox × Tampermonkey/Violentmonkeyの4環境実機確認は、各環境を利用できる場合に記録します。

## 2026-08-10 BMSIR実ページ確認

対象譜面をin-app Browserで読み込み、次を確認しました。

- `#box > h1`は1件で、titleは `図書室のエルザ [FOX]`
- title直後は`H2`で、Notes/Illustrationを含むartist全文を取得可能
- MD5 patternに一致する`#box > p.muted`は1件
- URL `songmd5`、`ranking_key`、`hash`は一致
- 利用できたブラウザセッションは未ログイン状態

in-app Browserは安全上、ページ内の`eval`／`Function`を無効化しているため、生成bundleの実ページへの直接注入は実施できませんでした。生成bundleの実行確認は上記jsdom runtime smoke testで代替しています。Chrome/Firefox × Tampermonkey/Violentmonkeyの4環境実機確認は未実施です。
