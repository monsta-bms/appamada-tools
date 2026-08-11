// ==UserScript==
// @name         不放逸 BMSIR申請
// @namespace    https://github.com/monsta-bms/appamada-tools
// @version      0.3.0
// @description  BMSIRから不放逸への譜面申請を補助します
// @match        https://bms-ir.org/new/song*
// @match        https://www.bms-ir.org/new/song*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
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
      try {
        gmRequest({
          ...details,
          anonymous: true,
          responseType: "text",
          onload: resolve,
          onerror() {
            reject(
              new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, "API request failed")
            );
          },
          ontimeout() {
            reject(new ApiClientError(API_CLIENT_ERRORS.API_TIMEOUT, "API request timed out"));
          }
        });
      } catch (error) {
        reject(
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
  function directAnchors(element2) {
    return Array.from(element2.children).filter((child) => child.tagName === "A");
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
    const anchors = resolveAnchors(directAnchors(userElements[0]), page);
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
  function parseSong(document2, pageUrl) {
    const page = parseUrl(pageUrl);
    if (!page || page.protocol !== "https:" || !SONG_HOSTNAMES.has(page.hostname) || page.pathname !== "/new/song") {
      return failure(PARSER_ERRORS.NOT_SONG_PAGE);
    }
    const urlMd5Values = page.searchParams.getAll("songmd5");
    if (urlMd5Values.length !== 1 || !MD5_PATTERN2.test(urlMd5Values[0])) {
      return failure(PARSER_ERRORS.MD5_INVALID);
    }
    const titleElements = document2?.querySelectorAll?.("#box > h1");
    if (!titleElements || titleElements.length !== 1) {
      return failure(PARSER_ERRORS.SONG_DOM_INVALID);
    }
    const titleElement = titleElements[0];
    const artistElement = titleElement.nextElementSibling;
    if (!artistElement || artistElement.tagName !== "H2") {
      return failure(PARSER_ERRORS.SONG_DOM_INVALID);
    }
    const md5Matches = Array.from(document2.querySelectorAll("#box > p.muted")).flatMap((element2) => {
      const match = MD5_INFO_PATTERN.exec(normalizeText(element2.textContent));
      return match ? [{ rankingKey: match[1], hash: match[2] }] : [];
    });
    if (md5Matches.length !== 1) {
      return failure(PARSER_ERRORS.SONG_DOM_INVALID);
    }
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
    const rankingKey = md5Matches[0].rankingKey.toLowerCase();
    const hash = md5Matches[0].hash.toLowerCase();
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
    "13",
    "13+",
    "14",
    "15",
    "16"
  ]);
  var SPECIAL_LEVELS = Object.freeze(["?", "★★4?", "★★5?", "★★6?", "★★7?"]);
  var ALLOWED_LEVELS = Object.freeze([...STEP_LEVELS, ...SPECIAL_LEVELS]);
  var PUBLISH_LEVEL_ORDER = Object.freeze([
    ...STEP_LEVELS,
    "★★4?",
    "★★5?",
    "★★6?",
    "★★7?",
    "?"
  ]);
  var ALLOWED_LEVEL_SET = new Set(ALLOWED_LEVELS);
  var STEP_LEVEL_SET = new Set(STEP_LEVELS);
  var SPECIAL_LEVEL_SET = new Set(SPECIAL_LEVELS);
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
    INTERNAL_ERROR: "サーバー内部でエラーが発生しました。"
  });
  var STYLE = `
.appamada-menu,.appamada-overlay{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.appamada-menu{position:fixed;z-index:12000;min-width:190px;padding:6px;background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 8px 24px #0004}
.appamada-menu-title{padding:6px 10px;font-weight:700;border-bottom:1px solid #ddd}
.appamada-menu button,.appamada-modal button{font:inherit}
.appamada-menu button{display:block;width:100%;padding:8px 10px;text-align:left;border:0;background:transparent;border-radius:5px;color:inherit;cursor:pointer}
.appamada-menu button:hover,.appamada-menu button:focus{background:#e8eef8;outline:2px solid #4b75b8}
.appamada-overlay{position:fixed;inset:0;z-index:12010;display:grid;place-items:center;padding:20px;background:#0008}
.appamada-modal{box-sizing:border-box;width:min(680px,100%);max-height:90vh;overflow:auto;padding:20px;background:#fff;color:#222;border-radius:12px;box-shadow:0 14px 40px #0006}
.appamada-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #ddd}
.appamada-modal-header h2{margin:0 0 12px;font-size:1.25rem;color:#222;font-weight:700;opacity:1;text-shadow:none}
.appamada-close{padding:5px 10px;border:1px solid #888;border-radius:5px;background:#fff;cursor:pointer}
.appamada-facts{display:grid;grid-template-columns:max-content 1fr;gap:5px 12px;margin:16px 0}
.appamada-facts dt{font-weight:700}.appamada-facts dd{margin:0;overflow-wrap:anywhere}
.appamada-level-grid{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px}
.appamada-level-grid button,.appamada-step button{padding:6px 10px;border:1px solid #777;border-radius:6px;background:#fff;color:#222;cursor:pointer}
.appamada-level-grid button[aria-pressed="true"]{background:#244f91;color:#fff;border-color:#244f91}
.appamada-step{display:flex;align-items:center;justify-content:center;gap:10px;margin:12px 0}
.appamada-selected{min-width:90px;text-align:center;font-weight:700;font-size:1.2rem}
.appamada-comment{display:grid;gap:5px;margin:14px 0}.appamada-comment textarea{box-sizing:border-box;width:100%;min-height:90px;padding:8px;font:inherit}
.appamada-count{text-align:right}.appamada-count-error{color:#b00020;font-weight:700}
.appamada-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.appamada-submit{padding:8px 16px;border:0;border-radius:6px;background:#244f91;color:#fff;cursor:pointer}.appamada-submit:disabled{background:#999;cursor:not-allowed}
.appamada-status{margin:12px 0;padding:10px;border-radius:6px;background:#eef3fb}.appamada-status-error{background:#fdebec;color:#8b0018}.appamada-status-success{background:#e8f6ec;color:#145a28}
.appamada-subheading{margin:14px 0 4px;font-weight:700}
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
    clientVersion = "0.0.0",
    cryptoObject = window2.crypto,
    addStyle,
    logger: logger2
  }) {
    const titleElement = document2.querySelector("#box > h1");
    const artistElement = titleElement?.nextElementSibling;
    if (!titleElement || artistElement?.tagName !== "H2") {
      throw new Error("Parsed song elements are no longer available");
    }
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
    async function runSubmit({ payload, button, updateDisabled, statusContainer }) {
      if (button.dataset.submitting === "true") return;
      button.dataset.submitting = "true";
      button.textContent = "送信中…";
      updateDisabled();
      statusContainer.replaceChildren(statusNode(document2, "申請を送信しています。"));
      try {
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
        const code = error instanceof ApiClientError ? error.code : "INTERNAL_ERROR";
        logger2?.debug?.("SUBMIT_FAILED", code);
        statusContainer.replaceChildren(statusNode(document2, errorMessageFor(code), "error"));
      }
      button.dataset.submitting = "false";
      button.textContent = "申請を送信";
      updateDisabled();
    }
    function renderChange(chart) {
      const shell = modalShell("不放逸 難易度変更申請");
      shell.content.append(
        facts([
          ["曲名", chart.title],
          ["artist", chart.artist],
          ["投稿者", parsedPage.user.name],
          ["現在難易度", chart.current_level]
        ])
      );
      let selectedLevel = chart.current_level;
      const step = element(document2, "div", { className: "appamada-step" });
      const harder = element(document2, "button", { text: "難しく ↑", type: "button" });
      const selected = element(document2, "span", { className: "appamada-selected" });
      const easier = element(document2, "button", { text: "易しく ↓", type: "button" });
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
        text: "申請を送信",
        type: "button"
      });
      actions.append(submit);
      shell.content.append(statusContainer, actions);
      function selectLevel(level) {
        selectedLevel = level;
        update();
      }
      function update() {
        selected.textContent = `☸${selectedLevel}`;
        const harderLevel = getHarderLevel(selectedLevel);
        const easierLevel = getEasierLevel(selectedLevel);
        const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
        harder.disabled = busy || harderLevel === null;
        easier.disabled = busy || easierLevel === null;
        for (const button of [...specialButtons, ...normalButtons]) {
          button.setAttribute("aria-pressed", String(button.dataset.level === selectedLevel));
          button.disabled = busy;
        }
        const showNormalGrid = isSpecialLevel(chart.current_level) || isSpecialLevel(selectedLevel);
        normalHeading.hidden = !showNormalGrid;
        normalGrid.hidden = !showNormalGrid;
        submit.disabled = busy || selectedLevel === chart.current_level || codePointLength(comment.value) > 500;
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
        void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer });
      });
      update();
    }
    function renderNew() {
      const shell = modalShell("不放逸 新規譜面申請");
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
        text: "申請を送信",
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
        submit.disabled = busy || selectedLevel === null || codePointLength(comment.value) > 500;
      }
      submit.addEventListener("click", () => {
        if (submit.disabled) return;
        const payload = commonPayload("new", comment.value.normalize("NFC"));
        Object.assign(payload, {
          title: parsedPage.song.title,
          artist: parsedPage.song.artist,
          proposed_level: selectedLevel
        });
        void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer });
      });
      update();
    }
    async function openWorkflow(applicationType) {
      closeMenu();
      const shell = modalShell("不放逸 申請");
      shell.content.append(statusNode(document2, "登録状況を確認しています。"));
      try {
        const lookup = await apiClient.lookup(parsedPage.song.md5);
        if (!lookup.ok) {
          logger2?.debug?.("LOOKUP_FAILED", lookup.error.code);
          showMessage("申請できません", errorMessageFor(lookup.error.code));
          return;
        }
        if (applicationType === "change" && !lookup.exists) {
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
        else renderNew();
      } catch (error) {
        const code = error instanceof ApiClientError ? error.code : "INTERNAL_ERROR";
        logger2?.debug?.("LOOKUP_FAILED", code);
        showMessage("通信エラー", errorMessageFor(code));
      }
    }
    function showMenu(event) {
      if (event.shiftKey) return;
      event.preventDefault();
      closeMenu();
      const menu = element(document2, "div", { className: "appamada-menu" });
      menu.setAttribute("role", "menu");
      menu.append(element(document2, "div", { className: "appamada-menu-title", text: "☸ 不放逸" }));
      for (const [label, type] of [
        ["難易度変更申請", "change"],
        ["新規譜面申請", "new"]
      ]) {
        const button = element(document2, "button", { text: label, type: "button" });
        button.dataset.action = type;
        button.setAttribute("role", "menuitem");
        button.addEventListener("click", () => void openWorkflow(type));
        menu.append(button);
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
      destroy() {
        closeMenu();
        closeModal();
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
  var CLIENT_VERSION = "0.3.0";
  var DEBUG = false;
  var logger = createLogger({ debug: DEBUG });
  var parseResult = parseBmsirPage(document, location.href);
  if (!parseResult.ok) {
    logger.debug("PARSE_FAILED", parseResult.error);
  } else {
    try {
      const apiClient = createApiClient({
        apiUrl: "https://script.google.com/macros/s/AKfycbwNa1gz7heMGEGwVleNt6RVJuP9ykouI3dEqaP3auvl456HWb8-ZNEeb-VI_A-vaTyY/exec",
        gmRequest: GM_xmlhttpRequest
      });
      installSubmissionUi({
        document,
        window,
        parsedPage: parseResult,
        apiClient,
        clientVersion: CLIENT_VERSION,
        addStyle: typeof GM_addStyle === "function" ? GM_addStyle : void 0,
        logger
      });
    } catch (error) {
      logger.warn("SUBMISSION_INIT_FAILED", error?.code ?? "INTERNAL_ERROR");
    }
  }
})();
