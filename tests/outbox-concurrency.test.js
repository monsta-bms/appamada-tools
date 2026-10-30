import assert from "node:assert/strict";
import test from "node:test";
import { createOutbox } from "../src/outbox.js";
import { createAppsScriptHarness } from "./helpers/apps-script-harness.js";
import { memoryStorage } from "./helpers/outbox-storage.js";
import { lockManager } from "./helpers/locks.js";

const MD5 = "a".repeat(32), prefix = "appamada.outbox.v1.";
const id = n => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const metadata = { title: "Fixture", artist: "Artist" };
const payload = n => ({ application_type: "change", request_id: id(n), md5: MD5, proposed_level: "10+",
  comment: "same intent", bmsir_user_name: "FixtureUser", bmsir_player_id: "123456",
  ir_url: `https://bms-ir.org/new/song?songmd5=${MD5}`, client_version: "0.4.7" });
let realm = 0;
async function factory() { return (await import(`../src/outbox.js?realm=${++realm}`)).createOutbox; }
async function twoContexts({ sharedLocks = true, noLocks = false } = {}) {
  const storage = memoryStorage(), server = await createAppsScriptHarness({ kkjRows: [["10", "Title", "Artist", MD5, ""]] });
  const calls = [], locks = lockManager();
  const make = async (separateLock = false) => (await factory())({ storage, playerId: "123456",
    locks: noLocks ? undefined : separateLock ? lockManager() : locks, sharedLockScope: sharedLocks && !noLocks,
    now: () => 1_000, sleep: async () => {}, apiClient: { async submit(p) {
      calls.push(structuredClone(p)); return server.post(p);
    } } });
  return { storage, server, calls, locks, a: await make(), b: await make(!sharedLocks) };
}

test("shared locks serialize save/send/flush with one lock name and preserve identical intents", async () => {
  const state = await twoContexts();
  const [a, b] = await Promise.all([state.a.enqueue(payload(1), metadata), state.b.enqueue(payload(2), metadata)]);
  assert.equal(a.payload.request_id, b.payload.request_id);
  assert.equal((await state.a.list()).length, 1);
  await Promise.all([state.a.send(id(1)), state.b.flush()]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.server.applications().length, 1);
  assert.equal(new Set(state.locks.names).size, 1);
});

test("same-realm save calls are serialized even without Web Locks", async () => {
  const storage = memoryStorage();
  const make = () => createOutbox({ storage, playerId: "123456", apiClient: {}, sleep: async () => {} });
  const a = make(), b = make();
  await Promise.all([a.enqueue(payload(1), metadata), b.enqueue(payload(2), metadata)]);
  assert.equal((await a.list()).length, 1);
  await assert.rejects(a.remove(id(1)), { code: "OUTBOX_CANCEL_UNSAFE" });
});

test("missing or different-origin lock scopes may duplicate communication, but same-ID server acceptance stays one", async t => {
  for (const noLocks of [true, false]) await t.test(noLocks ? "unavailable" : "separate origins", async () => {
    const state = await twoContexts({ sharedLocks: false, noLocks });
    await state.a.enqueue(payload(1), metadata);
    await Promise.all([state.a.send(id(1)), state.b.send(id(1))]);
    assert.equal(state.calls.length, 2, "do not falsely claim cross-origin network exclusion");
    assert.equal(state.server.applications().length, 1);
    assert.equal((await state.a.list())[0].status, "sent");
    assert.deepEqual(state.calls, [payload(1), payload(1)]);
    await state.a.enqueue({ ...payload(2), comment: "another intent" }, metadata);
    await assert.rejects(state.b.remove(id(2)), { code: "OUTBOX_CANCEL_UNSAFE" });
  });
});

test("different-ID same-content concurrent proposals are a separate limitation without shared coordination", async () => {
  const state = await twoContexts({ sharedLocks: false, noLocks: true });
  await Promise.all([state.a.enqueue(payload(1), metadata), state.b.enqueue(payload(2), metadata)]);
  assert.equal((await state.a.list()).length, 2);
  // No new server business rule forbids a later intentional re-proposal.
  await state.a.send(id(1));
  await state.a.enqueue(payload(3), metadata);
  assert.equal(state.calls.length, 1);
});

test("cancellation winning a shared lock prevents sending; sending winning never reports cancellation success", async () => {
  const state = await twoContexts();
  await state.a.enqueue(payload(1), metadata);
  await Promise.all([state.a.remove(id(1)), state.b.send(id(1))]);
  assert.equal(state.calls.length, 0);
  await state.a.enqueue(payload(2), metadata);
  const results = await Promise.allSettled([state.b.send(id(2)), state.a.remove(id(2))]);
  assert.equal(results[0].value.status, "sent");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "OUTBOX_CANNOT_CANCEL");
  assert.equal((await state.a.list())[0].status, "sent");
  await state.a.remove(id(2), { kind: "receipt" });
  assert.equal(state.server.applications().length, 1, "receipt removal is not server withdrawal");
});

test("receipt persistence failure retries the original payload and request ID after the unknown-result lease", async () => {
  const storage = memoryStorage(), originalSet = storage.set;
  let failReceipt = true, now = 1_000;
  storage.set = async (name, value) => {
    if (failReceipt && name.includes(".receipt.")) throw new Error("quota");
    await originalSet(name, value);
  };
  const server = await createAppsScriptHarness({ kkjRows: [["10", "Title", "Artist", MD5, ""]] });
  const bodies = [];
  const make = () => createOutbox({ storage, playerId: "123456", now: () => now,
    apiClient: { async submit(p) { bodies.push(p); return server.post(p); } } });
  const first = make();
  await first.enqueue(payload(1), metadata);
  await assert.rejects(first.send(id(1)), { code: "OUTBOX_STORAGE_UNAVAILABLE" });
  assert.equal((await first.list())[0].status, "sending");
  await assert.rejects(first.remove(id(1)), { code: "OUTBOX_CANNOT_CANCEL" });
  assert.equal(server.applications().length, 1);
  failReceipt = false; now += 90_001;
  const result = await make().send(id(1));
  assert.equal(result.status, "sent");
  assert.equal(result.receipt.deduplicated, true);
  assert.deepEqual(bodies, [payload(1), payload(1)]);
  assert.equal(server.applications().length, 1);
});

test("200 completed receipts do not consume the 200 unresolved limit; originals are not pruned", async () => {
  const storage = memoryStorage();
  const box = createOutbox({ storage, playerId: "123456", apiClient: {}, now: () => 1_000 });
  await box.enqueue(payload(1), metadata);
  const seed = await storage.get(`${prefix}entry.${id(1)}`);
  for (let n = 1; n <= 200; n++) {
    await storage.set(`${prefix}entry.${id(n)}`, { ...seed, payload: { ...payload(n), comment: `fixture ${n}` } });
    await storage.set(`${prefix}receipt.${id(n)}`, { request_id: id(n), sentAt: 1_000, deduplicated: false });
  }
  await box.enqueue(payload(201), metadata);
  assert.equal((await box.list()).length, 201);
  assert.equal([...storage.values.keys()].filter(k => k.includes(".receipt.")).length, 200);
  for (let n = 202; n <= 400; n++) await storage.set(`${prefix}entry.${id(n)}`,
    { ...seed, payload: { ...payload(n), comment: `fixture ${n}` } });
  await assert.rejects(box.enqueue({ ...payload(401), comment: "new intent" }, metadata), { code: "OUTBOX_FULL" });
  assert.equal((await box.list()).length, 400);
});
