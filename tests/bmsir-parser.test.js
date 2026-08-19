import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  PARSER_ERRORS,
  collectDomDiagnostics,
  codePointLength,
  normalizeText,
  parseBmsirPage,
  parseLoggedInUser,
  parseSong,
  resolveSongElements,
} from "../src/bmsir-parser.js";

const MD5 = "b89279d026c9d40d0f5eedde2e25b920";
const PAGE_URL = `https://bms-ir.org/new/song?songmd5=${MD5}&view=new`;
const EXPECTED_ARTIST = "橘花音 かなえゆめ composed by nmk / Notes:キラ Illustration:かぜっと";

const fixtureCache = new Map();

async function fixture(name) {
  if (!fixtureCache.has(name)) {
    fixtureCache.set(name, await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  }
  return fixtureCache.get(name);
}

async function documentFrom(name) {
  return new JSDOM(await fixture(name), { url: PAGE_URL }).window.document;
}

function expectError(result, error) {
  assert.deepEqual(result, { ok: false, error });
}

test("normalizeText trims and NFC-normalizes without collapsing internal spaces", () => {
  assert.equal(normalizeText("  Cafe\u0301  two  spaces  "), "Café  two  spaces");
  assert.equal(codePointLength("A😀"), 2);
});
test("logged-in fixture parses the anonymized user", async () => {
  const result = parseLoggedInUser(await documentFrom("logged-in-song.html"), PAGE_URL);
  assert.deepEqual(result, { ok: true, user: { name: "FixtureUser", playerId: "123456" } });
});

test("current logged-in fixture parses the anonymized user and song", async () => {
  const document = await documentFrom("logged-in-song-current.html");
  assert.deepEqual(parseLoggedInUser(document, PAGE_URL), {
    ok: true,
    user: { name: "FixtureUser", playerId: "123456" },
  });
  assert.equal(resolveSongElements(document).layout, "current");
  const result = parseSong(document, PAGE_URL);
  assert.equal(result.ok, true);
  assert.equal(result.song.title, "図書室のエルザ [FOX]");
  assert.equal(result.song.artist, EXPECTED_ARTIST);
  assert.equal(result.song.md5, MD5);
});

test("current logged-out fixture keeps song parsing separate from login state", async () => {
  const document = await documentFrom("logged-out-song-current.html");
  expectError(parseLoggedInUser(document, PAGE_URL), PARSER_ERRORS.NOT_LOGGED_IN);
  assert.equal(parseSong(document, PAGE_URL).ok, true);
  expectError(parseBmsirPage(document, PAGE_URL), PARSER_ERRORS.NOT_LOGGED_IN);
});

test("notification counts do not affect login parsing", async () => {
  for (const count of [0, 5, 999]) {
    const document = await documentFrom("logged-in-song.html");
    document.querySelector("#user > .notification-badge").textContent = `通知(${count})`;
    assert.equal(parseLoggedInUser(document, PAGE_URL).ok, true);
  }
});

test("client-view and language forms do not affect login parsing", async () => {
  const document = await documentFrom("logged-in-song.html");
  assert.ok(document.querySelector("#user > form.client-view-switch"));
  assert.ok(document.querySelector("#user > form.language-switch"));
  assert.equal(parseLoggedInUser(document, PAGE_URL).ok, true);
});

test("links nested in forms are ignored", async () => {
  const document = await documentFrom("logged-in-song.html");
  const nestedLogin = document.createElement("a");
  nestedLogin.href = "/login";
  document.querySelector("#user > form").append(nestedLogin);
  assert.equal(parseLoggedInUser(document, PAGE_URL).ok, true);
});

test("profile and logout links may be wrapped inside the user region", async () => {
  const document = await documentFrom("logged-in-song.html");
  const user = document.querySelector("#user");
  const wrapper = document.createElement("span");
  wrapper.className = "account-links";
  for (const anchor of [...user.querySelectorAll(":scope > a")]) wrapper.append(anchor);
  user.prepend(wrapper);
  assert.deepEqual(parseLoggedInUser(document, PAGE_URL), {
    ok: true,
    user: { name: "FixtureUser", playerId: "123456" },
  });
});

test("a direct /login anchor reports NOT_LOGGED_IN", async () => {
  const document = await documentFrom("logged-out-song.html");
  expectError(parseLoggedInUser(document, PAGE_URL), PARSER_ERRORS.NOT_LOGGED_IN);
});

test("missing /logout reports USER_DOM_INVALID", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector('#user > a[href="/logout"]').remove();
  expectError(parseLoggedInUser(document, PAGE_URL), PARSER_ERRORS.USER_DOM_INVALID);
});

test("zero profile links reports USER_DOM_INVALID", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector('#user > a[href^="/new/player"]').remove();
  expectError(parseLoggedInUser(document, PAGE_URL), PARSER_ERRORS.USER_DOM_INVALID);
});

test("two profile links reports USER_DOM_INVALID", async () => {
  const document = await documentFrom("logged-in-song.html");
  const profile = document.querySelector('#user > a[href^="/new/player"]');
  profile.after(profile.cloneNode(true));
  expectError(parseLoggedInUser(document, PAGE_URL), PARSER_ERRORS.USER_DOM_INVALID);
});

test("an empty profile name reports LOGIN_NAME_MISSING", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector('#user > a[href^="/new/player"]').textContent = "   ";
  expectError(parseLoggedInUser(document, PAGE_URL), PARSER_ERRORS.LOGIN_NAME_MISSING);
});

test("profile IDs must contain 1 to 20 decimal digits", async () => {
  for (const id of ["", "abc", "1".repeat(21)]) {
    const document = await documentFrom("logged-in-song.html");
    document.querySelector('#user > a[href^="/new/player"]').href = `/new/player?id=${id}`;
    expectError(parseLoggedInUser(document, PAGE_URL), PARSER_ERRORS.USER_DOM_INVALID);
  }
});

test("the normal song fixture parses exactly and builds a canonical URL", async () => {
  const result = parseSong(await documentFrom("logged-in-song.html"), `${PAGE_URL}&extra=ignored`);
  assert.deepEqual(result, {
    ok: true,
    song: {
      md5: MD5,
      title: "図書室のエルザ [FOX]",
      artist: EXPECTED_ARTIST,
      irUrl: PAGE_URL,
    },
  });
});

test("URL, ranking_key, and hash comparison is case-insensitive", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector("#box > p.muted").firstChild.textContent =
    `ranking_key: ${MD5.toUpperCase()} / hash: ${MD5.toUpperCase()} / `;
  assert.equal(parseSong(document, PAGE_URL.replace(MD5, MD5.toUpperCase())).ok, true);
});

test("a ranking_key mismatch reports MD5_MISMATCH", async () => {
  const document = await documentFrom("md5-mismatch.html");
  expectError(parseSong(document, PAGE_URL), PARSER_ERRORS.MD5_MISMATCH);
});

test("a hash mismatch reports MD5_MISMATCH", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector("#box > p.muted").firstChild.textContent =
    `ranking_key: ${MD5} / hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa / `;
  expectError(parseSong(document, PAGE_URL), PARSER_ERRORS.MD5_MISMATCH);
});

test("a URL MD5 mismatch reports MD5_MISMATCH", async () => {
  const document = await documentFrom("logged-in-song.html");
  expectError(
    parseSong(document, PAGE_URL.replace(MD5, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
    PARSER_ERRORS.MD5_MISMATCH,
  );
});

test("missing, duplicate, or malformed songmd5 reports MD5_INVALID", async () => {
  const document = await documentFrom("logged-in-song.html");
  for (const url of [
    "https://bms-ir.org/new/song?view=new",
    `${PAGE_URL}&songmd5=${MD5}`,
    "https://bms-ir.org/new/song?songmd5=not-32-hex",
  ]) {
    expectError(parseSong(document, url), PARSER_ERRORS.MD5_INVALID);
  }
});

test("non-song origins, protocols, and paths report NOT_SONG_PAGE", async () => {
  const document = await documentFrom("logged-in-song.html");
  for (const url of [
    PAGE_URL.replace("https:", "http:"),
    PAGE_URL.replace("bms-ir.org", "example.com"),
    PAGE_URL.replace("/new/song", "/new/player"),
  ]) {
    expectError(parseSong(document, url), PARSER_ERRORS.NOT_SONG_PAGE);
  }
});

test("missing or duplicate #box > h1 reports SONG_DOM_INVALID", async () => {
  const missing = await documentFrom("logged-in-song.html");
  missing.querySelector("#box > h1").remove();
  expectError(parseSong(missing, PAGE_URL), PARSER_ERRORS.SONG_DOM_INVALID);

  const duplicate = await documentFrom("logged-in-song.html");
  const h1 = duplicate.querySelector("#box > h1");
  h1.after(h1.cloneNode(true));
  expectError(parseSong(duplicate, PAGE_URL), PARSER_ERRORS.SONG_DOM_INVALID);
});

test("title and artist remain related without requiring immediate adjacency", async () => {
  assert.equal(parseSong(await documentFrom("malformed-song.html"), PAGE_URL).ok, true);
});

test("current layout rejects ambiguous direct title or artist candidates", async () => {
  const duplicateTitle = await documentFrom("logged-in-song-current.html");
  const title = duplicateTitle.querySelector("#main-content > h1");
  title.after(title.cloneNode(true));
  expectError(parseSong(duplicateTitle, PAGE_URL), PARSER_ERRORS.SONG_DOM_INVALID);

  const duplicateArtist = await documentFrom("logged-in-song-current.html");
  const artist = duplicateArtist.querySelector("#main-content > h2");
  artist.after(artist.cloneNode(true));
  expectError(parseSong(duplicateArtist, PAGE_URL), PARSER_ERRORS.SONG_DOM_INVALID);
});

test("current layout keeps URL, ranking_key, and hash three-way validation", async () => {
  const document = await documentFrom("logged-in-song-current.html");
  const md5Info = [...document.querySelectorAll("#main-content > p.muted")].find((element) =>
    element.textContent.includes("ranking_key:"),
  );
  md5Info.firstChild.textContent =
    `ranking_key: ${MD5} / hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa / `;
  expectError(parseSong(document, PAGE_URL), PARSER_ERRORS.MD5_MISMATCH);
});

test("DOM diagnostics expose counts and path without user or song text", async () => {
  const document = await documentFrom("logged-in-song-current.html");
  const diagnostic = collectDomDiagnostics(document, PAGE_URL);
  assert.deepEqual(diagnostic, {
    pathname: "/new/song",
    userMatches: 1,
    profileMatches: 1,
    logoutMatches: 1,
    currentContainerMatches: 1,
    currentTitleMatches: 1,
    currentArtistMatches: 1,
    currentMd5InfoMatches: 1,
    legacyTitleMatches: 0,
    legacyArtistMatches: 0,
    legacyMd5InfoMatches: 0,
  });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /FixtureUser|図書室|b89279/i);
});

test("zero or multiple matching MD5 paragraphs reports SONG_DOM_INVALID", async () => {
  const missing = await documentFrom("logged-in-song.html");
  missing.querySelector("#box > p.muted").remove();
  expectError(parseSong(missing, PAGE_URL), PARSER_ERRORS.SONG_DOM_INVALID);

  const duplicate = await documentFrom("logged-in-song.html");
  const paragraph = duplicate.querySelector("#box > p.muted");
  paragraph.after(paragraph.cloneNode(true));
  expectError(parseSong(duplicate, PAGE_URL), PARSER_ERRORS.SONG_DOM_INVALID);
});

test("an empty title reports TITLE_REQUIRED", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector("#box > h1").textContent = "  ";
  expectError(parseSong(document, PAGE_URL), PARSER_ERRORS.TITLE_REQUIRED);
});

test("an empty artist reports ARTIST_REQUIRED", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector("#box > h2").textContent = "  ";
  expectError(parseSong(document, PAGE_URL), PARSER_ERRORS.ARTIST_REQUIRED);
});

test("1001-code-point titles report TITLE_TOO_LONG", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector("#box > h1").textContent = "😀".repeat(1001);
  expectError(parseSong(document, PAGE_URL), PARSER_ERRORS.TITLE_TOO_LONG);
});

test("501-code-point artists report ARTIST_TOO_LONG", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector("#box > h2").textContent = "😀".repeat(501);
  expectError(parseSong(document, PAGE_URL), PARSER_ERRORS.ARTIST_TOO_LONG);
});

test("internal whitespace and Notes/Illustration text are preserved", async () => {
  const document = await documentFrom("logged-in-song.html");
  const artist = "ビタミンc  obj:IBARAGI / Notes:キラ Illustration:かぜっと";
  document.querySelector("#box > h2").textContent = `  ${artist}  `;
  assert.equal(parseSong(document, PAGE_URL).song.artist, artist);
});

test("title and artist are NFC-normalized", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector("#box > h1").textContent = "Cafe\u0301";
  document.querySelector("#box > h2").textContent = "Ame\u0301lie";
  const result = parseSong(document, PAGE_URL);
  assert.equal(result.song.title, "Café");
  assert.equal(result.song.artist, "Amélie");
});

test("HTML entities are decoded through textContent", async () => {
  const document = await documentFrom("logged-in-song.html");
  document.querySelector("#box > h1").innerHTML = "A &amp; B";
  assert.equal(parseSong(document, PAGE_URL).song.title, "A & B");
});

test("parseBmsirPage returns user and song on success", async () => {
  const result = parseBmsirPage(await documentFrom("logged-in-song.html"), PAGE_URL);
  assert.equal(result.ok, true);
  assert.equal(result.user.playerId, "123456");
  assert.equal(result.song.md5, MD5);
});

test("parseBmsirPage returns the user error before parsing the song", async () => {
  expectError(
    parseBmsirPage(await documentFrom("logged-out-song.html"), PAGE_URL),
    PARSER_ERRORS.NOT_LOGGED_IN,
  );
});
