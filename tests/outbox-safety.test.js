import assert from "node:assert/strict";
import test from "node:test";
import { createGmStorage, createOutbox } from "../src/outbox.js";
import { memoryStorage } from "./helpers/outbox-storage.js";

const prefix = "appamada.outbox.v1.";
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = (kind, n) => `${prefix}${kind}.${typeof n === "number" ? id(n) : n}`;
const metadata = { title: "Fixture", artist: "Fixture artist" };
function payload(n = 1, overrides = {}) {
  return { application_type: "change", request_id: id(n), md5: "a".repeat(32), proposed_level: "10+",
    comment: `fixture ${n}`, bmsir_user_name: "FixtureUser", bmsir_player_id: "123456",
    ir_url: `https://bms-ir.org/new/song?songmd5=${"a".repeat(32)}`, client_version: "0.4.7", ...overrides };
}
function setup(storage = memoryStorage(), extra = {}) {
  const calls = [];
  const outbox = createOutbox({ storage, playerId: "123456", now: () => 1_000,
    sleep: async () => {}, apiClient: { async submit(body) {
      calls.push(body); return { ok: true, request_id: body.request_id, deduplicated: false };
    } }, ...extra });
  return { outbox, storage, calls };
}

test("one individually malformed record never blocks two valid proposals, new saves or original export", async t => {
  for (const defect of ["metadata", "payload", "state", "receipt", "version", "key", "cancelled"]) {
    await t.test(defect, async () => {
      const { outbox, storage, calls } = setup();
      for (let n = 1; n <= 3; n++) await outbox.enqueue(payload(n), metadata);
      const entry = await storage.get(key("entry", 2));
      let badKey = key("entry", 2), bad;
      if (defect === "metadata") { delete entry.metadata; bad = entry; }
      if (defect === "payload") { entry.payload.md5 = "invalid"; bad = entry; }
      if (defect === "version") { entry.version = 99; bad = entry; }
      if (defect === "state") { badKey = key("state", 2); bad = { status: "sending", attempts: -1, nextAttemptAt: 0 }; }
      if (defect === "receipt") { badKey = key("receipt", 2); bad = { request_id: id(2), sentAt: "invalid", deduplicated: false }; }
      if (defect === "cancelled") { badKey = key("cancelled", 2); bad = { cancelled: "maybe" }; }
      if (defect === "key") { await storage.remove(badKey); badKey = key("entry", "invalid-id"); bad = entry; }
      await storage.set(badKey, bad);
      const snapshot = await outbox.inspect();
      assert.equal(snapshot.entries.length, 2);
      assert.equal(snapshot.issues.length, 1);
      assert.equal((await outbox.send(defect === "key" ? "invalid-id" : id(2))).status, "review");
      await outbox.flush();
      assert.deepEqual(calls.map(p => p.request_id), [id(1), id(3)]);
      await outbox.enqueue(payload(4), metadata);
      assert.equal((await outbox.list()).length, 3);
      assert.deepEqual(await storage.get(badKey), bad);
      const exported = JSON.parse(await outbox.exportData());
      assert.deepEqual(exported.records.find(record => record.key === badKey).value, bad);
      assert.equal(exported.issues.length, 1);
    });
  }
});

test("foreign corruption is neither displayed nor exported; unknown owners are counted without content", async () => {
  const { outbox, storage, calls } = setup();
  await outbox.enqueue(payload(1), metadata);
  const entry = await storage.get(key("entry", 1));
  const foreign = structuredClone(entry);
  foreign.payload.bmsir_player_id = "789"; foreign.payload.request_id = id(2);
  foreign.metadata = null; foreign.payload.comment = "FOREIGN_PRIVATE_TEXT";
  await storage.set(key("entry", 2), foreign);
  await storage.set(key("entry", 3), { version: 99, data: "UNKNOWN_PRIVATE_TEXT" });
  await storage.set(key("receipt", 4), { request_id: id(4), sentAt: 1, deduplicated: false });
  const snapshot = await outbox.inspect();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.issues.length, 0);
  assert.equal(snapshot.unidentifiedCount, 2);
  assert.equal(await outbox.send(id(2)).then(r => r.status), "missing");
  await outbox.flush();
  assert.equal(calls.length, 1);
  const exported = await outbox.exportData();
  assert.doesNotMatch(exported, /FOREIGN_PRIVATE_TEXT|UNKNOWN_PRIVATE_TEXT/);
  assert.deepEqual(await storage.get(key("entry", 2)), foreign);
  assert.deepEqual(await storage.get(key("entry", 3)), { version: 99, data: "UNKNOWN_PRIVATE_TEXT" });
});

test("a corrupt state does not reset attempts or resend an accepted receipt", async () => {
  const { outbox, storage, calls } = setup();
  await outbox.enqueue(payload(), metadata);
  const state = { status: "sending", attempts: "lost", nextAttemptAt: 90_000 };
  await storage.set(key("state", 1), state);
  assert.equal((await outbox.send(id(1))).status, "review");
  assert.equal(calls.length, 0);
  await storage.set(key("receipt", 1), { request_id: id(1), sentAt: 500, deduplicated: true });
  const [sent] = await outbox.list();
  assert.equal(sent.status, "sent");
  assert.equal(sent.attempts, null);
  assert.equal((await outbox.send(id(1))).status, "sent");
  assert.equal(calls.length, 0);
  assert.deepEqual(await storage.get(key("state", 1)), state);
  assert.equal((await outbox.inspect()).issues[0].blocked, false);
});

test("v1 and original client version stay immutable; old levels and future formats are quarantined without migration", async () => {
  const { outbox, storage } = setup();
  await outbox.enqueue(payload(), metadata);
  const old = await storage.get(key("entry", 1));
  old.payload.proposed_level = "legacy-17";
  await storage.set(key("entry", 1), old);
  await outbox.enqueue(payload(2), metadata);
  const before = structuredClone([...storage.values]);
  for (let n = 0; n < 3; n++) {
    const reloaded = setup(storage).outbox;
    assert.equal((await reloaded.list()).length, 1);
    assert.equal((await reloaded.inspect()).issues[0].reason, "OUTBOX_PAYLOAD_UNSUPPORTED");
  }
  assert.deepEqual([...storage.values], before);
  await assert.rejects(outbox.enqueue(payload(), metadata), { code: "OUTBOX_REVIEW_REQUIRED" });
  assert.equal(old.payload.client_version, "0.4.7");
});

test("storage enumeration/read failures are explicit, never empty queues or sends", async () => {
  for (const method of ["keys", "get"]) {
    const storage = memoryStorage();
    const { outbox, calls } = setup(storage);
    await outbox.enqueue(payload(), metadata);
    storage[method] = async () => { throw new Error("permission"); };
    for (const action of [() => outbox.list(), () => outbox.inspect(), () => outbox.flush(),
      () => outbox.send(id(1)), () => outbox.exportData(), () => outbox.enqueue(payload(2), metadata)]) {
      await assert.rejects(action(), { code: "OUTBOX_STORAGE_UNAVAILABLE" });
    }
    assert.equal(calls.length, 0);
  }
});

test("non-JSON damaged originals export with explicit value encoding instead of silently losing NaN or cycles", async () => {
  const { outbox, storage } = setup();
  await outbox.enqueue(payload(), metadata);
  const original = await storage.get(key("entry", 1));
  original.notBefore = NaN;
  original.circular = original;
  await storage.set(key("entry", 1), original);
  const exported = JSON.parse(await outbox.exportData());
  const raw = exported.records.find(record => record.key === key("entry", 1));
  assert.equal(raw.encoding, "structured-graph-v1");
  assert.deepEqual(raw.value.nodes[0].entries.find(([key]) => key === "notBefore")[1], { type: "number", value: "NaN" });
  assert.deepEqual(raw.value.nodes[0].entries.find(([key]) => key === "circular")[1], { type: "reference", id: 0 });
  assert.equal(Number.isNaN((await storage.get(key("entry", 1))).notBefore), true);
});

test("completed flush reads only entries/receipts with no persistent index, preserving tombstones and reload recovery", async () => {
  const { outbox, storage } = setup();
  await outbox.enqueue(payload(), metadata);
  const seed = await storage.get(key("entry", 1));
  for (let n = 1; n <= 200; n++) {
    await storage.set(key("entry", n), { ...seed, payload: payload(n) });
    await storage.set(key("receipt", n), { request_id: id(n), sentAt: 1_000, deduplicated: false });
    await storage.set(key("state", n), { status: "sending", attempts: 1, nextAttemptAt: 91_000 });
  }
  const get = storage.get, keys = storage.keys;
  let reads = 0, lists = 0;
  storage.get = async name => { reads++; return get(name); };
  storage.keys = async () => { lists++; return keys(); };
  await outbox.flush();
  assert.equal(reads, 400);
  assert.equal(lists, 1);
  await storage.set(key("cancelled", 999), true);
  assert.equal((await outbox.inspect()).unidentifiedCount, 0);
  assert.equal(await storage.get(key("cancelled", 999)), true);
  const added = { ...seed, payload: payload(201) };
  await storage.set(key("entry", 201), added);
  const reloaded = setup(storage);
  await reloaded.outbox.flush();
  assert.equal(reloaded.calls[0].request_id, id(201));
  assert.equal((await reloaded.outbox.list()).length, 201);
});

test("contradictory rejected communication states stay quarantined, not reset, cancelled or auto-retried", async () => {
  for (const errorCode of ["API_NETWORK_ERROR", "RATE_LIMITED", "WRITE_FAILED"]) {
    const { outbox, storage, calls } = setup();
    await outbox.enqueue(payload(), metadata);
    const state = { status: "rejected", attempts: 3, nextAttemptAt: 0, errorCode };
    await storage.set(key("state", 1), state);
    assert.equal((await outbox.inspect()).issues[0].reason, "OUTBOX_STATE_UNCERTAIN");
    assert.equal((await outbox.send(id(1))).status, "review");
    await assert.rejects(outbox.remove(id(1), { kind: "receipt" }), { code: "OUTBOX_REVIEW_REQUIRED" });
    assert.equal(calls.length, 0);
    assert.deepEqual(await storage.get(key("state", 1)), state);
  }
});

test("manual-only configuration holds show a resumption condition and preserve FIFO until explicit retry", async () => {
  for (const code of ["API_NOT_CONFIGURED", "SHEET_SCHEMA_INVALID", "GATEWAY_AUTH_REQUIRED", "UNRECOGNIZED_SERVER_ERROR"]) {
    const storage = memoryStorage();
    let recovered = false, now = 1_000;
    const calls = [];
    const outbox = setup(storage, { now: () => now, apiClient: { async submit(p) {
      calls.push(p.request_id);
      return recovered ? { ok: true, request_id: p.request_id, deduplicated: false } : { ok: false, error: { code } };
    } } }).outbox;
    await outbox.enqueue(payload(1), metadata); await outbox.enqueue(payload(2), metadata);
    await outbox.send(id(1));
    now += 1_000_000;
    assert.equal((await outbox.flush())[0].status, "waiting");
    assert.deepEqual(calls, [id(1)]);
    const snapshot = await outbox.inspect();
    assert.equal(snapshot.entries[0].manualOnly, true);
    assert.equal(snapshot.queue.requestId, id(1));
    recovered = true;
    await outbox.flush({ manual: true });
    assert.deepEqual(calls, [id(1), id(1), id(2)]);
    assert.equal((await outbox.list()).every(entry => entry.status === "sent"), true);
  }
});

test("an awaiting-result head retains FIFO while unrelated malformed items do not stall valid processing", async () => {
  const { outbox, storage, calls } = setup();
  await outbox.enqueue(payload(1), metadata); await outbox.enqueue(payload(2), metadata);
  await storage.set(key("state", 1), { status: "sending", attempts: 1, nextAttemptAt: 91_000, errorCode: "" });
  const result = await outbox.flush({ manual: true });
  assert.equal(result[0].status, "waiting");
  assert.equal(calls.length, 0);
  assert.equal((await outbox.inspect()).queue.nextAttemptAt, 91_000);
});

test("same-ID field order and canonical server UUID casing never mutate saved originals", async () => {
  const { outbox, storage } = setup(undefined, { apiClient: { async submit(p) {
    return { ok: true, request_id: p.request_id.toLowerCase(), deduplicated: true };
  } } });
  const p = payload(1, { request_id: "ABCDEF00-0000-4000-8000-000000000001" });
  const original = await outbox.enqueue(p, metadata);
  const reversed = Object.fromEntries(Object.entries(p).reverse());
  assert.deepEqual((await outbox.enqueue(reversed, metadata)).payload, p);
  assert.equal((await outbox.send(p.request_id)).status, "sent");
  assert.deepEqual((await storage.get(`${prefix}entry.${p.request_id}`)).payload, original.payload);
});

test("untrusted state fields cannot replace a validated payload or leak another player into send/list", async () => {
  const { outbox, storage, calls } = setup();
  await outbox.enqueue(payload(), metadata);
  const state = { status: "pending", attempts: 0, nextAttemptAt: 0,
    payload: payload(2, { bmsir_player_id: "789", comment: "FOREIGN_PRIVATE_TEXT" }) };
  await storage.set(key("state", 1), state);
  assert.equal((await outbox.inspect()).issues[0].reason, "OUTBOX_STATE_INVALID");
  assert.equal((await outbox.list()).length, 0);
  assert.equal((await outbox.send(id(1))).status, "review");
  assert.equal(calls.length, 0);
  assert.deepEqual(await storage.get(key("state", 1)), state);
  assert.doesNotMatch(await outbox.exportData(), /FOREIGN_PRIVATE_TEXT/);
});

test("stored string payloads outside current content rules stay individually reviewable without rewriting", async () => {
  for (const overrides of [{ comment: "😀".repeat(501) }, { client_version: "legacy-client" }]) {
    const { outbox, storage, calls } = setup();
    await outbox.enqueue(payload(), metadata);
    const entry = await storage.get(key("entry", 1));
    Object.assign(entry.payload, overrides);
    await storage.set(key("entry", 1), entry);
    await outbox.enqueue(payload(2), metadata);
    assert.equal((await outbox.inspect()).issues[0].reason, "OUTBOX_PAYLOAD_UNSUPPORTED");
    await outbox.flush();
    assert.deepEqual(calls.map(p => p.request_id), [id(2)]);
    assert.deepEqual(await storage.get(key("entry", 1)), entry);
  }
});

test("damaged current-account rate pause is visible, exported and cannot be bypassed by manual send", async () => {
  const { outbox, storage, calls } = setup();
  await outbox.enqueue(payload(), metadata);
  const raw = { until: "unknown", errorCode: "RATE_LIMITED" };
  await storage.set(`${prefix}pause.123456`, raw);
  const snapshot = await outbox.inspect();
  assert.equal(snapshot.queue.blocked, true);
  assert.equal(snapshot.issues[0].reason, "OUTBOX_PAUSE_INVALID");
  assert.equal((await outbox.send(id(1))).status, "review");
  assert.equal((await outbox.flush({ manual: true }))[0].status, "review");
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(await outbox.exportData()).records.find(r => r.key.endsWith("pause.123456")).value, raw);
});

test("partially available GM storage is an explicit failure, not the unsupported/direct-submit path", async () => {
  for (const options of [{ modern: { getValue: async () => "existing" } }, { legacy: { keys: async () => [] } }]) {
    const storage = createGmStorage(options);
    assert.ok(storage);
    const { outbox, calls } = setup(storage);
    await assert.rejects(outbox.enqueue(payload(), metadata), { code: "OUTBOX_STORAGE_UNAVAILABLE" });
    assert.equal(calls.length, 0);
  }
  assert.equal(createGmStorage(), null, "fully unsupported remains the legacy online-only path");
});
