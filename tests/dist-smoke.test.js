import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const distUrl = new URL("../dist/appamada_bmsir_submit.user.js", import.meta.url);
const fixtureUrl = new URL("./fixtures/", import.meta.url);
const pageUrl =
  "https://bms-ir.org/new/song?songmd5=b89279d026c9d40d0f5eedde2e25b920&view=new";

test("built Userscript metadata and bundle pass smoke checks", async () => {
  const source = await readFile(distUrl, "utf8");
  assert.equal(source.startsWith("// ==UserScript=="), true);
  assert.match(source, /^\/\/ @version\s+0\.1\.0$/m);
  assert.match(source, /^\/\/ @run-at\s+document-idle$/m);
  assert.match(source, /^\/\/ @noframes$/m);

  const matches = source.match(/^\/\/ @match\s+.+$/gm);
  assert.deepEqual(matches, [
    "// @match        https://bms-ir.org/new/song*",
    "// @match        https://www.bms-ir.org/new/song*",
  ]);

  assert.doesNotMatch(source, /sourceMappingURL/);
  assert.doesNotMatch(source, /node:test|tests\/fixtures|dist-smoke/);
  assert.doesNotThrow(() => new Function(source));
});

for (const fixtureName of ["logged-in-song.html", "logged-out-song.html"]) {
  test(`built Userscript runs without side effects on ${fixtureName}`, async () => {
    const [source, html] = await Promise.all([
      readFile(distUrl, "utf8"),
      readFile(new URL(fixtureName, fixtureUrl), "utf8"),
    ]);
    const virtualConsole = new VirtualConsole();
    const consoleErrors = [];
    virtualConsole.on("jsdomError", (error) => consoleErrors.push(error));

    const dom = new JSDOM(html, {
      url: pageUrl,
      runScripts: "outside-only",
      virtualConsole,
    });
    let externalCalls = 0;
    dom.window.fetch = () => {
      externalCalls += 1;
      throw new Error("Unexpected fetch");
    };
    dom.window.GM_xmlhttpRequest = () => {
      externalCalls += 1;
      throw new Error("Unexpected GM_xmlhttpRequest");
    };
    dom.window.GM_addStyle = () => {
      externalCalls += 1;
      throw new Error("Unexpected GM_addStyle");
    };

    const before = dom.serialize();
    assert.doesNotThrow(() => dom.window.eval(source));
    assert.equal(dom.serialize(), before);
    assert.equal(externalCalls, 0);
    assert.deepEqual(consoleErrors, []);
    dom.window.close();
  });
}
