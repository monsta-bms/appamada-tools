// ==UserScript==
// @name         不放逸 BMSIR申請
// @namespace    https://github.com/monsta-bms/appamada-tools
// @version      0.4.7
// @description  BMSIRから不放逸への譜面申請を補助します
// @match        https://bms-ir.org/new/song*
// @match        https://www.bms-ir.org/new/song*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/monsta-bms/appamada-tools/main/dist/appamada_bmsir_submit.user.js
// @downloadURL  https://raw.githubusercontent.com/monsta-bms/appamada-tools/main/dist/appamada_bmsir_submit.user.js
// ==/UserScript==

(() => {
  // src/api-client.js
  var API_CLIENT_ERRORS = Object.freeze({
    API_NETWORK_ERROR: "API_NETWORK_ERROR",
    API_TIMEOUT: "API_TIMEOUT",
    API_INVALID_RESPONSE: "API_INVALID_RESPONSE",
    API_NOT_CONFIGURED: "API_NOT_CONFIGURED"
  });
  var MD5_PATTERN = /^[0-9a-f]{32}$/i;
  var LOCK_RETRY_RANGES = Object.freeze([
    [300, 500],
    [900, 1200],
    [1800, 2400]
  ]);
  var ApiClientError = class extends Error {
    constructor(code, message, options = {}) {
      super(message, options);
      this.name = "ApiClientError";
      this.code = code;
    }
  };
  function validateApiUrl(apiUrl) {
    if (!apiUrl) {
      throw new ApiClientError(API_CLIENT_ERRORS.API_NOT_CONFIGURED, "API URL is not configured");
    }
    try {
      const url = new URL(apiUrl);
      if (url.protocol !== "https:" || url.hostname !== "script.google.com" || !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) || url.search || url.hash) {
        throw new Error("invalid URL");
      }
      return url.toString();
    } catch (error) {
      throw new ApiClientError(API_CLIENT_ERRORS.API_NOT_CONFIGURED, "API URL is invalid", {
        cause: error
      });
    }
  }
  function parseApiResponse(response) {
    const status = Number(response?.status ?? 0);
    if (status < 200 || status >= 300) {
      throw new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, `API returned HTTP ${status}`);
    }
    const text = String(response?.responseText ?? response?.response ?? "");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API returned invalid JSON", {
        cause: error
      });
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
      throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API response shape is invalid");
    }
    if (!parsed.ok && (!parsed.error || typeof parsed.error.code !== "string")) {
      throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API error shape is invalid");
    }
    return parsed;
  }
  function gmRequestAsPromise(gmRequest, details) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      }
      const timer = setTimeout(() => {
        finish(reject, new ApiClientError(API_CLIENT_ERRORS.API_TIMEOUT, "API request timed out"));
        try {
          request?.abort?.();
        } catch {
        }
      }, details.timeout);
      try {
        request = gmRequest({
          ...details,
          anonymous: true,
          responseType: "text",
          onload(response) {
            finish(resolve, response);
          },
          onerror() {
            finish(
              reject,
              new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, "API request failed")
            );
          },
          ontimeout() {
            finish(reject, new ApiClientError(API_CLIENT_ERRORS.API_TIMEOUT, "API request timed out"));
          }
        });
      } catch (error) {
        finish(
          reject,
          new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, "API request could not start", {
            cause: error
          })
        );
      }
    });
  }
  function jitteredDelay([minimum, maximum], random) {
    return Math.floor(minimum + random() * (maximum - minimum + 1));
  }
  function createApiClient({
    apiUrl,
    gmRequest,
    timeoutMs = 15e3,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random = Math.random
  } = {}) {
    if (typeof gmRequest !== "function") {
      throw new TypeError("gmRequest must be a function");
    }
    const configuredUrl = validateApiUrl(apiUrl);
    const lookupCache = /* @__PURE__ */ new Map();
    const lookupInFlight = /* @__PURE__ */ new Map();
    async function requestJson(details) {
      return parseApiResponse(
        await gmRequestAsPromise(gmRequest, {
          timeout: timeoutMs,
          ...details
        })
      );
    }
    async function lookup(md5) {
      const normalizedMd5 = String(md5 ?? "").toLowerCase();
      if (!MD5_PATTERN.test(normalizedMd5)) {
        throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "lookup MD5 is invalid");
      }
      const cached = lookupCache.get(normalizedMd5);
      if (cached && cached.expiresAt > now()) {
        return cached.value;
      }
      if (lookupInFlight.has(normalizedMd5)) {
        return lookupInFlight.get(normalizedMd5);
      }
      const requestUrl = new URL(configuredUrl);
      requestUrl.searchParams.set("action", "lookup");
      requestUrl.searchParams.set("md5", normalizedMd5);
      const request = requestJson({ method: "GET", url: requestUrl.toString() }).then((result) => {
        if (result.ok && typeof result.exists !== "boolean") {
          throw new ApiClientError(
            API_CLIENT_ERRORS.API_INVALID_RESPONSE,
            "lookup response shape is invalid"
          );
        }
        if (result.ok && result.exists && (!result.chart || typeof result.chart.title !== "string" || typeof result.chart.artist !== "string" || typeof result.chart.current_level !== "string")) {
          throw new ApiClientError(
            API_CLIENT_ERRORS.API_INVALID_RESPONSE,
            "lookup chart shape is invalid"
          );
        }
        if (result.ok) {
          lookupCache.set(normalizedMd5, {
            value: result,
            expiresAt: now() + (result.exists ? 12e4 : 3e4)
          });
        }
        return result;
      }).finally(() => lookupInFlight.delete(normalizedMd5));
      lookupInFlight.set(normalizedMd5, request);
      return request;
    }
    async function submit(payload) {
      for (let attempt = 0; ; attempt += 1) {
        const result = await requestJson({
          method: "POST",
          url: configuredUrl,
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          data: JSON.stringify(payload)
        });
        if (result.ok && (typeof result.request_id !== "string" || typeof result.deduplicated !== "boolean")) {
          throw new ApiClientError(
            API_CLIENT_ERRORS.API_INVALID_RESPONSE,
            "submit response shape is invalid"
          );
        }
        const isLockTimeout = !result.ok && result.error?.code === "LOCK_TIMEOUT";
        if (!isLockTimeout || attempt >= LOCK_RETRY_RANGES.length) {
          return result;
        }
        await sleep(jitteredDelay(LOCK_RETRY_RANGES[attempt], random));
      }
    }
    return Object.freeze({ lookup, submit });
  }

  // src/bmsir-parser.js
  var PARSER_ERRORS = Object.freeze({
    USER_DOM_INVALID: "USER_DOM_INVALID",
    NOT_LOGGED_IN: "NOT_LOGGED_IN",
    LOGIN_NAME_MISSING: "LOGIN_NAME_MISSING",
    NOT_SONG_PAGE: "NOT_SONG_PAGE",
    MD5_INVALID: "MD5_INVALID",
    MD5_MISMATCH: "MD5_MISMATCH",
    SONG_DOM_INVALID: "SONG_DOM_INVALID",
    TITLE_REQUIRED: "TITLE_REQUIRED",
    TITLE_TOO_LONG: "TITLE_TOO_LONG",
    ARTIST_REQUIRED: "ARTIST_REQUIRED",
    ARTIST_TOO_LONG: "ARTIST_TOO_LONG"
  });
  var MD5_INFO_PATTERN = /^ranking_key:\s*([0-9a-f]{32})\s*\/\s*hash:\s*([0-9a-f]{32})(?:\s*\/|$)/i;
  var MD5_PATTERN2 = /^[0-9a-f]{32}$/i;
  var PLAYER_ID_PATTERN = /^\d{1,20}$/;
  var SONG_HOSTNAMES = /* @__PURE__ */ new Set(["bms-ir.org", "www.bms-ir.org"]);
  var SONG_LAYOUTS = Object.freeze([
    Object.freeze({ name: "current", containerSelector: "#box > main#main-content" }),
    Object.freeze({ name: "legacy", containerSelector: "#box" })
  ]);
  function normalizeText(value) {
    return String(value ?? "").trim().normalize("NFC");
  }
  function codePointLength(value) {
    return [...String(value ?? "")].length;
  }
  function failure(error) {
    return { ok: false, error };
  }
  function parseUrl(value) {
    try {
      return new URL(String(value));
    } catch {
      return null;
    }
  }
  function userAnchors(element2) {
    return Array.from(element2.querySelectorAll("a")).filter((anchor) => !anchor.closest("form"));
  }
  function resolveAnchors(anchors, pageUrl) {
    return anchors.flatMap((anchor) => {
      const href = anchor.getAttribute("href");
      if (href === null) {
        return [];
      }
      try {
        return [{ anchor, url: new URL(href, pageUrl) }];
      } catch {
        return [];
      }
    });
  }
  function parseLoggedInUser(document2, pageUrl) {
    const page = parseUrl(pageUrl);
    const userElements = document2?.querySelectorAll?.("#user");
    if (!page || !userElements || userElements.length !== 1) {
      return failure(PARSER_ERRORS.USER_DOM_INVALID);
    }
    const anchors = resolveAnchors(userAnchors(userElements[0]), page);
    const sameOriginAnchors = anchors.filter(({ url }) => url.origin === page.origin);
    if (sameOriginAnchors.some(({ url }) => url.pathname === "/login")) {
      return failure(PARSER_ERRORS.NOT_LOGGED_IN);
    }
    if (!sameOriginAnchors.some(({ url }) => url.pathname === "/logout")) {
      return failure(PARSER_ERRORS.USER_DOM_INVALID);
    }
    const profiles = sameOriginAnchors.filter(({ url }) => {
      const ids = url.searchParams.getAll("id");
      return url.pathname === "/new/player" && ids.length === 1 && PLAYER_ID_PATTERN.test(ids[0]);
    });
    if (profiles.length !== 1) {
      return failure(PARSER_ERRORS.USER_DOM_INVALID);
    }
    const name = normalizeText(profiles[0].anchor.textContent);
    if (!name) {
      return failure(PARSER_ERRORS.LOGIN_NAME_MISSING);
    }
    return {
      ok: true,
      user: {
        name,
        playerId: profiles[0].url.searchParams.get("id")
      }
    };
  }
  function directChildren(container, selector) {
    return Array.from(container.children).filter((child) => child.matches(selector));
  }
  function md5InfoElements(container) {
    return directChildren(container, "p.muted").filter(
      (element2) => MD5_INFO_PATTERN.test(normalizeText(element2.textContent))
    );
  }
  function resolveLayout(document2, layout) {
    const containers = document2.querySelectorAll(layout.containerSelector);
    if (containers.length !== 1) return null;
    const container = containers[0];
    const titleElements = directChildren(container, "h1");
    const artistElements = directChildren(container, "h2");
    const md5Elements = md5InfoElements(container);
    if (titleElements.length !== 1 || artistElements.length !== 1 || md5Elements.length !== 1) {
      return null;
    }
    const titleElement = titleElements[0];
    const artistElement = artistElements[0];
    if (titleElement.compareDocumentPosition(artistElement) & 2) return null;
    return {
      layout: layout.name,
      container,
      titleElement,
      artistElement,
      md5InfoElement: md5Elements[0]
    };
  }
  function resolveSongElements(document2) {
    if (!document2?.querySelectorAll) {
      return failure(PARSER_ERRORS.SONG_DOM_INVALID);
    }
    const matches = SONG_LAYOUTS.flatMap((layout) => {
      const resolved = resolveLayout(document2, layout);
      return resolved ? [resolved] : [];
    });
    if (matches.length !== 1) {
      return failure(PARSER_ERRORS.SONG_DOM_INVALID);
    }
    return { ok: true, ...matches[0] };
  }
  function collectDomDiagnostics(document2, pageUrl) {
    const page = parseUrl(pageUrl);
    const count = (selector) => document2?.querySelectorAll?.(selector)?.length ?? 0;
    const matchingMd5Count = (selector) => Array.from(document2?.querySelectorAll?.(selector) ?? []).filter(
      (element2) => MD5_INFO_PATTERN.test(normalizeText(element2.textContent))
    ).length;
    const users = Array.from(document2?.querySelectorAll?.("#user") ?? []);
    const anchors = users.length === 1 ? resolveAnchors(userAnchors(users[0]), pageUrl) : [];
    return Object.freeze({
      pathname: page?.pathname ?? "",
      userMatches: users.length,
      profileMatches: anchors.filter(({ url }) => url.pathname === "/new/player").length,
      logoutMatches: anchors.filter(({ url }) => url.pathname === "/logout").length,
      currentContainerMatches: count("#box > main#main-content"),
      currentTitleMatches: count("#box > main#main-content > h1"),
      currentArtistMatches: count("#box > main#main-content > h2"),
      currentMd5InfoMatches: matchingMd5Count("#box > main#main-content > p.muted"),
      legacyTitleMatches: count("#box > h1"),
      legacyArtistMatches: count("#box > h2"),
      legacyMd5InfoMatches: matchingMd5Count("#box > p.muted")
    });
  }
  function parseSong(document2, pageUrl) {
    const page = parseUrl(pageUrl);
    if (!page || page.protocol !== "https:" || !SONG_HOSTNAMES.has(page.hostname) || page.pathname !== "/new/song") {
      return failure(PARSER_ERRORS.NOT_SONG_PAGE);
    }
    const urlMd5Values = page.searchParams.getAll("songmd5");
    if (urlMd5Values.length !== 1 || !MD5_PATTERN2.test(urlMd5Values[0])) {
      return failure(PARSER_ERRORS.MD5_INVALID);
    }
    const resolved = resolveSongElements(document2);
    if (!resolved.ok) return resolved;
    const { titleElement, artistElement, md5InfoElement } = resolved;
    const md5Match = MD5_INFO_PATTERN.exec(normalizeText(md5InfoElement.textContent));
    const title = normalizeText(titleElement.textContent);
    if (!title) {
      return failure(PARSER_ERRORS.TITLE_REQUIRED);
    }
    if (codePointLength(title) > 1e3) {
      return failure(PARSER_ERRORS.TITLE_TOO_LONG);
    }
    const artist = normalizeText(artistElement.textContent);
    if (!artist) {
      return failure(PARSER_ERRORS.ARTIST_REQUIRED);
    }
    if (codePointLength(artist) > 500) {
      return failure(PARSER_ERRORS.ARTIST_TOO_LONG);
    }
    const md5 = urlMd5Values[0].toLowerCase();
    const rankingKey = md5Match[1].toLowerCase();
    const hash = md5Match[2].toLowerCase();
    if (md5 !== rankingKey || md5 !== hash) {
      return failure(PARSER_ERRORS.MD5_MISMATCH);
    }
    return {
      ok: true,
      song: {
        md5,
        title,
        artist,
        irUrl: `https://bms-ir.org/new/song?songmd5=${md5}&view=new`
      }
    };
  }
  function parseBmsirPage(document2, pageUrl) {
    const userResult = parseLoggedInUser(document2, pageUrl);
    if (!userResult.ok) {
      return userResult;
    }
    const songResult = parseSong(document2, pageUrl);
    if (!songResult.ok) {
      return songResult;
    }
    return {
      ok: true,
      user: userResult.user,
      song: songResult.song
    };
  }

  // src/logger.js
  var PREFIX = "[appamada-userscript]";
  function createLogger({ debug = false, sink = globalThis.console } = {}) {
    function write(level, eventCode, detail) {
      if (level === "debug" && !debug) {
        return;
      }
      const method = typeof sink?.[level] === "function" ? sink[level] : sink?.log;
      if (typeof method !== "function") {
        return;
      }
      const message = `${PREFIX} ${eventCode}`;
      if (detail === void 0) {
        method.call(sink, message);
      } else {
        method.call(sink, message, detail);
      }
    }
    return Object.freeze({
      error(eventCode, detail) {
        write("error", eventCode, detail);
      },
      warn(eventCode, detail) {
        write("warn", eventCode, detail);
      },
      debug(eventCode, detail) {
        write("debug", eventCode, detail);
      }
    });
  }

  // src/levels.js
  var STEP_LEVELS = Object.freeze([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10-",
    "10",
    "10+",
    "11-",
    "11",
    "11+",
    "12-",
    "12",
    "12+",
    "13-",
    "13",
    "13+",
    "14",
    "15",
    "16"
  ]);
  var SPECIAL_LEVELS = Object.freeze(["?", "★★4?", "★★5?", "★★6?", "★★7?", "隔離"]);
  var ALLOWED_LEVELS = Object.freeze([...STEP_LEVELS, ...SPECIAL_LEVELS]);
  var PUBLISH_LEVEL_ORDER = Object.freeze([
    ...STEP_LEVELS,
    "★★4?",
    "★★5?",
    "★★6?",
    "★★7?",
    "?",
    "隔離"
  ]);
  var ALLOWED_LEVEL_SET = new Set(ALLOWED_LEVELS);
  var STEP_LEVEL_SET = new Set(STEP_LEVELS);
  var SPECIAL_LEVEL_SET = new Set(SPECIAL_LEVELS);
  function isAllowedLevel(level) {
    return ALLOWED_LEVEL_SET.has(level);
  }
  function isSpecialLevel(level) {
    return SPECIAL_LEVEL_SET.has(level);
  }
  function getHarderLevel(level) {
    const index = STEP_LEVELS.indexOf(level);
    return index >= 0 && index < STEP_LEVELS.length - 1 ? STEP_LEVELS[index + 1] : null;
  }
  function getEasierLevel(level) {
    const index = STEP_LEVELS.indexOf(level);
    return index > 0 ? STEP_LEVELS[index - 1] : null;
  }

  // src/outbox.js
  var OFFLINE_NOTICE = "通信不具合中。現時点の難易度表データ取得できません";
  var PREFIX2 = "appamada.outbox.v1.";
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var TRANSIENT = /* @__PURE__ */ new Set([
    "API_NETWORK_ERROR",
    "API_TIMEOUT",
    "API_INVALID_RESPONSE",
    "LOCK_TIMEOUT",
    "RATE_LIMITED",
    "WRITE_FAILED",
    "INTERNAL_ERROR",
    "SUBMISSIONS_DISABLED"
  ]);
  var COMMON_FIELDS = [
    "application_type",
    "request_id",
    "md5",
    "proposed_level",
    "comment",
    "bmsir_user_name",
    "bmsir_player_id",
    "ir_url",
    "client_version"
  ];
  var clone = (value) => JSON.parse(JSON.stringify(value));
  var OutboxError = class extends Error {
    constructor(code) {
      super(code);
      this.name = "OutboxError";
      this.code = code;
    }
  };
  function isCommunicationError(code) {
    return ["API_NETWORK_ERROR", "API_TIMEOUT", "API_INVALID_RESPONSE"].includes(code);
  }
  function createGmStorage({ modern, legacy = {} } = {}) {
    if (modern && ["getValue", "setValue", "deleteValue", "listValues"].every(
      (name) => typeof modern[name] === "function"
    )) {
      return {
        get: (key) => modern.getValue(key),
        set: (key, value) => modern.setValue(key, value),
        remove: (key) => modern.deleteValue(key),
        keys: () => modern.listValues()
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
    try {
      url = new URL(payload.ir_url);
    } catch {
    }
    if (!payload || !["change", "new", "delete"].includes(payload.application_type) || !UUID.test(payload.request_id) || !/^[0-9a-f]{32}$/.test(payload.md5) || !fields.every((field) => typeof payload[field] === "string") || Object.keys(payload).some((field) => !fields.includes(field)) || payload.bmsir_player_id !== playerId || !/^[0-9]+$/.test(playerId) || !payload.bmsir_user_name.trim() || Array.from(payload.comment).length > 500 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(payload.client_version) || !(payload.application_type === "delete" ? payload.proposed_level === "削除" : isAllowedLevel(payload.proposed_level)) || !url || url.protocol !== "https:" || !["bms-ir.org", "www.bms-ir.org"].includes(url.hostname) || url.pathname !== "/new/song" || url.searchParams.get("songmd5")?.toLowerCase() !== payload.md5) throw new OutboxError("OUTBOX_INVALID_DATA");
  }
  function createOutbox({
    storage,
    apiClient,
    playerId,
    now = () => Date.now(),
    locks,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxEntries = 200
  }) {
    if (!storage) throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
    playerId = String(playerId);
    let dispatching = false;
    const listeners = /* @__PURE__ */ new Set();
    const key = (kind, id) => `${PREFIX2}${kind}.${id}`;
    const notify = () => {
      for (const listener of listeners) listener();
    };
    async function read(name) {
      try {
        return await storage.get(name);
      } catch {
        throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
      }
    }
    async function write(name, value) {
      try {
        await storage.set(name, value);
        if (JSON.stringify(await storage.get(name)) !== JSON.stringify(value)) throw new Error("readback");
      } catch {
        throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
      }
    }
    async function getEntry(id) {
      const entry = await read(key("entry", id));
      if (!entry) return null;
      if (entry.version !== 1 || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.notBefore) || typeof entry.payload?.bmsir_player_id !== "string" || typeof entry.metadata?.title !== "string" || typeof entry.metadata?.artist !== "string") {
        throw new OutboxError("OUTBOX_INVALID_DATA");
      }
      if (entry.payload?.bmsir_player_id !== playerId) return null;
      validatePayload(entry.payload, playerId);
      if (entry.payload.request_id !== id) throw new OutboxError("OUTBOX_INVALID_DATA");
      const [state, receipt, cancelled] = await Promise.all([
        read(key("state", id)),
        read(key("receipt", id)),
        read(key("cancelled", id))
      ]);
      if (cancelled) return null;
      if (state && (!Number.isInteger(state.attempts) || state.attempts < 0 || !Number.isFinite(state.nextAttemptAt) || !["pending", "sending", "rejected"].includes(state.status))) {
        throw new OutboxError("OUTBOX_INVALID_DATA");
      }
      if (receipt && (receipt.request_id !== id || !Number.isFinite(receipt.sentAt) || typeof receipt.deduplicated !== "boolean")) {
        throw new OutboxError("OUTBOX_INVALID_DATA");
      }
      return clone({
        ...entry,
        ...state,
        status: receipt ? "sent" : state?.status ?? "pending",
        attempts: state?.attempts ?? 0,
        nextAttemptAt: state?.nextAttemptAt ?? entry.notBefore,
        receipt
      });
    }
    async function list() {
      let keys;
      try {
        keys = await storage.keys();
      } catch {
        throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
      }
      if (!Array.isArray(keys)) throw new OutboxError("OUTBOX_INVALID_DATA");
      const ids = keys.filter((name) => name.startsWith(key("entry", ""))).map(
        (name) => name.slice(key("entry", "").length)
      );
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
          return await locks.request(
            `appamada-outbox-dispatch-${playerId}`,
            { ifAvailable: true },
            (lock) => lock ? task() : { status: "busy" }
          );
        }
        return await task();
      } finally {
        dispatching = false;
      }
    }
    async function enqueue(payload, metadata, { defer = false } = {}) {
      validatePayload(payload, playerId);
      const save = async () => {
        const entries = await list();
        const sameId = entries.find((entry2) => entry2.payload.request_id === payload.request_id);
        if (sameId) {
          if (JSON.stringify(sameId.payload) !== JSON.stringify(payload)) throw new OutboxError("OUTBOX_CONFLICT");
          return sameId;
        }
        if (await read(key("cancelled", payload.request_id))) throw new OutboxError("OUTBOX_CONFLICT");
        const intent = (value) => JSON.stringify(COMMON_FIELDS.concat(value.application_type === "new" ? ["title", "artist"] : []).filter((field) => !["request_id", "client_version"].includes(field)).map((field) => value[field]));
        const existing = entries.find((entry2) => ["pending", "sending"].includes(entry2.status) && intent(entry2.payload) === intent(payload));
        if (existing) return existing;
        if (entries.length >= maxEntries) throw new OutboxError("OUTBOX_FULL");
        const entry = {
          version: 1,
          createdAt: now(),
          notBefore: defer ? now() + 3e4 : 0,
          payload: clone(payload),
          metadata: { title: String(metadata?.title ?? ""), artist: String(metadata?.artist ?? "") }
        };
        await write(key("entry", payload.request_id), entry);
        notify();
        return getEntry(payload.request_id);
      };
      return typeof locks?.request === "function" ? locks.request(`appamada-outbox-save-${playerId}`, save) : save();
    }
    async function sendEntry(id, manual) {
      const entry = await getEntry(id);
      if (!entry) return { status: "missing" };
      if (["sent", "rejected"].includes(entry.status)) return entry;
      if (entry.nextAttemptAt > now() && (!manual || entry.status === "sending" || entry.errorCode === "RATE_LIMITED")) {
        return { status: "waiting", errorCode: entry.errorCode };
      }
      const pause = await read(key("pause", playerId));
      if (pause?.until > now() && (!manual || pause.errorCode === "RATE_LIMITED")) {
        return { status: "waiting", errorCode: pause.errorCode };
      }
      const state = {
        status: "sending",
        attempts: entry.attempts + 1,
        nextAttemptAt: now() + 9e4,
        errorCode: ""
      };
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
        await write(key("receipt", id), { request_id: id, sentAt: now(), deduplicated: result.deduplicated });
      } else {
        const errorCode = result.error.code;
        const retryable = TRANSIENT.has(errorCode);
        const delay = errorCode === "RATE_LIMITED" ? Math.max(3e4, Math.min(6e5, Number(result.error.retry_after_ms) || 6e5)) : Math.min(3e5, 3e4 * 2 ** Math.min(state.attempts - 1, 4));
        await write(key("state", id), {
          ...state,
          status: retryable ? "pending" : "rejected",
          nextAttemptAt: retryable ? now() + delay : 0,
          errorCode
        });
        if (retryable) await write(key("pause", playerId), { until: now() + delay, errorCode });
      }
      notify();
      return await getEntry(id) ?? { status: result.ok ? "sent" : "rejected", errorCode: result.error?.code };
    }
    async function send(id) {
      return dispatch(() => sendEntry(id, true));
    }
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
          await sleep(1e3);
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
          for (const kind of ["entry", "state", "receipt"]) await storage.remove(key(kind, id));
        } catch {
          throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
        }
        notify();
      });
      if (result?.status === "busy") throw new OutboxError("OUTBOX_BUSY");
    }
    return Object.freeze({
      enqueue,
      list,
      send,
      flush,
      remove,
      async exportData() {
        return JSON.stringify({ version: 1, exportedAt: now(), entries: await list() }, null, 2);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    });
  }
  function startOutboxSync({ outbox, window: window2, onError = () => {
  }, intervalMs = 3e4 }) {
    let stopped = false;
    let disposed = false;
    let running = false;
    let timer;
    async function tick() {
      if (stopped || running) return;
      running = true;
      try {
        await outbox.flush({ shouldContinue: () => !stopped });
      } catch (error) {
        onError(error);
      } finally {
        running = false;
      }
      if (!stopped) timer = window2.setTimeout(tick, intervalMs);
    }
    function wake() {
      if (stopped || window2.document.visibilityState === "hidden") return;
      window2.clearTimeout(timer);
      void tick();
    }
    function pause() {
      stopped = true;
      window2.clearTimeout(timer);
    }
    function resume() {
      if (disposed) return;
      stopped = false;
      void tick();
    }
    function stop() {
      disposed = true;
      pause();
      window2.removeEventListener("online", wake);
      window2.document.removeEventListener("visibilitychange", wake);
      window2.removeEventListener("pagehide", pause);
      window2.removeEventListener("pageshow", resume);
    }
    window2.addEventListener("online", wake);
    window2.document.addEventListener("visibilitychange", wake);
    window2.addEventListener("pagehide", pause);
    window2.addEventListener("pageshow", resume);
    void tick();
    return stop;
  }

  // src/ui.js
  var ERROR_MESSAGES = Object.freeze({
    API_NETWORK_ERROR: "通信に失敗しました。時間を置いて再度お試しください。",
    API_TIMEOUT: "通信がタイムアウトしました。時間を置いて再度お試しください。",
    API_INVALID_RESPONSE: "サーバーから正しい応答を取得できませんでした。",
    API_NOT_CONFIGURED: "申請APIが設定されていません。",
    SUBMISSIONS_DISABLED: "現在、不放逸への申請受付を一時停止しています。",
    BAD_REQUEST: "送信内容を確認できませんでした。",
    APPLICATION_TYPE_INVALID: "申請種別が正しくありません。",
    LOGIN_NAME_MISSING: "BMSIRのログインユーザー名を取得できませんでした。",
    PLAYER_ID_INVALID: "BMSIRプレイヤーIDを確認できませんでした。",
    MD5_INVALID: "譜面MD5が正しくありません。",
    MD5_MISMATCH: "BMSIR URLと譜面MD5が一致しません。",
    IR_URL_INVALID: "BMSIR譜面URLが正しくありません。",
    CHART_NOT_FOUND: "不放逸に登録されていません。",
    CHART_DUPLICATED: "同じMD5の譜面が複数登録されています。管理者へご連絡ください。",
    CHART_ALREADY_EXISTS: "すでに不放逸に登録されています。",
    CURRENT_LEVEL_UNSUPPORTED: "現在の難易度は申請対象外です。",
    TITLE_REQUIRED: "曲名を取得できませんでした。",
    TITLE_TOO_LONG: "曲名が長すぎます。",
    ARTIST_REQUIRED: "artistを取得できませんでした。",
    ARTIST_TOO_LONG: "artistが長すぎます。",
    LEVEL_REQUIRED: "難易度を選択してください。",
    LEVEL_INVALID: "選択した難易度が正しくありません。",
    SAME_AS_CURRENT: "現在と異なる難易度を選択してください。",
    COMMENT_TOO_LONG: "コメントは500文字以内にしてください。",
    CLIENT_VERSION_INVALID: "Userscriptのバージョン情報が正しくありません。",
    REQUEST_ID_INVALID: "送信識別子を生成できませんでした。",
    RATE_LIMITED: "短時間の投稿数が多すぎます。少し待ってください。",
    LOCK_TIMEOUT: "サーバーが混み合っています。時間を置いて再度お試しください。",
    SHEET_NOT_FOUND: "申請先シートが設定されていません。",
    SHEET_SCHEMA_INVALID: "申請先シートの構成が正しくありません。",
    REQUEST_ID_CONFLICT: "送信識別子が競合しました。画面を開き直してください。",
    WRITE_FAILED: "申請一覧へ保存できませんでした。",
    INTERNAL_ERROR: "サーバー内部でエラーが発生しました。",
    OUTBOX_STORAGE_UNAVAILABLE: "保存した提案の読み書きができませんでした。保存権限や空き容量を確認してください。送信状況は「保存した提案」で確認してください。",
    OUTBOX_INVALID_DATA: "保存した提案を読み取れませんでした。データは削除していません。",
    OUTBOX_FULL: "保存件数が上限に達しました。保存した提案から送信済み・受付不可の項目を消してください。",
    OUTBOX_CONFLICT: "同じ申請の保存内容が一致しません。保存した提案を確認してください。",
    OUTBOX_CANNOT_CANCEL: "送信を試みた提案は、受け付けられた可能性があるため取り消せません。",
    OUTBOX_BUSY: "保存した提案を送信中です。少し待ってください。"
  });
  var STYLE = `
.appamada-menu,.appamada-overlay{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.appamada-menu{position:fixed;z-index:12000;min-width:190px;padding:6px;background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 8px 24px #0004}
.appamada-menu-title{padding:6px 10px;font-weight:700;border-bottom:1px solid #ddd}
.appamada-menu button,.appamada-modal button{font:inherit}
.appamada-menu button{display:block;width:100%;padding:8px 10px;text-align:left;border:0;background:transparent;border-radius:5px;color:inherit;cursor:pointer}
.appamada-menu button:hover,.appamada-menu button:focus{background:#e8eef8;outline:2px solid #4b75b8}
.appamada-overlay{position:fixed;inset:0;z-index:12010;display:grid;place-items:center;padding:20px;background:#0008}
.appamada-modal{box-sizing:border-box;width:min(680px,100%);max-height:90vh;overflow:auto;padding:20px;background:#fff;color:#222;color-scheme:light;border-radius:12px;box-shadow:0 14px 40px #0006}
.appamada-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #ddd}
.appamada-modal-header h2{margin:0 0 12px;font-size:1.25rem;color:#222;font-weight:700;opacity:1;text-shadow:none}
.appamada-close{padding:5px 10px;border:1px solid #888;border-radius:5px;background:#fff;color:#222;opacity:1;-webkit-text-fill-color:#222;cursor:pointer}
.appamada-modal .appamada-close:disabled{background:#eee;color:#777;-webkit-text-fill-color:#777;cursor:not-allowed}
.appamada-facts{display:grid;grid-template-columns:max-content 1fr;gap:5px 12px;margin:16px 0}
.appamada-facts dt{font-weight:700}.appamada-facts dd{margin:0;overflow-wrap:anywhere}
.appamada-level-grid{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px}
.appamada-level-grid button,.appamada-step button{padding:6px 10px;border:1px solid #777;border-radius:6px;background:#fff;color:#222;cursor:pointer}
.appamada-level-grid button[aria-pressed="true"]{background:#244f91;color:#fff;border-color:#244f91}
.appamada-step button:disabled,.appamada-level-grid button:disabled{background:#eee;color:#777;cursor:not-allowed;opacity:1}
.appamada-step{display:flex;align-items:center;justify-content:center;gap:10px;margin:12px 0}
.appamada-selected{min-width:90px;text-align:center;font-weight:700;font-size:1.2rem}
.appamada-comment{display:grid;gap:5px;margin:14px 0}.appamada-comment textarea{box-sizing:border-box;width:100%;min-height:90px;padding:8px;border:1px solid #777;background:#fff;color:#222;color-scheme:light;opacity:1;-webkit-text-fill-color:#222;caret-color:#222;font:inherit}
.appamada-count{text-align:right}.appamada-count-error{color:#b00020;font-weight:700}
.appamada-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.appamada-submit{padding:8px 16px;border:0;border-radius:6px;background:#244f91;color:#fff;cursor:pointer}.appamada-submit:disabled{background:#999;cursor:not-allowed}
.appamada-submit-danger{background:#a51d2d}.appamada-warning{padding:10px;border-left:4px solid #a51d2d;background:#fff1f2;color:#6f101c}
.appamada-status{margin:12px 0;padding:10px;border-radius:6px;background:#eef3fb}.appamada-status-error{background:#fdebec;color:#8b0018}.appamada-status-success{background:#e8f6ec;color:#145a28}
.appamada-subheading{margin:14px 0 4px;font-weight:700}
.appamada-saved-item{padding:12px 0;border-bottom:1px solid #ddd}.appamada-saved-item p{overflow-wrap:anywhere}
`;
  function element(document2, tagName, options = {}) {
    const node = document2.createElement(tagName);
    if (options.className) node.className = options.className;
    if (options.text !== void 0) node.textContent = options.text;
    if (options.type) node.type = options.type;
    return node;
  }
  function addFact(document2, list, label, value) {
    list.append(element(document2, "dt", { text: label }), element(document2, "dd", { text: value }));
  }
  function createRequestId(cryptoObject) {
    if (typeof cryptoObject?.randomUUID === "function") {
      return cryptoObject.randomUUID();
    }
    if (typeof cryptoObject?.getRandomValues !== "function") {
      throw new Error("Secure UUID generation is unavailable");
    }
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function errorMessageFor(code) {
    return ERROR_MESSAGES[code] ?? "申請を処理できませんでした。時間を置いて再度お試しください。";
  }
  function installSubmissionUi({
    document: document2,
    window: window2,
    parsedPage,
    apiClient,
    outbox,
    clientVersion = "0.0.0",
    cryptoObject = window2.crypto,
    addStyle,
    logger: logger2
  }) {
    const resolvedSongElements = resolveSongElements(document2);
    if (!resolvedSongElements.ok) {
      const error = new Error("Parsed song elements are no longer available");
      error.code = resolvedSongElements.error;
      throw error;
    }
    const { titleElement, artistElement } = resolvedSongElements;
    if (typeof addStyle === "function") {
      addStyle(STYLE);
    } else if (!document2.querySelector("style[data-appamada-style]")) {
      const style = element(document2, "style");
      style.dataset.appamadaStyle = "true";
      style.textContent = STYLE;
      document2.head.append(style);
    }
    let activeMenu = null;
    let activeModal = null;
    let lookupUnavailableUntil = 0;
    function markLookupUnavailable(code) {
      if (isCommunicationError(code)) lookupUnavailableUntil = Date.now() + 3e4;
    }
    function offlineInfo(shell) {
      shell.content.append(statusNode(document2, OFFLINE_NOTICE), statusNode(
        document2,
        outbox ? "提案はこのブラウザに保存され、通信が回復したら順番に送信されます。" : errorMessageFor("OUTBOX_STORAGE_UNAVAILABLE"),
        outbox ? "info" : "error"
      ));
    }
    function closeMenu() {
      activeMenu?.remove();
      activeMenu = null;
    }
    function closeModal() {
      activeModal?.overlay.remove();
      activeModal = null;
    }
    function modalShell(title) {
      closeModal();
      const overlay = element(document2, "div", { className: "appamada-overlay" });
      const modal = element(document2, "section", { className: "appamada-modal" });
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      const header = element(document2, "header", { className: "appamada-modal-header" });
      const heading = element(document2, "h2", { text: title });
      const close = element(document2, "button", {
        className: "appamada-close",
        text: "閉じる",
        type: "button"
      });
      close.addEventListener("click", closeModal);
      header.append(heading, close);
      const content = element(document2, "div");
      modal.append(header, content);
      overlay.append(modal);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeModal();
      });
      document2.body.append(overlay);
      activeModal = { overlay, modal, content };
      close.focus();
      return activeModal;
    }
    function statusNode(document3, message, kind = "info") {
      const status = element(document3, "p", {
        className: `appamada-status${kind === "error" ? " appamada-status-error" : ""}${kind === "success" ? " appamada-status-success" : ""}`,
        text: message
      });
      status.setAttribute("role", kind === "error" ? "alert" : "status");
      return status;
    }
    function showMessage(title, message, kind = "error") {
      const shell = modalShell(title);
      shell.content.append(statusNode(document2, message, kind));
    }
    function facts(values) {
      const list = element(document2, "dl", { className: "appamada-facts" });
      for (const [label, value] of values) addFact(document2, list, label, String(value));
      return list;
    }
    function commentField(onChange) {
      const wrapper = element(document2, "label", { className: "appamada-comment" });
      wrapper.append(element(document2, "span", { text: "コメント（任意）" }));
      const textarea = element(document2, "textarea");
      const count = element(document2, "span", { className: "appamada-count", text: "0 / 500" });
      textarea.addEventListener("input", () => {
        const length = codePointLength(textarea.value);
        count.textContent = `${length} / 500`;
        count.classList.toggle("appamada-count-error", length > 500);
        onChange();
      });
      wrapper.append(textarea, count);
      return { wrapper, textarea };
    }
    function levelButton(level, onSelect) {
      const button = element(document2, "button", { text: level, type: "button" });
      button.dataset.level = level;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => onSelect(level));
      return button;
    }
    function commonPayload(applicationType, comment) {
      return {
        application_type: applicationType,
        request_id: createRequestId(cryptoObject),
        md5: parsedPage.song.md5,
        proposed_level: "",
        comment,
        bmsir_user_name: parsedPage.user.name,
        bmsir_player_id: parsedPage.user.playerId,
        ir_url: parsedPage.song.irUrl,
        client_version: clientVersion
      };
    }
    async function runSubmit({ payload, button, updateDisabled, statusContainer, offline = false }) {
      if (button.dataset.submitting === "true") return;
      button.dataset.submitting = "true";
      button.textContent = offline ? "保存中…" : "送信中…";
      updateDisabled();
      statusContainer.replaceChildren(statusNode(document2, offline ? "提案をブラウザに保存しています。" : "申請を送信しています。"));
      try {
        if (outbox) {
          const entry = await outbox.enqueue(payload, parsedPage.song, { defer: offline });
          const result2 = offline ? entry : await outbox.send(entry.payload.request_id);
          if (result2.status === "sent") {
            statusContainer.replaceChildren(statusNode(document2, "申請を送信しました。", "success"));
            button.textContent = "送信済み";
          } else if (result2.status === "rejected") {
            statusContainer.replaceChildren(statusNode(document2, errorMessageFor(result2.errorCode), "error"));
            button.dataset.submitting = "false";
            button.textContent = offline ? "ブラウザに保存" : "申請を送信";
            updateDisabled();
            return;
          } else {
            markLookupUnavailable(result2.errorCode);
            const reason = result2.errorCode && !isCommunicationError(result2.errorCode) ? `${errorMessageFor(result2.errorCode)} ` : "";
            statusContainer.replaceChildren(statusNode(
              document2,
              `${isCommunicationError(result2.errorCode) ? `${OFFLINE_NOTICE}。 ` : ""}${reason}提案をブラウザに保存しました。まだ送信完了していません。通信が回復したら再送します。右クリックの「保存した提案」から確認できます。`
            ));
            button.textContent = "保存済み（送信待ち）";
          }
          button.dataset.completed = "true";
          updateDisabled();
          return;
        }
        const result = await apiClient.submit(payload);
        if (result.ok) {
          const message = result.deduplicated ? "この申請はすでに送信済みです。" : "申請を送信しました。";
          statusContainer.replaceChildren(statusNode(document2, message, "success"));
          button.textContent = "送信済み";
          button.dataset.completed = "true";
          return;
        }
        logger2?.debug?.("SUBMIT_FAILED", result.error.code);
        statusContainer.replaceChildren(
          statusNode(document2, errorMessageFor(result.error.code), "error")
        );
      } catch (error) {
        const code = error?.code ?? "INTERNAL_ERROR";
        logger2?.debug?.("SUBMIT_FAILED", code);
        statusContainer.replaceChildren(statusNode(document2, errorMessageFor(code), "error"));
      }
      button.dataset.submitting = "false";
      button.textContent = offline ? "ブラウザに保存" : "申請を送信";
      updateDisabled();
    }
    function renderChange(chart, offline = false) {
      const shell = modalShell("不放逸 難易度変更申請");
      if (offline) offlineInfo(shell);
      shell.content.append(
        facts([
          ["曲名", chart.title],
          ["artist", chart.artist],
          ["投稿者", parsedPage.user.name],
          ["現在難易度", offline ? "取得できません" : chart.current_level]
        ])
      );
      let selectedLevel = offline ? null : chart.current_level;
      const step = element(document2, "div", { className: "appamada-step" });
      const harder = element(document2, "button", { text: "難しく ↑", type: "button" });
      const selected = element(document2, "span", { className: "appamada-selected" });
      const easier = element(document2, "button", { text: "易しく ↓", type: "button" });
      if (offline) {
        for (const button of [harder, easier]) {
          button.title = "現在難易度を取得できないため選択できません。下のレベルから直接選んでください。";
          button.setAttribute("aria-label", `${button.textContent}（現在難易度を取得できないため選択できません）`);
        }
      }
      step.append(harder, selected, easier);
      shell.content.append(element(document2, "p", { className: "appamada-subheading", text: "変更案" }), step);
      const specialGrid = element(document2, "div", { className: "appamada-level-grid" });
      const specialButtons = SPECIAL_LEVELS.map((level) => levelButton(level, selectLevel));
      specialGrid.append(...specialButtons);
      shell.content.append(
        element(document2, "p", { className: "appamada-subheading", text: "特殊レベル" }),
        specialGrid
      );
      const normalHeading = element(document2, "p", {
        className: "appamada-subheading",
        text: "通常レベルを直接選択"
      });
      const normalGrid = element(document2, "div", { className: "appamada-level-grid" });
      const normalButtons = STEP_LEVELS.map((level) => levelButton(level, selectLevel));
      normalGrid.append(...normalButtons);
      shell.content.append(normalHeading, normalGrid);
      let comment;
      const commentControl = commentField(update);
      comment = commentControl.textarea;
      shell.content.append(commentControl.wrapper);
      const statusContainer = element(document2, "div");
      const actions = element(document2, "div", { className: "appamada-actions" });
      const submit = element(document2, "button", {
        className: "appamada-submit",
        text: offline ? "ブラウザに保存" : "申請を送信",
        type: "button"
      });
      actions.append(submit);
      shell.content.append(statusContainer, actions);
      function selectLevel(level) {
        selectedLevel = level;
        update();
      }
      function update() {
        selected.textContent = selectedLevel === null ? "選択してください" : `卍${selectedLevel}`;
        const harderLevel = getHarderLevel(selectedLevel);
        const easierLevel = getEasierLevel(selectedLevel);
        const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
        harder.disabled = offline || busy || harderLevel === null;
        easier.disabled = offline || busy || easierLevel === null;
        for (const button of [...specialButtons, ...normalButtons]) {
          button.setAttribute("aria-pressed", String(button.dataset.level === selectedLevel));
          button.disabled = busy;
        }
        const showNormalGrid = offline || isSpecialLevel(chart.current_level) || isSpecialLevel(selectedLevel);
        normalHeading.hidden = !showNormalGrid;
        normalGrid.hidden = !showNormalGrid;
        submit.disabled = busy || offline && !outbox || selectedLevel === null || !offline && selectedLevel === chart.current_level || codePointLength(comment.value) > 500;
      }
      harder.addEventListener("click", () => {
        const level = getHarderLevel(selectedLevel);
        if (level !== null) selectLevel(level);
      });
      easier.addEventListener("click", () => {
        const level = getEasierLevel(selectedLevel);
        if (level !== null) selectLevel(level);
      });
      submit.addEventListener("click", () => {
        if (submit.disabled) return;
        const payload = commonPayload("change", comment.value.normalize("NFC"));
        payload.proposed_level = selectedLevel;
        void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer, offline });
      });
      update();
    }
    function renderNew(offline = false) {
      const shell = modalShell("不放逸 新規譜面申請");
      if (offline) offlineInfo(shell);
      shell.content.append(
        facts([
          ["曲名", parsedPage.song.title],
          ["artist", parsedPage.song.artist],
          ["md5", parsedPage.song.md5],
          ["投稿者", parsedPage.user.name]
        ]),
        element(document2, "p", { className: "appamada-subheading", text: "難易度" })
      );
      let selectedLevel = null;
      const groups = [
        ["通常", STEP_LEVELS.slice(0, 10)],
        ["10～12", STEP_LEVELS.slice(10, 19)],
        ["高難度", STEP_LEVELS.slice(19)],
        ["特殊", SPECIAL_LEVELS]
      ];
      const levelButtons = [];
      for (const [label, levels] of groups) {
        const grid = element(document2, "div", { className: "appamada-level-grid" });
        const buttons = levels.map((level) => levelButton(level, selectLevel));
        levelButtons.push(...buttons);
        grid.append(...buttons);
        shell.content.append(
          element(document2, "p", { className: "appamada-subheading", text: label }),
          grid
        );
      }
      let comment;
      const commentControl = commentField(update);
      comment = commentControl.textarea;
      shell.content.append(commentControl.wrapper);
      const statusContainer = element(document2, "div");
      const actions = element(document2, "div", { className: "appamada-actions" });
      const submit = element(document2, "button", {
        className: "appamada-submit",
        text: offline ? "ブラウザに保存" : "申請を送信",
        type: "button"
      });
      actions.append(submit);
      shell.content.append(statusContainer, actions);
      function selectLevel(level) {
        selectedLevel = level;
        update();
      }
      function update() {
        const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
        for (const button of levelButtons) {
          button.setAttribute("aria-pressed", String(button.dataset.level === selectedLevel));
          button.disabled = busy;
        }
        submit.disabled = busy || offline && !outbox || selectedLevel === null || codePointLength(comment.value) > 500;
      }
      submit.addEventListener("click", () => {
        if (submit.disabled) return;
        const payload = commonPayload("new", comment.value.normalize("NFC"));
        Object.assign(payload, {
          title: parsedPage.song.title,
          artist: parsedPage.song.artist,
          proposed_level: selectedLevel
        });
        void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer, offline });
      });
      update();
    }
    function renderDelete(chart, offline = false) {
      const shell = modalShell("不放逸 削除申請");
      if (offline) offlineInfo(shell);
      shell.content.append(
        facts([
          ["曲名", chart.title],
          ["artist", chart.artist],
          ["投稿者", parsedPage.user.name],
          ["現在難易度", offline ? "取得できません" : chart.current_level]
        ]),
        element(document2, "p", {
          className: "appamada-warning",
          text: "卍0未満として不放逸から削除すべき譜面のみ申請してください。"
        })
      );
      let comment;
      const commentControl = commentField(update);
      comment = commentControl.textarea;
      shell.content.append(commentControl.wrapper);
      const statusContainer = element(document2, "div");
      const actions = element(document2, "div", { className: "appamada-actions" });
      const submit = element(document2, "button", {
        className: "appamada-submit appamada-submit-danger",
        text: offline ? "ブラウザに保存" : "申請を送信",
        type: "button"
      });
      actions.append(submit);
      shell.content.append(statusContainer, actions);
      function update() {
        const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
        submit.disabled = busy || offline && !outbox || codePointLength(comment.value) > 500;
      }
      submit.addEventListener("click", () => {
        if (submit.disabled) return;
        const payload = commonPayload("delete", comment.value.normalize("NFC"));
        payload.proposed_level = "削除";
        void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer, offline });
      });
      update();
    }
    async function openWorkflow(applicationType) {
      closeMenu();
      function renderOffline() {
        if (applicationType === "change") renderChange(parsedPage.song, true);
        else if (applicationType === "delete") renderDelete(parsedPage.song, true);
        else renderNew(true);
      }
      if (lookupUnavailableUntil > Date.now()) {
        renderOffline();
        return;
      }
      const shell = modalShell("不放逸 申請");
      shell.content.append(statusNode(document2, "登録状況を確認しています。"));
      try {
        const lookup = await apiClient.lookup(parsedPage.song.md5);
        if (activeModal !== shell) return;
        lookupUnavailableUntil = 0;
        if (!lookup.ok) {
          logger2?.debug?.("LOOKUP_FAILED", lookup.error.code);
          showMessage("申請できません", errorMessageFor(lookup.error.code));
          return;
        }
        if ((applicationType === "change" || applicationType === "delete") && !lookup.exists) {
          showMessage(
            "申請できません",
            "不放逸に未登録です。新規譜面申請を利用してください。"
          );
          return;
        }
        if (applicationType === "new" && lookup.exists) {
          showMessage(
            "申請できません",
            "すでに不放逸に登録されています。難易度変更申請を利用してください。"
          );
          return;
        }
        if (applicationType === "change") renderChange(lookup.chart);
        else if (applicationType === "delete") renderDelete(lookup.chart);
        else renderNew();
      } catch (error) {
        const code = error instanceof ApiClientError ? error.code : "INTERNAL_ERROR";
        logger2?.debug?.("LOOKUP_FAILED", code);
        if (activeModal !== shell) return;
        if (isCommunicationError(code)) {
          markLookupUnavailable(code);
          renderOffline();
        } else showMessage("通信エラー", errorMessageFor(code));
      }
    }
    async function showSaved() {
      closeMenu();
      const shell = modalShell("不放逸 保存した提案");
      shell.content.append(statusNode(
        document2,
        "このブラウザに保存した提案です。BMS-IRの譜面ページを開いている間、送信待ちの提案を順番に送信します。"
      ));
      const actions = element(document2, "div", { className: "appamada-actions" });
      const retry = element(document2, "button", { className: "appamada-submit", type: "button", text: "送信待ちを再送" });
      const refresh = element(document2, "button", { className: "appamada-close", type: "button", text: "表示を更新" });
      const backup = element(document2, "button", { className: "appamada-close", type: "button", text: "控えを保存" });
      const status = element(document2, "div");
      const items = element(document2, "div");
      actions.append(retry, refresh, backup);
      shell.content.append(actions, status, items);
      async function updateList() {
        try {
          const entries = await outbox.list();
          if (activeModal !== shell) return;
          items.replaceChildren();
          if (!entries.length) items.append(statusNode(document2, "保存した提案はありません。"));
          for (const entry of entries) {
            const item = element(document2, "section", { className: "appamada-saved-item" });
            const labels = { change: "難易度変更", new: "新規譜面", delete: "削除" };
            const states = { pending: "送信待ち", sending: "送信結果を確認中", sent: "送信済み", rejected: "受付不可" };
            item.append(facts([
              ["曲名", entry.metadata.title],
              ["artist", entry.metadata.artist],
              ["提案", `${labels[entry.payload.application_type]}：${entry.payload.proposed_level}`],
              ["状態", states[entry.status]],
              ["コメント", entry.payload.comment]
            ]));
            if (entry.errorCode && entry.status !== "sent") item.append(statusNode(document2, errorMessageFor(entry.errorCode), "error"));
            const remove = element(document2, "button", {
              className: "appamada-close",
              type: "button",
              text: ["sent", "rejected"].includes(entry.status) ? "控えを消す" : "保存を取り消す"
            });
            remove.disabled = !["sent", "rejected"].includes(entry.status) && entry.attempts > 0;
            if (remove.disabled) remove.title = "送信を試みたため、受付状況が確定するまで取り消せません。";
            remove.addEventListener("click", async () => {
              try {
                await outbox.remove(entry.payload.request_id);
                await updateList();
              } catch (error) {
                status.replaceChildren(statusNode(document2, errorMessageFor(error.code), "error"));
              }
            });
            item.append(remove);
            items.append(item);
          }
        } catch (error) {
          status.replaceChildren(statusNode(document2, errorMessageFor(error.code), "error"));
        }
      }
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        status.replaceChildren(statusNode(document2, "保存した提案を確認・送信しています。"));
        try {
          await outbox.flush({ manual: true });
          status.replaceChildren(statusNode(document2, "送信状況を確認してください。通信不調や投稿間隔の制限がある場合は、時間を置いて再送します。"));
        } catch (error) {
          status.replaceChildren(statusNode(document2, errorMessageFor(error.code), "error"));
        }
        retry.disabled = false;
        await updateList();
      });
      refresh.addEventListener("click", () => void updateList());
      backup.addEventListener("click", async () => {
        try {
          const data = await outbox.exportData();
          const link = element(document2, "a", { text: "保存した提案の控えをダウンロード" });
          link.href = `data:application/json;charset=utf-8,${encodeURIComponent(data)}`;
          link.download = "appamada-saved-proposals.json";
          status.replaceChildren(link);
        } catch (error) {
          status.replaceChildren(statusNode(document2, errorMessageFor(error.code), "error"));
        }
      });
      shell.savedRefresh = updateList;
      await updateList();
    }
    const unsubscribe = outbox?.subscribe(() => {
      if (activeModal?.savedRefresh) void activeModal.savedRefresh();
    });
    function showMenu(event) {
      if (event.shiftKey) return;
      event.preventDefault();
      closeMenu();
      const menu = element(document2, "div", { className: "appamada-menu" });
      menu.setAttribute("role", "menu");
      menu.append(element(document2, "div", { className: "appamada-menu-title", text: "卍 不放逸" }));
      for (const [label, type] of [
        ["難易度変更申請", "change"],
        ["新規譜面申請", "new"],
        ["削除申請(難易度が卍0未満)", "delete"]
      ]) {
        const button = element(document2, "button", { text: label, type: "button" });
        button.dataset.action = type;
        button.setAttribute("role", "menuitem");
        button.addEventListener("click", () => void openWorkflow(type));
        menu.append(button);
      }
      if (outbox) {
        const saved = element(document2, "button", { text: "保存した提案", type: "button" });
        saved.dataset.action = "saved";
        saved.setAttribute("role", "menuitem");
        saved.addEventListener("click", () => void showSaved());
        menu.append(saved);
      }
      document2.body.append(menu);
      const rect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(event.clientX, window2.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(event.clientY, window2.innerHeight - rect.height - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      activeMenu = menu;
      menu.querySelector("button")?.focus();
    }
    function onDocumentClick(event) {
      if (activeMenu && !activeMenu.contains(event.target)) closeMenu();
    }
    function onKeyDown(event) {
      if (event.key === "Escape") {
        closeMenu();
        closeModal();
      }
    }
    titleElement.addEventListener("contextmenu", showMenu);
    artistElement.addEventListener("contextmenu", showMenu);
    document2.addEventListener("click", onDocumentClick);
    document2.addEventListener("keydown", onKeyDown);
    window2.addEventListener("scroll", closeMenu, true);
    window2.addEventListener("resize", closeMenu);
    return Object.freeze({
      closeMenu,
      closeModal,
      markLookupUnavailable,
      destroy() {
        closeMenu();
        closeModal();
        unsubscribe?.();
        titleElement.removeEventListener("contextmenu", showMenu);
        artistElement.removeEventListener("contextmenu", showMenu);
        document2.removeEventListener("click", onDocumentClick);
        document2.removeEventListener("keydown", onKeyDown);
        window2.removeEventListener("scroll", closeMenu, true);
        window2.removeEventListener("resize", closeMenu);
      }
    });
  }

  // src/submission-main.js
  var CLIENT_VERSION = "0.4.7";
  var DEBUG = false;
  var logger = createLogger({ debug: DEBUG });
  var parseResult = parseBmsirPage(document, location.href);
  if (!parseResult.ok) {
    logger.warn("PARSE_FAILED", {
      code: parseResult.error,
      ...collectDomDiagnostics(document, location.href)
    });
  } else {
    try {
      const apiClient = createApiClient({
        apiUrl: "https://script.google.com/macros/s/AKfycbw6dwFnKUnEC__0yzpVduEOSWAIhQiNngisPf7dU5zMZFx0Vgm-UHxipeS-pDZdwyKR/exec",
        gmRequest: GM_xmlhttpRequest
      });
      const storage = createGmStorage({
        modern: typeof GM === "object" ? GM : void 0,
        legacy: {
          get: typeof GM_getValue === "function" ? GM_getValue : void 0,
          set: typeof GM_setValue === "function" ? GM_setValue : void 0,
          remove: typeof GM_deleteValue === "function" ? GM_deleteValue : void 0,
          keys: typeof GM_listValues === "function" ? GM_listValues : void 0
        }
      });
      const outbox = storage ? createOutbox({
        storage,
        apiClient,
        playerId: parseResult.user.playerId,
        locks: window.navigator.locks
      }) : void 0;
      const ui = installSubmissionUi({
        document,
        window,
        parsedPage: parseResult,
        apiClient,
        outbox,
        clientVersion: CLIENT_VERSION,
        addStyle: typeof GM_addStyle === "function" ? GM_addStyle : void 0,
        logger
      });
      if (outbox) startOutboxSync({
        outbox,
        window,
        onError: (error) => logger.debug("OUTBOX_SYNC_FAILED", error?.code ?? "INTERNAL_ERROR")
      });
      void apiClient.lookup(parseResult.song.md5).catch((error) => {
        logger.debug("LOOKUP_PREFETCH_FAILED", error?.code ?? "INTERNAL_ERROR");
        ui.markLookupUnavailable(error?.code);
      });
    } catch (error) {
      logger.warn("SUBMISSION_INIT_FAILED", error?.code ?? "INTERNAL_ERROR");
    }
  }
})();
