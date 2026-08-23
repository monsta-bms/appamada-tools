var RECENT_TABLE_HEADERS = Object.freeze(["level", "title", "artist", "md5", "comment"]);

function parseRecentTableDateOrdinal_(comment) {
  if (comment && typeof comment.getTime === "function" && !isNaN(comment.getTime())) {
    comment = Utilities.formatDate(comment, ADMIN_CONFIG.timezone, "yyyy/MM/dd");
  }
  var match = String(comment || "").match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})(?:\s|$)/);
  if (!match) return null;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) return null;
  return Math.floor(value.getTime() / 86400000);
}

function recentTableTodayOrdinal_(now) {
  var today = Utilities.formatDate(now || new Date(), ADMIN_CONFIG.timezone, "yyyy/M/d");
  var ordinal = parseRecentTableDateOrdinal_(today);
  if (ordinal === null) throwAdminError_("GOOGLE_SERVICE_ERROR", "today could not be parsed", "エラー");
  return ordinal;
}

function filterRecentTableRows_(rows, windowDays, todayOrdinal) {
  var days = Number(windowDays);
  if (!Number.isInteger(days) || days < 1) throw new Error("windowDays must be a positive integer");
  var cutoff = todayOrdinal - days + 1;
  return rows.filter(function (row) {
    var date = parseRecentTableDateOrdinal_(row[4]);
    return date !== null && date >= cutoff && date <= todayOrdinal;
  });
}

function readRecentTableSourceRows_(masterSheet) {
  var lastRow = masterSheet.getLastRow();
  if (lastRow < 1) throwAdminError_("SHEET_SCHEMA_INVALID", "kkj is empty", "要確認");
  var headers = masterSheet.getRange(1, 1, 1, 5).getValues()[0];
  var valid = headers.every(function (value, index) {
    return String(value) === RECENT_TABLE_HEADERS[index];
  });
  if (!valid) throwAdminError_("SHEET_SCHEMA_INVALID", "kkj A:E headers are invalid", "要確認");
  return lastRow < 2 ? [] : masterSheet.getRange(2, 1, lastRow - 1, 5).getValues();
}

function overwriteRecentTableSheet_(spreadsheet, sheetName, rows) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  sheet.clearContents();
  var values = [RECENT_TABLE_HEADERS.slice()].concat(rows.map(function (row) { return row.slice(0, 5); }));
  var range = sheet.getRange(1, 1, values.length, 5);
  range.setNumberFormat("@");
  range.setValues(values);
  sheet.setFrozenRows(1);
  return sheet;
}

function generateRecentTable_(sheetName, windowDays) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    SpreadsheetApp.getUi().alert("別の処理が実行中です。少し待ってから再実行してください。");
    return { ok: false, code: "LOCK_TIMEOUT" };
  }
  try {
    var spreadsheet = getAdminSpreadsheet_();
    var masterSheet = getAdminMasterSheet_(spreadsheet);
    var sourceRows = readRecentTableSourceRows_(masterSheet);
    var todayOrdinal = recentTableTodayOrdinal_(new Date());
    var selected = filterRecentTableRows_(sourceRows, windowDays, todayOrdinal);
    overwriteRecentTableSheet_(spreadsheet, sheetName, selected);
    SpreadsheetApp.flush();
    SpreadsheetApp.getUi().alert(
      sheetName + "シートを上書きしました。対象: " + selected.length + "譜面",
    );
    return { ok: true, sheetName: sheetName, rowCount: selected.length, windowDays: windowDays };
  } finally {
    lock.releaseLock();
  }
}

function generateRecentWeekTable() {
  return generateRecentTable_("一週間", 7);
}

function generateRecentMonthTable() {
  return generateRecentTable_("一ヶ月", 30);
}
