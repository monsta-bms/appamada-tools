import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient } from "../src/api-client.js";
import { createOutbox } from "../src/outbox.js";
import { memoryStorage } from "./helpers/outbox-storage.js";

const API = "https://script.google.com/macros/s/LOCAL_FIXTURE/exec";
function client(response, options = {}) {
  return createApiClient({ apiUrl: API, gmRequest: details => queueMicrotask(() => details.onload(response)), ...options });
}
const error = (code, retry) => JSON.stringify({ ok: false, error: { code, ...(retry === undefined ? {} : { retry_after_ms: retry }) } });

test("HTTP error bodies preserve valid codes, while an unsuccessful HTTP status cannot acknowledge success", async () => {
  for (const status of [400, 403, 503]) {
    assert.equal((await client({ status, responseText: error("GATEWAY_UNAVAILABLE") }).submit({})).error.code, "GATEWAY_UNAVAILABLE");
    await assert.rejects(client({ status, responseText: '{"ok":true,"request_id":"x","deduplicated":false}' }).submit({}), { code: "API_NETWORK_ERROR" });
  }
  assert.equal((await client({ status: 200, responseText: error("CHART_ALREADY_EXISTS") }).submit({})).error.code, "CHART_ALREADY_EXISTS");
  assert.equal((await client({ status: 500, responseText: error("UNKNOWN_SAFE_CODE") }).submit({})).error.code, "UNKNOWN_SAFE_CODE");
  for (const responseText of ["<html>Error</html>", "{bad", '{"ok":false,"error":{"code":42}}']) {
    await assert.rejects(client({ status: 200, responseText }).submit({}), { code: "API_INVALID_RESPONSE" });
    await assert.rejects(client({ status: 503, responseText }).submit({}), { code: "API_NETWORK_ERROR" });
  }
});

test("429 JSON/HTML and Retry-After use the longest valid instruction without capping long delays", async () => {
  const now = Date.UTC(2026, 9, 30, 12);
  for (const [body, header, expected] of [
    [error("RATE_LIMITED", 120_000), "Retry-After: 900", 900_000],
    [error("RATE_LIMITED", 3_600_000), "Retry-After: 30", 3_600_000],
    ["<html>Too many requests</html>", "", 600_000],
    ["{bad", "Retry-After: 120", 120_000],
    [error("RATE_LIMITED", -1), "Retry-After: invalid", 600_000],
    [error("RATE_LIMITED", "Infinity"), "Retry-After: -10", 600_000],
    [error("RATE_LIMITED", null), `Retry-After: ${new Date(now + 7_200_000).toUTCString()}`, 7_200_000],
  ]) {
    const result = await client({ status: 429, responseText: body, responseHeaders: header }, { now: () => now }).submit({});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "RATE_LIMITED");
    assert.equal(result.error.retry_after_ms, expected);
  }
});

test("an outbox manual retry cannot bypass long 429/header waits or the player-wide pause", async () => {
  let now = 1_000, calls = 0;
  const apiClient = createApiClient({ apiUrl: API, now: () => now,
    gmRequest(details) { calls++; queueMicrotask(() => details.onload({ status: 429,
      responseText: "<html>Rate limited</html>", responseHeaders: "Retry-After: 3600" })); } });
  const storage = memoryStorage();
  const make = () => createOutbox({ storage, playerId: "123456", apiClient, now: () => now });
  const p = { application_type: "change", request_id: "30000000-0000-4000-8000-000000000001", md5: "a".repeat(32),
    proposed_level: "10", comment: "", bmsir_user_name: "Fixture", bmsir_player_id: "123456",
    ir_url: `https://bms-ir.org/new/song?songmd5=${"a".repeat(32)}`, client_version: "0.4.7" };
  const box = make();
  await box.enqueue(p, {}); await box.send(p.request_id);
  await box.enqueue({ ...p, request_id: p.request_id.replace(/1$/, "2"), comment: "second" }, {});
  now += 900_000;
  await make().send(p.request_id); await make().flush({ manual: true });
  assert.equal(calls, 1);
  now += 2_700_001;
  await make().send(p.request_id);
  assert.equal(calls, 2);
});

test("accepted new submission never fabricates an exists/current-level lookup cache result", async () => {
  const requestId = "30000000-0000-4000-8000-000000000001";
  let now = 1_000, gets = 0;
  const api = createApiClient({ apiUrl: API, now: () => now, gmRequest(details) {
    if (details.method === "GET") gets++;
    queueMicrotask(() => details.onload({ status: 200, responseText: JSON.stringify(details.method === "GET"
      ? { ok: true, exists: false } : { ok: true, request_id: requestId, deduplicated: false }) }));
  } });
  assert.equal((await api.lookup("a".repeat(32))).exists, false);
  await api.submit({ request_id: requestId });
  assert.deepEqual(await api.lookup("a".repeat(32)), { ok: true, exists: false });
  assert.equal(gets, 1);
  now += 30_001;
  assert.equal((await api.lookup("a".repeat(32))).exists, false);
  assert.equal(gets, 2);
});

test("API-level manual resubmission respects server wait even without an outbox; long lock waits return for durable storage", async () => {
  for (const code of ["RATE_LIMITED", "LOCK_TIMEOUT"]) {
    let now = 1_000, calls = 0;
    const api = createApiClient({ apiUrl: API, now: () => now, sleep: async () => assert.fail("long waits should be persisted, not slept"),
      gmRequest(details) { calls++; queueMicrotask(() => details.onload({ status: code === "RATE_LIMITED" ? 429 : 200,
        responseText: error(code, 3_600_000) })); } });
    assert.equal((await api.submit({ request_id: "same" })).error.code, code);
    now += 900_000;
    assert.equal((await api.submit({ request_id: "same" })).error.retry_after_ms, 2_700_000);
    assert.equal(calls, 1);
    now += 2_700_001;
    await api.submit({ request_id: "same" });
    assert.equal(calls, 2);
  }
});
