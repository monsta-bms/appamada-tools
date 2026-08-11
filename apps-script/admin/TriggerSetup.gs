function setupAdminTriggers() {
  var spreadsheet = getAdminSpreadsheet_();
  var triggers = ScriptApp.getProjectTriggers();
  var edit = triggers.filter(function (trigger) {
    return trigger.getHandlerFunction() === "handleAdminEdit" &&
      String(trigger.getEventType()) === String(ScriptApp.EventType.ON_EDIT);
  });
  var recovery = triggers.filter(function (trigger) {
    return trigger.getHandlerFunction() === "runScheduledRecovery" &&
      String(trigger.getEventType()) === String(ScriptApp.EventType.CLOCK);
  });
  if (edit.length === 0) {
    ScriptApp.newTrigger("handleAdminEdit").forSpreadsheet(spreadsheet).onEdit().create();
  }
  if (recovery.length === 0) {
    ScriptApp.newTrigger("runScheduledRecovery").timeBased().everyMinutes(15).create();
  }
  return inspectAdminTriggers();
}

function inspectAdminTriggers() {
  var owner = "";
  try { owner = Session.getEffectiveUser().getEmail(); } catch (error) { owner = ""; }
  return ScriptApp.getProjectTriggers().map(function (trigger) {
    return {
      handler: trigger.getHandlerFunction(),
      event_type: String(trigger.getEventType()),
      trigger_source: String(trigger.getTriggerSource()),
      source_id: trigger.getTriggerSourceId() || "",
      owner: owner,
      unique_id: trigger.getUniqueId(),
    };
  });
}

function setupAdminSheetValidation() {
  var spreadsheet = getAdminSpreadsheet_();
  var sheet = getAdminApplicationSheet_(spreadsheet);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["○"], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
  return { ok: true, rows: Math.max(sheet.getMaxRows() - 1, 1) };
}
