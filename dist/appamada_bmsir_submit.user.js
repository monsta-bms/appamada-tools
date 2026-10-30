// ==UserScript==
// @name         不放逸 BMSIR申請
// @namespace    https://github.com/monsta-bms/appamada-tools
// @version      0.4.9
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
// @connect      appamada-submission-gateway.monsta3228gsl.workers.dev
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/monsta-bms/appamada-tools/main/dist/appamada_bmsir_submit.user.js
// @downloadURL  https://raw.githubusercontent.com/monsta-bms/appamada-tools/main/dist/appamada_bmsir_submit.user.js
// ==/UserScript==

(() => {
  // src/retry-policy.js
  var DEFAULT_RATE_RETRY_MS = 6e5;
  function validRetryDelay(value) {
    if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) return null;
    const milliseconds = Number(value);
    return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= Number.MAX_SAFE_INTEGER ? Math.ceil(milliseconds) : null;
  }
  function rateRetryDelay(value) {
    return Math.max(3e4, validRetryDelay(value) ?? DEFAULT_RATE_RETRY_MS);
  }
  function retryAfterHeader(responseHeaders, now) {
    if (typeof responseHeaders !== "string") return null;
    const delays = [];
    for (const line of responseHeaders.split(/\r?\n/)) {
      const match = /^Retry-After\s*:\s*(.*?)\s*$/i.exec(line);
      if (!match) continue;
      const value = match[1];
      if (/^\d+$/.test(value)) {
        const delay = validRetryDelay(Number(value) * 1e3);
        if (delay !== null) delays.push(delay);
      } else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
        const date = Date.parse(value);
        if (Number.isFinite(date)) delays.push(Math.max(0, date - now));
      }
    }
    return delays.length ? Math.max(...delays) : null;
  }

  // src/api-client.js
  var API_CLIENT_ERRORS = Object.freeze({
    API_NETWORK_ERROR: "API_NETWORK_ERROR",
    API_TIMEOUT: "API_TIMEOUT",
    API_INVALID_RESPONSE: "API_INVALID_RESPONSE",
    API_NOT_CONFIGURED: "API_NOT_CONFIGURED"
  });
  var MD5_PATTERN = /^[0-9a-f]{32}$/i;
  var REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function matchesRequestId(actual, expected) {
    return actual === expected || typeof actual === "string" && typeof expected === "string" && REQUEST_ID_PATTERN.test(actual) && REQUEST_ID_PATTERN.test(expected) && actual.toLowerCase() === expected.toLowerCase();
  }
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
      if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === "script.google.com" && /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) || /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) && url.pathname === "/api") || url.search || url.hash) {
        throw new Error("invalid URL");
      }
      return url.toString();
    } catch (error) {
      throw new ApiClientError(API_CLIENT_ERRORS.API_NOT_CONFIGURED, "API URL is invalid", {
        cause: error
      });
    }
  }
  function parseApiResponse(response, now) {
    const status = Number(response?.status ?? 0);
    const successfulHttp = status >= 200 && status < 300;
    const text = String(response?.responseText ?? response?.response ?? "");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
    }
    const headerDelay = retryAfterHeader(response?.responseHeaders, now);
    const errorResponse = parsed?.ok === false && parsed.error && typeof parsed.error.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.error.code);
    if (status === 429 || errorResponse) {
      const code = status === 429 ? "RATE_LIMITED" : parsed.error.code;
      const bodyDelay = errorResponse ? validRetryDelay(parsed.error.retry_after_ms) : null;
      const delays = [bodyDelay, headerDelay].filter((value) => value !== null);
      const retryDelay = delays.length ? Math.max(...delays) : code === "RATE_LIMITED" ? DEFAULT_RATE_RETRY_MS : null;
      return { ...errorResponse ? parsed : {}, ok: false, error: {
        ...errorResponse ? parsed.error : {},
        code,
        ...retryDelay === null ? {} : { retry_after_ms: retryDelay }
      } };
    }
    if (!successfulHttp) throw new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, `API returned HTTP ${status}`);
    if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
      throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API response shape is invalid");
    }
    if (!parsed.ok && (!parsed.error || typeof parsed.error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.error.code))) {
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
    let submitPause;
    async function requestJson(details) {
      return parseApiResponse(
        await gmRequestAsPromise(gmRequest, {
          timeout: timeoutMs,
          ...details
        }),
        now()
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
      if (submitPause?.until > now()) return {
        ...submitPause.result,
        request_id: payload?.request_id,
        error: { ...submitPause.result.error, retry_after_ms: submitPause.until - now() }
      };
      for (let attempt = 0; ; attempt += 1) {
        const result = await requestJson({
          method: "POST",
          url: configuredUrl,
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          data: JSON.stringify(payload)
        });
        if (result.ok && (typeof result.request_id !== "string" || !matchesRequestId(result.request_id, payload?.request_id) || typeof result.deduplicated !== "boolean")) {
          throw new ApiClientError(
            API_CLIENT_ERRORS.API_INVALID_RESPONSE,
            "submit response shape is invalid"
          );
        }
        const isLockTimeout = !result.ok && result.error?.code === "LOCK_TIMEOUT";
        const serverDelay = result.ok ? null : validRetryDelay(result.error.retry_after_ms);
        if (serverDelay !== null && serverDelay > 0) {
          const until = Math.min(Number.MAX_SAFE_INTEGER, now() + serverDelay);
          if (!submitPause || until > submitPause.until) submitPause = { until, result };
        }
        if (isLockTimeout && serverDelay >= 3e4) return result;
        if (!isLockTimeout || attempt >= LOCK_RETRY_RANGES.length) {
          return result;
        }
        await sleep(Math.max(
          jitteredDelay(LOCK_RETRY_RANGES[attempt], random),
          validRetryDelay(result.error.retry_after_ms) ?? 0
        ));
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

  // src/outbox-export.js
  function preserveRawRecord(record) {
    const seen = /* @__PURE__ */ new WeakSet();
    function jsonCompatible(value, depth = 0) {
      if (value === null || typeof value === "string" || typeof value === "boolean") return true;
      if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
      if (typeof value !== "object" || seen.has(value) || depth > 100) return false;
      seen.add(value);
      if (!Array.isArray(value) && Object.prototype.toString.call(value) !== "[object Object]") return false;
      if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
      return Object.keys(value).every((key) => jsonCompatible(value[key], depth + 1));
    }
    if (jsonCompatible(record.value)) return record;
    const references = /* @__PURE__ */ new WeakMap(), nodes = [], pending = [];
    function reference(value) {
      if (value === null || ["string", "boolean"].includes(typeof value)) return { type: "literal", value };
      if (typeof value === "number") return { type: "number", value: Object.is(value, -0) ? "-0" : String(value) };
      if (typeof value === "undefined") return { type: "undefined" };
      if (typeof value === "bigint") return { type: "bigint", value: String(value) };
      if (typeof value !== "object") return { type: "unsupported", description: typeof value };
      if (!references.has(value)) {
        const id = nodes.length;
        references.set(value, id);
        nodes.push(null);
        pending.push(value);
      }
      return { type: "reference", id: references.get(value) };
    }
    const root = reference(record.value);
    for (let index = 0; index < pending.length; index++) {
      const value = pending[index], id = references.get(value);
      if (value instanceof Map) nodes[id] = { type: "map", entries: [...value].map(([k, v]) => [reference(k), reference(v)]) };
      else if (value instanceof Set) nodes[id] = { type: "set", values: [...value].map(reference) };
      else if (value instanceof Date) nodes[id] = { type: "date", value: String(value.getTime()) };
      else nodes[id] = {
        type: Array.isArray(value) ? "array" : "object",
        ...Array.isArray(value) ? { length: value.length } : {},
        entries: Object.keys(value).map((key) => [key, reference(value[key])])
      };
    }
    return { key: record.key, encoding: "structured-graph-v1", value: { root, nodes } };
  }

  // src/outbox.js
  var OFFLINE_NOTICE = "通信不具合中。現時点の難易度表データ取得できません";
  var PREFIX2 = "appamada.outbox.v1.";
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var LEGACY_GATEWAY_REJECTIONS = /* @__PURE__ */ new Set([
    "GATEWAY_AUTH_REQUIRED",
    "GATEWAY_NOT_CONFIGURED",
    "GATEWAY_SOURCE_REQUIRED",
    "GATEWAY_UNAVAILABLE"
  ]);
  var TRANSIENT = /* @__PURE__ */ new Set([
    "API_NETWORK_ERROR",
    "API_TIMEOUT",
    "API_INVALID_RESPONSE",
    "LOCK_TIMEOUT",
    "RATE_LIMITED",
    "WRITE_FAILED",
    "INTERNAL_ERROR",
    "SUBMISSIONS_DISABLED",
    ...LEGACY_GATEWAY_REJECTIONS
  ]);
  var MANUAL_RESUME = /* @__PURE__ */ new Set([
    "API_NOT_CONFIGURED",
    "GATEWAY_NOT_CONFIGURED",
    "GATEWAY_AUTH_REQUIRED",
    "SHEET_NOT_FOUND",
    "SHEET_SCHEMA_INVALID",
    "CLIENT_VERSION_INVALID"
  ]);
  var PERMANENT = /* @__PURE__ */ new Set([
    "BAD_REQUEST",
    "APPLICATION_TYPE_INVALID",
    "LOGIN_NAME_MISSING",
    "PLAYER_ID_INVALID",
    "MD5_INVALID",
    "MD5_MISMATCH",
    "IR_URL_INVALID",
    "CHART_NOT_FOUND",
    "CHART_DUPLICATED",
    "CHART_ALREADY_EXISTS",
    "CURRENT_LEVEL_UNSUPPORTED",
    "TITLE_REQUIRED",
    "TITLE_TOO_LONG",
    "ARTIST_REQUIRED",
    "ARTIST_TOO_LONG",
    "LEVEL_REQUIRED",
    "LEVEL_INVALID",
    "SAME_AS_CURRENT",
    "COMMENT_TOO_LONG",
    "REQUEST_ID_INVALID",
    "REQUEST_ID_CONFLICT"
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
  var localQueues = /* @__PURE__ */ new WeakMap();
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
    if (["getValue", "setValue", "deleteValue", "listValues"].some((name) => typeof modern?.[name] === "function") || ["get", "set", "remove", "keys"].some((name) => typeof legacy[name] === "function")) {
      const unavailable = async () => {
        throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
      };
      return { get: unavailable, set: unavailable, remove: unavailable, keys: unavailable };
    }
    return null;
  }
  function validatePayload(payload, playerId, { stored = false } = {}) {
    const fields = payload?.application_type === "new" ? [...COMMON_FIELDS, "title", "artist"] : COMMON_FIELDS;
    let url;
    try {
      url = new URL(payload.ir_url);
    } catch {
    }
    if (!payload || !["change", "new", "delete"].includes(payload.application_type) || !UUID.test(payload.request_id) || !/^[0-9a-f]{32}$/.test(payload.md5) || !fields.every((field) => typeof payload[field] === "string") || Object.keys(payload).some((field) => !fields.includes(field)) || payload.bmsir_player_id !== playerId || !/^[0-9]+$/.test(playerId) || !stored && (!payload.bmsir_user_name.trim() || Array.from(payload.comment).length > 500 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(payload.client_version) || !(payload.application_type === "delete" ? payload.proposed_level === "削除" : isAllowedLevel(payload.proposed_level))) || !url || url.protocol !== "https:" || !["bms-ir.org", "www.bms-ir.org"].includes(url.hostname) || url.pathname !== "/new/song" || url.searchParams.get("songmd5")?.toLowerCase() !== payload.md5) throw new OutboxError("OUTBOX_INVALID_DATA");
  }
  function createOutbox({
    storage,
    apiClient,
    playerId,
    now = () => Date.now(),
    locks,
    sharedLockScope = false,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxEntries = 200
  }) {
    if (!storage) throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
    playerId = String(playerId);
    let dispatching = false;
    const listeners = /* @__PURE__ */ new Set();
    const canCancelUnsent = sharedLockScope === true && typeof locks?.request === "function";
    const key = (kind, id) => `${PREFIX2}${kind}.${id}`;
    const deadline = (delay) => Math.min(Number.MAX_SAFE_INTEGER, now() + delay);
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
    const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const timestamp = (value) => Number.isFinite(value) && value >= 0;
    async function storageKeys() {
      let keys;
      try {
        keys = await storage.keys();
      } catch {
        throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
      }
      if (!Array.isArray(keys) || keys.some((name) => typeof name !== "string")) {
        throw new OutboxError("OUTBOX_STORAGE_UNAVAILABLE");
      }
      return new Set(keys);
    }
    async function inspectRecord(id, keys, { forDispatch = false } = {}) {
      const names = ["entry", "state", "receipt", "cancelled"].map((kind) => key(kind, id));
      const values = [];
      values[0] = keys.has(names[0]) ? await read(names[0]) : void 0;
      values[2] = keys.has(names[2]) ? await read(names[2]) : void 0;
      const acknowledged = record(values[2]) && values[2].request_id === id && (values[2].version === void 0 || values[2].version === 1) && timestamp(values[2].sentAt) && typeof values[2].deduplicated === "boolean";
      const skipState = forDispatch && acknowledged;
      values[1] = !skipState && keys.has(names[1]) ? await read(names[1]) : void 0;
      values[3] = keys.has(names[3]) ? await read(names[3]) : void 0;
      const [entry, state, receipt, cancelled] = values;
      const raw = names.flatMap((name, index) => keys.has(name) ? [{ key: name, value: values[index] }] : []);
      const owner = entry?.payload?.bmsir_player_id;
      if (typeof owner === "string" && /^\d+$/.test(owner) && owner !== playerId) return {};
      if (owner !== playerId) {
        if (entry === void 0 && cancelled === true && !keys.has(names[1]) && !keys.has(names[2])) return {};
        return { unidentified: raw.length ? 1 : 0 };
      }
      const issue = (reason, blocked = true) => ({ issue: { id, reason, blocked }, raw });
      if (!UUID.test(id)) return issue("OUTBOX_KEY_INVALID");
      if (!record(entry) || entry.version !== 1) return issue("OUTBOX_VERSION_UNSUPPORTED");
      if (Object.keys(entry).some((field) => !["version", "createdAt", "notBefore", "payload", "metadata"].includes(field)) || !timestamp(entry.createdAt) || !timestamp(entry.notBefore) || !record(entry.metadata) || typeof entry.metadata?.title !== "string" || typeof entry.metadata?.artist !== "string") {
        return issue("OUTBOX_METADATA_INVALID");
      }
      try {
        validatePayload(entry.payload, playerId, { stored: true });
      } catch {
        return issue("OUTBOX_PAYLOAD_INVALID");
      }
      if (entry.payload.request_id !== id) return issue("OUTBOX_KEY_INVALID");
      if (keys.has(key("cancelled", id))) {
        if (cancelled === true) return { raw };
        return issue("OUTBOX_CANCELLATION_INVALID");
      }
      const hasState = !skipState && keys.has(key("state", id));
      const validState = !hasState || record(state) && (state.version === void 0 || state.version === 1) && Object.keys(state).every((field) => ["version", "status", "attempts", "nextAttemptAt", "errorCode", "manualOnly", "retryNotBefore"].includes(field)) && Number.isSafeInteger(state.attempts) && state.attempts >= 0 && timestamp(state.nextAttemptAt) && ["pending", "sending", "rejected"].includes(state.status) && (state.errorCode === void 0 || typeof state.errorCode === "string") && (state.manualOnly === void 0 || typeof state.manualOnly === "boolean") && (state.retryNotBefore === void 0 || timestamp(state.retryNotBefore));
      const hasReceipt = keys.has(key("receipt", id));
      const validReceipt = hasReceipt && record(receipt) && (receipt.version === void 0 || receipt.version === 1) && Object.keys(receipt).every((field) => ["version", "request_id", "sentAt", "deduplicated"].includes(field)) && receipt.request_id === id && timestamp(receipt.sentAt) && typeof receipt.deduplicated === "boolean";
      if (hasReceipt && !validReceipt) return issue("OUTBOX_RECEIPT_INVALID");
      if (!validState && !validReceipt) return issue("OUTBOX_STATE_INVALID");
      if (!validReceipt && state?.status === "rejected" && TRANSIENT.has(state.errorCode) && !LEGACY_GATEWAY_REJECTIONS.has(state.errorCode)) return issue("OUTBOX_STATE_UNCERTAIN");
      const savedState = validState && hasState ? {
        status: state.status,
        attempts: state.attempts,
        nextAttemptAt: state.nextAttemptAt,
        errorCode: state.errorCode,
        manualOnly: state.manualOnly,
        retryNotBefore: state.retryNotBefore
      } : void 0;
      const recoverGatewayRejection = !validReceipt && savedState?.status === "rejected" && LEGACY_GATEWAY_REJECTIONS.has(savedState.errorCode);
      const result = { raw, entry: clone({
        ...entry,
        ...savedState,
        status: validReceipt ? "sent" : recoverGatewayRejection ? "pending" : savedState?.status ?? "pending",
        attempts: !skipState && validState ? savedState?.attempts ?? 0 : null,
        nextAttemptAt: recoverGatewayRejection ? 0 : savedState?.nextAttemptAt ?? entry.notBefore,
        ...validReceipt ? { receipt } : {}
      }) };
      if (!validState) result.issue = { id, reason: "OUTBOX_STATE_INVALID", blocked: false };
      if (!validReceipt) {
        try {
          validatePayload(entry.payload, playerId);
        } catch {
          return issue("OUTBOX_PAYLOAD_UNSUPPORTED");
        }
      }
      return result;
    }
    async function inspect({ forDispatch = false } = {}) {
      const keys = await storageKeys();
      const ids = /* @__PURE__ */ new Set();
      const unusual = [];
      for (const name of keys) {
        const match = /^appamada\.outbox\.v1\.(entry|state|receipt|cancelled)\.(.*)$/.exec(name);
        if (match) ids.add(match[2]);
        else if (name.startsWith("appamada.outbox.") && !name.startsWith(`${PREFIX2}pause.`)) unusual.push(name);
      }
      const entries = [], issues = [], raw = [];
      let unidentifiedCount = 0;
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
      const head = entries.find((entry) => ["pending", "sending"].includes(entry.status));
      const pause = keys.has(key("pause", playerId)) ? await read(key("pause", playerId)) : void 0;
      const validPause = pause === void 0 || record(pause) && timestamp(pause.until) && typeof pause.errorCode === "string" && (pause.retryNotBefore === void 0 || timestamp(pause.retryNotBefore));
      if (!validPause) {
        issues.push({ id: "pause", reason: "OUTBOX_PAUSE_INVALID", blocked: true });
      }
      if (pause !== void 0) raw.push({ key: key("pause", playerId), value: pause });
      const paused = validPause && pause?.until > now();
      const queue = head ? {
        requestId: head.payload.request_id,
        manualOnly: Boolean(head.manualOnly),
        nextAttemptAt: Math.max(head.nextAttemptAt, paused ? pause.until : 0),
        errorCode: !validPause ? "OUTBOX_PAUSE_INVALID" : paused ? pause.errorCode : head.errorCode,
        blocked: !validPause
      } : null;
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
      const current = previous.catch(() => {
      }).then(() => {
        if (typeof locks?.request !== "function") return task();
        const name = `appamada-outbox-${playerId}`;
        return nonBlocking ? locks.request(
          name,
          { ifAvailable: true },
          (lock) => lock ? task() : { status: "busy" }
        ) : locks.request(name, task);
      });
      const tail = current.then(() => {
      }, () => {
      });
      localQueues.set(storage, tail);
      try {
        return await current;
      } finally {
        if (localQueues.get(storage) === tail) localQueues.delete(storage);
      }
    }
    async function dispatch(task) {
      if (dispatching) return { status: "busy" };
      dispatching = true;
      try {
        return await coordinate(task, true);
      } finally {
        dispatching = false;
      }
    }
    async function enqueue(payload, metadata, { defer = false } = {}) {
      validatePayload(payload, playerId);
      const save = async () => {
        const snapshot = await inspect();
        const { entries } = snapshot;
        const sameId = entries.find((entry2) => entry2.payload.request_id === payload.request_id);
        if (sameId) {
          const fields = COMMON_FIELDS.concat(payload.application_type === "new" ? ["title", "artist"] : []);
          if (JSON.stringify(fields.map((field) => sameId.payload[field])) !== JSON.stringify(fields.map((field) => payload[field]))) {
            throw new OutboxError("OUTBOX_CONFLICT");
          }
          return sameId;
        }
        if (await read(key("cancelled", payload.request_id))) throw new OutboxError("OUTBOX_CONFLICT");
        if (snapshot.reservedIds.has(payload.request_id)) throw new OutboxError("OUTBOX_REVIEW_REQUIRED");
        const intent = (value) => JSON.stringify(COMMON_FIELDS.concat(value.application_type === "new" ? ["title", "artist"] : []).filter((field) => !["request_id", "client_version"].includes(field)).map((field) => value[field]));
        const existing = entries.find((entry2) => ["pending", "sending"].includes(entry2.status) && intent(entry2.payload) === intent(payload));
        if (existing) return existing;
        if (entries.filter((entry2) => ["pending", "sending"].includes(entry2.status)).length >= maxEntries) {
          throw new OutboxError("OUTBOX_FULL");
        }
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
      return coordinate(save);
    }
    async function sendEntry(id, manual) {
      const entry = await getEntry(id);
      if (!entry) return { status: "missing" };
      if (["sent", "rejected", "review"].includes(entry.status)) return entry;
      if (entry.manualOnly && !manual) return {
        status: "waiting",
        errorCode: entry.errorCode,
        nextAttemptAt: entry.nextAttemptAt,
        manualOnly: true
      };
      if (entry.retryNotBefore > now() || entry.nextAttemptAt > now() && (!manual || entry.status === "sending" || entry.errorCode === "RATE_LIMITED")) {
        return { status: "waiting", errorCode: entry.errorCode, nextAttemptAt: Math.max(entry.nextAttemptAt, entry.retryNotBefore ?? 0) };
      }
      const pause = await read(key("pause", playerId));
      if (pause !== void 0 && (!record(pause) || !timestamp(pause.until) || typeof pause.errorCode !== "string" || pause.retryNotBefore !== void 0 && !timestamp(pause.retryNotBefore))) {
        return { status: "review", errorCode: "OUTBOX_PAUSE_INVALID" };
      }
      if (pause?.retryNotBefore > now() || pause?.until > now() && (!manual || pause.errorCode === "RATE_LIMITED")) {
        return { status: "waiting", errorCode: pause.errorCode, nextAttemptAt: Math.max(pause.until, pause.retryNotBefore ?? 0) };
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
        if (typeof result?.ok !== "boolean" || result.ok && (!matchesRequestId(result.request_id, id) || typeof result.deduplicated !== "boolean")) {
          throw new OutboxError("API_INVALID_RESPONSE");
        }
        if (!result?.ok && typeof result?.error?.code !== "string") throw new OutboxError("API_INVALID_RESPONSE");
      } catch (error) {
        result = { ok: false, error: { code: isCommunicationError(error?.code) || MANUAL_RESUME.has(error?.code) ? error.code : "API_NETWORK_ERROR" } };
      }
      if (result.ok) {
        try {
          await write(key("receipt", id), { request_id: id, sentAt: now(), deduplicated: result.deduplicated });
        } catch (error) {
          const acknowledged = await getEntry(id);
          if (acknowledged?.status !== "sent") throw error;
        }
      } else {
        const errorCode = result.error.code;
        const retryable = !PERMANENT.has(errorCode);
        const manualOnly = MANUAL_RESUME.has(errorCode) || !TRANSIENT.has(errorCode) && !PERMANENT.has(errorCode);
        const delay = errorCode === "RATE_LIMITED" ? rateRetryDelay(result.error.retry_after_ms) : Math.max(
          validRetryDelay(result.error.retry_after_ms) ?? 0,
          Math.min(3e5, 3e4 * 2 ** Math.min(state.attempts - 1, 4))
        );
        await write(key("state", id), {
          ...state,
          status: retryable ? "pending" : "rejected",
          nextAttemptAt: retryable ? deadline(delay) : 0,
          errorCode,
          manualOnly,
          retryNotBefore: validRetryDelay(result.error.retry_after_ms) === null ? 0 : deadline(delay)
        });
        if (retryable) {
          const oldPause = await read(key("pause", playerId));
          await write(key("pause", playerId), {
            until: Math.max(oldPause?.until ?? 0, deadline(delay)),
            retryNotBefore: Math.max(
              oldPause?.retryNotBefore ?? 0,
              validRetryDelay(result.error.retry_after_ms) === null ? 0 : deadline(delay)
            ),
            errorCode: oldPause?.until > deadline(delay) ? oldPause.errorCode : errorCode
          });
        }
      }
      notify();
      return await getEntry(id) ?? { status: result.ok ? "sent" : "rejected", errorCode: result.error?.code };
    }
    async function send(id) {
      return dispatch(() => sendEntry(id, true));
    }
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
          await sleep(1e3);
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
        if (kind === "cancel" && (completed || entry.attempts > 0) || kind === "receipt" && !completed || !["cancel", "receipt"].includes(kind)) throw new OutboxError("OUTBOX_CANNOT_CANCEL");
        if (kind === "cancel" && !canCancelUnsent) {
          throw new OutboxError("OUTBOX_CANCEL_UNSAFE");
        }
        await write(key("cancelled", id), true);
        try {
          for (const kind2 of ["entry", "state", "receipt"]) await storage.remove(key(kind2, id));
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
      canCancelUnsent,
      async inspect() {
        const { entries, issues, unidentifiedCount, queue } = await inspect();
        return { entries, issues, unidentifiedCount, queue };
      },
      async exportData() {
        const { entries, issues, raw, unidentifiedCount } = await inspect();
        const ownRaw = raw.filter((record2) => ![record2.value?.payload?.bmsir_player_id, record2.value?.bmsir_player_id].some((owner) => typeof owner === "string" && /^\d+$/.test(owner) && owner !== playerId));
        return JSON.stringify({
          version: 1,
          exportedAt: now(),
          entries,
          issues,
          records: ownRaw.map(preserveRawRecord),
          omittedRecords: {
            count: raw.length - ownRaw.length,
            notice: "別の所有者を示す情報を含む異常原本は、保存領域に残して通常の控え出力から除外しています。"
          },
          unidentified: {
            count: unidentifiedCount,
            included: false,
            notice: "所有者を確認できない原本は保存領域に残しています。内容はこの控えに含めません。"
          }
        }, null, 2);
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
    GATEWAY_NOT_CONFIGURED: "申請受付の準備が整っていません。時間を置いてお試しください。",
    GATEWAY_AUTH_REQUIRED: "申請用Userscriptを最新版へ更新してください。保存した提案は保持されています。",
    GATEWAY_SOURCE_REQUIRED: "送信元を確認できませんでした。時間を置いてお試しください。",
    GATEWAY_UNAVAILABLE: "申請受付へ接続できませんでした。時間を置いてお試しください。",
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
    OUTBOX_REVIEW_REQUIRED: "保存データの確認が必要です。原本を残し、自動送信を止めています。控えを保存して管理者へご相談ください。",
    OUTBOX_KEY_INVALID: "保存データの識別子または保存形式を確認できません。",
    OUTBOX_VERSION_UNSUPPORTED: "この版では読めない保存形式です。対応するUserscriptでの確認が必要です。",
    OUTBOX_METADATA_INVALID: "保存日時または曲名・artistの保存情報を確認できません。",
    OUTBOX_PAYLOAD_INVALID: "保存された申請内容の形式を確認できません。",
    OUTBOX_PAYLOAD_UNSUPPORTED: "以前の申請内容が現在の受付条件に合いません。内容を自動変更せず保全しています。",
    OUTBOX_STATE_INVALID: "過去の送信状態を確認できません。未送信とは扱いません。",
    OUTBOX_STATE_UNCERTAIN: "通信失敗と受付不可の記録が矛盾しています。受付状況が不明なため、原本を保全して自動送信を止めています。",
    OUTBOX_RECEIPT_INVALID: "送信結果の記録を確認できません。未送信とは扱いません。",
    OUTBOX_CANCELLATION_INVALID: "保存取消の記録を確認できません。自動送信は行いません。",
    OUTBOX_PAUSE_INVALID: "投稿間隔の待機記録を確認できません。安全のため再送を止め、原本を残しています。控えを保存して管理者へご相談ください。",
    OUTBOX_FULL: "送信待ち・送信結果未確定の提案が上限200件に達しました。完了控えや要確認データは別に保持しています。",
    OUTBOX_CONFLICT: "同じ申請の保存内容が一致しません。保存した提案を確認してください。",
    OUTBOX_CANNOT_CANCEL: "送信を試みた提案は、受け付けられた可能性があるため取り消せません。",
    OUTBOX_CANCEL_UNSAFE: "複数ページ間で送信と取消の順序を保証できないため、この環境では未送信の保存取消を利用できません。",
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
    return Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : "申請を処理できませんでした。時間を置いて再度お試しください。";
  }
  function retryDescription(entry, now = Date.now()) {
    if (entry.status === "sent") return "申請を受け付けました。難易度表への反映・承認完了を示すものではありません。";
    if (entry.status === "rejected") return "受付不可の控えです。自動で再送しません。控えの削除は申請の撤回ではありません。";
    if (entry.status === "review" || entry.blocked) return "確認が必要なため自動送信しません。原本の控えを保存して確認してください。";
    if (entry.manualOnly) return "自動再送は保留しています。設定や対応版を確認後、「送信待ちを再送」で再開できます。元の申請内容・識別子は変更しません。";
    const time = new Date(entry.nextAttemptAt);
    const next = entry.nextAttemptAt > now && Number.isFinite(time.getTime()) ? `次の自動再送は${time.toLocaleString("ja-JP")}以降です。` : "このページを開いている間、順番に自動再送します。";
    if (entry.status === "sending") return `受付結果がまだ確定していません。取り消さず、同じ識別子で確認し直します。${next}`;
    return `${entry.errorCode === "RATE_LIMITED" ? "投稿間隔の制限が終わるのを待っています。" : ""}${next}`;
  }
  function showSubmissionUnavailable(document2, pageUrl, code) {
    let url;
    try {
      url = new URL(pageUrl);
    } catch {
      return;
    }
    if (url.protocol !== "https:" || !["bms-ir.org", "www.bms-ir.org"].includes(url.hostname) || url.pathname !== "/new/song") return;
    const messages = {
      NOT_LOGGED_IN: "不放逸の申請は、BMS-IRへログインすると利用できます。",
      USER_DOM_INVALID: "ログイン情報の構造を確認できないため、不放逸の申請を開始できません。",
      SONG_DOM_INVALID: "譜面ページの構造を確認できないため、不放逸の申請を開始できません。",
      MD5_MISMATCH: "譜面の識別情報が一致しないため、不放逸の申請を開始できません。",
      MD5_INVALID: "URLの譜面識別情報を確認できないため、不放逸の申請を開始できません。"
    };
    let notice = document2.querySelector("[data-appamada-unavailable]");
    if (!notice) {
      notice = element(document2, "p");
      notice.dataset.appamadaUnavailable = "true";
      notice.setAttribute("role", "status");
      notice.style.cssText = "padding:8px;border:1px solid #888;background:#fff;color:#222;font:14px system-ui;";
      document2.body.append(notice);
    }
    notice.textContent = Object.hasOwn(messages, code) ? messages[code] : `不放逸の申請を開始できません。${errorMessageFor(code)}`;
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
          } else if (["rejected", "review"].includes(result2.status)) {
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
              `${isCommunicationError(result2.errorCode) ? `${OFFLINE_NOTICE}。 ` : ""}${reason}提案をブラウザに保存しました。まだ送信完了していません。${retryDescription(result2)}右クリックの「保存した提案」から確認できます。`
            ));
            button.textContent = "保存済み（送信待ち）";
          }
          button.dataset.completed = "true";
          updateDisabled();
          return;
        }
        const result = await apiClient.submit(payload);
        if (result.ok) {
          if (!matchesRequestId(result.request_id, payload.request_id) || typeof result.deduplicated !== "boolean") {
            throw new ApiClientError("API_INVALID_RESPONSE", "Mismatched acknowledgement");
          }
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
      let refreshVersion = 0;
      async function updateList() {
        const version = ++refreshVersion;
        try {
          const { entries, issues, unidentifiedCount, queue } = await outbox.inspect();
          if (activeModal !== shell || version !== refreshVersion) return;
          items.replaceChildren();
          items.append(statusNode(document2, `正常な提案：${entries.length}件 ／ 要確認：${issues.filter((issue) => issue.blocked).length}件` + (issues.some((issue) => !issue.blocked) ? ` ／ 記録警告：${issues.filter((issue) => !issue.blocked).length}件` : "")));
          if (queue && (queue.blocked || queue.manualOnly || queue.nextAttemptAt > Date.now())) {
            items.append(statusNode(document2, `先頭の提案を待っています。${queue.errorCode ? errorMessageFor(queue.errorCode) : ""}${retryDescription(queue)}後続の提案も申請順を保って待機します。`));
          }
          if (unidentifiedCount) items.append(statusNode(
            document2,
            `所有者を確認できない保存データが${unidentifiedCount}件あります。内容の表示・送信・通常の控え出力は行いません。原本は保存領域に残しています。`,
            "error"
          ));
          for (const issue of issues) {
            const item = element(document2, "section", { className: "appamada-saved-item" });
            item.append(
              facts([[issue.blocked ? "要確認の識別子" : "記録警告の識別子", issue.id], ["理由", errorMessageFor(issue.reason)]]),
              statusNode(document2, issue.blocked ? "原本を保全しています。この項目は自動送信しません。控えを保存して確認してください。" : "受領記録から送信済みを確認しています。異常な状態記録も原本の控えに含めます。")
            );
            items.append(item);
          }
          if (!entries.length && !issues.length && !unidentifiedCount) items.append(statusNode(document2, "保存した提案はありません。"));
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
            item.append(statusNode(document2, retryDescription(entry)));
            const remove = element(document2, "button", {
              className: "appamada-close",
              type: "button",
              text: ["sent", "rejected"].includes(entry.status) ? "控えを消す" : "保存を取り消す"
            });
            const completed = ["sent", "rejected"].includes(entry.status);
            remove.disabled = !completed && (entry.attempts > 0 || !outbox.canCancelUnsent);
            if (remove.disabled) remove.title = entry.attempts > 0 ? errorMessageFor("OUTBOX_CANNOT_CANCEL") : errorMessageFor("OUTBOX_CANCEL_UNSAFE");
            remove.addEventListener("click", async () => {
              if (completed && !window2.confirm(`「${entry.metadata.title}」の完了控え1件をこのブラウザから消します。サーバー上の申請を撤回する操作ではありません。よろしいですか？`)) return;
              try {
                await outbox.remove(entry.payload.request_id, { kind: completed ? "receipt" : "cancel" });
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
  var CLIENT_VERSION = "0.4.9";
  var DEBUG = false;
  var logger = createLogger({ debug: DEBUG });
  var parseResult = parseBmsirPage(document, location.href);
  if (!parseResult.ok) {
    showSubmissionUnavailable(document, location.href, parseResult.error);
    logger.warn("PARSE_FAILED", {
      code: parseResult.error,
      ...collectDomDiagnostics(document, location.href)
    });
  } else {
    try {
      const apiClient = createApiClient({
        apiUrl: "https://appamada-submission-gateway.monsta3228gsl.workers.dev/api",
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
      showSubmissionUnavailable(document, location.href, error?.code ?? "INTERNAL_ERROR");
    }
  }
})();
