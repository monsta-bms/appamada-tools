function applyAdminChange_(spreadsheet, applicationSheet, masterSheet, application) {
  assertAdminTableOrder_(masterSheet);
  var matches = findAdminMasterRowsByMd5_(masterSheet, application.record.md5);
  if (matches.length === 0) throwAdminError_("CHART_NOT_FOUND", "このMD5はkkjに存在しません", "要確認");
  if (matches.length > 1) throwAdminError_("CHART_DUPLICATED", "このMD5はkkjで重複しています", "要確認");

  var sourceRow = matches[0];
  validateAdminMasterFormulaFree_(masterSheet, sourceRow);
  var masterRow = masterSheet.getRange(sourceRow, 1, 1, 5).getValues()[0];
  var currentLevel = String(masterRow[0]);
  if (currentLevel !== application.record.originalLevel) {
    throwAdminError_(
      "STALE_CURRENT_LEVEL",
      "現難易度が投稿時の" + application.record.originalLevel + "から" + currentLevel + "へ変更済み",
      "要確認",
    );
  }

  var plan = planAdminMasterMove_(masterSheet, sourceRow, application.record.targetLevel);
  var history = adminHistoryDate_() + " " + currentLevel + "→" + application.record.targetLevel;
  masterRow[0] = application.record.targetLevel;
  masterRow[4] = AppamadaAdminLogic.appendCommentHistory(masterRow[4], history);

  var metadata = addAdminPlannedMetadata_(masterSheet, sourceRow, application, { history: history });
  writeAdminMasterRowRaw_(spreadsheet, masterSheet, sourceRow, masterRow);
  maybeInjectAdminFault_("FAIL_AFTER_MASTER_WRITE", application.record.requestId);
  moveAdminMasterRow_(masterSheet, sourceRow, plan.finalRow);

  metadata = requireAdminPlannedMetadataByRequestId_(masterSheet, application.record.requestId);
  var finalRow = getAdminMetadataRow_(metadata);
  if (finalRow !== plan.finalRow) {
    throwAdminError_("METADATA_CONFLICT", "moved row metadata did not reach the planned row", "要確認");
  }
  assertAdminTableOrder_(masterSheet);
  finalizeAdminApplication_(
    spreadsheet,
    applicationSheet,
    application.rowNumber,
    "kkj " + finalRow + "行目 " + currentLevel + "→" + application.record.targetLevel,
  );
  maybeInjectAdminFault_("FAIL_AFTER_APPLICATION_UPDATE", application.record.requestId);
  removeAdminPlannedMetadata_(metadata, application.record.requestId);
  return { ok: true, finalRow: finalRow, history: history };
}
