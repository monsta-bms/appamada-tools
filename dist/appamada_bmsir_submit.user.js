// ==UserScript==
// @name         不放逸 BMSIR申請
// @namespace    https://github.com/monsta-bms/appamada-tools
// @version      0.1.0
// @description  BMSIRから不放逸への譜面申請を補助します
// @match        https://bms-ir.org/new/song*
// @match        https://www.bms-ir.org/new/song*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/monsta-bms/appamada-tools/main/dist/appamada_bmsir_submit.user.js
// @downloadURL  https://raw.githubusercontent.com/monsta-bms/appamada-tools/main/dist/appamada_bmsir_submit.user.js
// ==/UserScript==

(() => {
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
  var MD5_PATTERN = /^[0-9a-f]{32}$/i;
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
  function directAnchors(element) {
    return Array.from(element.children).filter((child) => child.tagName === "A");
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
    if (urlMd5Values.length !== 1 || !MD5_PATTERN.test(urlMd5Values[0])) {
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
    const md5Matches = Array.from(document2.querySelectorAll("#box > p.muted")).flatMap((element) => {
      const match = MD5_INFO_PATTERN.exec(normalizeText(element.textContent));
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

  // src/main.js
  var DEBUG = false;
  var logger = createLogger({ debug: DEBUG });
  var parseResult = parseBmsirPage(document, location.href);
  if (!parseResult.ok) {
    logger.debug("PARSE_FAILED", parseResult.error);
  } else {
    const phase1State = Object.freeze({
      user: Object.freeze({ ...parseResult.user }),
      song: Object.freeze({ ...parseResult.song })
    });
    void phase1State;
    logger.debug("PARSE_READY");
  }
})();
