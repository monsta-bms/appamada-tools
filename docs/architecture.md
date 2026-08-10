# Architecture

将来の申請経路は次を予定しています。

```text
BMSIR
  ↓
Userscript
  ↓
Standalone Apps Script API
  ↓
申請一覧

管理者
  ↓
Spreadsheet bound Apps Script
  ↓
kkj
```

Phase 1で実装するのはUserscript基盤、BMSIR parser、LEVEL定数、fixture testまでです。Apps Script API、Spreadsheet操作、申請送信、kkj反映は未実装です。

parserはglobal `document` / `location`へ直接依存せず、`parseBmsirPage(document, pageUrl)`としてfixtureと実ページの両方から呼び出せます。URL、DOM、MD5三値をfail closedで検証し、原因は固定error codeで返します。
