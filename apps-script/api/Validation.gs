var APPAMADA_MD5_PATTERN = /^[0-9a-f]{32}$/i;
var APPAMADA_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var APPAMADA_INVALID_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function normalizeText_(value) {
  return String(value === null || value === undefined ? "" : value).trim().normalize("NFC");
}

function normalizePreservingEdges_(value) {
  return String(value === null || value === undefined ? "" : value).normalize("NFC");
}

function codePointLength_(value) {
  return Array.from(String(value === null || value === undefined ? "" : value)).length;
}

function rejectUnknownFields_(payload, allowedFields) {
  Object.keys(payload).forEach(function (key) {
    if (allowedFields.indexOf(key) === -1) {
      throwApiError_("BAD_REQUEST", "Unexpected field: " + key);
    }
  });
}

function validateRequiredText_(value, requiredCode, tooLongCode, maximum) {
  var normalized = normalizeText_(value);
  if (!normalized) throwApiError_(requiredCode, "Required text is missing");
  if (APPAMADA_INVALID_CONTROL_PATTERN.test(normalized)) {
    throwApiError_("BAD_REQUEST", "Text contains an invalid control character");
  }
  if (codePointLength_(normalized) > maximum) {
    throwApiError_(tooLongCode, "Text is too long");
  }
  return normalized;
}

function validateIrUrl_(value, md5) {
  var normalized = normalizeText_(value);
  var match = /^https:\/\/(?:www\.)?bms-ir\.org\/new\/song\?([^#]+)$/.exec(normalized);
  if (!match) throwApiError_("IR_URL_INVALID", "IR URL is invalid");

  var md5Values = [];
  match[1].split("&").forEach(function (part) {
    var pieces = part.split("=");
    var key;
    var decoded;
    try {
      key = decodeURIComponent(pieces.shift().replace(/\+/g, " "));
      decoded = decodeURIComponent(pieces.join("=").replace(/\+/g, " "));
    } catch (error) {
      throwApiError_("IR_URL_INVALID", "IR URL query is invalid");
    }
    if (key === "songmd5") md5Values.push(decoded);
  });
  if (md5Values.length !== 1 || !APPAMADA_MD5_PATTERN.test(md5Values[0])) {
    throwApiError_("IR_URL_INVALID", "IR URL songmd5 is invalid");
  }
  if (md5Values[0].toLowerCase() !== md5) {
    throwApiError_("MD5_MISMATCH", "IR URL MD5 does not match payload MD5");
  }
  return normalized;
}

function validatePayload_(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throwApiError_("BAD_REQUEST", "Payload must be a JSON object");
  }

  var applicationType = payload.application_type;
  if (applicationType !== "change" && applicationType !== "new") {
    throwApiError_("APPLICATION_TYPE_INVALID", "application_type is invalid");
  }

  var commonFields = [
    "application_type", "request_id", "md5", "proposed_level", "comment",
    "bmsir_user_name", "bmsir_player_id", "ir_url", "client_version",
  ];
  rejectUnknownFields_(payload, applicationType === "new" ? commonFields.concat(["title", "artist"]) : commonFields);

  var requestId = normalizeText_(payload.request_id).toLowerCase();
  if (!APPAMADA_UUID_PATTERN.test(requestId)) {
    throwApiError_("REQUEST_ID_INVALID", "request_id is invalid");
  }

  var md5 = normalizeText_(payload.md5).toLowerCase();
  if (!APPAMADA_MD5_PATTERN.test(md5)) throwApiError_("MD5_INVALID", "md5 is invalid");

  var username = validateRequiredText_(
    payload.bmsir_user_name,
    "LOGIN_NAME_MISSING",
    "BAD_REQUEST",
    100,
  );
  var playerId = normalizeText_(payload.bmsir_player_id);
  if (!/^\d{1,20}$/.test(playerId)) {
    throwApiError_("PLAYER_ID_INVALID", "BMSIR player ID is invalid");
  }

  var proposedLevel = String(payload.proposed_level === undefined ? "" : payload.proposed_level);
  if (!proposedLevel) throwApiError_("LEVEL_REQUIRED", "proposed_level is required");
  if (APPAMADA_ALLOWED_LEVELS.indexOf(proposedLevel) === -1) {
    throwApiError_("LEVEL_INVALID", "proposed_level is invalid");
  }

  var comment = normalizePreservingEdges_(payload.comment);
  if (APPAMADA_INVALID_CONTROL_PATTERN.test(comment)) {
    throwApiError_("BAD_REQUEST", "Comment contains an invalid control character");
  }
  if (codePointLength_(comment) > 500) {
    throwApiError_("COMMENT_TOO_LONG", "Comment is too long");
  }

  var clientVersion = normalizeText_(payload.client_version);
  if (
    !clientVersion ||
    codePointLength_(clientVersion) > 32 ||
    APPAMADA_INVALID_CONTROL_PATTERN.test(clientVersion)
  ) {
    throwApiError_("CLIENT_VERSION_INVALID", "client_version is invalid");
  }

  var normalized = {
    application_type: applicationType,
    request_id: requestId,
    md5: md5,
    proposed_level: proposedLevel,
    comment: comment,
    bmsir_user_name: username,
    bmsir_player_id: playerId,
    ir_url: validateIrUrl_(payload.ir_url, md5),
    client_version: clientVersion,
  };

  if (applicationType === "new") {
    normalized.title = validateRequiredText_(payload.title, "TITLE_REQUIRED", "TITLE_TOO_LONG", 1000);
    normalized.artist = validateRequiredText_(
      payload.artist,
      "ARTIST_REQUIRED",
      "ARTIST_TOO_LONG",
      500,
    );
  }
  return normalized;
}
