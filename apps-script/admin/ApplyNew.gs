function applyAdminNew_(spreadsheet, applicationSheet, masterSheet, application, context) {
  var state = getAdminMasterState_(masterSheet, context);
  var matches = findAdminMasterIndexesByMd5_(state.rows, application.record.md5);
  if (matches.length > 1) throwAdminError_("CHART_DUPLICATED", "このMD5はkkjで重複しています", "要確認");
  if (matches.length === 1) {
    throwAdminError_(
      "CHART_ALREADY_EXISTS",
      "このMD5は申請後に既にkkjへ追加されています",
      "要確認",
    );
  }

  var insertionRow = planAdminMasterInsertion_(masterSheet, application.record.targetLevel, state.rows);
  var newCommentDate = adminNewCommentDate_();
  var newComment = formatAdminNewComment_(application.record.comment, newCommentDate);
  insertAdminMasterBlankRow_(masterSheet, insertionRow);
  var metadata = addAdminPlannedMetadata_(masterSheet, insertionRow, application, {
    new_comment_date: newCommentDate,
  });
  maybeInjectAdminFault_("FAIL_AFTER_BLANK_INSERT", application.record.requestId);
  writeAdminMasterRowRaw_(spreadsheet, masterSheet, insertionRow, [
    application.record.targetLevel,
    application.record.title,
    application.record.artist,
    application.record.md5,
    newComment,
  ]);
  maybeInjectAdminFault_("FAIL_AFTER_MASTER_WRITE", application.record.requestId);
  refreshAdminMasterState_(masterSheet, context);
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
