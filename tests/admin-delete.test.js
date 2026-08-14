import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const MD5 = "00000000000000000000000000000001";
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";

function application(overrides = {}) {
  return {
    rowNumber: 2,
    record: {
      applyMark: "○",
      applicationType: "delete",
      md5: MD5,
      originalLevel: "隔離",
      targetLevel: "削除",
      state: "未処理",
      memo: "",
      requestId: REQUEST_ID,
      ...overrides,
    },
  };
}

async function loadDeleteHarness({ currentLevel = "隔離", matches = [12], failAfterDelete = false } = {}) {
  const calls = [];
  const masterSheet = {};
  const rows = Array.from({ length: Math.max(0, ...matches.map((row) => row - 1)) }, (_, index) => [
    currentLevel,
    `Title ${index}`,
    `Artist ${index}`,
    `000000000000000000000000${String(index).padStart(8, "0")}`,
    "",
  ]);
  for (const row of matches) rows[row - 2][3] = MD5;
  const context = vm.createContext({
    getAdminMasterState_() { return { rows }; },
    findAdminMasterIndexesByMd5_() { return matches.map((row) => row - 2); },
    refreshAdminMasterState_() { calls.push(["assertOrder"]); return { rows }; },
    validateAdminMasterFormulaFree_(sheet, row) { calls.push(["formulaFree", sheet, row]); },
    throwAdminError_(code, message, state) {
      const error = new Error(message);
      Object.assign(error, { code, state });
      throw error;
    },
    updateAdminApplicationOutcome_(spreadsheet, sheet, row, values) {
      calls.push(["plan", spreadsheet, sheet, row, values]);
    },
    maybeInjectAdminFault_(point, requestId) {
      calls.push(["fault", point, requestId]);
      if (failAfterDelete && point === "FAIL_AFTER_MASTER_DELETE") throw new Error("injected");
    },
    deleteAdminMasterRow_(sheet, row) { calls.push(["delete", sheet, row]); },
    finalizeAdminApplication_(spreadsheet, sheet, row, memo) {
      calls.push(["finalize", spreadsheet, sheet, row, memo]);
    },
  });
  const source = await readFile(new URL("../apps-script/admin/ApplyDelete.gs", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "ApplyDelete.gs" });
  return { context, calls, masterSheet };
}

test("approved delete records a recovery plan before deleting the unique matching row", async () => {
  const { context, calls, masterSheet } = await loadDeleteHarness();
  const spreadsheet = { id: "spreadsheet" };
  const applicationSheet = { name: "申請一覧" };
  const result = context.applyAdminDelete_(spreadsheet, applicationSheet, masterSheet, application());
  assert.deepEqual({ ...result }, { ok: true, deletedRow: 12 });
  const planIndex = calls.findIndex(([name]) => name === "plan");
  const deleteIndex = calls.findIndex(([name]) => name === "delete");
  const finalizeIndex = calls.findIndex(([name]) => name === "finalize");
  assert.equal(planIndex < deleteIndex && deleteIndex < finalizeIndex, true);
  assert.match(calls[planIndex][4].memo, new RegExp(`^DELETE_PLANNED request_id=${REQUEST_ID} md5=${MD5} level=隔離$`));
  assert.match(calls[finalizeIndex][4], /kkj 12行目 隔離 を削除/);
});

test("delete refuses stale, missing, and duplicated targets without deleting", async () => {
  const stale = await loadDeleteHarness({ currentLevel: "?" });
  assert.throws(
    () => stale.context.applyAdminDelete_({}, {}, stale.masterSheet, application()),
    (error) => error.code === "STALE_CURRENT_LEVEL",
  );
  assert.equal(stale.calls.some(([name]) => name === "delete"), false);

  for (const [matches, code] of [[[], "CHART_NOT_FOUND"], [[2, 3], "CHART_DUPLICATED"]]) {
    const harness = await loadDeleteHarness({ matches });
    assert.throws(
      () => harness.context.applyAdminDelete_({}, {}, harness.masterSheet, application()),
      (error) => error.code === code,
    );
    assert.equal(harness.calls.some(([name]) => name === "delete"), false);
  }
});

test("scheduled recovery finalizes a planned delete when the master row is already gone", async () => {
  const request = application();
  const calls = [];
  const context = vm.createContext({
    readAdminApplication_() { return request; },
    validateAdminApplication_() { calls.push("validate"); },
    findAdminMasterRowsByMd5_() { return []; },
    assertAdminTableOrder_() { calls.push("assertOrder"); },
    finalizeAdminApplication_(spreadsheet, sheet, row, memo) {
      calls.push(["finalize", row, memo]);
    },
    logAdminDiagnostic_(entry) { calls.push(["log", entry.action, entry.result]); },
    markAdminApplicationFailure_() { calls.push("failure"); },
    throwAdminError_(code, message, state) {
      const error = new Error(message);
      Object.assign(error, { code, state });
      throw error;
    },
  });
  for (const file of ["ApplyDelete.gs", "Recovery.gs"]) {
    const source = await readFile(new URL(`../apps-script/admin/${file}`, import.meta.url), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  request.record.memo = context.createAdminDeletePlanMemo_(request);
  const result = context.recoverAdminDeletePlans_({}, { getLastRow: () => 2 }, {});
  assert.deepEqual({ ...result }, { recovered: 1, failed: 0, ignored: 0 });
  assert.deepEqual(calls, [
    "validate",
    "assertOrder",
    ["finalize", 2, "kkjから削除済み（復旧）"],
    ["log", "recover_delete", "success"],
  ]);
});

test("an interruption after row deletion preserves the recovery marker", async () => {
  const { context, masterSheet } = await loadDeleteHarness({ failAfterDelete: true });
  assert.throws(
    () => context.applyAdminDelete_({}, {}, masterSheet, application()),
    (error) => error.message === "injected" && error.preserveDeletePlan === true,
  );
});
