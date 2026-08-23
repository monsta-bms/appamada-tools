var ADMIN_APPLICATION_HEADERS = Object.freeze([
  "反映", "申請種別", "投稿日時", "BMSIRユーザー名", "BMSIRプレイヤーID",
  "曲名", "artist", "md5", "投稿時現難易度", "難易度案", "コメント", "IR URL",
  "状態", "反映日時", "処理メモ", "request_id", "client_version", "エラーコード", "再試行回数",
]);

var ADMIN_CONFIG = Object.freeze({
  applicationSheetName: "申請一覧",
  masterSheetName: "kkj",
  deletedSheetName: "削除済",
  timezone: "Asia/Tokyo",
  metadataKey: "appamada_apply",
  maxAutomaticRetries: 3,
  applyLockTimeoutMs: 30000,
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
  return Utilities.formatDate(new Date(), ADMIN_CONFIG.timezone, "yyyy/MM/dd");
}

function isValidAdminCommentDate_(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function normalizeAdminCommentDateSegment_(segment) {
  return String(segment).replace(
    /(^|[^\d])(\d{4})([\/.])(\d{1,2})\3(\d{1,2})(?=$|[^\d])/g,
    function (matched, prefix, yearText, separator, monthText, dayText) {
      var year = Number(yearText);
      var month = Number(monthText);
      var day = Number(dayText);
      if (!isValidAdminCommentDate_(year, month, day)) return matched;
      return prefix + yearText + "/" + String(month).padStart(2, "0") + "/" + String(day).padStart(2, "0");
    },
  );
}

function normalizeAdminCommentDates_(value) {
  if (value && typeof value.getTime === "function" && !isNaN(value.getTime())) {
    return Utilities.formatDate(new Date(value.getTime()), ADMIN_CONFIG.timezone, "yyyy/MM/dd");
  }
  var text = value === null || value === undefined ? "" : String(value);
  var serializedDate = text.match(
    /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{4}) 00:00:00 GMT\+0900 \(日本標準時\)$/,
  );
  if (serializedDate) {
    var month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
      .indexOf(serializedDate[1]) + 1;
    var day = Number(serializedDate[2]);
    var year = Number(serializedDate[3]);
    if (isValidAdminCommentDate_(year, month, day)) {
      return String(year) + "/" + String(month).padStart(2, "0") + "/" + String(day).padStart(2, "0");
    }
  }
  return text
    .split(/(https?:\/\/\S+)/g)
    .map(function (part) {
      return /^https?:\/\//.test(part) ? part : normalizeAdminCommentDateSegment_(part);
    })
    .join("");
}

function formatAdminNewComment_(comment, datePrefix) {
  var value = normalizeAdminCommentDates_(comment);
  var prefix = normalizeAdminCommentDates_(datePrefix);
  return prefix + (value ? " " + value : "");
}

function adminNewCommentDate_() {
  return Utilities.formatDate(new Date(), ADMIN_CONFIG.timezone, "yyyy/MM/dd");
}

function adminNewComment_(comment) {
  return formatAdminNewComment_(comment, adminNewCommentDate_());
}

function maybeInjectAdminFault_(point, requestId) {
  var value = PropertiesService.getScriptProperties().getProperty("TEST_" + point);
  if (value === "true" || value === requestId) throw new AdminInjectedFault(point);
}

function isAdminApplyEnabled_() {
  return PropertiesService.getScriptProperties().getProperty("ADMIN_APPLY_ENABLED") === "true";
}

function adminApplyDisabledResult_() {
  return { ok: false, disabled: true, code: "ADMIN_APPLY_DISABLED" };
}
