var APPAMADA_APPLICATION_HEADERS = Object.freeze([
  "反映",
  "申請種別",
  "投稿日時",
  "BMSIRユーザー名",
  "BMSIRプレイヤーID",
  "曲名",
  "artist",
  "md5",
  "投稿時現難易度",
  "難易度案",
  "コメント",
  "IR URL",
  "状態",
  "反映日時",
  "処理メモ",
  "request_id",
  "client_version",
  "エラーコード",
  "再試行回数",
]);

var APPAMADA_ALLOWED_LEVELS = Object.freeze([
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "10-", "10", "10+", "11-", "11", "11+", "12-", "12", "12+",
  "13", "13+", "14", "15", "16", "?", "★★4?", "★★5?", "★★6?", "★★7?",
]);

var APPAMADA_DEFAULTS = Object.freeze({
  applicationSheetName: "申請一覧",
  chartSheetName: "kkj",
  timezone: "Asia/Tokyo",
  userLimit: 60,
  userMd5Limit: 10,
  globalLimit: 500,
  rateWindowSeconds: 600,
});

function positiveIntegerProperty_(properties, name, fallback) {
  var raw = properties.getProperty(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throwApiError_("INTERNAL_ERROR", "Invalid Script Property: " + name);
  }
  return Number(raw);
}

function isSubmitEnabled_() {
  return PropertiesService.getScriptProperties().getProperty("SUBMIT_ENABLED") === "true";
}

function getAppamadaConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = String(properties.getProperty("SPREADSHEET_ID") || "").trim();
  if (!spreadsheetId) {
    throwApiError_("SHEET_NOT_FOUND", "SPREADSHEET_ID is not configured");
  }
  return {
    spreadsheetId: spreadsheetId,
    applicationSheetName: APPAMADA_DEFAULTS.applicationSheetName,
    chartSheetName: APPAMADA_DEFAULTS.chartSheetName,
    timezone: APPAMADA_DEFAULTS.timezone,
    userLimit: positiveIntegerProperty_(properties, "USER_LIMIT", APPAMADA_DEFAULTS.userLimit),
    userMd5Limit: positiveIntegerProperty_(
      properties,
      "USER_MD5_LIMIT",
      APPAMADA_DEFAULTS.userMd5Limit,
    ),
    globalLimit: positiveIntegerProperty_(
      properties,
      "GLOBAL_LIMIT",
      APPAMADA_DEFAULTS.globalLimit,
    ),
    rateWindowSeconds: APPAMADA_DEFAULTS.rateWindowSeconds,
  };
}
