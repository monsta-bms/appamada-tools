import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import { parseBmsirPage, resolveSongElements } from "../src/bmsir-parser.js";
import { ALLOWED_LEVELS } from "../src/levels.js";
import { errorMessageFor, installSubmissionUi } from "../src/ui.js";
import { ApiClientError } from "../src/api-client.js";
import { createOutbox, OFFLINE_NOTICE } from "../src/outbox.js";
import { memoryStorage } from "./helpers/outbox-storage.js";

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

function setup({ lookup, submit, html = legacyFixture, withOutbox = false, storage = memoryStorage() } = {}) {
  const dom = new JSDOM(html, { url: PAGE_URL, pretendToBeVisual: true });
  const parsedPage = parseBmsirPage(dom.window.document, PAGE_URL);
  let styleText = "";
  const apiClient = {
    lookup: lookup ?? (async () => ({ ok: true, exists: false })),
    submit: submit ?? (async () => ({ ok: true, request_id: UUID, deduplicated: false })),
  };
  const outbox = withOutbox ? createOutbox({ storage, apiClient,
    playerId: parsedPage.user.playerId, sleep: async () => {} }) : undefined;
  const ui = installSubmissionUi({
    document: dom.window.document,
    window: dom.window,
    parsedPage,
    apiClient,
    outbox,
    clientVersion: "0.4.7",
    cryptoObject: { randomUUID: () => UUID },
    addStyle(css) { styleText = css; },
  });
  return { dom, document: dom.window.document, ui, apiClient, styleText, outbox, storage };
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
  assert.match(
    state.document.querySelector(".appamada-modal").textContent,
    /卍0未満として不放逸から削除すべき譜面のみ申請してください。/,
  );
  assert.doesNotMatch(
    state.document.querySelector(".appamada-modal").textContent,
    /採用されると|管理者|kkj/,
  );
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

test("offline uses the same three forms, metadata, grids and exact notice; no POST on save", async () => {
  for (const type of ["change", "new", "delete"]) {
    let posts = 0;
    const state = setup({ withOutbox: true, html: currentFixture,
      lookup: async () => { throw new ApiClientError("API_TIMEOUT", "fixture"); },
      submit: async () => { posts++; },
    });
    await openWorkflow(state, type);
    const modal = state.document.querySelector(".appamada-modal");
    assert.equal(modal.getAttribute("role"), "dialog");
    assert.match(modal.textContent, /不放逸 .*申請/);
    assert.equal(modal.querySelector(".appamada-status").textContent, OFFLINE_NOTICE);
    assert.match(modal.textContent, /図書室のエルザ \[FOX\]/);
    if (type === "change") {
      for (const arrow of modal.querySelectorAll(".appamada-step button")) {
        assert.equal(arrow.disabled, true);
        assert.match(arrow.title, /選択できません/);
      }
      assert.equal(modal.querySelector(".appamada-selected").textContent, "選択してください");
      assert.equal([...modal.querySelectorAll(".appamada-level-grid")].at(-1).hidden, false);
    }
    if (type !== "delete") modal.querySelector('[data-level="13-"]').click();
    const submit = modal.querySelector(".appamada-submit");
    assert.equal(submit.textContent, "ブラウザに保存");
    assert.equal(submit.disabled, false);
    modal.querySelector("textarea").value = "fixture comment";
    submit.click();
    await flush();
    await flush();
    assert.equal(posts, 0);
    assert.equal(submit.textContent, "保存済み（送信待ち）");
    assert.equal(submit.disabled, true);
    assert.match(modal.textContent, /まだ送信完了していません/);
    const [entry] = await state.outbox.list();
    assert.equal(entry.payload.application_type, type);
    assert.equal(entry.payload.proposed_level, type === "delete" ? "削除" : "13-");
    assert.equal(entry.payload.comment, "fixture comment");
    assert.equal("current_level" in entry.payload, false);
    if (type !== "new") assert.equal("title" in entry.payload, false);
    else assert.match(entry.payload.artist, /Notes:キラ Illustration:かぜっと/);
    state.ui.destroy();
    state.dom.window.close();
  }
});

test("failed prefetch opens offline form immediately and unavailable storage cannot claim saved", async () => {
  let lookups = 0;
  const state = setup({ lookup: async () => { lookups++; return { ok: true, exists: false }; } });
  state.ui.markLookupUnavailable("API_NETWORK_ERROR");
  await openWorkflow(state, "new");
  assert.equal(lookups, 0);
  state.document.querySelector('[data-level="10"]').click();
  assert.equal(state.document.querySelector(".appamada-submit").disabled, true);
  assert.match(state.document.querySelector(".appamada-modal").textContent, /保存権限/);
  state.dom.window.close();
});

test("online timeout stores the unchanged payload and queue displays refusal without automatic type conversion", async () => {
  let timeout = true;
  const submitted = [];
  const state = setup({ withOutbox: true, submit: async (body) => {
    submitted.push(structuredClone(body));
    if (timeout) throw new ApiClientError("API_TIMEOUT", "fixture");
    return { ok: false, error: { code: "CHART_ALREADY_EXISTS" } };
  } });
  await openWorkflow(state, "new");
  state.document.querySelector('[data-level="10+"]').click();
  state.document.querySelector(".appamada-submit").click();
  await flush(); await flush();
  assert.equal((await state.outbox.list())[0].status, "pending");
  assert.match(state.document.querySelector(".appamada-modal").textContent, /まだ送信完了していません/);
  timeout = false;
  await state.outbox.send(UUID);
  await openWorkflow(state, "saved");
  assert.match(state.document.querySelector(".appamada-modal").textContent, /受付不可/);
  assert.match(state.document.querySelector(".appamada-modal").textContent, /すでに不放逸に登録/);
  assert.deepEqual(submitted[0], submitted[1]);
  assert.equal((await state.outbox.list())[0].payload.application_type, "new");
  state.ui.destroy(); state.dom.window.close();
});

test("storage save failure shows an error, keeps form retryable and never sends", async () => {
  const storage = memoryStorage();
  storage.set = async () => { throw new Error("quota"); };
  let posts = 0;
  const state = setup({ withOutbox: true, storage, submit: async () => { posts++; } });
  await openWorkflow(state, "new");
  state.document.querySelector('[data-level="10"]').click();
  state.document.querySelector(".appamada-submit").click();
  await flush();
  assert.equal(posts, 0);
  assert.match(state.document.querySelector(".appamada-status-error").textContent, /読み書きができません/);
  assert.equal(state.document.querySelector(".appamada-submit").disabled, false);
  state.dom.window.close();
});

test("closed lookup modal is not reopened by a late response", async () => {
  let finish;
  const state = setup({ lookup: () => new Promise((resolve) => { finish = resolve; }) });
  await openWorkflow(state, "new");
  state.ui.closeModal();
  finish({ ok: true, exists: false });
  await flush();
  assert.equal(state.document.querySelector(".appamada-overlay"), null);
  state.dom.window.close();
});
