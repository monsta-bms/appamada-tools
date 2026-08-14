function processAdminApplicationRowLocked_(rowNumber, settings, context) {
  var application;
  try {
    application = readAdminApplication_(context.applicationSheet, rowNumber);
    if (application.record.applyMark !== "○") return { ok: false, ignored: true };
    if (!AppamadaAdminLogic.canProcessState(application.record.state, settings.allowError)) {
      return { ok: false, ignored: true };
    }
    validateAdminApplication_(application, settings.allowError);
    if (!context.masterSheet) context.masterSheet = getAdminMasterSheet_(context.spreadsheet);
    var action = application.record.applicationType === "change"
      ? "apply_change"
      : application.record.applicationType === "delete" ? "apply_delete" : "apply_new";
    var result = application.record.applicationType === "change"
      ? applyAdminChange_(context.spreadsheet, context.applicationSheet, context.masterSheet, application, context)
      : application.record.applicationType === "delete"
        ? applyAdminDelete_(context.spreadsheet, context.applicationSheet, context.masterSheet, application, context)
        : applyAdminNew_(context.spreadsheet, context.applicationSheet, context.masterSheet, application, context);
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
    context.masterState = null;
    markAdminApplicationFailure_(context.spreadsheet, context.applicationSheet, rowNumber, error);
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
  }
}

function normalizeAdminRowNumbers_(rowNumbers) {
  var seen = Object.create(null);
  return (rowNumbers || [])
    .map(function (rowNumber) { return Number(rowNumber); })
    .filter(function (rowNumber) {
      if (!Number.isInteger(rowNumber) || rowNumber < 2 || seen[rowNumber]) return false;
      seen[rowNumber] = true;
      return true;
    })
    .sort(function (left, right) { return left - right; });
}

function processAdminApplicationRows_(rowNumbers, options) {
  if (!isAdminApplyEnabled_()) return adminApplyDisabledResult_();
  var rows = normalizeAdminRowNumbers_(rowNumbers);
  if (!rows.length) return { ok: true, processed: 0, results: [] };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ADMIN_CONFIG.applyLockTimeoutMs)) {
    logAdminDiagnostic_({
      action: "apply_batch",
      application_row: rows[0],
      result: "deferred",
      error_code: "LOCK_TIMEOUT",
    });
    return { ok: false, code: "LOCK_TIMEOUT", deferred: true, processed: 0 };
  }
  try {
    var spreadsheet = getAdminSpreadsheet_();
    var context = {
      spreadsheet: spreadsheet,
      applicationSheet: getAdminApplicationSheet_(spreadsheet),
      masterSheet: null,
      masterState: null,
    };
    var settings = options || {};
    var results = rows.map(function (rowNumber) {
      return processAdminApplicationRowLocked_(rowNumber, settings, context);
    });
    return {
      ok: results.every(function (result) { return result.ok || result.ignored; }),
      processed: results.filter(function (result) { return !result.ignored; }).length,
      results: results,
    };
  } finally {
    lock.releaseLock();
  }
}

function processAdminApplicationRow_(rowNumber, options) {
  var batch = processAdminApplicationRows_([rowNumber], options);
  return batch.results ? batch.results[0] : batch;
}

function handleAdminEdit(e) {
  if (!isAdminApplyEnabled_()) return adminApplyDisabledResult_();
  if (!e || !e.range) return;
  var range = e.range;
  var sheet = range.getSheet();
  if (sheet.getName() !== ADMIN_CONFIG.applicationSheetName) return;
  if (range.getColumn() > 1 || range.getLastColumn() < 1) return;
  var firstRow = Math.max(2, range.getRow());
  var lastRow = range.getLastRow();
  if (lastRow < firstRow) return;
  var rowNumbers = [];
  for (var rowNumber = firstRow; rowNumber <= lastRow; rowNumber += 1) rowNumbers.push(rowNumber);
  try {
    return processAdminApplicationRows_(rowNumbers, { allowError: false });
  } catch (error) {
    logAdminDiagnostic_({
      action: "on_edit",
      application_row: firstRow,
      result: "error",
      error_code: error.code || "GOOGLE_SERVICE_ERROR",
    });
    return { ok: false, code: error.code || "GOOGLE_SERVICE_ERROR" };
  }
}
