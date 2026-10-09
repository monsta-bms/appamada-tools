import { isAllowedLevel } from "./levels.js";

export const OFFLINE_NOTICE = "通信不具合中。現時点の難易度表データ取得できません";
const PREFIX = "appamada.outbox.v1.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSIENT = new Set([
  "API_NETWORK_ERROR", "API_TIMEOUT", "API_INVALID_RESPONSE", "LOCK_TIMEOUT",
  "RATE_LIMITED", "WRITE_FAILED", "INTERNAL_ERROR", "SUBMISSIONS_DISABLED",
]);
const COMMON_FIELDS = [
  "application_type", "request_id", "md5", "proposed_level", "comment",
  "bmsir_user_name", "bmsir_player_id", "ir_url", "client_version",
];
const clone = (value) => JSON.parse(JSON.stringify(value));

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
  return null;
}

function validatePayload(payload, playerId) {
  const fields = payload?.application_type === "new" ? [...COMMON_FIELDS, "title", "artist"] : COMMON_FIELDS;
  let url;
  try { url = new URL(payload.ir_url); } catch { /* validated below */ }
  if (
    !payload || !["change", "new", "delete"].includes(payload.application_type) ||
    !UUID.test(payload.request_id) || !/^[0-9a-f]{32}$/.test(payload.md5) ||
    !fields.every((field) => typeof payload[field] === "string") ||
    Object.keys(payload).some((field) => !fields.includes(field)) ||
    payload.bmsir_player_id !== playerId || !/^[0-9]+$/.test(playerId) ||
    !payload.bmsir_user_name.trim() || Array.from(payload.comment).length > 500 ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(payload.client_version) ||
    !(payload.application_type === "delete" ? payload.proposed_level === "削除" : isAllowedLevel(payload.proposed_level)) ||
    !url || url.protocol !== "https:" || !["bms-ir.org", "www.bms-ir.org"].includes(url.hostname) ||
    url.pathname !== "/new/song" || url.searchParams.get("songmd5")?.toLowerCase() !== payload.md5
  ) throw new OutboxError("OUTBOX_INVALID_DATA");
}

export function createOutbox({
  storage, apiClient, playerId, now = () => Date.now(), locks,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxEntries = 200,
}) {
  if (!storage) throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
  playerId = String(playerId);
  let dispatching = false;
  const listeners = new Set();
  const key = (kind, id) => `${PREFIX}${kind}.${id}`;
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
  async function getEntry(id) {
    const entry = await read(key("entry", id));
    if (!entry) return null;
    if (entry.version !== 1 || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.notBefore) ||
      typeof entry.payload?.bmsir_player_id !== "string" ||
      typeof entry.metadata?.title !== "string" || typeof entry.metadata?.artist !== "string") {
      throw new OutboxError("OUTBOX_INVALID_DATA");
    }
    // Other accounts' entries are preserved but never sent from this account.
    if (entry.payload?.bmsir_player_id !== playerId) return null;
    validatePayload(entry.payload, playerId);
    if (entry.payload.request_id !== id) throw new OutboxError("OUTBOX_INVALID_DATA");
    const [state, receipt, cancelled] = await Promise.all([
      read(key("state", id)), read(key("receipt", id)), read(key("cancelled", id)),
    ]);
    if (cancelled) return null;
    if (state && (!Number.isInteger(state.attempts) || state.attempts < 0 ||
      !Number.isFinite(state.nextAttemptAt) || !["pending", "sending", "rejected"].includes(state.status))) {
      throw new OutboxError("OUTBOX_INVALID_DATA");
    }
    if (receipt && (receipt.request_id !== id || !Number.isFinite(receipt.sentAt) || typeof receipt.deduplicated !== "boolean")) {
      throw new OutboxError("OUTBOX_INVALID_DATA");
    }
    return clone({ ...entry, ...state, status: receipt ? "sent" : state?.status ?? "pending",
      attempts: state?.attempts ?? 0, nextAttemptAt: state?.nextAttemptAt ?? entry.notBefore, receipt });
  }
  async function list() {
    let keys;
    try { keys = await storage.keys(); } catch { throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE"); }
    if (!Array.isArray(keys)) throw new OutboxError("OUTBOX_INVALID_DATA");
    const ids = keys.filter((name) => name.startsWith(key("entry", ""))).map(
      (name) => name.slice(key("entry", "").length),
    );
    // Finite listValues traversal; no search down an unbounded index.
    const entries = [];
    for (const id of ids) {
      if (!UUID.test(id)) throw new OutboxError("OUTBOX_INVALID_DATA");
      const entry = await getEntry(id);
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.payload.request_id.localeCompare(b.payload.request_id));
  }
  async function dispatch(task) {
    if (dispatching) return { status: "busy" };
    dispatching = true;
    try {
      if (typeof locks?.request === "function") {
        return await locks.request(`appamada-outbox-dispatch-${playerId}`, { ifAvailable: true },
          (lock) => lock ? task() : { status: "busy" });
      }
      return await task();
    } finally { dispatching = false; }
  }
  async function enqueue(payload, metadata, { defer = false } = {}) {
    validatePayload(payload, playerId);
    const save = async () => {
      const entries = await list();
      const sameId = entries.find((entry) => entry.payload.request_id === payload.request_id);
      if (sameId) {
        if (JSON.stringify(sameId.payload) !== JSON.stringify(payload)) throw new OutboxError("OUTBOX_CONFLICT");
        return sameId;
      }
      if (await read(key("cancelled", payload.request_id))) throw new OutboxError("OUTBOX_CONFLICT");
      // A second click/reopened form reuses an identical waiting proposal.
      const intent = (value) => JSON.stringify(COMMON_FIELDS.concat(value.application_type === "new" ? ["title", "artist"] : [])
        .filter((field) => !["request_id", "client_version"].includes(field)).map((field) => value[field]));
      const existing = entries.find((entry) => ["pending", "sending"].includes(entry.status) && intent(entry.payload) === intent(payload));
      if (existing) return existing;
      if (entries.length >= maxEntries) throw new OutboxError("OUTBOX_FULL");
      const entry = { version: 1, createdAt: now(), notBefore: defer ? now() + 30_000 : 0, payload: clone(payload),
        metadata: { title: String(metadata?.title ?? ""), artist: String(metadata?.artist ?? "") } };
      await write(key("entry", payload.request_id), entry);
      notify();
      return getEntry(payload.request_id);
    };
    return typeof locks?.request === "function"
      ? locks.request(`appamada-outbox-save-${playerId}`, save) : save();
  }
  async function sendEntry(id, manual) {
    const entry = await getEntry(id);
    if (!entry) return { status: "missing" };
    if (["sent", "rejected"].includes(entry.status)) return entry;
    // Never bypass server rate limits, even on the manual retry button.
    if (entry.nextAttemptAt > now() && (!manual || entry.status === "sending" || entry.errorCode === "RATE_LIMITED")) {
      return { status: "waiting", errorCode: entry.errorCode };
    }
    const pause = await read(key("pause", playerId));
    if (pause?.until > now() && (!manual || pause.errorCode === "RATE_LIMITED")) {
      return { status: "waiting", errorCode: pause.errorCode };
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
      if (result?.ok && (result.request_id !== id || typeof result.deduplicated !== "boolean")) {
        throw new OutboxError("API_INVALID_RESPONSE");
      }
      if (!result?.ok && typeof result?.error?.code !== "string") throw new OutboxError("API_INVALID_RESPONSE");
    } catch (error) {
      result = { ok: false, error: { code: isCommunicationError(error?.code) ? error.code : "API_NETWORK_ERROR" } };
    }
    if (result.ok) {
      // A separate sticky receipt cannot be overwritten by another tab's late timeout.
      await write(key("receipt", id), { request_id: id, sentAt: now(), deduplicated: result.deduplicated });
    } else {
      const errorCode = result.error.code;
      const retryable = TRANSIENT.has(errorCode);
      const delay = errorCode === "RATE_LIMITED"
        ? Math.max(30_000, Math.min(600_000, Number(result.error.retry_after_ms) || 600_000))
        : Math.min(300_000, 30_000 * 2 ** Math.min(state.attempts - 1, 4));
      await write(key("state", id), { ...state, status: retryable ? "pending" : "rejected",
        nextAttemptAt: retryable ? now() + delay : 0, errorCode });
      if (retryable) await write(key("pause", playerId), { until: now() + delay, errorCode });
    }
    notify();
    return await getEntry(id) ?? { status: result.ok ? "sent" : "rejected", errorCode: result.error?.code };
  }
  async function send(id) { return dispatch(() => sendEntry(id, true)); }
  async function flush({ manual = false, limit = 5, shouldContinue = () => true } = {}) {
    return dispatch(async () => {
      const entries = await list();
      const results = [];
      for (const entry of entries) {
        if (!shouldContinue()) break;
        if (!["pending", "sending"].includes(entry.status)) continue;
        const result = await sendEntry(entry.payload.request_id, manual);
        results.push(result);
        if (["pending", "waiting"].includes(result.status) || results.length >= Math.min(5, limit)) break;
        await sleep(1_000);
      }
      return results;
    });
  }
  async function remove(id) {
    const result = await dispatch(async () => {
      const entry = await getEntry(id);
      if (!entry) return;
      if (!["sent", "rejected"].includes(entry.status) && entry.attempts > 0) throw new OutboxError("OUTBOX_CANNOT_CANCEL");
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
    enqueue, list, send, flush, remove,
    async exportData() { return JSON.stringify({ version: 1, exportedAt: now(), entries: await list() }, null, 2); },
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
