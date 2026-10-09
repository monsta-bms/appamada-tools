import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createGmStorage, createOutbox, startOutboxSync } from "../src/outbox.js";
import { createAppsScriptHarness } from "./helpers/apps-script-harness.js";
import { memoryStorage } from "./helpers/outbox-storage.js";

const MD5 = "b89279d026c9d40d0f5eedde2e25b920";
const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const metadata = { title: "BMS-IR Title", artist: "Artist / Notes:fixture" };
function payload(type = "change", overrides = {}) {
  return { application_type: type, request_id: id(), md5: MD5,
    proposed_level: type === "delete" ? "削除" : "10+", comment: "=SUM(1,2)",
    bmsir_user_name: "FixtureUser", bmsir_player_id: "123456",
    ir_url: `https://bms-ir.org/new/song?songmd5=${MD5}`, client_version: "0.4.7",
    ...(type === "new" ? metadata : {}), ...overrides };
}
function setup(options = {}) {
  const storage = options.storage ?? memoryStorage();
  const calls = [];
  let time = 1_000;
  const apiClient = options.apiClient ?? { async submit(body) {
    calls.push(body);
    return { ok: true, request_id: body.request_id, deduplicated: false };
  } };
  const make = (extra = {}) => createOutbox({ storage, apiClient, playerId: "123456",
    now: () => time, sleep: async () => {}, ...options, ...extra });
  return { storage, calls, make, outbox: make(), advance(ms) { time += ms; } };
}

test("GM async storage and legacy storage are supported without site localStorage", async () => {
  const store = memoryStorage();
  const modern = createGmStorage({ modern: { getValue: store.get, setValue: store.set,
    deleteValue: store.remove, listValues: store.keys } });
  await modern.set("a", "value");
  assert.equal(await modern.get("a"), "value");
  assert.deepEqual(await modern.keys(), ["a"]);
  await modern.remove("a");
  assert.deepEqual(await modern.keys(), []);
  assert.equal(createGmStorage({ legacy: store }), store);
  assert.equal(createGmStorage(), null);
});

test("all three types persist across reload without a lookup or fabricated current level", async () => {
  const state = setup();
  for (const [index, type] of ["change", "new", "delete"].entries()) {
    await state.outbox.enqueue(payload(type, { request_id: id(index + 1) }), metadata, { defer: true });
  }
  const entries = await state.make().list();
  assert.equal(entries.length, 3);
  assert.equal(state.calls.length, 0);
  assert.equal(entries[0].status, "pending");
  for (const entry of entries) {
    assert.equal(entry.metadata.artist, metadata.artist);
    assert.equal("current_level" in entry.payload, false);
    if (entry.payload.application_type !== "new") assert.equal("title" in entry.payload, false);
  }
});

test("recovery sends waiting proposals in order, bounded at five per batch", async () => {
  const state = setup();
  for (let n = 1; n <= 7; n++) await state.outbox.enqueue(payload("change", {
    request_id: id(n), comment: `comment ${n}`,
  }), metadata, { defer: true });
  await state.outbox.flush();
  assert.equal(state.calls.length, 0);
  state.advance(30_001);
  await state.outbox.flush();
  assert.equal(state.calls.length, 5);
  assert.deepEqual(state.calls.map((body) => body.request_id), [1, 2, 3, 4, 5].map(id));
  await state.outbox.flush();
  assert.equal(state.calls.length, 7);
});

test("accepted POST with lost response retries the identical payload and creates just one server row", async () => {
  const server = await createAppsScriptHarness({ kkjRows: [["10", "Server title", "Server artist", MD5, ""]] });
  let loseResponse = true;
  const bodies = [];
  const state = setup({ apiClient: { async submit(body) {
    bodies.push(structuredClone(body));
    const result = server.post(body);
    if (loseResponse) { loseResponse = false; throw Object.assign(new Error(), { code: "API_TIMEOUT" }); }
    return result;
  } } });
  const original = payload();
  await state.outbox.enqueue(original, metadata);
  assert.equal((await state.outbox.send(id())).status, "pending");
  assert.equal(server.applications().length, 1);
  const reloaded = state.make();
  state.advance(30_001);
  const result = await reloaded.send(id());
  assert.equal(result.status, "sent");
  assert.equal(result.receipt.deduplicated, true);
  assert.deepEqual(bodies, [original, original]);
  assert.equal(server.applications().length, 1);
  assert.equal(server.applications()[0][10], original.comment);
  assert.equal(server.rawWrites[0].options.valueInputOption, "RAW");
});

test("registered new is rejected server-side after recovery, retained with reason and never retried", async () => {
  const server = await createAppsScriptHarness({ kkjRows: [["10", "Title", "Artist", MD5, ""]] });
  let calls = 0;
  const state = setup({ apiClient: { async submit(body) { calls++; return server.post(body); } } });
  await state.outbox.enqueue(payload("new"), metadata, { defer: true });
  state.advance(30_001);
  await state.outbox.flush();
  const [entry] = await state.outbox.list();
  assert.equal(entry.status, "rejected");
  assert.equal(entry.errorCode, "CHART_ALREADY_EXISTS");
  await state.outbox.flush({ manual: true });
  assert.equal(calls, 1);
  assert.equal(server.applications().length, 0);
  assert.equal(entry.payload.application_type, "new");
});

test("server verifies current level at submission, missing change/delete and same level are rejected", async () => {
  for (const [type, rows, code] of [
    ["change", [], "CHART_NOT_FOUND"], ["delete", [], "CHART_NOT_FOUND"],
    ["change", [["10+", "Title", "Artist", MD5, ""]], "SAME_AS_CURRENT"],
  ]) {
    const server = await createAppsScriptHarness({ kkjRows: rows });
    const state = setup({ apiClient: { async submit(body) { return server.post(body); } } });
    await state.outbox.enqueue(payload(type), metadata);
    const result = await state.outbox.send(id());
    assert.equal(result.errorCode, code);
    assert.equal(result.status, "rejected");
    assert.equal(server.applications().length, 0);
  }
});

test("failed requests use backoff and stop a batch rather than hammering the server", async () => {
  let calls = 0;
  const state = setup({ apiClient: { async submit() { calls++; throw Object.assign(new Error(), { code: "API_NETWORK_ERROR" }); } } });
  await state.outbox.enqueue(payload(), metadata);
  await state.outbox.enqueue(payload("delete", { request_id: id(2) }), metadata);
  await state.outbox.flush();
  await state.outbox.flush();
  assert.equal(calls, 1);
  state.advance(30_001);
  await state.outbox.flush();
  assert.equal(calls, 2);
  assert.equal((await state.outbox.list())[0].nextAttemptAt, 91_001);
});

test("RATE_LIMITED respects server retry delay even on manual retry", async () => {
  let calls = 0;
  const state = setup({ apiClient: { async submit() { calls++; return { ok: false,
    error: { code: "RATE_LIMITED", retry_after_ms: 120_000 } }; } } });
  await state.outbox.enqueue(payload(), metadata);
  await state.outbox.send(id());
  state.advance(90_000);
  await state.outbox.flush({ manual: true });
  assert.equal(calls, 1);
  state.advance(30_001);
  await state.outbox.flush();
  assert.equal(calls, 2);
});

test("wrong acknowledgement ID never marks a proposal sent", async () => {
  const state = setup({ apiClient: { async submit() { return { ok: true, request_id: id(2), deduplicated: false }; } } });
  await state.outbox.enqueue(payload(), metadata);
  const result = await state.outbox.send(id());
  assert.equal(result.status, "pending");
  assert.equal(result.errorCode, "API_INVALID_RESPONSE");
  assert.equal(result.receipt, undefined);
});

test("storage failures never report saved or send before durable save", async () => {
  const storage = memoryStorage();
  storage.set = async () => { throw new Error("quota"); };
  const state = setup({ storage });
  await assert.rejects(state.outbox.enqueue(payload(), metadata), { code: "OUTBOX_STORAGE_UNAVAILABLE" });
  assert.equal(state.calls.length, 0);
  assert.deepEqual(await state.outbox.list(), []);
});

test("capacity preserves pending proposals, identical intents reuse ID and original client version", async () => {
  const state = setup({ maxEntries: 1 });
  const first = await state.outbox.enqueue(payload(), metadata);
  const same = await state.make().enqueue(payload("change", { request_id: id(2), client_version: "0.4.8" }), metadata);
  assert.equal(same.payload.request_id, first.payload.request_id);
  assert.equal(same.payload.client_version, "0.4.7");
  await assert.rejects(state.outbox.enqueue(payload("delete", { request_id: id(3) }), metadata), { code: "OUTBOX_FULL" });
  assert.equal((await state.outbox.list()).length, 1);
});

test("different accounts are isolated and invalid data is preserved, not silently deleted", async () => {
  const state = setup();
  await state.outbox.enqueue(payload(), metadata);
  await state.make({ playerId: "190072" }).flush({ manual: true });
  assert.equal(state.calls.length, 0);
  assert.equal(JSON.parse(await state.make({ playerId: "190072" }).exportData()).entries.length, 0);
  const name = [...state.storage.values.keys()].find((name) => name.includes("entry."));
  const corrupted = { ...state.storage.values.get(name), notBefore: "invalid" };
  state.storage.values.set(name, corrupted);
  await assert.rejects(state.outbox.list(), { code: "OUTBOX_INVALID_DATA" });
  assert.deepEqual(state.storage.values.get(name), corrupted);
});

test("never-attempted proposals can be cancelled but ambiguous submissions cannot", async () => {
  const state = setup({ apiClient: { async submit() { throw Object.assign(new Error(), { code: "API_TIMEOUT" }); } } });
  await state.outbox.enqueue(payload(), metadata);
  await state.outbox.remove(id());
  assert.deepEqual(await state.outbox.list(), []);
  await assert.rejects(state.outbox.enqueue(payload(), metadata), { code: "OUTBOX_CONFLICT" });
  await state.outbox.enqueue(payload("change", { request_id: id(2) }), metadata);
  await state.outbox.send(id(2));
  await assert.rejects(state.outbox.remove(id(2)), { code: "OUTBOX_CANNOT_CANCEL" });
  assert.equal((await state.outbox.list()).length, 1);
});

test("concurrent tabs keep all entries and a late timeout cannot overwrite a sent receipt", async () => {
  const storage = memoryStorage();
  let finishLate;
  const slow = setup({ storage, apiClient: { submit: () => new Promise((_, reject) => { finishLate = reject; }) } });
  const fast = setup({ storage });
  await Promise.all([slow.outbox.enqueue(payload(), metadata), fast.outbox.enqueue(payload("delete", { request_id: id(2) }), metadata)]);
  const attempt = slow.outbox.send(id());
  while (!finishLate) await new Promise((resolve) => setImmediate(resolve));
  // Simulate the persisted in-flight lease expiring after a suspended tab.
  fast.advance(90_001);
  assert.equal((await fast.outbox.send(id())).status, "sent");
  finishLate(Object.assign(new Error(), { code: "API_TIMEOUT" }));
  assert.equal((await attempt).status, "sent");
  assert.equal((await fast.outbox.list()).length, 2);
});

test("Web Lock exclusion does not send, and shutdown stops automatic wakeups", async () => {
  const state = setup({ locks: { async request(_name, options, callback) {
    return typeof options === "function" ? options() : callback(null);
  } } });
  await state.outbox.enqueue(payload(), metadata);
  assert.equal((await state.outbox.send(id())).status, "busy");
  assert.equal(state.calls.length, 0);
  const dom = new JSDOM("", { pretendToBeVisual: true });
  let flushes = 0;
  const stop = startOutboxSync({ outbox: { async flush() { flushes++; } }, window: dom.window, intervalMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  dom.window.dispatchEvent(new dom.window.Event("online"));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(flushes, 1);
  dom.window.dispatchEvent(new dom.window.Event("pageshow"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(flushes, 2);
  stop();
  dom.window.dispatchEvent(new dom.window.Event("pageshow"));
  assert.equal(flushes, 2);
  dom.window.close();
});

test("client extra fields and altered immutable payload are rejected before sending", async () => {
  const state = setup();
  await assert.rejects(state.outbox.enqueue(payload("change", { current_level: "10" }), metadata), { code: "OUTBOX_INVALID_DATA" });
  await state.outbox.enqueue(payload(), metadata);
  await assert.rejects(state.outbox.enqueue(payload("change", { comment: "changed" }), metadata), { code: "OUTBOX_CONFLICT" });
  assert.equal(state.calls.length, 0);
});
