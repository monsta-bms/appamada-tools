function logDiagnostic_(entry) {
  var timestamp = Utilities.formatDate(new Date(), APPAMADA_DEFAULTS.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX");
  console.log(JSON.stringify({
    timestamp: timestamp,
    request_id: entry.request_id || "",
    action: entry.action || "",
    application_type: entry.application_type || "",
    md5: entry.md5 || "",
    result: entry.result || "",
    error_code: entry.error_code || "",
  }));
}
