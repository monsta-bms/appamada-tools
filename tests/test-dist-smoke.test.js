import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const distUrl = new URL("../.local/appamada_bmsir_submit.test.user.js", import.meta.url);
const fixtureUrl = new URL("./fixtures/logged-in-song.html", import.meta.url);
const expectedApiUrl =
  process.env.APPAMADA_API_URL ??
  "https://script.google.com/macros/s/test-deployment/exec";
const pageUrl =
  "https://bms-ir.org/new/song?songmd5=b89279d026c9d40d0f5eedde2e25b920&view=new";

test("Phase 2 test bundle has isolated metadata and starts without a request", async () => {
  const [source, html] = await Promise.all([readFile(distUrl, "utf8"), readFile(fixtureUrl, "utf8")]);
  assert.equal(source.startsWith("// ==UserScript=="), true);
  assert.match(source, /^\/\/ @version\s+0\.2\.0-test$/m);
  assert.match(source, /^\/\/ @connect\s+script\.google\.com$/m);
  assert.match(source, /^\/\/ @connect\s+script\.googleusercontent\.com$/m);
  assert.doesNotMatch(source, /@updateURL|@downloadURL/);
  assert.equal(source.includes(expectedApiUrl), true);
  assert.doesNotThrow(() => new Function(source));

  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only", virtualConsole });
  let requests = 0;
  dom.window.GM_xmlhttpRequest = () => {
    requests += 1;
  };
  dom.window.GM_addStyle = () => {};
  assert.doesNotThrow(() => dom.window.eval(source));
  assert.equal(requests, 0);
  assert.deepEqual(errors, []);
  dom.window.close();
});
