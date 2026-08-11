import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const builtDistUrl = new URL(
  "../.local/appamada_bmsir_submit.public-check.user.js",
  import.meta.url,
);
const publicDistUrl = new URL("../dist/appamada_bmsir_submit.user.js", import.meta.url);
const fixtureUrl = new URL("./fixtures/", import.meta.url);
const pageUrl =
  "https://bms-ir.org/new/song?songmd5=b89279d026c9d40d0f5eedde2e25b920&view=new";
const checkApiUrl = "https://script.google.com/macros/s/BUILD_CHECK_PLACEHOLDER/exec";
const rawUrl =
  "https://raw.githubusercontent.com/monsta-bms/appamada-tools/main/dist/appamada_bmsir_submit.user.js";
const apiUrlPattern = /https:\/\/script\.google\.com\/macros\/s\/[^/"']+\/exec/;

function normalizeEol(value) {
  return value.replace(/\r\n?/g, "\n");
}

function assertReleaseMetadata(source) {
  assert.equal(source.startsWith("// ==UserScript=="), true);
  assert.match(source, /^\/\/ @name\s+不放逸 BMSIR申請$/m);
  assert.match(source, /^\/\/ @version\s+0\.3\.0$/m);
  assert.match(source, /^\/\/ @run-at\s+document-idle$/m);
  assert.match(source, /^\/\/ @noframes$/m);
  assert.match(source, /^\/\/ @updateURL\s+https:\/\/raw\.githubusercontent\.com\/monsta-bms\/appamada-tools\/main\/dist\/appamada_bmsir_submit\.user\.js$/m);
  assert.match(source, /^\/\/ @downloadURL\s+https:\/\/raw\.githubusercontent\.com\/monsta-bms\/appamada-tools\/main\/dist\/appamada_bmsir_submit\.user\.js$/m);
  assert.equal(source.includes(rawUrl), true);

  assert.deepEqual(source.match(/^\/\/ @match\s+.+$/gm), [
    "// @match        https://bms-ir.org/new/song*",
    "// @match        https://www.bms-ir.org/new/song*",
  ]);
  assert.deepEqual(source.match(/^\/\/ @grant\s+.+$/gm), [
    "// @grant        GM_xmlhttpRequest",
    "// @grant        GM_addStyle",
  ]);
  assert.deepEqual(source.match(/^\/\/ @connect\s+.+$/gm), [
    "// @connect      script.google.com",
    "// @connect      script.googleusercontent.com",
  ]);
}

test("production bundle has release metadata and differs from the check build only by API URL", async () => {
  const [builtSourceRaw, publicSourceRaw] = await Promise.all([
    readFile(builtDistUrl, "utf8"),
    readFile(publicDistUrl, "utf8"),
  ]);
  const builtSource = normalizeEol(builtSourceRaw);
  const publicSource = normalizeEol(publicSourceRaw);
  assertReleaseMetadata(builtSource);
  assertReleaseMetadata(publicSource);

  const builtApiUrl = builtSource.match(apiUrlPattern)?.[0];
  const publicApiUrl = publicSource.match(apiUrlPattern)?.[0];
  assert.equal(builtApiUrl, checkApiUrl);
  assert.ok(publicApiUrl);
  assert.notEqual(publicApiUrl, checkApiUrl);
  assert.doesNotMatch(publicApiUrl, /test|placeholder/i);
  assert.equal(
    builtSource.replaceAll(builtApiUrl, "__API_URL__"),
    publicSource.replaceAll(publicApiUrl, "__API_URL__"),
  );

  assert.doesNotMatch(publicSource, /sourceMappingURL/);
  assert.doesNotMatch(publicSource, /node:test|tests\/fixtures|dist-smoke/);
  assert.doesNotMatch(publicSource, /0\.2\.0-test|0\.3\.0-rc\.1|Production Candidate/);
  assert.doesNotThrow(() => new Function(publicSource));
});

test("production bundle initializes the logged-in UI without an API request", async () => {
  const [source, html] = await Promise.all([
    readFile(publicDistUrl, "utf8"),
    readFile(new URL("logged-in-song.html", fixtureUrl), "utf8"),
  ]);
  const virtualConsole = new VirtualConsole();
  const consoleErrors = [];
  virtualConsole.on("jsdomError", (error) => consoleErrors.push(error));
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only", virtualConsole });
  let requests = 0;
  let styles = 0;
  dom.window.GM_xmlhttpRequest = () => { requests += 1; };
  dom.window.GM_addStyle = () => { styles += 1; };

  assert.doesNotThrow(() => dom.window.eval(source));
  assert.equal(requests, 0);
  assert.equal(styles, 1);
  assert.deepEqual(consoleErrors, []);
  dom.window.close();
});

test("production bundle leaves a logged-out page untouched", async () => {
  const [source, html] = await Promise.all([
    readFile(publicDistUrl, "utf8"),
    readFile(new URL("logged-out-song.html", fixtureUrl), "utf8"),
  ]);
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only" });
  let externalCalls = 0;
  dom.window.GM_xmlhttpRequest = () => { externalCalls += 1; };
  dom.window.GM_addStyle = () => { externalCalls += 1; };
  const before = dom.serialize();

  assert.doesNotThrow(() => dom.window.eval(source));
  assert.equal(dom.serialize(), before);
  assert.equal(externalCalls, 0);
  dom.window.close();
});
