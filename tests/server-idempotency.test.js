import assert from "node:assert/strict";
import test from "node:test";
import { createAppsScriptHarness } from "./helpers/apps-script-harness.js";

const MD5 = "a".repeat(32), ID = "40000000-0000-4000-8000-000000000001";
const payload = (overrides = {}) => ({ application_type: "new", request_id: ID, md5: MD5,
  title: "Original title", artist: "Original artist / Notes:fixture", proposed_level: "10",
  comment: "=1+1", bmsir_user_name: "Fixture", bmsir_player_id: "123456",
  ir_url: `https://bms-ir.org/new/song?songmd5=${MD5}`, client_version: "0.4.7", ...overrides });

test("ScriptLock covers duplicate lookup through append, including an interleaved second request", async () => {
  let server, competing, entered = false;
  server = await createAppsScriptHarness({ hooks: { beforeWrite() {
    if (!entered) { entered = true; competing = server.post(payload()); }
  } } });
  assert.equal(server.post(payload()).deduplicated, false);
  assert.equal(competing.error.code, "LOCK_TIMEOUT");
  assert.equal(server.post(payload()).deduplicated, true);
  assert.equal(server.applications().length, 1);
  assert.equal(server.rawWrites.length, 1);
  assert.equal(server.lockState.held, false);
});

test("immutable acceptance fingerprint survives admin F/G edits and rejects every altered original field", async () => {
  const server = await createAppsScriptHarness();
  const original = payload();
  assert.equal(server.post(original).ok, true);
  const sheet = server.spreadsheet.getSheetByName("申請一覧");
  assert.match(sheet.getRange(2, 16).getNote(), /^appamada-request-v1:[a-f0-9]{64}$/);
  sheet.getRange(2, 6, 1, 2).setValues([["Admin corrected title", "Admin corrected artist"]]);
  assert.equal(server.post(original).deduplicated, true);
  for (const override of [{ title: "Admin corrected title" }, { artist: "Admin corrected artist" },
    { comment: "changed" }, { proposed_level: "11" }, { client_version: "0.4.8" },
    { bmsir_user_name: "other" }, { bmsir_player_id: "789" }]) {
    assert.equal(server.post(payload(override)).error.code, "REQUEST_ID_CONFLICT");
  }
  assert.equal(server.applications().length, 1);
  assert.deepEqual(server.applications()[0].slice(5, 7), ["Admin corrected title", "Admin corrected artist"]);
  assert.equal(server.applications()[0][10], "=1+1");
});

test("response/write-result loss after acceptance retries the same ID without a second row", async () => {
  let fail = true;
  const server = await createAppsScriptHarness({ hooks: { afterWrite() {
    if (fail) { fail = false; throw new Error("response lost after commit"); }
  } } });
  assert.equal(server.post(payload()).error.code, "WRITE_FAILED");
  assert.equal(server.applications().length, 1);
  assert.equal(server.post(payload()).deduplicated, true);
  assert.equal(server.applications().length, 1);
});

test("fingerprint persistence failure never accepts a row, and retry preserves pre-existing unrelated notes", async () => {
  let fail = true;
  const server = await createAppsScriptHarness({ hooks: { beforeNote() { if (fail) throw new Error("note unavailable"); } } });
  assert.equal(server.post(payload()).error.code, "WRITE_FAILED");
  assert.equal(server.applications().length, 0);
  fail = false;
  const cell = server.spreadsheet.getSheetByName("申請一覧").getRange(2, 16);
  cell.setNote("Admin note");
  assert.equal(server.post(payload()).ok, true);
  assert.match(cell.getNote(), /^Admin note\nappamada-request-v1:/);
  assert.equal(server.post(payload()).deduplicated, true);
});

test("legacy rows stay readable without backfill; unknown fingerprint versions fail closed", async () => {
  const server = await createAppsScriptHarness();
  assert.equal(server.post(payload()).ok, true);
  const cell = server.spreadsheet.getSheetByName("申請一覧").getRange(2, 16);
  cell.setNote("");
  assert.equal(server.post(payload()).deduplicated, true);
  assert.equal(cell.getNote(), "", "no automatic backfill from mutable row values");
  cell.setNote("appamada-request-v99:unknown");
  assert.equal(server.post(payload()).error.code, "REQUEST_ID_CONFLICT");
});
