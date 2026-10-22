import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createAppsScriptHarness } from "./helpers/apps-script-harness.js";

// Preserve the published 0.4.7 bundle as a fixture, replacing only its API URL
// with a dummy endpoint; its functional code is otherwise unchanged.
const legacyDistUrl = new URL("./fixtures/legacy/appamada_bmsir_submit-0.4.7.user.js", import.meta.url);
const fixtureUrl = new URL("./fixtures/logged-in-song-current.html", import.meta.url);
const md5 = "b89279d026c9d40d0f5eedde2e25b920";
const pageUrl = `https://bms-ir.org/new/song?songmd5=${md5}&view=new`;
const outboxPrefix = "appamada.outbox.v1.";

async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("published 0.4.7 keeps an unsigned submission pending when the new GAS endpoint disables it", async (t) => {
  const [source, html] = await Promise.all([
    readFile(legacyDistUrl, "utf8"),
    readFile(fixtureUrl, "utf8"),
  ]);
  assert.equal(source.match(/^\/\/ @version\s+([^\r\n]+)$/m)?.[1], "0.4.7");

  for (const storageApi of ["modern", "legacy"]) {
    await t.test(storageApi, async (t) => {
      const server = await createAppsScriptHarness();
      const values = new Map();
      const posted = [];
      const opened = [];
      let time = Date.now();
      t.after(() => { for (const dom of opened) dom.window.close(); });

      function page(offline) {
        const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only" });
        opened.push(dom);
        dom.window.Date.now = () => time;
        const get = (key) => values.has(key) ? structuredClone(values.get(key)) : undefined;
        const set = (key, value) => { values.set(key, structuredClone(value)); };
        const remove = (key) => { values.delete(key); };
        const keys = () => [...values.keys()];
        if (storageApi === "modern") {
          dom.window.GM = {
            getValue: async (key) => get(key),
            setValue: async (key, value) => { set(key, value); },
            deleteValue: async (key) => { remove(key); },
            listValues: async () => keys(),
          };
        } else {
          Object.assign(dom.window, {
            GM_getValue: get, GM_setValue: set,
            GM_deleteValue: remove, GM_listValues: keys,
          });
        }
        dom.window.GM_addStyle = () => {};
        // Intercept every request: neither the published URL nor any other
        // external endpoint is contacted by this compatibility test.
        dom.window.GM_xmlhttpRequest = (details) => {
          queueMicrotask(() => {
            if (offline) { details.onerror(); return; }
            let result;
            if (details.method === "POST") {
              const body = JSON.parse(details.data);
              result = server.postRaw(body);
              posted.push({ body, result });
            } else {
              const parameters = Object.fromEntries(new URL(details.url).searchParams);
              result = server.get(parameters);
            }
            details.onload({ status: 200, responseText: JSON.stringify(result) });
          });
        };
        dom.window.eval(source);
        return dom;
      }

      const first = page(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      first.window.document.querySelector("#main-content > h1").dispatchEvent(
        new first.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      first.window.document.querySelector('[data-action="change"]').click();
      await until(() => first.window.document.querySelector('[data-level="13-"]'),
        "published bundle did not open the offline submission form");
      assert.match(first.window.document.querySelector(".appamada-modal").textContent,
        /通信不具合中。現時点の難易度表データ取得できません/);
      first.window.document.querySelector('[data-level="13-"]').click();
      first.window.document.querySelector(".appamada-submit").click();
      await until(() => first.window.document.querySelector(".appamada-submit").textContent.includes("保存済み"),
        "published bundle did not save the offline submission");
      assert.equal(posted.length, 0);

      const entries = [...values.entries()].filter(([key]) => key.startsWith(`${outboxPrefix}entry.`));
      assert.equal(entries.length, 1);
      const [entryKey, saved] = structuredClone(entries[0]);
      const requestId = saved.payload.request_id;
      const stateKey = `${outboxPrefix}state.${requestId}`;
      const receiptKey = `${outboxPrefix}receipt.${requestId}`;
      assert.equal(saved.payload.client_version, "0.4.7");
      assert.equal(values.has(receiptKey), false);
      first.window.dispatchEvent(new first.window.Event("pagehide"));
      first.window.close();

      time += 30_001;
      const second = page(false);
      await until(() => posted.length > 0 && values.get(stateKey)?.errorCode,
        "published bundle did not finish handling the new GAS response");

      assert.equal(posted.length, 1);
      assert.equal(Object.hasOwn(posted[0].body, "gateway_version"), false);
      assert.equal(Object.hasOwn(posted[0].body, "signature"), false);
      assert.deepEqual(posted[0].body, saved.payload);
      assert.equal(posted[0].result.ok, false);
      assert.equal(posted[0].result.error.code, "SUBMISSIONS_DISABLED");
      const state = values.get(stateKey);
      assert.equal(state.status, "pending");
      assert.equal(state.errorCode, "SUBMISSIONS_DISABLED");
      assert.equal(state.attempts, 1);
      assert.ok(state.nextAttemptAt > time);
      assert.deepEqual(values.get(entryKey), saved);
      assert.equal(values.has(receiptKey), false);
      assert.equal([...values.keys()].some((key) => key.startsWith(`${outboxPrefix}receipt.`)), false);
      assert.equal(server.applications().length, 0);
      assert.equal(server.rawWrites.length, 0);
      second.window.dispatchEvent(new second.window.Event("pagehide"));
      second.window.close();
    });
  }
});
