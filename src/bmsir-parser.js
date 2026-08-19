export const PARSER_ERRORS = Object.freeze({
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
  ARTIST_TOO_LONG: "ARTIST_TOO_LONG",
});

export const MD5_INFO_PATTERN =
  /^ranking_key:\s*([0-9a-f]{32})\s*\/\s*hash:\s*([0-9a-f]{32})(?:\s*\/|$)/i;

const MD5_PATTERN = /^[0-9a-f]{32}$/i;
const PLAYER_ID_PATTERN = /^\d{1,20}$/;
const SONG_HOSTNAMES = new Set(["bms-ir.org", "www.bms-ir.org"]);
const SONG_LAYOUTS = Object.freeze([
  Object.freeze({ name: "current", containerSelector: "#box > main#main-content" }),
  Object.freeze({ name: "legacy", containerSelector: "#box" }),
]);

export function normalizeText(value) {
  return String(value ?? "").trim().normalize("NFC");
}
export function codePointLength(value) {
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

function userAnchors(element) {
  return Array.from(element.querySelectorAll("a")).filter((anchor) => !anchor.closest("form"));
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

export function parseLoggedInUser(document, pageUrl) {
  const page = parseUrl(pageUrl);
  const userElements = document?.querySelectorAll?.("#user");

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
      playerId: profiles[0].url.searchParams.get("id"),
    },
  };
}

function directChildren(container, selector) {
  return Array.from(container.children).filter((child) => child.matches(selector));
}

function md5InfoElements(container) {
  return directChildren(container, "p.muted").filter((element) =>
    MD5_INFO_PATTERN.test(normalizeText(element.textContent)),
  );
}

function resolveLayout(document, layout) {
  const containers = document.querySelectorAll(layout.containerSelector);
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
    md5InfoElement: md5Elements[0],
  };
}

export function resolveSongElements(document) {
  if (!document?.querySelectorAll) {
    return failure(PARSER_ERRORS.SONG_DOM_INVALID);
  }

  const matches = SONG_LAYOUTS.flatMap((layout) => {
    const resolved = resolveLayout(document, layout);
    return resolved ? [resolved] : [];
  });
  if (matches.length !== 1) {
    return failure(PARSER_ERRORS.SONG_DOM_INVALID);
  }
  return { ok: true, ...matches[0] };
}

export function collectDomDiagnostics(document, pageUrl) {
  const page = parseUrl(pageUrl);
  const count = (selector) => document?.querySelectorAll?.(selector)?.length ?? 0;
  const matchingMd5Count = (selector) =>
    Array.from(document?.querySelectorAll?.(selector) ?? []).filter((element) =>
      MD5_INFO_PATTERN.test(normalizeText(element.textContent)),
    ).length;
  const users = Array.from(document?.querySelectorAll?.("#user") ?? []);
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
    legacyMd5InfoMatches: matchingMd5Count("#box > p.muted"),
  });
}

export function parseSong(document, pageUrl) {
  const page = parseUrl(pageUrl);
  if (
    !page ||
    page.protocol !== "https:" ||
    !SONG_HOSTNAMES.has(page.hostname) ||
    page.pathname !== "/new/song"
  ) {
    return failure(PARSER_ERRORS.NOT_SONG_PAGE);
  }

  const urlMd5Values = page.searchParams.getAll("songmd5");
  if (urlMd5Values.length !== 1 || !MD5_PATTERN.test(urlMd5Values[0])) {
    return failure(PARSER_ERRORS.MD5_INVALID);
  }

  const resolved = resolveSongElements(document);
  if (!resolved.ok) return resolved;
  const { titleElement, artistElement, md5InfoElement } = resolved;
  const md5Match = MD5_INFO_PATTERN.exec(normalizeText(md5InfoElement.textContent));

  const title = normalizeText(titleElement.textContent);
  if (!title) {
    return failure(PARSER_ERRORS.TITLE_REQUIRED);
  }
  if (codePointLength(title) > 1000) {
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
      irUrl: `https://bms-ir.org/new/song?songmd5=${md5}&view=new`,
    },
  };
}

export function parseBmsirPage(document, pageUrl) {
  const userResult = parseLoggedInUser(document, pageUrl);
  if (!userResult.ok) {
    return userResult;
  }

  const songResult = parseSong(document, pageUrl);
  if (!songResult.ok) {
    return songResult;
  }

  return {
    ok: true,
    user: userResult.user,
    song: songResult.song,
  };
}
