import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const MD5 = "00000000000000000000000000000001";
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";

function application(comment = "差分URL:XXXX") {
  return {
    rowNumber: 2,
    record: {
      applicationType: "new",
      title: "New Title",
      artist: "New Artist",
      md5: MD5,
      originalLevel: "",
      targetLevel: "13-",
      comment,
      requestId: REQUEST_ID,
    },
  };
}

test("new comments use the requested slash date prefix", async () => {
  const context = vm.createContext({
    Utilities: { formatDate: () => "2026/8/15" },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    AppamadaAdminLogic: { failureState: () => "エラー" },
  });
  const source = await readFile(new URL("../apps-script/admin/Config.gs", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "Config.gs" });
  assert.equal(context.adminNewComment_("差分URL:XXXX"), "2026/8/15 差分URL:XXXX");
  assert.equal(context.adminNewComment_(""), "2026/8/15");
});

test("approved new applications persist the dated comment and recovery value", async () => {
  const calls = [];
  const context = vm.createContext({
    getAdminMasterState_() { return { rows: [] }; },
    findAdminMasterIndexesByMd5_() { return []; },
    planAdminMasterInsertion_() { return 2; },
    adminNewCommentDate_() { return "2026/8/15"; },
    formatAdminNewComment_(comment, date) { return `${date} ${comment}`; },
    insertAdminMasterBlankRow_() { calls.push("insert"); },
    addAdminPlannedMetadata_(sheet, row, request, details) {
      calls.push(["metadata", details]);
      return { id: "metadata" };
    },
    maybeInjectAdminFault_() {},
    writeAdminMasterRowRaw_(spreadsheet, sheet, row, values) {
      calls.push(["write", values]);
    },
    refreshAdminMasterState_() { calls.push("refresh"); },
    finalizeAdminApplication_() { calls.push("finalize"); },
    removeAdminPlannedMetadata_() { calls.push("remove"); },
    throwAdminError_(code, message, state) {
      const error = new Error(message);
      Object.assign(error, { code, state });
      throw error;
    },
  });
  const source = await readFile(new URL("../apps-script/admin/ApplyNew.gs", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "ApplyNew.gs" });
  const result = context.applyAdminNew_({}, {}, {}, application(), {});
  assert.equal(result.ok, true);
  assert.deepEqual({ ...calls.find(([name]) => name === "metadata")[1] }, {
    new_comment_date: "2026/8/15",
  });
  assert.deepEqual(Array.from(calls.find(([name]) => name === "write")[1]), [
    "13-", "New Title", "New Artist", MD5, "2026/8/15 差分URL:XXXX",
  ]);
});

test("new recovery reuses the original dated comment from metadata", async () => {
  const writes = [];
  const metadata = {};
  const context = vm.createContext({
    getAdminMetadataRow_() { return 2; },
    writeAdminMasterRowRaw_(spreadsheet, sheet, row, values) { writes.push(values); },
    assertAdminTableOrder_() {},
    finalizeAdminApplication_() {},
    removeAdminPlannedMetadata_() {},
    formatAdminNewComment_(comment, date) { return `${date} ${comment}`; },
    throwAdminError_(code, message, state) {
      const error = new Error(message);
      Object.assign(error, { code, state });
      throw error;
    },
  });
  const source = await readFile(new URL("../apps-script/admin/Recovery.gs", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "Recovery.gs" });
  const masterSheet = {
    getRange() { return { getValues: () => [["", "", "", "", ""]] }; },
  };
  context.recoverAdminNewMetadata_(
    {},
    {},
    masterSheet,
    application(),
    metadata,
    { new_comment_date: "2026/8/15" },
  );
  assert.deepEqual(Array.from(writes[0]), [
    "13-", "New Title", "New Artist", MD5, "2026/8/15 差分URL:XXXX",
  ]);
});
