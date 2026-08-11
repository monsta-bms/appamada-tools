import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function normalizeEol(value) {
  return value.replace(/\r\n?/g, "\n");
}

test("built Userscript matches the frozen public bundle and passes smoke checks", async () => {
  assert.equal(normalizeEol("LF\nCRLF\r\nCR\r"), "LF\nCRLF\nCR\n");
  const [source, publicSource] = await Promise.all([
    readFile(builtDistUrl, "utf8"),
    readFile(publicDistUrl, "utf8"),
  ]);
  const normalizedSource = normalizeEol(source);
  const normalizedPublicSource = normalizeEol(publicSource);
  assert.equal(
    createHash("sha256").update(normalizedPublicSource).digest("hex"),
    "60f2554ee805f61cbb1a61c14bc080fb01a8d90bf7e531929b668cebEE032aa9".toLowerCase(),
  );
  assert.equal(normalizedSource, normalizedPublicSource);
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
      readFile(builtDistUrl, "utf8"),
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
