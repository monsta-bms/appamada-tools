function buildAdminCommentDateNormalizationPlan_(values, formulas, firstRow) {
  var normalized = [];
  var changedRows = [];
  var dateValueRows = [];
  var formulaRows = [];
  var nonEmptyRows = 0;
  values.forEach(function (row, index) {
    var rowNumber = firstRow + index;
    var value = row[0];
    var text = value === null || value === undefined ? "" : String(value);
    var formula = formulas[index] && formulas[index][0];
    if (formula) formulaRows.push(rowNumber);
    if (text) nonEmptyRows += 1;
    var isDateValue = value && typeof value.getTime === "function" && !isNaN(value.getTime());
    if (isDateValue) {
      dateValueRows.push(rowNumber);
    }
    var output = normalizeAdminCommentDates_(value);
    normalized.push([output]);
    if (text !== output || isDateValue) {
      changedRows.push(rowNumber);
    }
  });
  return {
    normalized: normalized,
    rowCount: values.length,
    nonEmptyRowCount: nonEmptyRows,
    changedRows: changedRows,
    dateValueRows: dateValueRows,
    formulaRows: formulaRows,
  };
}

function inspectAdminMasterCommentDates_(writeChanges) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throwAdminError_("LOCK_TIMEOUT", "comment normalization lock timeout", "エラー");
  try {
    var spreadsheet = getAdminSpreadsheet_();
    var sheet = getAdminMasterSheet_(spreadsheet);
    if (String(sheet.getRange(1, 5).getValue()) !== "comment") {
      throwAdminError_("SHEET_SCHEMA_INVALID", "kkj E1 must be comment", "要確認");
    }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return { ok: true, applied: Boolean(writeChanges), rowCount: 0, changedRowCount: 0, dateValueRowCount: 0 };
    }
    var range = sheet.getRange(2, 5, lastRow - 1, 1);
    var plan = buildAdminCommentDateNormalizationPlan_(range.getValues(), range.getFormulas(), 2);
    if (plan.formulaRows.length) {
      throwAdminError_(
        "FORMULA_DETECTED",
        "kkj comment formulas at rows: " + plan.formulaRows.slice(0, 20).join(","),
        "要確認",
      );
    }
    var summary = {
      ok: true,
      applied: Boolean(writeChanges),
      rowCount: plan.rowCount,
      nonEmptyRowCount: plan.nonEmptyRowCount,
      changedRowCount: plan.changedRows.length,
      dateValueRowCount: plan.dateValueRows.length,
    };
    if (!writeChanges || !plan.changedRows.length) return summary;

    range.setNumberFormat("@");
    var a1 = "'" + sheet.getName().replace(/'/g, "''") + "'!E2:E" + lastRow;
    Sheets.Spreadsheets.Values.update(
      { values: plan.normalized },
      spreadsheet.getId(),
      a1,
      { valueInputOption: "RAW" },
    );
    SpreadsheetApp.flush();
    var actual = range.getValues();
    var mismatches = [];
    actual.forEach(function (row, index) {
      if (String(row[0] || "") !== plan.normalized[index][0]) mismatches.push(index + 2);
    });
    if (mismatches.length) {
      throwAdminError_(
        "GOOGLE_SERVICE_ERROR",
        "kkj comment normalization verification failed at rows: " + mismatches.slice(0, 20).join(","),
        "エラー",
      );
    }
    logAdminDiagnostic_({
      action: "normalize_comment_dates",
      result: "success",
      row_count: summary.rowCount,
      changed_row_count: summary.changedRowCount,
      date_value_row_count: summary.dateValueRowCount,
    });
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function auditAdminMasterCommentDates() {
  var summary = inspectAdminMasterCommentDates_(false);
  SpreadsheetApp.getUi().alert(
    "kkjコメント日付監査: " + summary.changedRowCount + "行を正規化できます。Date型: " + summary.dateValueRowCount + "行",
  );
  return summary;
}

function normalizeAdminMasterCommentDates() {
  var summary = inspectAdminMasterCommentDates_(true);
  SpreadsheetApp.getUi().alert(
    "kkjコメント日付をYYYY/MM/DDへ統一しました。変更: " + summary.changedRowCount + "行",
  );
  return summary;
}
