function analyzeTableOrder(rows) {
  return AppamadaAdminLogic.analyzeTableOrder(rows, 1);
}

function inspectTableOrder() {
  var result = auditAdminTableOrder_();
  SpreadsheetApp.getUi().alert(
    "レベル順序は正常です。行数: " + result.rowCount + " / block数: " + result.blockCount,
  );
  return result;
}

function inspectMd5Duplicates() {
  var result = auditAdminMd5Duplicates_();
  SpreadsheetApp.getUi().alert("MD5重複はありません。行数: " + result.rowCount);
  return result;
}
