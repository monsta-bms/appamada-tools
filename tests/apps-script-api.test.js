import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  APPLICATION_HEADERS,
  createAppsScriptHarness,
} from "./helpers/apps-script-harness.js";

const EXISTING_MD5 = "b89279d026c9d40d0f5eedde2e25b920";
const NEW_MD5 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const KJJ_ROW = ["10", "Server Title", "Server Artist", EXISTING_MD5, "https://example.com/"];

function changePayload(overrides = {}) {
  return {
    application_type: "change",
    request_id: UUID,
    md5: EXISTING_MD5,
    proposed_level: "10+",
    comment: "change comment",
    bmsir_user_name: "FixtureUser",
    bmsir_player_id: "123456",
    ir_url: `https://bms-ir.org/new/song?songmd5=${EXISTING_MD5}&view=new`,
    client_version: "0.2.0-test",
    ...overrides,
  };
}

function newPayload(overrides = {}) {
  return {
    application_type: "new",
    request_id: UUID,
    md5: NEW_MD5,
    title: "New Title",
    artist: "New Artist",
    proposed_level: "10+",
    comment: "new comment",
    bmsir_user_name: "FixtureUser",
    bmsir_player_id: "123456",
    ir_url: `https://bms-ir.org/new/song?songmd5=${NEW_MD5}&view=new`,
    client_version: "0.2.0-test",
    ...overrides,
  };
}

function deletePayload(overrides = {}) {
  return {
    ...changePayload(),
    application_type: "delete",
    proposed_level: "削除",
    comment: "☸0未満のため削除希望",
    ...overrides,
  };
}

function uniqueUuid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

test("Apps Script manifest enables only Sheets v4 with anonymous deployer webapp", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../apps-script/api/appsscript.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.timeZone, "Asia/Tokyo");
  assert.equal(manifest.runtimeVersion, "V8");
  assert.equal(manifest.exceptionLogging, "STACKDRIVER");
  assert.deepEqual(manifest.oauthScopes, ["https://www.googleapis.com/auth/spreadsheets"]);
  assert.deepEqual(manifest.webapp, {
    access: "ANYONE_ANONYMOUS",
    executeAs: "USER_DEPLOYING",
  });
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [
    { userSymbol: "Sheets", serviceId: "sheets", version: "v4" },
  ]);
});

test("lookup distinguishes registered and missing MD5 values", async () => {
  const harness = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  assert.deepEqual(harness.get({ action: "lookup", md5: EXISTING_MD5 }), {
    ok: true,
    exists: true,
    chart: { current_level: "10", title: "Server Title", artist: "Server Artist" },
  });
  assert.deepEqual(harness.get({ action: "lookup", md5: NEW_MD5 }), {
    ok: true,
    exists: false,
  });
});

test("submit defaults closed while lookup remains available", async () => {
  for (const setting of [null, "false"]) {
    const harness = await createAppsScriptHarness({
      kkjRows: [KJJ_ROW],
      properties: { SUBMIT_ENABLED: setting },
    });
    assert.equal(harness.get({ action: "lookup", md5: EXISTING_MD5 }).ok, true);
    assert.equal(harness.post(changePayload()).error.code, "SUBMISSIONS_DISABLED");
    assert.equal(harness.applications().length, 0);
    assert.equal(harness.lockState.released, false);
  }
});

test("lookup rejects malformed MD5 and unknown query shapes", async () => {
  const harness = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  assert.equal(harness.get({ action: "lookup", md5: "bad" }).error.code, "MD5_INVALID");
  assert.equal(harness.get({ action: "unknown", md5: EXISTING_MD5 }).error.code, "BAD_REQUEST");
  assert.equal(
    harness.get({ action: "lookup", md5: [EXISTING_MD5, NEW_MD5] }).error.code,
    "BAD_REQUEST",
  );
});

test("lookup detects duplicate chart MD5 values", async () => {
  const harness = await createAppsScriptHarness({ kkjRows: [KJJ_ROW, KJJ_ROW] });
  assert.equal(harness.get({ action: "lookup", md5: EXISTING_MD5 }).error.code, "CHART_DUPLICATED");
});

test("normal change stores server-owned chart fields with A:S schema", async () => {
  const harness = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  const result = harness.post(changePayload());
  assert.deepEqual(result, { ok: true, request_id: UUID, deduplicated: false });
  const row = harness.applications()[0];
  assert.equal(row.length, 19);
  assert.deepEqual(row.slice(0, 10), [
    "", "change", "2026/08/11 12:34:56", "FixtureUser", "123456",
    "Server Title", "Server Artist", EXISTING_MD5, "10", "10+",
  ]);
  assert.equal(row[12], "未処理");
  assert.equal(row[15], UUID);
  assert.equal(row[18], 0);
  assert.equal(harness.rawWrites[0].options.valueInputOption, "RAW");
});

test("change rejects same level and a missing chart", async () => {
  const same = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  assert.equal(same.post(changePayload({ proposed_level: "10" })).error.code, "SAME_AS_CURRENT");
  assert.equal(same.applications().length, 0);

  const missing = await createAppsScriptHarness({ kkjRows: [] });
  assert.equal(missing.post(changePayload()).error.code, "CHART_NOT_FOUND");
});

test("change rejects unsupported current levels", async () => {
  const harness = await createAppsScriptHarness({
    kkjRows: [["hst1", "Title", "Artist", EXISTING_MD5, ""]],
  });
  assert.equal(harness.post(changePayload()).error.code, "CURRENT_LEVEL_UNSUPPORTED");
});

test("delete stores server-owned fields and the fixed delete marker", async () => {
  const harness = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  assert.equal(harness.post(deletePayload()).ok, true);
  const row = harness.applications()[0];
  assert.deepEqual(row.slice(1, 11), [
    "delete", "2026/08/11 12:34:56", "FixtureUser", "123456",
    "Server Title", "Server Artist", EXISTING_MD5, "10", "削除", "☸0未満のため削除希望",
  ]);
});

test("delete rejects missing, duplicated, and forged delete targets", async () => {
  const missing = await createAppsScriptHarness({ kkjRows: [] });
  assert.equal(missing.post(deletePayload()).error.code, "CHART_NOT_FOUND");
  const duplicated = await createAppsScriptHarness({ kkjRows: [KJJ_ROW, KJJ_ROW] });
  assert.equal(duplicated.post(deletePayload()).error.code, "CHART_DUPLICATED");
  const forged = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  assert.equal(forged.post(deletePayload({ proposed_level: "0" })).error.code, "LEVEL_INVALID");
});

test("normal new stores parser title and artist", async () => {
  const harness = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  assert.equal(harness.post(newPayload()).ok, true);
  const row = harness.applications()[0];
  assert.equal(row[5], "New Title");
  assert.equal(row[6], "New Artist");
  assert.equal(row[8], "");
});

test("13- is accepted as a proposed level", async () => {
  const harness = await createAppsScriptHarness();
  const result = harness.post(newPayload({ proposed_level: "13-" }));
  assert.equal(result.ok, true);
  assert.equal(harness.applications()[0][9], "13-");
});

test("new rejects an existing or duplicated chart", async () => {
  const existing = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  const payload = newPayload({
    md5: EXISTING_MD5,
    ir_url: `https://bms-ir.org/new/song?songmd5=${EXISTING_MD5}&view=new`,
  });
  assert.equal(existing.post(payload).error.code, "CHART_ALREADY_EXISTS");

  const duplicated = await createAppsScriptHarness({ kkjRows: [KJJ_ROW, KJJ_ROW] });
  assert.equal(duplicated.post(payload).error.code, "CHART_DUPLICATED");
});

test("RAW writes preserve formula-like title, artist, and comment strings", async () => {
  const harness = await createAppsScriptHarness();
  const payload = newPayload({
    title: "=1+1",
    artist: "+84",
    comment: '=HYPERLINK("https://example.com","x")',
  });
  assert.equal(harness.post(payload).ok, true);
  const row = harness.applications()[0];
  assert.equal(row[5], "=1+1");
  assert.equal(row[6], "+84");
  assert.equal(row[10], '=HYPERLINK("https://example.com","x")');
  assert.equal(harness.rawWrites[0].options.valueInputOption, "RAW");
});

test("same request_id and payload deduplicates without a second row", async () => {
  const harness = await createAppsScriptHarness();
  assert.equal(harness.post(newPayload()).deduplicated, false);
  assert.equal(harness.post(newPayload()).deduplicated, true);
  assert.equal(harness.applications().length, 1);
  assert.equal(harness.rawWrites.length, 1);
});

test("same request_id with changed payload conflicts without a new row", async () => {
  const harness = await createAppsScriptHarness();
  assert.equal(harness.post(newPayload()).ok, true);
  assert.equal(harness.post(newPayload({ comment: "different" })).error.code, "REQUEST_ID_CONFLICT");
  assert.equal(harness.applications().length, 1);
});

test("common validation rejects long comments, invalid levels, and invalid IR URLs", async () => {
  for (const [overrides, code] of [
    [{ comment: "😀".repeat(501) }, "COMMENT_TOO_LONG"],
    [{ proposed_level: "hst1" }, "LEVEL_INVALID"],
    [{ ir_url: `https://bms-ir.org.example.com/new/song?songmd5=${NEW_MD5}` }, "IR_URL_INVALID"],
    [{ ir_url: `https://bms-ir.org/new/song?songmd5=${EXISTING_MD5}` }, "MD5_MISMATCH"],
  ]) {
    const harness = await createAppsScriptHarness();
    assert.equal(harness.post(newPayload(overrides)).error.code, code);
  }
});

test("change payload rejects client-owned title fields", async () => {
  const harness = await createAppsScriptHarness({ kkjRows: [KJJ_ROW] });
  assert.equal(harness.post({ ...changePayload(), title: "Client Title" }).error.code, "BAD_REQUEST");
});

test("ScriptLock timeout is retryable and does not write", async () => {
  const harness = await createAppsScriptHarness({ lockAvailable: false });
  const result = harness.post(newPayload());
  assert.equal(result.error.code, "LOCK_TIMEOUT");
  assert.equal(result.error.retryable, true);
  assert.equal(result.error.retry_after_ms, 500);
  assert.equal(harness.applications().length, 0);
});

test("rate limit overrides are honored and idempotent retries do not count", async () => {
  const harness = await createAppsScriptHarness({ properties: { USER_LIMIT: "3" } });
  const first = newPayload({ request_id: uniqueUuid(1) });
  assert.equal(harness.post(first).ok, true);
  assert.equal(harness.post(first).deduplicated, true);
  assert.equal(harness.post(newPayload({ request_id: uniqueUuid(2) })).ok, true);
  assert.equal(harness.post(newPayload({ request_id: uniqueUuid(3) })).ok, true);
  assert.equal(harness.post(newPayload({ request_id: uniqueUuid(4) })).error.code, "RATE_LIMITED");
  assert.equal(harness.applications().length, 3);
});

test("schema mismatch fails closed and setup is explicit", async () => {
  const invalid = await createAppsScriptHarness({ applicationHeaders: ["wrong"] });
  assert.equal(invalid.post(newPayload()).error.code, "SHEET_SCHEMA_INVALID");

  const missing = await createAppsScriptHarness({ includeApplicationSheet: false });
  assert.equal(missing.post(newPayload()).error.code, "SHEET_NOT_FOUND");
  const setupResult = missing.context.setupApplicationSheet();
  assert.equal(setupResult.columns, 19);
  assert.deepEqual(
    missing.spreadsheet.getSheetByName("申請一覧").rows[0],
    APPLICATION_HEADERS,
  );
});

test("Advanced Sheets failures return WRITE_FAILED", async () => {
  const harness = await createAppsScriptHarness({ writeFails: true });
  assert.equal(harness.post(newPayload()).error.code, "WRITE_FAILED");
  assert.equal(harness.lockState.released, true);
});

test("diagnostic logs contain fixed fields without username", async () => {
  const harness = await createAppsScriptHarness();
  harness.post(newPayload());
  const log = JSON.parse(harness.logs.at(-1));
  assert.deepEqual(Object.keys(log), [
    "timestamp", "request_id", "action", "application_type", "md5", "result", "error_code",
  ]);
  assert.doesNotMatch(harness.logs.at(-1), /FixtureUser/);
});
