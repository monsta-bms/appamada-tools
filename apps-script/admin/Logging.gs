function logAdminDiagnostic_(entry) {
  console.log(JSON.stringify({
    timestamp: Utilities.formatDate(new Date(), ADMIN_CONFIG.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    request_id: entry.request_id || "",
    application_type: entry.application_type || "",
    action: entry.action || "",
    application_row: entry.application_row || 0,
    md5: entry.md5 || "",
    result: entry.result || "",
    error_code: entry.error_code || "",
  }));
}
