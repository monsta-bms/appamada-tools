import { isAllowedLevel } from "./levels.js";
import { rateRetryDelay, validRetryDelay } from "./retry-policy.js";
import { preserveRawRecord } from "./outbox-export.js";
import { matchesRequestId } from "./api-client.js";

export const OFFLINE_NOTICE = "通信不具合中。現時点の難易度表データ取得できません";
const PREFIX = "appamada.outbox.v1.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_GATEWAY_REJECTIONS = new Set([
  "GATEWAY_AUTH_REQUIRED", "GATEWAY_NOT_CONFIGURED", "GATEWAY_SOURCE_REQUIRED", "GATEWAY_UNAVAILABLE",
]);
const TRANSIENT = new Set([
  "API_NETWORK_ERROR", "API_TIMEOUT", "API_INVALID_RESPONSE", "LOCK_TIMEOUT",
  "RATE_LIMITED", "WRITE_FAILED", "INTERNAL_ERROR", "SUBMISSIONS_DISABLED",
  ...LEGACY_GATEWAY_REJECTIONS,
]);
const MANUAL_RESUME = new Set([
  "API_NOT_CONFIGURED", "GATEWAY_NOT_CONFIGURED", "GATEWAY_AUTH_REQUIRED",
  "SHEET_NOT_FOUND", "SHEET_SCHEMA_INVALID", "CLIENT_VERSION_INVALID",
]);
const PERMANENT = new Set([
  "BAD_REQUEST", "APPLICATION_TYPE_INVALID", "LOGIN_NAME_MISSING", "PLAYER_ID_INVALID",
  "MD5_INVALID", "MD5_MISMATCH", "IR_URL_INVALID", "CHART_NOT_FOUND", "CHART_DUPLICATED",
  "CHART_ALREADY_EXISTS", "CURRENT_LEVEL_UNSUPPORTED", "TITLE_REQUIRED", "TITLE_TOO_LONG",
  "ARTIST_REQUIRED", "ARTIST_TOO_LONG", "LEVEL_REQUIRED", "LEVEL_INVALID", "SAME_AS_CURRENT",
  "COMMENT_TOO_LONG", "REQUEST_ID_INVALID", "REQUEST_ID_CONFLICT",
]);
const COMMON_FIELDS = [
  "application_type", "request_id", "md5", "proposed_level", "comment",
  "bmsir_user_name", "bmsir_player_id", "ir_url", "client_version",
];
const clone = (value) => JSON.parse(JSON.stringify(value));
// Same-realm callers can share a queue. This is not a cross-tab GM-storage lock.
const localQueues = new WeakMap();

export class OutboxError extends Error {
  constructor(code) {
    super(code);
    this.name = "OutboxError";
    this.code = code;
  }
}

export function isCommunicationError(code) {
  return ["API_NETWORK_ERROR", "API_TIMEOUT", "API_INVALID_RESPONSE"].includes(code);
}

// These values belong only to this Userscript, not to the BMS-IR site's storage.
export function createGmStorage({ modern, legacy = {} } = {}) {
  if (modern && ["getValue", "setValue", "deleteValue", "listValues"].every(
    (name) => typeof modern[name] === "function",
  )) {
    return {
      get: (key) => modern.getValue(key), set: (key, value) => modern.setValue(key, value),
      remove: (key) => modern.deleteValue(key), keys: () => modern.listValues(),
    };
  }
  if (["get", "set", "remove", "keys"].every((name) => typeof legacy[name] === "function")) {
    return legacy;
  }
  if (["getValue", "setValue", "deleteValue", "listValues"].some(name => typeof modern?.[name] === "function") ||
    ["get", "set", "remove", "keys"].some(name => typeof legacy[name] === "function")) {
    // Partial permissions/API availability is a storage failure, not evidence
    // that no queue exists. Never silently fall back to a direct online POST.
    const unavailable = async () => { throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE"); };
    return { get: unavailable, set: unavailable, remove: unavailable, keys: unavailable };
  }
  return null;
}

function validatePayload(payload, playerId, { stored = false } = {}) {
  const fields = payload?.application_type === "new" ? [...COMMON_FIELDS, "title", "artist"] : COMMON_FIELDS;
  let url;
  try { url = new URL(payload.ir_url); } catch { /* validated below */ }
  if (
    !payload || !["change", "new", "delete"].includes(payload.application_type) ||
    !UUID.test(payload.request_id) || !/^[0-9a-f]{32}$/.test(payload.md5) ||
    !fields.every((field) => typeof payload[field] === "string") ||
    Object.keys(payload).some((field) => !fields.includes(field)) ||
    payload.bmsir_player_id !== playerId || !/^[0-9]+$/.test(playerId) ||
    (!stored && (!payload.bmsir_user_name.trim() || Array.from(payload.comment).length > 500 ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(payload.client_version) ||
      !(payload.application_type === "delete" ? payload.proposed_level === "削除" : isAllowedLevel(payload.proposed_level)))) ||
    !url || url.protocol !== "https:" || !["bms-ir.org", "www.bms-ir.org"].includes(url.hostname) ||
    url.pathname !== "/new/song" || url.searchParams.get("songmd5")?.toLowerCase() !== payload.md5
  ) throw new OutboxError("OUTBOX_INVALID_DATA");
}

export function createOutbox({
  storage, apiClient, playerId, now = () => Date.now(), locks, sharedLockScope = false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxEntries = 200,
}) {
  if (!storage) throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
  playerId = String(playerId);
  let dispatching = false;
  const listeners = new Set();
  const canCancelUnsent = sharedLockScope === true && typeof locks?.request === "function";
  const key = (kind, id) => `${PREFIX}${kind}.${id}`;
  const deadline = (delay) => Math.min(Number.MAX_SAFE_INTEGER, now() + delay);
  const notify = () => { for (const listener of listeners) listener(); };
  async function read(name) {
    try { return await storage.get(name); } catch { throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE"); }
  }
  async function write(name, value) {
    try {
      await storage.set(name, value);
      if (JSON.stringify(await storage.get(name)) !== JSON.stringify(value)) throw new Error("readback");
    } catch { throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE"); }
  }
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const timestamp = (value) => Number.isFinite(value) && value >= 0;
  async function storageKeys() {
    let keys;
    try { keys = await storage.keys(); } catch { throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE"); }
    if (!Array.isArray(keys) || keys.some((name) => typeof name !== "string")) {
      throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
    }
    return new Set(keys);
  }
  async function inspectRecord(id, keys, { forDispatch = false } = {}) {
    const names = ["entry", "state", "receipt", "cancelled"].map((kind) => key(kind, id));
    const values = [];
    // A flush needs no mutable state for an already acknowledged item. A full
    // inspection/export still reads it, preserving damaged state in the backup.
    values[0] = keys.has(names[0]) ? await read(names[0]) : undefined;
    values[2] = keys.has(names[2]) ? await read(names[2]) : undefined;
    const acknowledged = record(values[2]) && values[2].request_id === id &&
      (values[2].version === undefined || values[2].version === 1) &&
      timestamp(values[2].sentAt) && typeof values[2].deduplicated === "boolean";
    const skipState = forDispatch && acknowledged;
    values[1] = !skipState && keys.has(names[1]) ? await read(names[1]) : undefined;
    values[3] = keys.has(names[3]) ? await read(names[3]) : undefined;
    const [entry, state, receipt, cancelled] = values;
    const raw = names.flatMap((name, index) => keys.has(name) ? [{ key: name, value: values[index] }] : []);
    const owner = entry?.payload?.bmsir_player_id;
    // Partition by the explicitly stored owner before validating any display fields.
    if (typeof owner === "string" && /^\d+$/.test(owner) && owner !== playerId) return {};
    if (owner !== playerId) {
      if (entry === undefined && cancelled === true && !keys.has(names[1]) && !keys.has(names[2])) return {};
      return { unidentified: raw.length ? 1 : 0 };
    }
    const issue = (reason, blocked = true) => ({ issue: { id, reason, blocked }, raw });
    if (!UUID.test(id)) return issue("OUTBOX_KEY_INVALID");
    if (!record(entry) || entry.version !== 1) return issue("OUTBOX_VERSION_UNSUPPORTED");
    if (Object.keys(entry).some(field => !["version", "createdAt", "notBefore", "payload", "metadata"].includes(field)) ||
      !timestamp(entry.createdAt) || !timestamp(entry.notBefore) || !record(entry.metadata) ||
      typeof entry.metadata?.title !== "string" || typeof entry.metadata?.artist !== "string") {
      return issue("OUTBOX_METADATA_INVALID");
    }
    try { validatePayload(entry.payload, playerId, { stored: true }); }
    catch { return issue("OUTBOX_PAYLOAD_INVALID"); }
    if (entry.payload.request_id !== id) return issue("OUTBOX_KEY_INVALID");
    if (keys.has(key("cancelled", id))) {
      if (cancelled === true) return { raw };
      return issue("OUTBOX_CANCELLATION_INVALID");
    }
    const hasState = !skipState && keys.has(key("state", id));
    const validState = !hasState || (record(state) && (state.version === undefined || state.version === 1) &&
      Object.keys(state).every(field => ["version", "status", "attempts", "nextAttemptAt", "errorCode", "manualOnly", "retryNotBefore"].includes(field)) &&
      Number.isSafeInteger(state.attempts) && state.attempts >= 0 && timestamp(state.nextAttemptAt) &&
      ["pending", "sending", "rejected"].includes(state.status) &&
      (state.errorCode === undefined || typeof state.errorCode === "string") &&
      (state.manualOnly === undefined || typeof state.manualOnly === "boolean") &&
      (state.retryNotBefore === undefined || timestamp(state.retryNotBefore)));
    const hasReceipt = keys.has(key("receipt", id));
    const validReceipt = hasReceipt && record(receipt) && (receipt.version === undefined || receipt.version === 1) &&
      Object.keys(receipt).every(field => ["version", "request_id", "sentAt", "deduplicated"].includes(field)) &&
      receipt.request_id === id && timestamp(receipt.sentAt) && typeof receipt.deduplicated === "boolean";
    if (hasReceipt && !validReceipt) return issue("OUTBOX_RECEIPT_INVALID");
    // A matching sticky receipt is authoritative even if a late state write is damaged.
    if (!validState && !validReceipt) return issue("OUTBOX_STATE_INVALID");
    if (!validReceipt && state?.status === "rejected" && TRANSIENT.has(state.errorCode) &&
      !LEGACY_GATEWAY_REJECTIONS.has(state.errorCode)) return issue("OUTBOX_STATE_UNCERTAIN");
    const savedState = validState && hasState ? { status: state.status, attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt, errorCode: state.errorCode,
      manualOnly: state.manualOnly, retryNotBefore: state.retryNotBefore } : undefined;
    const recoverGatewayRejection = !validReceipt && savedState?.status === "rejected" &&
      LEGACY_GATEWAY_REJECTIONS.has(savedState.errorCode);
    const result = { raw, entry: clone({ ...entry, ...savedState,
      status: validReceipt ? "sent" : recoverGatewayRejection ? "pending" : savedState?.status ?? "pending",
      attempts: !skipState && validState ? savedState?.attempts ?? 0 : null,
      nextAttemptAt: recoverGatewayRejection ? 0 : savedState?.nextAttemptAt ?? entry.notBefore,
      ...(validReceipt ? { receipt } : {}) }) };
    if (!validState) result.issue = { id, reason: "OUTBOX_STATE_INVALID", blocked: false };
    if (!validReceipt) {
      try { validatePayload(entry.payload, playerId); }
      catch { return issue("OUTBOX_PAYLOAD_UNSUPPORTED"); }
    }
    return result;
  }
  async function inspect({ forDispatch = false } = {}) {
    const keys = await storageKeys();
    const ids = new Set();
    const unusual = [];
    for (const name of keys) {
      const match = /^appamada\.outbox\.v1\.(entry|state|receipt|cancelled)\.(.*)$/.exec(name);
      if (match) ids.add(match[2]);
      else if (name.startsWith("appamada.outbox.") && !name.startsWith(`${PREFIX}pause.`)) unusual.push(name);
    }
    const entries = [], issues = [], raw = [];
    let unidentifiedCount = 0;
    // One finite traversal of the key snapshot. Individual schema errors are data,
    // whereas a failed get/listValues aborts the operation, never an empty queue.
    for (const id of ids) {
      const item = await inspectRecord(id, keys, { forDispatch });
      if (item.entry) entries.push(item.entry);
      if (item.issue) issues.push(item.issue);
      if (item.raw) raw.push(...item.raw);
      unidentifiedCount += item.unidentified ?? 0;
    }
    for (const name of unusual) {
      const value = await read(name);
      const owner = value?.payload?.bmsir_player_id;
      if (owner === playerId) {
        issues.push({ id: name, reason: "OUTBOX_KEY_INVALID", blocked: true });
        raw.push({ key: name, value });
      } else if (typeof owner !== "string" || !/^\d+$/.test(owner)) unidentifiedCount++;
    }
    entries.sort((a, b) => a.createdAt - b.createdAt || a.payload.request_id.localeCompare(b.payload.request_id));
    const head = entries.find(entry => ["pending", "sending"].includes(entry.status));
    const pause = keys.has(key("pause", playerId)) ? await read(key("pause", playerId)) : undefined;
    const validPause = pause === undefined || (record(pause) && timestamp(pause.until) &&
      typeof pause.errorCode === "string" && (pause.retryNotBefore === undefined || timestamp(pause.retryNotBefore)));
    if (!validPause) {
      issues.push({ id: "pause", reason: "OUTBOX_PAUSE_INVALID", blocked: true });
    }
    if (pause !== undefined) raw.push({ key: key("pause", playerId), value: pause });
    const paused = validPause && pause?.until > now();
    const queue = head ? { requestId: head.payload.request_id, manualOnly: Boolean(head.manualOnly),
      nextAttemptAt: Math.max(head.nextAttemptAt, paused ? pause.until : 0),
      errorCode: !validPause ? "OUTBOX_PAUSE_INVALID" : paused ? pause.errorCode : head.errorCode,
      blocked: !validPause } : null;
    return { entries, issues, unidentifiedCount, raw, reservedIds: ids, queue };
  }
  async function getEntry(id) {
    const item = await inspectRecord(id, await storageKeys());
    return item.entry ?? (item.issue ? { status: "review", errorCode: item.issue.reason } : null);
  }
  async function list() {
    return (await inspect()).entries;
  }
  async function coordinate(task, nonBlocking = false) {
    const previous = localQueues.get(storage) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      if (typeof locks?.request !== "function") return task();
      const name = `appamada-outbox-${playerId}`;
      return nonBlocking ? locks.request(name, { ifAvailable: true },
        lock => lock ? task() : { status: "busy" }) : locks.request(name, task);
    });
    // Always settle the queue tail; individual callers still receive their error.
    const tail = current.then(() => {}, () => {});
    localQueues.set(storage, tail);
    try { return await current; }
    finally { if (localQueues.get(storage) === tail) localQueues.delete(storage); }
  }
  async function dispatch(task) {
    if (dispatching) return { status: "busy" };
    dispatching = true;
    try {
      return await coordinate(task, true);
    } finally { dispatching = false; }
  }
  async function enqueue(payload, metadata, { defer = false } = {}) {
    validatePayload(payload, playerId);
    const save = async () => {
      const snapshot = await inspect();
      const { entries } = snapshot;
      const sameId = entries.find((entry) => entry.payload.request_id === payload.request_id);
      if (sameId) {
        const fields = COMMON_FIELDS.concat(payload.application_type === "new" ? ["title", "artist"] : []);
        if (JSON.stringify(fields.map(field => sameId.payload[field])) !== JSON.stringify(fields.map(field => payload[field]))) {
          throw new OutboxError("OUTBOX_CONFLICT");
        }
        return sameId;
      }
      if (await read(key("cancelled", payload.request_id))) throw new OutboxError("OUTBOX_CONFLICT");
      if (snapshot.reservedIds.has(payload.request_id)) throw new OutboxError("OUTBOX_REVIEW_REQUIRED");
      // A second click/reopened form reuses an identical waiting proposal.
      const intent = (value) => JSON.stringify(COMMON_FIELDS.concat(value.application_type === "new" ? ["title", "artist"] : [])
        .filter((field) => !["request_id", "client_version"].includes(field)).map((field) => value[field]));
      const existing = entries.find((entry) => ["pending", "sending"].includes(entry.status) && intent(entry.payload) === intent(payload));
      if (existing) return existing;
      if (entries.filter(entry => ["pending", "sending"].includes(entry.status)).length >= maxEntries) {
        throw new OutboxError("OUTBOX_FULL");
      }
      const entry = { version: 1, createdAt: now(), notBefore: defer ? now() + 30_000 : 0, payload: clone(payload),
        metadata: { title: String(metadata?.title ?? ""), artist: String(metadata?.artist ?? "") } };
      await write(key("entry", payload.request_id), entry);
      notify();
      return getEntry(payload.request_id);
    };
    return coordinate(save);
  }
  async function sendEntry(id, manual) {
    const entry = await getEntry(id);
    if (!entry) return { status: "missing" };
    if (["sent", "rejected", "review"].includes(entry.status)) return entry;
    if (entry.manualOnly && !manual) return { status: "waiting", errorCode: entry.errorCode,
      nextAttemptAt: entry.nextAttemptAt, manualOnly: true };
    // Never bypass server rate limits, even on the manual retry button.
    if (entry.retryNotBefore > now() || (entry.nextAttemptAt > now() && (!manual || entry.status === "sending" || entry.errorCode === "RATE_LIMITED"))) {
      return { status: "waiting", errorCode: entry.errorCode, nextAttemptAt: Math.max(entry.nextAttemptAt, entry.retryNotBefore ?? 0) };
    }
    const pause = await read(key("pause", playerId));
    if (pause !== undefined && (!record(pause) || !timestamp(pause.until) || typeof pause.errorCode !== "string" ||
      (pause.retryNotBefore !== undefined && !timestamp(pause.retryNotBefore)))) {
      return { status: "review", errorCode: "OUTBOX_PAUSE_INVALID" };
    }
    if (pause?.retryNotBefore > now() || (pause?.until > now() && (!manual || pause.errorCode === "RATE_LIMITED"))) {
      return { status: "waiting", errorCode: pause.errorCode, nextAttemptAt: Math.max(pause.until, pause.retryNotBefore ?? 0) };
    }
    const state = { status: "sending", attempts: entry.attempts + 1,
      nextAttemptAt: now() + 90_000, errorCode: "" };
    // Persist the attempt before sending, including across a page close/crash.
    await write(key("state", id), state);
    if (await read(key("cancelled", id))) return { status: "missing" };
    notify();
    let result;
    try {
      result = await apiClient.submit(clone(entry.payload));
      if (typeof result?.ok !== "boolean" || (result.ok && (!matchesRequestId(result.request_id, id) || typeof result.deduplicated !== "boolean"))) {
        throw new OutboxError("API_INVALID_RESPONSE");
      }
      if (!result?.ok && typeof result?.error?.code !== "string") throw new OutboxError("API_INVALID_RESPONSE");
    } catch (error) {
      result = { ok: false, error: { code: isCommunicationError(error?.code) || MANUAL_RESUME.has(error?.code)
        ? error.code : "API_NETWORK_ERROR" } };
    }
    if (result.ok) {
      // A separate sticky receipt cannot be overwritten by another tab's late timeout.
      try {
        await write(key("receipt", id), { request_id: id, sentAt: now(), deduplicated: result.deduplicated });
      } catch (error) {
        // Two validated acknowledgements can differ in time/deduplication flag.
        // Only an independently readable, matching receipt resolves the write race.
        const acknowledged = await getEntry(id);
        if (acknowledged?.status !== "sent") throw error;
      }
    } else {
      const errorCode = result.error.code;
      const retryable = !PERMANENT.has(errorCode);
      const manualOnly = MANUAL_RESUME.has(errorCode) || (!TRANSIENT.has(errorCode) && !PERMANENT.has(errorCode));
      const delay = errorCode === "RATE_LIMITED"
        ? rateRetryDelay(result.error.retry_after_ms)
        : Math.max(validRetryDelay(result.error.retry_after_ms) ?? 0,
          Math.min(300_000, 30_000 * 2 ** Math.min(state.attempts - 1, 4)));
      await write(key("state", id), { ...state, status: retryable ? "pending" : "rejected",
        nextAttemptAt: retryable ? deadline(delay) : 0, errorCode, manualOnly,
        retryNotBefore: validRetryDelay(result.error.retry_after_ms) === null ? 0 : deadline(delay) });
      if (retryable) {
        const oldPause = await read(key("pause", playerId));
        await write(key("pause", playerId), { until: Math.max(oldPause?.until ?? 0, deadline(delay)),
          retryNotBefore: Math.max(oldPause?.retryNotBefore ?? 0,
            validRetryDelay(result.error.retry_after_ms) === null ? 0 : deadline(delay)),
          errorCode: oldPause?.until > deadline(delay) ? oldPause.errorCode : errorCode });
      }
    }
    notify();
    return await getEntry(id) ?? { status: result.ok ? "sent" : "rejected", errorCode: result.error?.code };
  }
  async function send(id) { return dispatch(() => sendEntry(id, true)); }
  async function flush({ manual = false, limit = 5, shouldContinue = () => true } = {}) {
    return dispatch(async () => {
      const { entries, queue } = await inspect({ forDispatch: true });
      if (queue?.blocked) return [{ status: "review", errorCode: queue.errorCode }];
      const results = [];
      for (const entry of entries) {
        if (!shouldContinue()) break;
        if (!["pending", "sending"].includes(entry.status)) continue;
        const result = await sendEntry(entry.payload.request_id, manual);
        results.push(result);
        if (["pending", "waiting", "review"].includes(result.status) || results.length >= Math.min(5, limit)) break;
        await sleep(1_000);
      }
      return results;
    });
  }
  async function remove(id, { kind = "cancel" } = {}) {
    const result = await dispatch(async () => {
      const entry = await getEntry(id);
      if (!entry) return;
      if (entry.status === "review") throw new OutboxError("OUTBOX_REVIEW_REQUIRED");
      const completed = ["sent", "rejected"].includes(entry.status);
      // Do not turn a cancellation into receipt removal while waiting for a lock.
      if ((kind === "cancel" && (completed || entry.attempts > 0)) || (kind === "receipt" && !completed) ||
        !["cancel", "receipt"].includes(kind)) throw new OutboxError("OUTBOX_CANNOT_CANCEL");
      if (kind === "cancel" && !canCancelUnsent) {
        throw new OutboxError("OUTBOX_CANCEL_UNSAFE");
      }
      await write(key("cancelled", id), true);
      try {
        // Keep only the small tombstone: prevent an already-reading tab from sending it.
        for (const kind of ["entry", "state", "receipt"]) await storage.remove(key(kind, id));
      } catch { throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE"); }
      notify();
    });
    if (result?.status === "busy") throw new OutboxError("OUTBOX_BUSY");
  }
  return Object.freeze({
    enqueue, list, send, flush, remove, canCancelUnsent,
    async inspect() {
      const { entries, issues, unidentifiedCount, queue } = await inspect();
      return { entries, issues, unidentifiedCount, queue };
    },
    async exportData() {
      const { entries, issues, raw, unidentifiedCount } = await inspect();
      const ownRaw = raw.filter(record => ![record.value?.payload?.bmsir_player_id, record.value?.bmsir_player_id]
        .some(owner => typeof owner === "string" && /^\d+$/.test(owner) && owner !== playerId));
      return JSON.stringify({ version: 1, exportedAt: now(), entries, issues, records: ownRaw.map(preserveRawRecord),
        omittedRecords: { count: raw.length - ownRaw.length,
          notice: "別の所有者を示す情報を含む異常原本は、保存領域に残して通常の控え出力から除外しています。" },
        unidentified: { count: unidentifiedCount, included: false,
          notice: "所有者を確認できない原本は保存領域に残しています。内容はこの控えに含めません。" } }, null, 2);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
}

export function startOutboxSync({ outbox, window, onError = () => {}, intervalMs = 30_000 }) {
  let stopped = false;
  let disposed = false;
  let running = false;
  let timer;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try { await outbox.flush({ shouldContinue: () => !stopped }); } catch (error) { onError(error); }
    finally { running = false; }
    if (!stopped) timer = window.setTimeout(tick, intervalMs);
  }
  function wake() {
    if (stopped || window.document.visibilityState === "hidden") return;
    window.clearTimeout(timer);
    void tick();
  }
  function pause() {
    stopped = true;
    window.clearTimeout(timer);
  }
  function resume() {
    if (disposed) return;
    stopped = false;
    void tick();
  }
  function stop() {
    disposed = true;
    pause();
    window.removeEventListener("online", wake);
    window.document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("pagehide", pause);
    window.removeEventListener("pageshow", resume);
  }
  window.addEventListener("online", wake);
  window.document.addEventListener("visibilitychange", wake);
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", resume);
  void tick();
  return stop;
}
