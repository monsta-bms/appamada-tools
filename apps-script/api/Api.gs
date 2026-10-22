function AppamadaApiError(code, message, options) {
  this.name = "AppamadaApiError";
  this.code = code;
  this.message = message;
  this.retryable = Boolean(options && options.retryable);
  this.retryAfterMs = options && options.retryAfterMs ? Number(options.retryAfterMs) : null;
}
AppamadaApiError.prototype = Object.create(Error.prototype);

function throwApiError_(code, message, options) {
  throw new AppamadaApiError(code, message, options);
}

function errorPayload_(error, requestId) {
  var normalized = error instanceof AppamadaApiError
    ? error
    : new AppamadaApiError("INTERNAL_ERROR", "Unexpected server error");
  var payload = {
    ok: false,
    request_id: requestId || "",
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
    },
  };
  if (normalized.retryAfterMs !== null) payload.error.retry_after_ms = normalized.retryAfterMs;
  return payload;
}

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    var parameters = e && e.parameters ? e.parameters : {};
    var keys = Object.keys(parameters).sort();
    if (
      keys.join(",") !== "action,md5" ||
      !Array.isArray(parameters.action) || parameters.action.length !== 1 ||
      !Array.isArray(parameters.md5) || parameters.md5.length !== 1 ||
      parameters.action[0] !== "lookup"
    ) {
      throwApiError_("BAD_REQUEST", "Only action=lookup&md5=... is supported");
    }
    var result = handleLookup_(parameters.md5[0]);
    logDiagnostic_({ action: "lookup", md5: parameters.md5[0], result: "success" });
    return jsonOutput_(result);
  } catch (error) {
    var failure = errorPayload_(error, "");
    logDiagnostic_({ action: "lookup", result: "error", error_code: failure.error.code });
    return jsonOutput_(failure);
  }
}

function doPost(e) {
  var rawPayload = null;
  var requestId = "";
  try {
    var contents = e && e.postData ? e.postData.contents : "";
    if (!contents || contents.length > 65536) throwApiError_("BAD_REQUEST", "POST body is missing or too large");
    try {
      rawPayload = JSON.parse(contents);
    } catch (error) {
      throwApiError_("BAD_REQUEST", "POST body must be valid JSON");
    }
    if (!isSubmitEnabled_()) throwApiError_("SUBMISSIONS_DISABLED", "Application submissions are disabled");
    // Published clients keep SUBMISSIONS_DISABLED requests pending for retry.
    // Reject their direct format without permanently discarding saved proposals.
    if (
      rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) &&
      !Object.prototype.hasOwnProperty.call(rawPayload, "gateway_version") &&
      ["new", "change", "delete"].indexOf(rawPayload.application_type) !== -1
    ) {
      throwApiError_("SUBMISSIONS_DISABLED", "Direct submissions are disabled; update the Userscript");
    }
    var verified = verifyGatewayEnvelope_(rawPayload);
    rawPayload = verified.payload;
    requestId = rawPayload && typeof rawPayload.request_id === "string" ? rawPayload.request_id : "";
    var result = submitApplication_(rawPayload, verified.sourceHash);
    logDiagnostic_({
      request_id: result.request_id,
      action: "submit",
      application_type: rawPayload.application_type,
      md5: rawPayload.md5,
      result: "success",
    });
    return jsonOutput_(result);
  } catch (error) {
    var failure = errorPayload_(error, requestId);
    logDiagnostic_({
      request_id: requestId,
      action: "submit",
      application_type: rawPayload && rawPayload.application_type,
      md5: rawPayload && rawPayload.md5,
      result: "error",
      error_code: failure.error.code,
    });
    return jsonOutput_(failure);
  }
}
