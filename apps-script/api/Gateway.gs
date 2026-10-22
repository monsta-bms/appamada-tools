// Only the server-side gateway knows this key. Never embed it in a Userscript.
function verifyGatewayEnvelope_(envelope) {
  var secret = String(PropertiesService.getScriptProperties().getProperty("GATEWAY_SHARED_SECRET") || "");
  if (secret.length < 32) throwApiError_("GATEWAY_NOT_CONFIGURED", "Submission gateway is not configured");
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(",") !== "gateway_version,issued_at,payload,signature,source_hash" ||
      envelope.gateway_version !== 1 || !Number.isSafeInteger(envelope.issued_at) ||
      Math.abs(Date.now() - envelope.issued_at) > 300000 ||
      typeof envelope.source_hash !== "string" || !/^[0-9a-f]{64}$/.test(envelope.source_hash) ||
      typeof envelope.signature !== "string" || !/^[0-9a-f]{64}$/.test(envelope.signature) ||
      typeof envelope.payload !== "string" || envelope.payload.length > 32768) {
    throwApiError_("GATEWAY_AUTH_REQUIRED", "A valid submission gateway signature is required");
  }
  var message = "appamada-gateway-v1\n" + envelope.issued_at + "\n" + envelope.source_hash + "\n" + envelope.payload;
  var expected = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8)
    .map(function (byte) { return (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0"); }).join("");
  var mismatch = 0;
  for (var i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ envelope.signature.charCodeAt(i);
  if (mismatch !== 0) throwApiError_("GATEWAY_AUTH_REQUIRED", "A valid submission gateway signature is required");
  var payload;
  try { payload = JSON.parse(envelope.payload); }
  catch (error) { throwApiError_("BAD_REQUEST", "Gateway payload must be valid JSON"); }
  return { payload: payload, sourceHash: envelope.source_hash };
}
