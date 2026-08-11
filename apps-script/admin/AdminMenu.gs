function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("不放逸管理")
    .addItem("選択行を再処理", "reprocessSelectedAdminRows")
    .addItem("一時エラー行を再処理", "retryTemporaryAdminErrorsFromMenu")
    .addItem("○済み未完了行を確認", "inspectApprovedPendingAdminRows")
    .addSeparator()
    .addItem("中断トランザクションを回収", "recoverInterruptedTransactionsFromMenu")
    .addItem("MD5重複を検査", "inspectMd5Duplicates")
    .addItem("レベル順序を検査", "inspectTableOrder")
    .addItem("Trigger状態を確認", "inspectAdminTriggersFromMenu")
    .addToUi();
}

function reprocessSelectedAdminRows() {
  if (!isAdminApplyEnabled_()) {
    SpreadsheetApp.getUi().alert("管理反映は現在停止中です。");
    return { processed: 0, disabled: true };
  }
  var spreadsheet = getAdminSpreadsheet_();
  var sheet = spreadsheet.getActiveSheet();
  if (sheet.getName() !== ADMIN_CONFIG.applicationSheetName) {
    SpreadsheetApp.getUi().alert("申請一覧で対象行を選択してください。");
    return { processed: 0 };
  }
  var range = spreadsheet.getActiveRange();
  var firstRow = Math.max(2, range.getRow());
  var lastRow = range.getLastRow();
  var processed = 0;
  for (var rowNumber = firstRow; rowNumber <= lastRow; rowNumber += 1) {
    var application = readAdminApplication_(sheet, rowNumber);
    if (
      application.record.applyMark !== "○" ||
      (application.record.state !== "未処理" && application.record.state !== "エラー")
    ) continue;
    if (application.record.state === "エラー") {
      updateAdminApplicationOutcome_(spreadsheet, sheet, rowNumber, {
        state: "エラー",
        retryCount: application.record.retryCount + 1,
      });
    }
    processAdminApplicationRow_(rowNumber, { allowError: application.record.state === "エラー" });
    processed += 1;
  }
  SpreadsheetApp.getUi().alert("再処理対象: " + processed + "行");
  return { processed: processed };
}

function retryTemporaryAdminErrorsFromMenu() {
  var result = retryTemporaryAdminErrors();
  if (result.disabled) {
    SpreadsheetApp.getUi().alert("管理反映は現在停止中です。");
    return result;
  }
  SpreadsheetApp.getUi().alert(
    "一時エラー再処理: " + result.retried + "行 / 上限到達: " + result.exhausted + "行",
  );
  return result;
}

function inspectApprovedPendingAdminRows() {
  var spreadsheet = getAdminSpreadsheet_();
  var sheet = getAdminApplicationSheet_(spreadsheet);
  var rows = [];
  for (var rowNumber = 2; rowNumber <= sheet.getLastRow(); rowNumber += 1) {
    var application = readAdminApplication_(sheet, rowNumber);
    if (
      application.record.applyMark === "○" &&
      (application.record.state === "未処理" || application.record.state === "エラー")
    ) rows.push(rowNumber);
  }
  SpreadsheetApp.getUi().alert(rows.length ? "未完了行: " + rows.join(", ") : "○済み未完了行はありません。");
  return rows;
}

function recoverInterruptedTransactionsFromMenu() {
  var result = recoverInterruptedTransactions();
  if (result.disabled) {
    SpreadsheetApp.getUi().alert("管理反映は現在停止中です。");
    return result;
  }
  SpreadsheetApp.getUi().alert(
    "回収: " + result.recovered + " / metadata掃除: " + result.cleaned +
    " / 要確認: " + result.failed + " / 無視: " + result.ignored,
  );
  return result;
}

function inspectAdminTriggersFromMenu() {
  var result = inspectAdminTriggers();
  SpreadsheetApp.getUi().alert(JSON.stringify(result, null, 2));
  return result;
}
