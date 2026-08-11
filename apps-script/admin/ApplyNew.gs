function applyAdminNew_(spreadsheet, applicationSheet, masterSheet, application) {
  assertAdminTableOrder_(masterSheet);
  var matches = findAdminMasterRowsByMd5_(masterSheet, application.record.md5);
  if (matches.length > 1) throwAdminError_("CHART_DUPLICATED", "このMD5はkkjで重複しています", "要確認");
  if (matches.length === 1) {
    throwAdminError_(
      "CHART_ALREADY_EXISTS",
      "このMD5は申請後に既にkkjへ追加されています",
      "要確認",
    );
  }

  var insertionRow = planAdminMasterInsertion_(masterSheet, application.record.targetLevel);
  insertAdminMasterBlankRow_(masterSheet, insertionRow);
  var metadata = addAdminPlannedMetadata_(masterSheet, insertionRow, application);
  maybeInjectAdminFault_("FAIL_AFTER_BLANK_INSERT", application.record.requestId);
  writeAdminMasterRowRaw_(spreadsheet, masterSheet, insertionRow, [
    application.record.targetLevel,
    application.record.title,
    application.record.artist,
    application.record.md5,
    "",
  ]);
  maybeInjectAdminFault_("FAIL_AFTER_MASTER_WRITE", application.record.requestId);
  assertAdminTableOrder_(masterSheet);
  finalizeAdminApplication_(
    spreadsheet,
    applicationSheet,
    application.rowNumber,
    "kkj " + insertionRow + "行目へ新規追加",
  );
  maybeInjectAdminFault_("FAIL_AFTER_APPLICATION_UPDATE", application.record.requestId);
  removeAdminPlannedMetadata_(metadata, application.record.requestId);
  return { ok: true, finalRow: insertionRow };
}
