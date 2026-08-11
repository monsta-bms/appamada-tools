function processAdminApplicationRow_(rowNumber, options) {
  var settings = options || {};
  var spreadsheet = getAdminSpreadsheet_();
  var applicationSheet = getAdminApplicationSheet_(spreadsheet);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    var lockError = new AdminApplyError("LOCK_TIMEOUT", "ScriptLockを取得できませんでした", "エラー");
    markAdminApplicationFailure_(spreadsheet, applicationSheet, rowNumber, lockError);
    return { ok: false, code: lockError.code };
  }

  var application;
  try {
    application = readAdminApplication_(applicationSheet, rowNumber);
    if (application.record.applyMark !== "○") return { ok: false, ignored: true };
    if (!AppamadaAdminLogic.canProcessState(application.record.state, settings.allowError)) {
      return { ok: false, ignored: true };
    }
    validateAdminApplication_(application, settings.allowError);
    var masterSheet = getAdminMasterSheet_(spreadsheet);
    var action = application.record.applicationType === "change" ? "apply_change" : "apply_new";
    var result = application.record.applicationType === "change"
      ? applyAdminChange_(spreadsheet, applicationSheet, masterSheet, application)
      : applyAdminNew_(spreadsheet, applicationSheet, masterSheet, application);
    logAdminDiagnostic_({
      request_id: application.record.requestId,
      application_type: application.record.applicationType,
      action: action,
      application_row: rowNumber,
      md5: application.record.md5,
      result: "success",
    });
    return result;
  } catch (error) {
    if (error instanceof AdminInjectedFault) throw error;
    markAdminApplicationFailure_(spreadsheet, applicationSheet, rowNumber, error);
    logAdminDiagnostic_({
      request_id: application ? application.record.requestId : "",
      application_type: application ? application.record.applicationType : "",
      action: "apply",
      application_row: rowNumber,
      md5: application ? application.record.md5 : "",
      result: "error",
      error_code: error instanceof AdminApplyError ? error.code : "GOOGLE_SERVICE_ERROR",
    });
    return { ok: false, code: error instanceof AdminApplyError ? error.code : "GOOGLE_SERVICE_ERROR" };
  } finally {
    lock.releaseLock();
  }
}

function handleAdminEdit(e) {
  if (!e || !e.range) return;
  var range = e.range;
  var sheet = range.getSheet();
  if (sheet.getName() !== ADMIN_CONFIG.applicationSheetName) return;
  if (range.getColumn() > 1 || range.getLastColumn() < 1) return;
  var firstRow = Math.max(2, range.getRow());
  var lastRow = range.getLastRow();
  if (lastRow < firstRow) return;
  var values = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, 13).getValues();
  values.forEach(function (row, index) {
    if (String(row[0]) !== "○" || String(row[12]) !== "未処理") return;
    var rowNumber = firstRow + index;
    try {
      processAdminApplicationRow_(rowNumber, { allowError: false });
    } catch (error) {
      logAdminDiagnostic_({
        action: "on_edit",
        application_row: rowNumber,
        result: "error",
        error_code: error.code || "GOOGLE_SERVICE_ERROR",
      });
    }
  });
}
