import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import { parseBmsirPage, resolveSongElements } from "../src/bmsir-parser.js";
import { ALLOWED_LEVELS } from "../src/levels.js";
import { errorMessageFor, installSubmissionUi } from "../src/ui.js";

const MD5 = "b89279d026c9d40d0f5eedde2e25b920";
const PAGE_URL = `https://bms-ir.org/new/song?songmd5=${MD5}&view=new`;
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const legacyFixture = await readFile(
  new URL("./fixtures/logged-in-song.html", import.meta.url),
  "utf8",
);
const currentFixture = await readFile(
  new URL("./fixtures/logged-in-song-current.html", import.meta.url),
  "utf8",
);

function setup({ lookup, submit, html = legacyFixture } = {}) {
  const dom = new JSDOM(html, { url: PAGE_URL, pretendToBeVisual: true });
  const parsedPage = parseBmsirPage(dom.window.document, PAGE_URL);
  let styleText = "";
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
    addStyle(css) { styleText = css; },
  });
  return { dom, document: dom.window.document, ui, apiClient, styleText };
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
  contextMenu(state.dom, resolveSongElements(state.document).titleElement);
  state.document.querySelector(`.appamada-menu [data-action="${action}"]`).click();
  await flush();
}

test("submission kill switch has the required Japanese message", () => {
  assert.equal(
    errorMessageFor("SUBMISSIONS_DISABLED"),
    "現在、不放逸への申請受付を一時停止しています。",
  );
});

test("title and artist right-click open the custom menu", () => {
  for (const selector of ["#box > h1", "#box > h2"]) {
    const state = setup();
    const event = contextMenu(state.dom, state.document.querySelector(selector));
    assert.equal(event.defaultPrevented, true);
    assert.match(state.document.querySelector(".appamada-menu").textContent, /難易度変更申請/);
    assert.match(state.document.querySelector(".appamada-menu").textContent, /削除申請\(難易度が卍0未満\)/);
    state.dom.window.close();
  }
});

test("modal form colors override the current BMS-IR dark form defaults", () => {
  const state = setup({ html: currentFixture });
  assert.match(
    state.styleText,
    /\.appamada-close\{[^}]*background:#fff;[^}]*color:#222;[^}]*opacity:1;[^}]*-webkit-text-fill-color:#222;/,
  );
  assert.match(
    state.styleText,
    /\.appamada-comment textarea\{[^}]*border:1px solid #777;[^}]*background:#fff;[^}]*color:#222;[^}]*color-scheme:light;[^}]*opacity:1;[^}]*-webkit-text-fill-color:#222;/,
  );
  assert.doesNotMatch(state.styleText, /(^|})\s*(button|textarea)\s*\{/);
  state.dom.window.close();
});

test("current title and artist right-click open the custom menu", () => {
  for (const selector of ["#main-content > h1", "#main-content > h2"]) {
    const state = setup({ html: currentFixture });
    const event = contextMenu(state.dom, state.document.querySelector(selector));
    assert.equal(event.defaultPrevented, true);
    assert.equal(state.document.querySelectorAll(".appamada-menu").length, 1);
    state.dom.window.close();
  }
});

test("right-clicking title and artist child elements opens one menu", () => {
  for (const [selector, childTag] of [
    ["#main-content > h1", "span"],
    ["#main-content > h2", "a"],
  ]) {
    const state = setup({ html: currentFixture });
    const target = state.document.querySelector(selector);
    const child = state.document.createElement(childTag);
    child.textContent = target.textContent;
    target.replaceChildren(child);
    const event = contextMenu(state.dom, child);
    assert.equal(event.defaultPrevented, true);
    assert.equal(state.document.querySelectorAll(".appamada-menu").length, 1);
    state.dom.window.close();
  }
});

test("repeated contextmenu events never leave duplicate menus", () => {
  const state = setup({ html: currentFixture });
  const title = state.document.querySelector("#main-content > h1");
  contextMenu(state.dom, title);
  contextMenu(state.dom, title);
  assert.equal(state.document.querySelectorAll(".appamada-menu").length, 1);
  state.dom.window.close();
});

test("other elements do not open the menu", () => {
  const state = setup();
  const event = contextMenu(state.dom, state.document.querySelector("#box > p"));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.document.querySelector(".appamada-menu"), null);
  state.dom.window.close();
});

test("current page sections outside the song headings keep the native menu", () => {
  const state = setup({ html: currentFixture });
  const event = contextMenu(state.dom, state.document.querySelector(".song-section-tags h2"));
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

test("current title Shift+right-click preserves the native context menu", () => {
  const state = setup({ html: currentFixture });
  const event = contextMenu(state.dom, state.document.querySelector("#main-content > h1"), {
    shiftKey: true,
  });
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
  assert.equal(state.document.querySelector(".appamada-selected").textContent, "卍10+");
  assert.equal(submit.disabled, false);
  easier.click();
  assert.equal(state.document.querySelector(".appamada-selected").textContent, "卍10");
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
  assert.equal(levels.length, ALLOWED_LEVELS.length);
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

test("delete requires a registered chart and submits the fixed delete marker", async () => {
  let submitted;
  const state = setup({
    lookup: async () => ({
      ok: true,
      exists: true,
      chart: { title: "Server Title", artist: "Server Artist", current_level: "隔離" },
    }),
    submit: async (payload) => {
      submitted = payload;
      return { ok: true, request_id: UUID, deduplicated: false };
    },
  });
  await openWorkflow(state, "delete");
  assert.match(state.document.querySelector(".appamada-modal").textContent, /管理者の○反映時にkkjから譜面行が削除/);
  state.document.querySelector("textarea").value = "☸0未満のため";
  state.document.querySelector(".appamada-submit").click();
  await flush();
  assert.equal(submitted.application_type, "delete");
  assert.equal(submitted.proposed_level, "削除");
  assert.equal(submitted.comment, "☸0未満のため");
  assert.equal("title" in submitted, false);
  state.dom.window.close();

  const missing = setup({ lookup: async () => ({ ok: true, exists: false }) });
  await openWorkflow(missing, "delete");
  assert.match(missing.document.querySelector(".appamada-modal").textContent, /新規譜面申請を利用/);
  missing.dom.window.close();
});
