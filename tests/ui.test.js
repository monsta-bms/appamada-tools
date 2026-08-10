import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import { parseBmsirPage } from "../src/bmsir-parser.js";
import { installSubmissionUi } from "../src/ui.js";

const MD5 = "b89279d026c9d40d0f5eedde2e25b920";
const PAGE_URL = `https://bms-ir.org/new/song?songmd5=${MD5}&view=new`;
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const fixture = await readFile(new URL("./fixtures/logged-in-song.html", import.meta.url), "utf8");

function setup({ lookup, submit } = {}) {
  const dom = new JSDOM(fixture, { url: PAGE_URL, pretendToBeVisual: true });
  const parsedPage = parseBmsirPage(dom.window.document, PAGE_URL);
  const apiClient = {
    lookup: lookup ?? (async () => ({ ok: true, exists: false })),
    submit: submit ?? (async () => ({ ok: true, request_id: UUID, deduplicated: false })),
  };
  const ui = installSubmissionUi({
    document: dom.window.document,
    window: dom.window,
    parsedPage,
    apiClient,
    cryptoObject: { randomUUID: () => UUID },
    addStyle() {},
  });
  return { dom, document: dom.window.document, ui, apiClient };
}

function contextMenu(dom, target, options = {}) {
  const event = new dom.window.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 120,
    clientY: 80,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function openWorkflow(state, action) {
  contextMenu(state.dom, state.document.querySelector("#box > h1"));
  state.document.querySelector(`.appamada-menu [data-action="${action}"]`).click();
  await flush();
}

test("title and artist right-click open the custom menu", () => {
  for (const selector of ["#box > h1", "#box > h2"]) {
    const state = setup();
    const event = contextMenu(state.dom, state.document.querySelector(selector));
    assert.equal(event.defaultPrevented, true);
    assert.match(state.document.querySelector(".appamada-menu").textContent, /難易度変更申請/);
    state.dom.window.close();
  }
});

test("other elements do not open the menu", () => {
  const state = setup();
  const event = contextMenu(state.dom, state.document.querySelector("#box > p"));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.document.querySelector(".appamada-menu"), null);
  state.dom.window.close();
});

test("Shift+right-click preserves the native context menu", () => {
  const state = setup();
  const event = contextMenu(state.dom, state.document.querySelector("#box > h1"), { shiftKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.document.querySelector(".appamada-menu"), null);
  state.dom.window.close();
});

test("Escape and outside click close the menu", () => {
  const state = setup();
  contextMenu(state.dom, state.document.querySelector("#box > h1"));
  state.document.dispatchEvent(new state.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(state.document.querySelector(".appamada-menu"), null);
  contextMenu(state.dom, state.document.querySelector("#box > h1"));
  state.document.body.click();
  assert.equal(state.document.querySelector(".appamada-menu"), null);
  state.dom.window.close();
});

test("change on a missing chart shows the new-application guidance", async () => {
  const state = setup({ lookup: async () => ({ ok: true, exists: false }) });
  await openWorkflow(state, "change");
  assert.match(state.document.querySelector(".appamada-modal").textContent, /新規譜面申請を利用/);
  state.dom.window.close();
});

test("new on an existing chart shows the change guidance", async () => {
  const state = setup({
    lookup: async () => ({
      ok: true,
      exists: true,
      chart: { title: "Title", artist: "Artist", current_level: "10" },
    }),
  });
  await openWorkflow(state, "new");
  assert.match(state.document.querySelector(".appamada-modal").textContent, /難易度変更申請を利用/);
  state.dom.window.close();
});

test("change arrows use STEP_LEVELS and enforce boundaries", async () => {
  const state = setup({
    lookup: async () => ({
      ok: true,
      exists: true,
      chart: { title: "Title", artist: "Artist", current_level: "10" },
    }),
  });
  await openWorkflow(state, "change");
  const [harder, easier] = state.document.querySelectorAll(".appamada-step button");
  const submit = state.document.querySelector(".appamada-submit");
  assert.equal(submit.disabled, true);
  harder.click();
  assert.equal(state.document.querySelector(".appamada-selected").textContent, "☸10+");
  assert.equal(submit.disabled, false);
  easier.click();
  assert.equal(state.document.querySelector(".appamada-selected").textContent, "☸10");
  assert.equal(submit.disabled, true);
  state.dom.window.close();

  const boundary = setup({
    lookup: async () => ({
      ok: true,
      exists: true,
      chart: { title: "Title", artist: "Artist", current_level: "16" },
    }),
  });
  await openWorkflow(boundary, "change");
  assert.equal(boundary.document.querySelector(".appamada-step button").disabled, true);
  boundary.dom.window.close();
});

test("special levels are directly selectable and reveal the normal grid", async () => {
  const state = setup({
    lookup: async () => ({
      ok: true,
      exists: true,
      chart: { title: "Title", artist: "Artist", current_level: "10" },
    }),
  });
  await openWorkflow(state, "change");
  const special = state.document.querySelector('.appamada-level-grid [data-level="★★4?"]');
  special.click();
  assert.equal(special.getAttribute("aria-pressed"), "true");
  assert.equal(state.document.querySelector('.appamada-level-grid [data-level="0"]').parentElement.hidden, false);
  state.dom.window.close();
});

test("new modal renders every level and requires selection before submit", async () => {
  const state = setup({ lookup: async () => ({ ok: true, exists: false }) });
  await openWorkflow(state, "new");
  const levels = state.document.querySelectorAll(".appamada-level-grid [data-level]");
  const submit = state.document.querySelector(".appamada-submit");
  assert.equal(levels.length, 29);
  assert.equal(submit.disabled, true);
  state.document.querySelector('[data-level="10+"]').click();
  assert.equal(submit.disabled, false);
  assert.equal(state.document.querySelector(".appamada-status"), null);
  state.dom.window.close();
});

test("comment uses Unicode code points and disables over 500", async () => {
  const state = setup({ lookup: async () => ({ ok: true, exists: false }) });
  await openWorkflow(state, "new");
  state.document.querySelector('[data-level="10+"]').click();
  const textarea = state.document.querySelector("textarea");
  const submit = state.document.querySelector(".appamada-submit");
  textarea.value = "😀".repeat(500);
  textarea.dispatchEvent(new state.dom.window.Event("input", { bubbles: true }));
  assert.equal(submit.disabled, false);
  textarea.value += "😀";
  textarea.dispatchEvent(new state.dom.window.Event("input", { bubbles: true }));
  assert.equal(submit.disabled, true);
  assert.equal(state.document.querySelector(".appamada-count").textContent, "501 / 500");
  state.dom.window.close();
});

test("loading prevents double submit and generates one request_id", async () => {
  const payloads = [];
  let release;
  const state = setup({
    lookup: async () => ({ ok: true, exists: false }),
    submit: (payload) => {
      payloads.push(payload);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await openWorkflow(state, "new");
  state.document.querySelector('[data-level="10+"]').click();
  const submit = state.document.querySelector(".appamada-submit");
  submit.click();
  submit.click();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].request_id, UUID);
  assert.equal(submit.disabled, true);
  assert.equal(submit.textContent, "送信中…");
  release({ ok: true, request_id: UUID, deduplicated: false });
  await flush();
  assert.match(state.document.querySelector(".appamada-status").textContent, /送信しました/);
  state.dom.window.close();
});

test("change payload excludes title, artist, and current level", async () => {
  let submitted;
  const state = setup({
    lookup: async () => ({
      ok: true,
      exists: true,
      chart: { title: "Server Title", artist: "Server Artist", current_level: "10" },
    }),
    submit: async (payload) => {
      submitted = payload;
      return { ok: true, request_id: UUID, deduplicated: false };
    },
  });
  await openWorkflow(state, "change");
  state.document.querySelector(".appamada-step button").click();
  state.document.querySelector(".appamada-submit").click();
  await flush();
  assert.equal(submitted.application_type, "change");
  assert.equal("title" in submitted, false);
  assert.equal("artist" in submitted, false);
  assert.equal("current_level" in submitted, false);
  state.dom.window.close();
});
