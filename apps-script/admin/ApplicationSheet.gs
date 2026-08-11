function getAdminApplicationSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(ADMIN_CONFIG.applicationSheetName);
  if (!sheet) throwAdminError_("SHEET_NOT_FOUND", "申請一覧 sheet was not found", "エラー");
  var headers = sheet.getRange(1, 1, 1, ADMIN_APPLICATION_HEADERS.length).getValues()[0];
  var valid = headers.every(function (value, index) {
    return String(value) === ADMIN_APPLICATION_HEADERS[index];
  });
  if (!valid) throwAdminError_("SHEET_SCHEMA_INVALID", "申請一覧 A:S headers are invalid", "要確認");
  return sheet;
}

function setupAdminApplicationSheet() {
  var spreadsheet = getAdminSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(ADMIN_CONFIG.applicationSheetName);
  var created = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(ADMIN_CONFIG.applicationSheetName);
    created = true;
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, ADMIN_APPLICATION_HEADERS.length).setValues([
      ADMIN_APPLICATION_HEADERS.slice(),
    ]);
  } else {
    getAdminApplicationSheet_(spreadsheet);
  }
  sheet.setFrozenRows(1);
  return {
    ok: true,
    created: created,
    sheet_name: sheet.getName(),
    columns: ADMIN_APPLICATION_HEADERS.length,
  };
}

function readAdminApplication_(sheet, rowNumber) {
  if (rowNumber < 2 || rowNumber > sheet.getLastRow()) {
    throwAdminError_("BAD_REQUEST", "Application row is outside the sheet", "要確認");
  }
  var range = sheet.getRange(rowNumber, 1, 1, ADMIN_APPLICATION_HEADERS.length);
  var row = range.getValues()[0];
  var formulas = range.getFormulas()[0];
  return {
    rowNumber: rowNumber,
    row: row,
    formulas: formulas,
    record: {
      applyMark: String(row[0]),
      applicationType: String(row[1]),
      title: row[5],
      artist: row[6],
      md5: String(row[7]).toLowerCase(),
      originalLevel: String(row[8]),
      targetLevel: String(row[9]),
      state: String(row[12]),
      requestId: String(row[15]),
      retryCount: Number(row[18] || 0),
    },
    formulaMap: {
      title: formulas[5],
      artist: formulas[6],
      md5: formulas[7],
      originalLevel: formulas[8],
      targetLevel: formulas[9],
      requestId: formulas[15],
    },
  };
}

function writeAdminApplicationRowRaw_(spreadsheet, sheet, rowNumber, row) {
  var range = "'" + sheet.getName().replace(/'/g, "''") + "'!A" + rowNumber + ":S" + rowNumber;
  try {
    Sheets.Spreadsheets.Values.update(
      { values: [row] },
      spreadsheet.getId(),
      range,
      { valueInputOption: "RAW" },
    );
  } catch (error) {
    throwAdminError_("GOOGLE_SERVICE_ERROR", "申請一覧 could not be updated", "エラー");
  }
}

function updateAdminApplicationOutcome_(spreadsheet, sheet, rowNumber, options) {
  var current = readAdminApplication_(sheet, rowNumber);
  var row = current.row.slice();
  row[12] = options.state;
  row[13] = options.appliedAt === undefined ? row[13] : options.appliedAt;
  row[14] = options.memo === undefined ? row[14] : options.memo;
  row[17] = options.errorCode === undefined ? row[17] : options.errorCode;
  if (options.retryCount !== undefined) row[18] = options.retryCount;
  writeAdminApplicationRowRaw_(spreadsheet, sheet, rowNumber, row);
  return row;
}

function finalizeAdminApplication_(spreadsheet, sheet, rowNumber, memo) {
  return updateAdminApplicationOutcome_(spreadsheet, sheet, rowNumber, {
    state: "反映済",
    appliedAt: adminTimestamp_(),
    memo: memo,
    errorCode: "",
  });
}

function markAdminApplicationFailure_(spreadsheet, sheet, rowNumber, error) {
  var normalized = error instanceof AdminApplyError
    ? error
    : new AdminApplyError(
      "GOOGLE_SERVICE_ERROR",
      "Unexpected Google service failure: " + String(error && error.message ? error.message : error),
      "エラー",
    );
  return updateAdminApplicationOutcome_(spreadsheet, sheet, rowNumber, {
    state: normalized.state,
    memo: normalized.message,
    errorCode: normalized.code,
  });
}

function findAdminApplicationRowsByRequestId_(sheet, requestId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet
    .getRange(2, 16, lastRow - 1, 1)
    .createTextFinder(requestId)
    .matchEntireCell(true)
    .matchCase(true)
    .findAll()
    .map(function (range) { return range.getRow(); });
}
