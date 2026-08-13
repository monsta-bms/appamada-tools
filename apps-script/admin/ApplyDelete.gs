function createAdminDeletePlanMemo_(application) {
  return "DELETE_PLANNED request_id=" + application.record.requestId +
    " md5=" + application.record.md5 +
    " level=" + application.record.originalLevel;
}

function validateAdminDeleteTarget_(masterSheet, application) {
  assertAdminTableOrder_(masterSheet);
  var matches = findAdminMasterRowsByMd5_(masterSheet, application.record.md5);
  if (matches.length === 0) throwAdminError_("CHART_NOT_FOUND", "このMD5はkkjに存在しません", "要確認");
  if (matches.length > 1) throwAdminError_("CHART_DUPLICATED", "このMD5はkkjで重複しています", "要確認");
  var sourceRow = matches[0];
  validateAdminMasterFormulaFree_(masterSheet, sourceRow);
  var currentLevel = String(masterSheet.getRange(sourceRow, 1).getValue());
  if (currentLevel !== application.record.originalLevel) {
    throwAdminError_(
      "STALE_CURRENT_LEVEL",
      "現難易度が投稿時の" + application.record.originalLevel + "から" + currentLevel + "へ変更済み",
      "要確認",
    );
  }
  return { sourceRow: sourceRow, currentLevel: currentLevel };
}

function completeAdminDelete_(spreadsheet, applicationSheet, masterSheet, application, target, recovered) {
  deleteAdminMasterRow_(masterSheet, target.sourceRow);
  try {
    maybeInjectAdminFault_("FAIL_AFTER_MASTER_DELETE", application.record.requestId);
    assertAdminTableOrder_(masterSheet);
    finalizeAdminApplication_(
      spreadsheet,
      applicationSheet,
      application.rowNumber,
      "kkj " + target.sourceRow + "行目 " + target.currentLevel + " を削除" + (recovered ? "（復旧）" : ""),
    );
  } catch (error) {
    error.preserveDeletePlan = true;
    throw error;
  }
  return { ok: true, deletedRow: target.sourceRow };
}

function applyAdminDelete_(spreadsheet, applicationSheet, masterSheet, application) {
  var target = validateAdminDeleteTarget_(masterSheet, application);
  updateAdminApplicationOutcome_(spreadsheet, applicationSheet, application.rowNumber, {
    state: "未処理",
    memo: createAdminDeletePlanMemo_(application),
    errorCode: "",
  });
  maybeInjectAdminFault_("FAIL_AFTER_DELETE_PLAN", application.record.requestId);
  return completeAdminDelete_(
    spreadsheet,
    applicationSheet,
    masterSheet,
    application,
    target,
    false,
  );
}
