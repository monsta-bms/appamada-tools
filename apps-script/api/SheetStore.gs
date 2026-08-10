function getSpreadsheet_(providedConfig) {
  var config = providedConfig || getAppamadaConfig_();
  try {
    return SpreadsheetApp.openById(config.spreadsheetId);
  } catch (error) {
    throwApiError_("SHEET_NOT_FOUND", "Spreadsheet could not be opened");
  }
}

function assertApplicationSchema_(sheet) {
  var actual = sheet.getRange(1, 1, 1, APPAMADA_APPLICATION_HEADERS.length).getValues()[0];
  var matches = actual.length === APPAMADA_APPLICATION_HEADERS.length && actual.every(function (value, index) {
    return String(value) === APPAMADA_APPLICATION_HEADERS[index];
  });
  if (!matches) throwApiError_("SHEET_SCHEMA_INVALID", "Application sheet headers are invalid");
}

function getApplicationSheet_(providedConfig, providedSpreadsheet) {
  var spreadsheet = providedSpreadsheet || getSpreadsheet_(providedConfig);
  var sheet = spreadsheet.getSheetByName(APPAMADA_DEFAULTS.applicationSheetName);
  if (!sheet) throwApiError_("SHEET_NOT_FOUND", "Application sheet was not found");
  assertApplicationSchema_(sheet);
  return sheet;
}

function setupApplicationSheet() {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(APPAMADA_DEFAULTS.applicationSheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(APPAMADA_DEFAULTS.applicationSheetName);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, APPAMADA_APPLICATION_HEADERS.length).setValues([
      APPAMADA_APPLICATION_HEADERS.slice(),
    ]);
  } else {
    assertApplicationSchema_(sheet);
  }
  sheet.setFrozenRows(1);
  return { sheet_name: sheet.getName(), columns: APPAMADA_APPLICATION_HEADERS.length };
}

function findRequestRow_(sheet, requestId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var matches = sheet
    .getRange(2, 16, lastRow - 1, 1)
    .createTextFinder(requestId)
    .matchEntireCell(true)
    .matchCase(true)
    .findAll();
  if (matches.length > 1) {
    throwApiError_("REQUEST_ID_CONFLICT", "request_id exists more than once");
  }
  return matches.length === 1 ? matches[0].getRow() : null;
}

function storedRequestMatches_(row, payload) {
  function equal(index, value) {
    return String(row[index] === null || row[index] === undefined ? "" : row[index]) === String(value);
  }
  if (
    !equal(1, payload.application_type) ||
    !equal(3, payload.bmsir_user_name) ||
    !equal(4, payload.bmsir_player_id) ||
    !equal(7, payload.md5) ||
    !equal(9, payload.proposed_level) ||
    !equal(10, payload.comment) ||
    !equal(11, payload.ir_url) ||
    !equal(15, payload.request_id) ||
    !equal(16, payload.client_version)
  ) {
    return false;
  }
  return payload.application_type !== "new" || (equal(5, payload.title) && equal(6, payload.artist));
}

function createApplicationRow_(payload, chart, config) {
  var timestamp = Utilities.formatDate(new Date(), config.timezone, "yyyy/MM/dd HH:mm:ss");
  return [
    "",
    payload.application_type,
    timestamp,
    payload.bmsir_user_name,
    payload.bmsir_player_id,
    payload.application_type === "new" ? payload.title : chart.title,
    payload.application_type === "new" ? payload.artist : chart.artist,
    payload.md5,
    payload.application_type === "new" ? "" : chart.current_level,
    payload.proposed_level,
    payload.comment,
    payload.ir_url,
    "未処理",
    "",
    "",
    payload.request_id,
    payload.client_version,
    "",
    0,
  ];
}

function appendApplicationRowRaw_(sheet, row, config) {
  var rowNumber = Math.max(sheet.getLastRow() + 1, 2);
  var range = "'" + config.applicationSheetName.replace(/'/g, "''") + "'!A" + rowNumber + ":S" + rowNumber;
  try {
    Sheets.Spreadsheets.Values.update(
      { values: [row] },
      config.spreadsheetId,
      range,
      { valueInputOption: "RAW" },
    );
  } catch (error) {
    throwApiError_("WRITE_FAILED", "Application row could not be written");
  }
}
