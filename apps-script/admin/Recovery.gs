function positionRecoveredAdminChange_(masterSheet, metadataRow, targetLevel) {
  var rows = readAdminMasterRows_(masterSheet);
  var remaining = rows.map(function (row) { return row.slice(); });
  var moved = remaining.splice(metadataRow - 2, 1)[0];
  moved[0] = targetLevel;
  var insertion = AppamadaAdminLogic.insertionIndex(remaining, targetLevel);
  if (!insertion.ok) throwAdminError_(insertion.code, insertion.detail, "要確認");
  remaining.splice(insertion.index, 0, moved);
  var finalAnalysis = AppamadaAdminLogic.analyzeTableOrder(remaining, 2);
  if (!finalAnalysis.ok) throwAdminError_(finalAnalysis.code, finalAnalysis.detail, "要確認");
  var finalRow = insertion.index + 2;
  moveAdminMasterRow_(masterSheet, metadataRow, finalRow);
  return finalRow;
}

function recoverAdminChangeMetadata_(spreadsheet, applicationSheet, masterSheet, application, metadata, value) {
  var metadataRow = getAdminMetadataRow_(metadata);
  var masterRow = masterSheet.getRange(metadataRow, 1, 1, 5).getValues()[0];
  var level = String(masterRow[0]);
  var history = String(value.history || "");
  if (!history) throwAdminError_("RECOVERY_FAILED", "change metadata history is missing", "要確認");

  if (level === application.record.targetLevel) {
    if (String(masterRow[4]).split(" / ").indexOf(history) === -1) {
      throwAdminError_("RECOVERY_FAILED", "target level exists without the planned history", "要確認");
    }
  } else if (level === application.record.originalLevel) {
    masterRow[0] = application.record.targetLevel;
    masterRow[4] = AppamadaAdminLogic.appendCommentHistory(masterRow[4], history);
    writeAdminMasterRowRaw_(spreadsheet, masterSheet, metadataRow, masterRow);
  } else {
    throwAdminError_("RECOVERY_FAILED", "change row is neither original nor target level", "要確認");
  }

  var finalRow = positionRecoveredAdminChange_(masterSheet, metadataRow, application.record.targetLevel);
  metadata = requireAdminPlannedMetadataByRequestId_(masterSheet, application.record.requestId);
  assertAdminTableOrder_(masterSheet);
  finalizeAdminApplication_(
    spreadsheet,
    applicationSheet,
    application.rowNumber,
    "kkj " + finalRow + "行目 " + application.record.originalLevel + "→" + application.record.targetLevel + "（復旧）",
  );
  removeAdminPlannedMetadata_(metadata, application.record.requestId);
  return { ok: true, finalRow: finalRow };
}

function recoverAdminNewMetadata_(spreadsheet, applicationSheet, masterSheet, application, metadata) {
  var metadataRow = getAdminMetadataRow_(metadata);
  var current = masterSheet.getRange(metadataRow, 1, 1, 5).getValues()[0];
  var expected = [
    application.record.targetLevel,
    application.record.title,
    application.record.artist,
    application.record.md5,
    "",
  ];
  var blank = current.every(function (value) { return String(value) === ""; });
  var exact = current.every(function (value, index) { return String(value) === String(expected[index]); });
  if (blank) writeAdminMasterRowRaw_(spreadsheet, masterSheet, metadataRow, expected);
  else if (!exact) throwAdminError_("RECOVERY_FAILED", "new row contains unexpected partial data", "要確認");
  assertAdminTableOrder_(masterSheet);
  finalizeAdminApplication_(
    spreadsheet,
    applicationSheet,
    application.rowNumber,
    "kkj " + metadataRow + "行目へ新規追加（復旧）",
  );
  removeAdminPlannedMetadata_(metadata, application.record.requestId);
  return { ok: true, finalRow: metadataRow };
}

function recoverOneAdminMetadata_(spreadsheet, applicationSheet, masterSheet, metadata) {
  var value = parseAdminMetadata_(metadata);
  var rows = findAdminApplicationRowsByRequestId_(applicationSheet, value.request_id);
  if (rows.length !== 1) {
    throwAdminError_(
      rows.length === 0 ? "RECOVERY_FAILED" : "REQUEST_ID_CONFLICT",
      "planned metadata request_id must match exactly one application",
      "要確認",
    );
  }
  var application = readAdminApplication_(applicationSheet, rows[0]);
  if (application.record.state === "反映済") {
    removeAdminPlannedMetadata_(metadata, application.record.requestId);
    return { ok: true, cleaned: true };
  }
  if (application.record.state === "却下" || application.record.state === "要確認") {
    return { ok: false, ignored: true };
  }
  validateAdminApplication_(application, true);
  if (application.record.applicationType !== value.application_type) {
    throwAdminError_("METADATA_CONFLICT", "metadata application_type differs", "要確認");
  }
  return application.record.applicationType === "change"
    ? recoverAdminChangeMetadata_(spreadsheet, applicationSheet, masterSheet, application, metadata, value)
    : recoverAdminNewMetadata_(spreadsheet, applicationSheet, masterSheet, application, metadata);
}

function recoverInterruptedTransactions() {
  if (!isAdminApplyEnabled_()) {
    return { recovered: 0, cleaned: 0, failed: 0, ignored: 0, disabled: true };
  }
  var spreadsheet = getAdminSpreadsheet_();
  var applicationSheet = getAdminApplicationSheet_(spreadsheet);
  var masterSheet = getAdminMasterSheet_(spreadsheet);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) throwAdminError_("LOCK_TIMEOUT", "recovery lock timeout", "エラー");
  var summary = { recovered: 0, cleaned: 0, failed: 0, ignored: 0 };
  try {
    findAllAdminPlannedMetadata_(masterSheet).forEach(function (metadata) {
      var value;
      try {
        value = parseAdminMetadata_(metadata);
        var result = recoverOneAdminMetadata_(spreadsheet, applicationSheet, masterSheet, metadata);
        if (result.cleaned) summary.cleaned += 1;
        else if (result.ignored) summary.ignored += 1;
        else summary.recovered += 1;
        logAdminDiagnostic_({
          request_id: value.request_id,
          application_type: value.application_type,
          action: "recover_metadata",
          application_row: value.application_row,
          result: result.ignored ? "ignored" : "success",
        });
      } catch (error) {
        summary.failed += 1;
        if (value && value.request_id) {
          var rows = findAdminApplicationRowsByRequestId_(applicationSheet, value.request_id);
          if (rows.length === 1) markAdminApplicationFailure_(spreadsheet, applicationSheet, rows[0], error);
        }
        logAdminDiagnostic_({
          request_id: value ? value.request_id : "",
          application_type: value ? value.application_type : "",
          action: "recover_metadata",
          application_row: value ? value.application_row : 0,
          result: "error",
          error_code: error.code || "RECOVERY_FAILED",
        });
      }
    });
  } finally {
    lock.releaseLock();
  }
  return summary;
}

function retryTemporaryAdminErrors() {
  if (!isAdminApplyEnabled_()) return { retried: 0, exhausted: 0, disabled: true };
  var spreadsheet = getAdminSpreadsheet_();
  var sheet = getAdminApplicationSheet_(spreadsheet);
  var lastRow = sheet.getLastRow();
  var summary = { retried: 0, exhausted: 0 };
  for (var rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    var application = readAdminApplication_(sheet, rowNumber);
    if (
      application.record.applyMark !== "○" ||
      application.record.state !== "エラー" ||
      !AppamadaAdminLogic.isRetryableError(String(application.row[17]))
    ) continue;
    if (application.record.retryCount >= ADMIN_CONFIG.maxAutomaticRetries) {
      updateAdminApplicationOutcome_(spreadsheet, sheet, rowNumber, {
        state: "エラー",
        memo: "自動再試行上限到達",
      });
      summary.exhausted += 1;
      continue;
    }
    updateAdminApplicationOutcome_(spreadsheet, sheet, rowNumber, {
      state: "エラー",
      retryCount: application.record.retryCount + 1,
    });
    processAdminApplicationRow_(rowNumber, { allowError: true });
    summary.retried += 1;
  }
  return summary;
}

function runScheduledRecovery() {
  if (!isAdminApplyEnabled_()) {
    return {
      disabled: true,
      metadata: { recovered: 0, cleaned: 0, failed: 0, ignored: 0, disabled: true },
      retry: { retried: 0, exhausted: 0, disabled: true },
    };
  }
  return {
    metadata: recoverInterruptedTransactions(),
    retry: retryTemporaryAdminErrors(),
  };
}
