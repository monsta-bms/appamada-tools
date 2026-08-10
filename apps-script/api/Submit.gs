function submitApplication_(rawPayload) {
  var payload = validatePayload_(rawPayload);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    throwApiError_("LOCK_TIMEOUT", "Could not acquire ScriptLock", {
      retryable: true,
      retryAfterMs: 500,
    });
  }

  try {
    var config = getAppamadaConfig_();
    var spreadsheet = getSpreadsheet_(config);
    var applicationSheet = getApplicationSheet_(config, spreadsheet);
    var existingRowNumber = findRequestRow_(applicationSheet, payload.request_id);
    if (existingRowNumber !== null) {
      var existingRow = applicationSheet
        .getRange(existingRowNumber, 1, 1, APPAMADA_APPLICATION_HEADERS.length)
        .getValues()[0];
      if (!storedRequestMatches_(existingRow, payload)) {
        throwApiError_("REQUEST_ID_CONFLICT", "request_id payload differs from stored request");
      }
      return { ok: true, request_id: payload.request_id, deduplicated: true };
    }

    enforceRateLimit_(payload, config);
    var lookup = lookupChartByMd5_(payload.md5, false, config, spreadsheet);
    var chart = lookup.chart;
    if (payload.application_type === "change") {
      if (lookup.count === 0) throwApiError_("CHART_NOT_FOUND", "Chart was not found");
      if (lookup.count > 1) throwApiError_("CHART_DUPLICATED", "Chart MD5 is duplicated");
      if (APPAMADA_ALLOWED_LEVELS.indexOf(chart.current_level) === -1) {
        throwApiError_("CURRENT_LEVEL_UNSUPPORTED", "Current chart level is unsupported");
      }
      if (payload.proposed_level === chart.current_level) {
        throwApiError_("SAME_AS_CURRENT", "Proposed level equals current level");
      }
    } else {
      if (lookup.count > 1) throwApiError_("CHART_DUPLICATED", "Chart MD5 is duplicated");
      if (lookup.count === 1) throwApiError_("CHART_ALREADY_EXISTS", "Chart already exists");
      chart = null;
    }

    var row = createApplicationRow_(payload, chart, config);
    appendApplicationRowRaw_(applicationSheet, row, config);
    return { ok: true, request_id: payload.request_id, deduplicated: false };
  } finally {
    lock.releaseLock();
  }
}
