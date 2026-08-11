var ADMIN_APPLICATION_HEADERS = Object.freeze([
  "反映", "申請種別", "投稿日時", "BMSIRユーザー名", "BMSIRプレイヤーID",
  "曲名", "artist", "md5", "投稿時現難易度", "難易度案", "コメント", "IR URL",
  "状態", "反映日時", "処理メモ", "request_id", "client_version", "エラーコード", "再試行回数",
]);

var ADMIN_CONFIG = Object.freeze({
  applicationSheetName: "申請一覧",
  masterSheetName: "kkj",
  timezone: "Asia/Tokyo",
  metadataKey: "appamada_apply",
  maxAutomaticRetries: 3,
});

function AdminApplyError(code, message, state) {
  this.name = "AdminApplyError";
  this.code = code;
  this.message = message;
  this.state = state || AppamadaAdminLogic.failureState(code);
}
AdminApplyError.prototype = Object.create(Error.prototype);

function AdminInjectedFault(point) {
  this.name = "AdminInjectedFault";
  this.code = "TEST_FAULT_INJECTED";
  this.message = "Injected fault at " + point;
  this.point = point;
}
AdminInjectedFault.prototype = Object.create(Error.prototype);

function throwAdminError_(code, message, state) {
  throw new AdminApplyError(code, message, state);
}

function getAdminSpreadsheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throwAdminError_("GOOGLE_SERVICE_ERROR", "Active Spreadsheet is unavailable", "エラー");
  return spreadsheet;
}

function adminTimestamp_() {
  return Utilities.formatDate(new Date(), ADMIN_CONFIG.timezone, "yyyy/MM/dd HH:mm:ss");
}

function adminHistoryDate_() {
  return Utilities.formatDate(new Date(), ADMIN_CONFIG.timezone, "yyyy.M.d");
}

function maybeInjectAdminFault_(point, requestId) {
  var value = PropertiesService.getScriptProperties().getProperty("TEST_" + point);
  if (value === "true" || value === requestId) throw new AdminInjectedFault(point);
}
