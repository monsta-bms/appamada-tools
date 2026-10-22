import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createAppsScriptHarness } from "./helpers/apps-script-harness.js";

const SECRET = "local-test-gateway-secret-not-for-production-123456";
const MD5 = "a".repeat(32);
function payload(index, md5 = MD5) {
  return { application_type: "new", request_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    md5, proposed_level: "10", comment: "local fixture", title: "fixture", artist: "fixture",
    bmsir_user_name: `name${index}`, bmsir_player_id: String(index),
    ir_url: `https://bms-ir.org/new/song?songmd5=${md5}`, client_version: "0.4.7" };
}

test("actual local Worker/SQLite DO signs requests, bounds sources, and rejects unsafe forwarding", { timeout: 60000 }, async (t) => {
  const gas = await createAppsScriptHarness();
  const forwarded = [];
  let upstreamMode = "normal";
  const mf = new Miniflare({
    cf: false, telemetry: { enabled: false },
    workers: [{ config: {
      name: "gateway", compatibilityDate: "2026-10-22",
      manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: await readFile(new URL("../gateway/worker.js", import.meta.url), "utf8") } } },
      env: {
        SOURCE_LIMITER: { type: "durable-object", worker: "gateway", exportName: "SourceRateLimiter" },
        GATEWAY_SHARED_SECRET: { type: "text", value: SECRET },
        GAS_API_URL: { type: "text", value: "https://script.google.com/macros/s/LOCAL_FIXTURE/exec" },
      },
      exports: { SourceRateLimiter: { type: "durable-object", storage: "sqlite" } },
    }, dev: { stripCfConnectingIp: false, outboundService: { type: "fetcher", handler: async (request) => {
      forwarded.push({ url: request.url, method: request.method });
      if (upstreamMode === "evil-redirect") return new Response(null, { status: 302, headers: { Location: "https://example.invalid/exfiltrate" } });
      if (upstreamMode === "oversized") return new Response("x".repeat(65537));
      if (request.method === "GET") return Response.json({ ok: true, exists: false });
      const envelope = await request.json();
      const expected = createHmac("sha256", SECRET).update(`appamada-gateway-v1\n${envelope.issued_at}\n${envelope.source_hash}\n${envelope.payload}`).digest("hex");
      assert.equal(envelope.signature, expected);
      assert.doesNotMatch(envelope.source_hash, /192\.0\.2/);
      return Response.json(gas.postRaw(envelope));
    } } } }],
  });
  t.after(() => mf.dispose());
  async function send(value, ip = "192.0.2.10", ua = "fixture", extra = {}) {
    const result = await mf.dispatchFetch("https://gateway.fixture.workers.dev/api", {
      method: "POST", headers: { "CF-Connecting-IP": ip, "User-Agent": ua, "Content-Type": "text/plain", ...extra },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
    return { status: result.status, body: await result.json() };
  }
  await t.test("end-to-end normal submission and idempotent replay retain RAW/19 columns", async () => {
    const p = payload(1);
    assert.equal((await send(p)).body.deduplicated, false);
    assert.equal((await send(p)).body.deduplicated, true);
    assert.equal(gas.applications()[0].length, 19);
    assert.equal(gas.rawWrites[0].options.valueInputOption, "RAW");
  });
  await t.test("UA/name/player changes cannot bypass the ten-per-chart source limit", async () => {
    for (let i = 2; i <= 9; i++) assert.equal((await send(payload(i), "192.0.2.10", `ua${i}`)).body.ok, true);
    assert.equal((await send(payload(10), "192.0.2.10", "new-ua")).body.error.code, "RATE_LIMITED");
    assert.equal((await send(payload(11), "192.0.2.11")).body.ok, true);
  });
  await t.test("concurrent requests are capped atomically by SQLite DO", async () => {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => send(payload(100 + i), "192.0.2.12", `ua${i}`)));
    assert.equal(results.filter(r => r.body.ok).length, 10);
    assert.equal(results.filter(r => r.body.error?.code === "RATE_LIMITED").length, 6);
  });
  await t.test("changing chart IDs cannot bypass the sixty-attempt source budget", async () => {
    for (let i = 0; i < 60; i++) assert.equal((await send(payload(200 + i, i.toString(16).padStart(32, "0")), "192.0.2.13")).body.ok, true);
    assert.equal((await send(payload(300), "192.0.2.13")).body.error.code, "RATE_LIMITED");
  });
  await t.test("invalid trusted source cannot be replaced by X-Forwarded-For", async () => {
    const result = await mf.dispatchFetch("https://gateway.fixture.workers.dev/api", {
      method: "POST", headers: { "CF-Connecting-IP": "unavailable", "X-Forwarded-For": "192.0.2.10" }, body: JSON.stringify(payload(301)),
    });
    assert.equal((await result.json()).error.code, "GATEWAY_SOURCE_REQUIRED");
  });
  await t.test("oversized body is rejected before forwarding", async () => {
    const before = forwarded.length;
    assert.equal((await send("x".repeat(32769))).body.error.code, "BAD_REQUEST");
    assert.equal(forwarded.length, before);
  });
  await t.test("unknown Origin is rejected before forwarding", async () => {
    const before = forwarded.length;
    assert.equal((await send(payload(302), "192.0.2.14", "ua", { Origin: "https://example.invalid" })).status, 403);
    assert.equal(forwarded.length, before);
  });
  await t.test("lookup and preflight keep their existing payload contract", async () => {
    const lookup = await mf.dispatchFetch(`https://gateway.fixture.workers.dev/api?action=lookup&md5=${MD5}`, { headers: { "CF-Connecting-IP": "192.0.2.15", Origin: "https://bms-ir.org" } });
    assert.deepEqual(await lookup.json(), { ok: true, exists: false });
    const options = await mf.dispatchFetch("https://gateway.fixture.workers.dev/api", { method: "OPTIONS", headers: { Origin: "https://bms-ir.org" } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("Access-Control-Allow-Origin"), "https://bms-ir.org");
  });
  await t.test("upstream cannot redirect the signed payload to another domain", async () => {
    upstreamMode = "evil-redirect";
    const result = await send(payload(303), "192.0.2.16");
    assert.equal(result.body.error.code, "GATEWAY_UNAVAILABLE");
    assert.equal(forwarded.some(item => item.url.startsWith("https://example.invalid")), false);
  });
  await t.test("upstream response is also bounded", async () => {
    upstreamMode = "oversized";
    assert.equal((await send(payload(304), "192.0.2.17")).body.error.code, "GATEWAY_UNAVAILABLE");
  });
});
