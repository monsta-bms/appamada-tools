# Phase 1 test

## 自動テスト

`npm test`は次を検証します。

- `#user`領域内（form内を除く）のlogin/logout/profileリンクを使うログインユーザー判定
- 通知件数、表示機種form、言語formからの独立
- login/logout/profile異常と固定error code
- BMSIR譜面URLと32桁MD5
- URL `songmd5`、`ranking_key`、`hash`の三者一致
- 現行`#box > main#main-content`と旧`#box`の共通resolverによるtitle/artist/MD5取得
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

## 2026-08-19 BMSIR DOM変更対応（0.4.3）

現行BMS-IR譜面ページを確認し、曲情報が旧`#box`直下から`#box > main#main-content`直下へ移動していることを確認しました。旧selectorはtitleとMD5情報がともに0件となり、`SONG_DOM_INVALID`でUI初期化前に終了していました。

- 現行DOM: `#box > main#main-content`直下の一意な`h1`、`h2`、MD5形式に一致する`p.muted`
- 旧DOM fallback: `#box`直下の一意な`h1`、`h2`、MD5形式に一致する`p.muted`
- title/artistは同じ曲情報containerのdirect childかつ文書順を確認し、別sectionの見出しを取得しません
- URL `songmd5`、`ranking_key`、`hash`の三点一致は維持します
- `#user`内の非formリンクを探索し、wrapper追加へ対応しつつlogin/logout/profileの一意性を維持します
- fatal parse failureは`DEBUG=false`でも固定codeとselector件数を`warn`へ出し、ユーザー名・曲名・MD5・DOM全文は記録しません
- BMS-IRの`button, input, select, textarea`暗色規則に対し、`.appamada-close`と`.appamada-comment textarea`だけ白背景・濃色文字を明示します

現行曲情報DOMは実ページから必要部分だけを匿名化して`logged-in-song-current.html`／`logged-out-song-current.html`へ反映しました。取得できたブラウザセッションは未ログインだったため、0.4.3 production candidateのログイン済み実機確認は別途実施します。現行ページにinline `oncontextmenu`、`contextmenu`を扱うscript、title/artistの差し替えを示す構造は確認されず、event propagationやSPA再描画は今回の原因ではありませんでした。
