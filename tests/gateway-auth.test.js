import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createAppsScriptHarness } from "./helpers/apps-script-harness.js";
import { createApiClient } from "../src/api-client.js";

const SECRET = "local-test-gateway-secret-not-for-production-123456";
const MD5 = "a".repeat(32);
const payload = (index = 1, overrides = {}) => ({
  application_type: "new", request_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  md5: MD5, proposed_level: "10", comment: "audit fixture", title: "fixture", artist: "fixture",
  bmsir_user_name: "fixture", bmsir_player_id: "123", ir_url: `https://bms-ir.org/new/song?songmd5=${MD5}`,
  client_version: "0.4.7", ...overrides,
});
function envelope(value = payload(), overrides = {}) {
  const signed = { gateway_version: 1, issued_at: Date.now(), source_hash: "1".repeat(64), payload: JSON.stringify(value), ...overrides };
  signed.signature = createHmac("sha256", SECRET)
    .update(`appamada-gateway-v1\n${signed.issued_at}\n${signed.source_hash}\n${signed.payload}`).digest("hex");
  return signed;
}

test("legacy unsigned submissions stay disabled with a retry-compatible error; lookup is unaffected", async () => {
  for (const application_type of ["new", "change", "delete"]) {
    const h = await createAppsScriptHarness();
    assert.equal(h.postRaw(payload(1, { application_type })).error.code, "SUBMISSIONS_DISABLED");
    assert.equal(h.applications().length, 0);
    assert.equal(h.get({ action: "lookup", md5: MD5 }).exists, false);
  }
});

test("a gateway_version field always requires signature verification, even with legacy fields", async () => {
  for (const gateway_version of [null, false, 0, "", 1, 2]) {
    const h = await createAppsScriptHarness();
    assert.equal(h.postRaw(payload(1, { gateway_version })).error.code, "GATEWAY_AUTH_REQUIRED");
    assert.equal(h.applications().length, 0);
  }
  for (const input of [null, [], {}, payload(1, { application_type: "unknown" }), { ...envelope(), signature: "invalid" }]) {
    const h = await createAppsScriptHarness();
    assert.equal(h.postRaw(input).error.code, "GATEWAY_AUTH_REQUIRED");
    assert.equal(h.applications().length, 0);
  }
});

test("the submission kill switch takes precedence over gateway checks", async () => {
  const h = await createAppsScriptHarness({ properties: { SUBMIT_ENABLED: "false" } });
  for (const input of [payload(), envelope(), { ...envelope(), signature: "invalid" }]) {
    assert.equal(h.postRaw(input).error.code, "SUBMISSIONS_DISABLED");
  }
  assert.equal(h.applications().length, 0);
});

test("signed submissions remain idempotent and write RAW data", async () => {
  const h = await createAppsScriptHarness();
  const request = envelope(payload(1, { title: "=1+1" }));
  assert.equal(h.postRaw(request).deduplicated, false);
  assert.equal(h.postRaw(request).deduplicated, true);
  assert.equal(h.applications().length, 1);
  assert.equal(h.applications()[0][5], "=1+1");
  assert.equal(h.rawWrites[0].options.valueInputOption, "RAW");
  assert.doesNotMatch(h.logs.join("\n"), new RegExp(SECRET + "|" + request.signature));
});

test("tampered content/source/time and malformed signatures are rejected before writes", async () => {
  const good = envelope();
  const variants = [
    { ...good, payload: JSON.stringify(payload(2)) }, { ...good, source_hash: "2".repeat(64) },
    { ...good, issued_at: good.issued_at + 1 }, { ...good, signature: "f".repeat(64) },
    { ...good, signature: "short" }, { ...good, gateway_version: 2 }, { ...good, extra: true },
    envelope(payload(), { issued_at: Date.now() - 301000 }), envelope(payload(), { issued_at: Date.now() + 301000 }),
  ];
  for (const input of variants) {
    const h = await createAppsScriptHarness();
    assert.equal(h.postRaw(input).error.code, "GATEWAY_AUTH_REQUIRED");
    assert.equal(h.applications().length, 0);
  }
});

test("missing or weak gateway key fails closed without breaking lookup", async () => {
  for (const secret of [null, "short"]) {
    const h = await createAppsScriptHarness({ properties: { GATEWAY_SHARED_SECRET: secret } });
    assert.equal(h.postRaw(envelope()).error.code, "GATEWAY_NOT_CONFIGURED");
    assert.equal(h.get({ action: "lookup", md5: MD5 }).ok, true);
  }
});

test("changing claimed name or ID does not reset the verified source quota", async () => {
  const h = await createAppsScriptHarness();
  for (let i = 1; i <= 10; i++) assert.equal(h.post(payload(i, { bmsir_user_name: `name${i}`, bmsir_player_id: String(i) })).ok, true);
  assert.equal(h.post(payload(11, { bmsir_user_name: "another", bmsir_player_id: "999" })).error.code, "RATE_LIMITED");
  assert.equal(h.post(payload(12), "2".repeat(64)).ok, true);
});

test("invalid chart attempts cannot drain the accepted-submission global quota", async () => {
  const h = await createAppsScriptHarness({ properties: { GLOBAL_LIMIT: "2" } });
  for (let i = 1; i <= 5; i++) {
    const result = h.post(payload(i, { application_type: "change", title: undefined, artist: undefined }));
    assert.equal(result.error.code, "CHART_NOT_FOUND");
  }
  assert.equal(h.post(payload(6)).ok, true);
  assert.equal(h.post(payload(7), "2".repeat(64)).ok, true);
  assert.equal(h.post(payload(8), "3".repeat(64)).error.code, "RATE_LIMITED");
});

test("gateway client keeps the submission body and existing error/retry contract", async () => {
  let sent;
  const p = payload();
  const client = createApiClient({ apiUrl: "https://appamada-submission-gateway.fixture.workers.dev/api", gmRequest(details) {
    sent = details;
    queueMicrotask(() => details.onload({ status: 200, responseText: JSON.stringify({ ok: true, request_id: p.request_id, deduplicated: false }) }));
  } });
  assert.equal((await client.submit(p)).ok, true);
  assert.deepEqual(JSON.parse(sent.data), p);
  assert.equal(sent.anonymous, true);
  for (const url of ["https://user:password@gateway.fixture.workers.dev/api", "https://gateway.fixture.workers.dev/api?target=evil", "https://gateway.fixture.workers.dev/other"]) {
    assert.throws(() => createApiClient({ apiUrl: url, gmRequest() {} }), { code: "API_NOT_CONFIGURED" });
  }
});
