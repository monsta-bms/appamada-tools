function lookupChartByMd5_(md5, useCache, providedConfig, providedSpreadsheet) {
  var cache = CacheService.getScriptCache();
  var cacheKey = "lookup:" + md5;
  if (useCache) {
    var cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  var config = providedConfig || getAppamadaConfig_();
  var spreadsheet = providedSpreadsheet || getSpreadsheet_(config);
  var sheet = spreadsheet.getSheetByName(config.chartSheetName);
  if (!sheet) throwApiError_("SHEET_NOT_FOUND", "kkj sheet was not found");

  var lastRow = sheet.getLastRow();
  var matches = lastRow < 1
    ? []
    : sheet.getRange(1, 4, lastRow, 1).createTextFinder(md5).matchEntireCell(true).matchCase(false).findAll();
  var result = { count: matches.length, chart: null };
  if (matches.length === 1) {
    var row = sheet.getRange(matches[0].getRow(), 1, 1, 4).getValues()[0];
    result.chart = {
      current_level: String(row[0]),
      title: String(row[1]),
      artist: String(row[2]),
    };
  }

  if (useCache) cache.put(cacheKey, JSON.stringify(result), matches.length === 0 ? 30 : 120);
  return result;
}

function handleLookup_(md5) {
  var normalizedMd5 = normalizeText_(md5).toLowerCase();
  if (!APPAMADA_MD5_PATTERN.test(normalizedMd5)) {
    throwApiError_("MD5_INVALID", "md5 is invalid");
  }
  var lookup = lookupChartByMd5_(normalizedMd5, true);
  if (lookup.count > 1) throwApiError_("CHART_DUPLICATED", "Chart MD5 is duplicated");
  if (lookup.count === 0) return { ok: true, exists: false };
  return { ok: true, exists: true, chart: lookup.chart };
}
