var PHASE3_BACKUP_MASTER = "__phase3_backup_kkj";
var PHASE3_BACKUP_APPLICATIONS = "__phase3_backup_applications";

function assertPhase3IntegrationTestMode_() {
  var spreadsheet = getAdminSpreadsheet_();
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty("PHASE3_TEST_MODE") !== "enabled") {
    throw new Error("PHASE3_TEST_MODE is not enabled");
  }
  if (properties.getProperty("PHASE3_TEST_SPREADSHEET_ID") !== spreadsheet.getId()) {
    throw new Error("PHASE3_TEST_SPREADSHEET_ID does not match the active Spreadsheet");
  }
  return spreadsheet;
}

function phase3Assert_(condition, message) {
  if (!condition) throw new Error("Phase 3 integration assertion failed: " + message);
}

function phase3Md5_(number) {
  return Number(number).toString(16).padStart(32, "0");
}

function phase3Uuid_(number) {
  return "30000000-0000-4000-8000-" + String(number).padStart(12, "0");
}

function phase3WriteValuesRaw_(spreadsheet, sheet, rangeA1, values) {
  Sheets.Spreadsheets.Values.update(
    { values: values },
    spreadsheet.getId(),
    "'" + sheet.getName().replace(/'/g, "''") + "'!" + rangeA1,
    { valueInputOption: "RAW" },
  );
  SpreadsheetApp.flush();
}

function phase3SeedMaster_(spreadsheet, sheet) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 5).setValues([["level", "title", "artist", "md5", "comment"]]);
  var levels = ["0", "0", "9", "9", "10", "10", "10+", "11", "12-", "12", "12", "16", "16", "★★4?", "★★4?", "★★5?", "?"];
  var rows = levels.map(function (level, index) {
    return [level, "Phase3 Seed Title " + (index + 1), "Phase3 Seed Artist " + (index + 1), phase3Md5_(index + 1), index === 2 ? "2024.11.24 seed" : ""];
  });
  var seedRange = sheet.getRange(2, 1, rows.length, 5);
  seedRange.setNumberFormat("@");
  seedRange.setValues(rows);
  SpreadsheetApp.flush();
  return rows;
}

function phase3ResetApplications_(sheet) {
  if (sheet.getMaxRows() > 1) sheet.getRange(2, 1, sheet.getMaxRows() - 1, 19).clearContent();
}

function phase3AppendApplication_(spreadsheet, sheet, number, options) {
  var values = options || {};
  var rowNumber = Math.max(2, sheet.getLastRow() + 1);
  var type = values.type || "change";
  var md5 = values.md5 || phase3Md5_(1000 + number);
  var row = [
    values.applyMark === undefined ? "○" : values.applyMark,
    type,
    adminTimestamp_(),
    "Phase3TestUser",
    "999999",
    values.title === undefined ? "Phase3 New Title " + number : values.title,
    values.artist === undefined ? "Phase3 New Artist " + number : values.artist,
    md5,
    values.originalLevel === undefined ? (type === "new" ? "" : "9") : values.originalLevel,
    values.targetLevel === undefined ? "10+" : values.targetLevel,
    "Phase3 integration " + number,
    "https://bms-ir.org/new/song?songmd5=" + md5 + "&view=new",
    values.state || "未処理",
    "",
    "",
    phase3Uuid_(number),
    "0.3.0-test",
    values.errorCode || "",
    values.retryCount || 0,
  ];
  phase3WriteValuesRaw_(spreadsheet, sheet, "A" + rowNumber + ":S" + rowNumber, [row]);
  return rowNumber;
}

function phase3ResultCode_(sheet, rowNumber) {
  var spreadsheet = getAdminSpreadsheet_();
  var range = "'" + sheet.getName().replace(/'/g, "''") + "'!A" + rowNumber + ":S" + rowNumber;
  var response = Sheets.Spreadsheets.Values.get(spreadsheet.getId(), range, {
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  var row = response.values && response.values[0] ? response.values[0] : [];
  return {
    state: String(row[12]),
    memo: String(row[14] || ""),
    code: String(row[17]),
    retry: Number(row[18] || 0),
  };
}

function phase3ApplyAndAssert_(applicationSheet, rowNumber, expectedState, expectedCode) {
  processAdminApplicationRow_(rowNumber, { allowError: false });
  var result = phase3ResultCode_(applicationSheet, rowNumber);
  phase3Assert_(
    result.state === expectedState,
    "row " + rowNumber + " state " + result.state + " code " + result.code + " memo " + result.memo,
  );
  phase3Assert_(result.code === (expectedCode || ""), "row " + rowNumber + " code " + result.code);
  return result;
}

function phase3FindMasterRow_(sheet, md5) {
  var rows = findAdminMasterRowsByMd5_(sheet, md5);
  phase3Assert_(rows.length === 1, "expected one kkj row for " + md5);
  return rows[0];
}

function phase3BackupSheets_(spreadsheet) {
  phase3Assert_(!spreadsheet.getSheetByName(PHASE3_BACKUP_MASTER), "stale kkj backup exists");
  phase3Assert_(!spreadsheet.getSheetByName(PHASE3_BACKUP_APPLICATIONS), "stale application backup exists");
  getAdminMasterSheet_(spreadsheet).copyTo(spreadsheet).setName(PHASE3_BACKUP_MASTER);
  getAdminApplicationSheet_(spreadsheet).copyTo(spreadsheet).setName(PHASE3_BACKUP_APPLICATIONS);
}

function restorePhase3IntegrationBackup() {
  var spreadsheet = assertPhase3IntegrationTestMode_();
  var masterBackup = spreadsheet.getSheetByName(PHASE3_BACKUP_MASTER);
  var applicationBackup = spreadsheet.getSheetByName(PHASE3_BACKUP_APPLICATIONS);
  if (!masterBackup && !applicationBackup) return { restored: false };
  phase3Assert_(masterBackup && applicationBackup, "both backup sheets are required");
  var master = spreadsheet.getSheetByName(ADMIN_CONFIG.masterSheetName);
  var applications = spreadsheet.getSheetByName(ADMIN_CONFIG.applicationSheetName);
  if (master) spreadsheet.deleteSheet(master);
  if (applications) spreadsheet.deleteSheet(applications);
  masterBackup.setName(ADMIN_CONFIG.masterSheetName);
  applicationBackup.setName(ADMIN_CONFIG.applicationSheetName);
  return { restored: true };
}

function runPhase3IntegrationSuite() {
  var spreadsheet = assertPhase3IntegrationTestMode_();
  phase3BackupSheets_(spreadsheet);
  var results = [];
  var properties = PropertiesService.getScriptProperties();
  var previousAdminApplyEnabled = properties.getProperty("ADMIN_APPLY_ENABLED");
  properties.setProperty("ADMIN_APPLY_ENABLED", "true");
  try {
    var master = getAdminMasterSheet_(spreadsheet);
    var applications = getAdminApplicationSheet_(spreadsheet);
    var initialFilter = master.getFilter();
    var initialFilterRange = initialFilter ? initialFilter.getRange().getA1Notation() : "";
    phase3SeedMaster_(spreadsheet, master);
    phase3ResetApplications_(applications);
    var seedOrder = assertAdminTableOrder_(master);
    phase3Assert_(seedOrder.md5Count === 17, "seed audit: " + JSON.stringify(seedOrder));

    var down = phase3AppendApplication_(spreadsheet, applications, 1, { md5: phase3Md5_(3), originalLevel: "9", targetLevel: "10+" });
    phase3ApplyAndAssert_(applications, down, "反映済", "");
    results.push("change_down");

    var up = phase3AppendApplication_(spreadsheet, applications, 2, { md5: phase3Md5_(10), originalLevel: "12", targetLevel: "10" });
    phase3ApplyAndAssert_(applications, up, "反映済", "");
    results.push("change_up");

    var normalSpecial = phase3AppendApplication_(spreadsheet, applications, 3, { md5: phase3Md5_(5), originalLevel: "10", targetLevel: "★★4?" });
    phase3ApplyAndAssert_(applications, normalSpecial, "反映済", "");
    var specialNormal = phase3AppendApplication_(spreadsheet, applications, 4, { md5: phase3Md5_(14), originalLevel: "★★4?", targetLevel: "10" });
    phase3ApplyAndAssert_(applications, specialNormal, "反映済", "");
    results.push("normal_special", "special_normal");

    var zeroToSixteen = phase3AppendApplication_(spreadsheet, applications, 7, { md5: phase3Md5_(1), originalLevel: "0", targetLevel: "16" });
    phase3ApplyAndAssert_(applications, zeroToSixteen, "反映済", "");
    var sixteenToZero = phase3AppendApplication_(spreadsheet, applications, 8, { md5: phase3Md5_(12), originalLevel: "16", targetLevel: "0" });
    phase3ApplyAndAssert_(applications, sixteenToZero, "反映済", "");
    var questionToNormal = phase3AppendApplication_(spreadsheet, applications, 9, { md5: phase3Md5_(17), originalLevel: "?", targetLevel: "12" });
    phase3ApplyAndAssert_(applications, questionToNormal, "反映済", "");
    var normalToQuestion = phase3AppendApplication_(spreadsheet, applications, 15, { md5: phase3Md5_(11), originalLevel: "12", targetLevel: "?" });
    phase3ApplyAndAssert_(applications, normalToQuestion, "反映済", "");
    var restoredFilter = master.getFilter();
    phase3Assert_(
      (!initialFilterRange && !restoredFilter) ||
        (restoredFilter && restoredFilter.getRange().getA1Notation() === initialFilterRange),
      "kkj filter restore",
    );
    results.push("zero_to_sixteen", "sixteen_to_zero", "question_to_normal", "normal_to_question");

    var stale = phase3AppendApplication_(spreadsheet, applications, 5, { md5: phase3Md5_(8), originalLevel: "10", targetLevel: "11+" });
    phase3ApplyAndAssert_(applications, stale, "要確認", "STALE_CURRENT_LEVEL");
    var same = phase3AppendApplication_(spreadsheet, applications, 6, { md5: phase3Md5_(2), originalLevel: "0", targetLevel: "0" });
    phase3ApplyAndAssert_(applications, same, "要確認", "SAME_AS_CURRENT");
    results.push("stale", "same_level");

    var duplicateMasterRow = phase3FindMasterRow_(master, phase3Md5_(6));
    master.getRange(duplicateMasterRow, 4).setValue(phase3Md5_(7));
    SpreadsheetApp.flush();
    var duplicateTable = phase3AppendApplication_(spreadsheet, applications, 50, { md5: phase3Md5_(9), originalLevel: "12-", targetLevel: "13" });
    phase3ApplyAndAssert_(applications, duplicateTable, "要確認", "CHART_DUPLICATED");
    master.getRange(duplicateMasterRow, 4).setValue(phase3Md5_(6));
    SpreadsheetApp.flush();
    phase3Assert_(assertAdminTableOrder_(master).md5Count === 17, "duplicate table restore");

    var invalidOrderRow = phase3FindMasterRow_(master, phase3Md5_(2));
    master.getRange(invalidOrderRow, 1).setValue("10");
    SpreadsheetApp.flush();
    var invalidOrder = phase3AppendApplication_(spreadsheet, applications, 51, { md5: phase3Md5_(9), originalLevel: "12-", targetLevel: "13" });
    phase3ApplyAndAssert_(applications, invalidOrder, "要確認", "TABLE_ORDER_INVALID");
    master.getRange(invalidOrderRow, 1).setValue("0");
    SpreadsheetApp.flush();
    phase3Assert_(assertAdminTableOrder_(master).md5Count === 17, "invalid order restore");
    results.push("duplicate_table_defense", "invalid_order_defense");

    for (var index = 0; index < 5; index += 1) {
      var targets = ["10", "11+", "0", "?", "★★6?"];
      var newRow = phase3AppendApplication_(spreadsheet, applications, 10 + index, {
        type: "new", targetLevel: targets[index], md5: phase3Md5_(1100 + index),
      });
      phase3ApplyAndAssert_(applications, newRow, "反映済", "");
    }
    results.push("new_existing_block", "new_missing_block", "new_first", "new_last", "new_special");

    var duplicateMd5 = phase3Md5_(1200);
    var duplicateA = phase3AppendApplication_(spreadsheet, applications, 20, { type: "new", targetLevel: "11", md5: duplicateMd5 });
    var duplicateB = phase3AppendApplication_(spreadsheet, applications, 21, { type: "new", targetLevel: "11+", md5: duplicateMd5 });
    phase3ApplyAndAssert_(applications, duplicateA, "反映済", "");
    phase3ApplyAndAssert_(applications, duplicateB, "要確認", "CHART_ALREADY_EXISTS");
    results.push("new_duplicate");

    var edited = phase3AppendApplication_(spreadsheet, applications, 22, { type: "new", targetLevel: "12-", md5: phase3Md5_(1201) });
    applications.getRange(edited, 6, 1, 2).setValues([["管理者修正Title", "管理者修正Artist"]]);
    phase3ApplyAndAssert_(applications, edited, "反映済", "");
    var editedMaster = master.getRange(phase3FindMasterRow_(master, phase3Md5_(1201)), 1, 1, 5).getValues()[0];
    phase3Assert_(editedMaster[1] === "管理者修正Title" && editedMaster[2] === "管理者修正Artist", "F/G edited values");
    results.push("new_edited_fg");

    var formula = phase3AppendApplication_(spreadsheet, applications, 23, { type: "new", targetLevel: "12", md5: phase3Md5_(1202) });
    applications.getRange(formula, 6).setFormula("=1+1");
    phase3ApplyAndAssert_(applications, formula, "要確認", "CELL_FORMULA_NOT_ALLOWED");
    var raw = phase3AppendApplication_(spreadsheet, applications, 24, { type: "new", targetLevel: "12", md5: phase3Md5_(1203), title: "=Literal Title", artist: "+Literal Artist" });
    phase3ApplyAndAssert_(applications, raw, "反映済", "");
    var rawRow = phase3FindMasterRow_(master, phase3Md5_(1203));
    phase3Assert_(master.getRange(rawRow, 2, 1, 2).getFormulas()[0].every(function (value) { return value === ""; }), "RAW formula prefixes");
    var rawSecond = phase3AppendApplication_(spreadsheet, applications, 26, { type: "new", targetLevel: "12", md5: phase3Md5_(1205), title: "-Literal Title", artist: "@Literal Artist" });
    phase3ApplyAndAssert_(applications, rawSecond, "反映済", "");
    var rawSecondRow = phase3FindMasterRow_(master, phase3Md5_(1205));
    phase3Assert_(master.getRange(rawSecondRow, 2, 1, 2).getFormulas()[0].every(function (value) { return value === ""; }), "RAW second formula prefixes");
    var longTitle = phase3AppendApplication_(spreadsheet, applications, 25, { type: "new", targetLevel: "12", md5: phase3Md5_(1204), title: "x".repeat(1001) });
    phase3ApplyAndAssert_(applications, longTitle, "要確認", "CELL_TEXT_INVALID");
    var longArtist = phase3AppendApplication_(spreadsheet, applications, 27, { type: "new", targetLevel: "12", md5: phase3Md5_(1206), artist: "x".repeat(501) });
    phase3ApplyAndAssert_(applications, longArtist, "要確認", "CELL_TEXT_INVALID");
    var artistFormula = phase3AppendApplication_(spreadsheet, applications, 28, { type: "new", targetLevel: "12", md5: phase3Md5_(1207) });
    applications.getRange(artistFormula, 7).setFormula("=1+1");
    phase3ApplyAndAssert_(applications, artistFormula, "要確認", "CELL_FORMULA_NOT_ALLOWED");
    results.push("formula_reject", "raw_all_prefixes", "title_length", "artist_length");

    var multiA = phase3AppendApplication_(spreadsheet, applications, 30, { type: "new", targetLevel: "13", md5: phase3Md5_(1300) });
    var multiB = phase3AppendApplication_(spreadsheet, applications, 31, { type: "new", targetLevel: "13+", md5: phase3Md5_(1301) });
    handleAdminEdit({ range: applications.getRange(multiA, 1, 2, 1) });
    phase3Assert_(phase3ResultCode_(applications, multiA).state === "反映済", "multi row A");
    phase3Assert_(phase3ResultCode_(applications, multiB).state === "反映済", "multi row B");
    results.push("multi_row");

    var rejected = phase3AppendApplication_(spreadsheet, applications, 32, { type: "new", targetLevel: "14", md5: phase3Md5_(1302), state: "却下" });
    processAdminApplicationRow_(rejected, { allowError: true });
    phase3Assert_(phase3ResultCode_(applications, rejected).state === "却下", "rejected ignored");
    results.push("rejected_ignore");

    var recoveryChange = phase3AppendApplication_(spreadsheet, applications, 40, { md5: phase3Md5_(4), originalLevel: "9", targetLevel: "11" });
    properties.setProperty("TEST_FAIL_AFTER_MASTER_WRITE", phase3Uuid_(40));
    try { processAdminApplicationRow_(recoveryChange, { allowError: false }); } catch (error) { phase3Assert_(error instanceof AdminInjectedFault, "change injected fault"); }
    properties.deleteProperty("TEST_FAIL_AFTER_MASTER_WRITE");
    recoverInterruptedTransactions();
    phase3Assert_(phase3ResultCode_(applications, recoveryChange).state === "反映済", "change recovery");
    var recoveredComment = String(master.getRange(phase3FindMasterRow_(master, phase3Md5_(4)), 5).getValue());
    phase3Assert_(recoveredComment.split(" / ").filter(function (part) { return part.indexOf("9→11") !== -1; }).length === 1, "history idempotency");
    results.push("recovery_change", "history_idempotent");

    var recoveryNew = phase3AppendApplication_(spreadsheet, applications, 41, { type: "new", targetLevel: "15", md5: phase3Md5_(1400) });
    properties.setProperty("TEST_FAIL_AFTER_BLANK_INSERT", phase3Uuid_(41));
    try { processAdminApplicationRow_(recoveryNew, { allowError: false }); } catch (error) { phase3Assert_(error instanceof AdminInjectedFault, "new injected fault"); }
    properties.deleteProperty("TEST_FAIL_AFTER_BLANK_INSERT");
    recoverInterruptedTransactions();
    phase3Assert_(phase3ResultCode_(applications, recoveryNew).state === "反映済", "new recovery");
    results.push("recovery_new");

    var cleanup = phase3AppendApplication_(spreadsheet, applications, 42, { type: "new", targetLevel: "15", md5: phase3Md5_(1401) });
    properties.setProperty("TEST_FAIL_AFTER_APPLICATION_UPDATE", phase3Uuid_(42));
    try { processAdminApplicationRow_(cleanup, { allowError: false }); } catch (error) { phase3Assert_(error instanceof AdminInjectedFault, "cleanup injected fault"); }
    properties.deleteProperty("TEST_FAIL_AFTER_APPLICATION_UPDATE");
    var cleanupResult = recoverInterruptedTransactions();
    phase3Assert_(cleanupResult.cleaned >= 1, "metadata cleanup");
    results.push("metadata_cleanup");

    var retry = phase3AppendApplication_(spreadsheet, applications, 43, { type: "new", targetLevel: "15", md5: phase3Md5_(1402), state: "エラー", errorCode: "GOOGLE_SERVICE_ERROR" });
    retryTemporaryAdminErrors();
    var retryResult = phase3ResultCode_(applications, retry);
    phase3Assert_(retryResult.state === "反映済" && retryResult.retry === 1, "retryable error recovery");
    results.push("retryable_error");

    var orderResult = assertAdminTableOrder_(master);
    var duplicateResult = auditAdminMd5Duplicates_();
    phase3Assert_(duplicateResult.duplicateCount === 0, "final duplicate audit");
    phase3Assert_(findAllAdminPlannedMetadata_(master).length === 0, "final metadata audit");
    var triggerState = inspectAdminTriggers();
    phase3Assert_(triggerState.filter(function (trigger) { return trigger.handler === "handleAdminEdit"; }).length === 1, "installable onEdit trigger");
    phase3Assert_(triggerState.filter(function (trigger) { return trigger.handler === "runScheduledRecovery"; }).length === 1, "scheduled recovery trigger");
    results.push("trigger_state");
    var summary = {
      ok: true,
      passed: results,
      passedCount: results.length,
      finalRows: orderResult.md5Count,
      finalBlocks: orderResult.blocks.length,
      duplicateCount: 0,
      splitBlockCount: 0,
      triggerCount: triggerState.length,
      filterRestored: true,
    };
    console.log(JSON.stringify({ action: "phase3_integration_suite", result: summary }));
    return summary;
  } finally {
    ["TEST_FAIL_AFTER_MASTER_WRITE", "TEST_FAIL_AFTER_APPLICATION_UPDATE", "TEST_FAIL_AFTER_BLANK_INSERT"].forEach(function (name) {
      properties.deleteProperty(name);
    });
    if (previousAdminApplyEnabled === null) properties.deleteProperty("ADMIN_APPLY_ENABLED");
    else properties.setProperty("ADMIN_APPLY_ENABLED", previousAdminApplyEnabled);
    restorePhase3IntegrationBackup();
  }
}
