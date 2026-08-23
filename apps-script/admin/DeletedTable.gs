var ADMIN_DELETED_HEADERS = Object.freeze(["level", "title", "artist", "md5", "comment"]);

function getAdminDeletedSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(ADMIN_CONFIG.deletedSheetName);
  if (!sheet) throwAdminError_("SHEET_NOT_FOUND", "削除済 sheet was not found", "エラー");
  var headers = sheet.getRange(1, 1, 1, ADMIN_DELETED_HEADERS.length).getValues()[0];
  var valid = headers.every(function (value, index) {
    return String(value) === ADMIN_DELETED_HEADERS[index];
  });
  if (!valid) {
    throwAdminError_("SHEET_SCHEMA_INVALID", "削除済 A:E headers are invalid", "要確認");
  }
  return sheet;
}

function readAdminDeletedState_(spreadsheet) {
  var sheet = getAdminDeletedSheet_(spreadsheet);
  var lastRow = sheet.getLastRow();
  var rows = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  var md5Rows = Object.create(null);
  rows.forEach(function (row, index) {
    var blank = row.every(function (value) { return String(value) === ""; });
    if (blank) return;
    var md5 = String(row[3]).trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(md5)) {
      throwAdminError_("SHEET_SCHEMA_INVALID", "削除済 invalid md5 at " + (index + 2), "要確認");
    }
    if (!md5Rows[md5]) md5Rows[md5] = [];
    md5Rows[md5].push(index + 2);
  });
  return { sheet: sheet, rows: rows, md5Rows: md5Rows };
}

function getAdminDeletedState_(spreadsheet, context) {
  if (context && context.deletedState) return context.deletedState;
  var state = readAdminDeletedState_(spreadsheet);
  if (context) context.deletedState = state;
  return state;
}

function assertAdminChartNotDeleted_(spreadsheet, md5, context) {
  var state = getAdminDeletedState_(spreadsheet, context);
  var normalized = String(md5).toLowerCase();
  if (state.md5Rows[normalized] && state.md5Rows[normalized].length) {
    throwAdminError_("DELETED_CHART_DUPLICATE", "削除済重複", "削除済重複");
  }
  return state;
}

function writeAdminDeletedRowRaw_(spreadsheet, sheet, rowNumber, row) {
  var range = "'" + sheet.getName().replace(/'/g, "''") + "'!A" + rowNumber + ":E" + rowNumber;
  try {
    Sheets.Spreadsheets.Values.update(
      { values: [row] },
      spreadsheet.getId(),
      range,
      { valueInputOption: "RAW" },
    );
  } catch (error) {
    throwAdminError_("GOOGLE_SERVICE_ERROR", "削除済 row could not be written", "エラー");
  }
}

function archiveAdminDeletedChart_(spreadsheet, masterRow, context) {
  var state = getAdminDeletedState_(spreadsheet, context);
  var row = masterRow.slice(0, 5);
  var md5 = String(row[3]).toLowerCase();
  var existing = state.md5Rows[md5] || [];
  if (existing.length) {
    return { ok: true, alreadyArchived: true, rowNumber: existing[0] };
  }
  var rowNumber = Math.max(2, state.sheet.getLastRow() + 1);
  row[3] = md5;
  writeAdminDeletedRowRaw_(spreadsheet, state.sheet, rowNumber, row);
  state.rows.push(row.slice());
  state.md5Rows[md5] = [rowNumber];
  return { ok: true, alreadyArchived: false, rowNumber: rowNumber };
}

function assertAdminDeletedChartArchived_(spreadsheet, md5, context) {
  var state = getAdminDeletedState_(spreadsheet, context);
  var matches = state.md5Rows[String(md5).toLowerCase()] || [];
  if (!matches.length) {
    throwAdminError_("RECOVERY_FAILED", "deleted chart archive is missing", "要確認");
  }
  return matches[0];
}
