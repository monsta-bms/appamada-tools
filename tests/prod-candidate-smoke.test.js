import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const bundleUrl = new URL("../.local/appamada_bmsir_submit.prod-candidate.user.js", import.meta.url);
const fixtureUrl = new URL("./fixtures/logged-in-song-current.html", import.meta.url);
const pageUrl =
  "https://bms-ir.org/new/song?songmd5=b89279d026c9d40d0f5eedde2e25b920&view=new";

test("production candidate uses release metadata without public update URLs", async () => {
  const [source, html] = await Promise.all([readFile(bundleUrl, "utf8"), readFile(fixtureUrl, "utf8")]);
  assert.match(source, /^\/\/ @version\s+0\.4\.5-rc\.1$/m);
  assert.match(source, /^\/\/ @name\s+不放逸 BMSIR申請 \[Production Candidate\]$/m);
  assert.match(source, /^\/\/ @connect\s+script\.google\.com$/m);
  assert.match(source, /^\/\/ @connect\s+script\.googleusercontent\.com$/m);
  assert.doesNotMatch(source, /@updateURL|@downloadURL/);
  assert.match(source, /https:\/\/script\.google\.com\/macros\/s\/[^/"']+\/exec/);
  assert.doesNotThrow(() => new Function(source));

  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only", virtualConsole });
  let requests = 0;
  dom.window.GM_xmlhttpRequest = () => { requests += 1; };
  dom.window.GM_addStyle = () => {};
  assert.doesNotThrow(() => dom.window.eval(source));
  assert.equal(requests, 1);
  assert.deepEqual(errors, []);
  dom.window.close();
});
