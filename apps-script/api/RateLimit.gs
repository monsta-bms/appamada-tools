function sha256Hex_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8,
  ).map(function (byte) {
    return (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0");
  }).join("");
}

function enforceRateLimit_(payload, config) {
  var now = Date.now();
  var windowMs = config.rateWindowSeconds * 1000;
  var bucket = Math.floor(now / windowMs);
  var userHash = sha256Hex_(payload.bmsir_user_name);
  var cache = CacheService.getScriptCache();
  var limits = [
    { key: "rate:g:" + bucket, limit: config.globalLimit },
    { key: "rate:u:" + bucket + ":" + userHash, limit: config.userLimit },
    { key: "rate:m:" + bucket + ":" + userHash + ":" + payload.md5, limit: config.userMd5Limit },
  ];
  var cachedValues = cache.getAll(limits.map(function (item) { return item.key; }));
  var counters = limits.map(function (item) {
    var raw = cachedValues[item.key];
    var count = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
    return { key: item.key, limit: item.limit, count: count };
  });
  if (counters.some(function (item) { return item.count >= item.limit; })) {
    throwApiError_("RATE_LIMITED", "Submission rate limit exceeded", {
      retryable: false,
      retryAfterMs: windowMs - (now % windowMs),
    });
  }
  var nextValues = {};
  counters.forEach(function (item) { nextValues[item.key] = String(item.count + 1); });
  cache.putAll(nextValues, config.rateWindowSeconds + 5);
}
