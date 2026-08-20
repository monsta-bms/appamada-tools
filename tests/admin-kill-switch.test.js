import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function createHarness(propertyValue, { lockAvailable = true } = {}) {
  const properties = new Map();
  if (propertyValue !== undefined) properties.set("ADMIN_APPLY_ENABLED", propertyValue);
  const calls = { spreadsheet: 0, apply: 0, ensureOrder: 0, alerts: [], lockAttempts: 0, lockReleases: 0 };
  const context = vm.createContext({
    AppamadaAdminLogic: {
      failureState() { return "エラー"; },
      canProcessState() { return true; },
      isRetryableError() { return true; },
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty: (name) => properties.get(name) ?? null };
      },
    },
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        calls.spreadsheet += 1;
        return {};
      },
      getUi() {
        return { alert: (message) => calls.alerts.push(message) };
      },
    },
    LockService: {
      getScriptLock() {
        return {
          tryLock() {
            calls.lockAttempts += 1;
            return lockAvailable;
          },
          releaseLock() { calls.lockReleases += 1; },
        };
      },
    },
  });
  for (const file of ["Config.gs", "Main.gs", "Recovery.gs", "AdminMenu.gs"]) {
    const source = await readFile(new URL(`../apps-script/admin/${file}`, import.meta.url), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return { context, properties, calls };
}

test("ADMIN_APPLY_ENABLED is false unless explicitly true", async () => {
  for (const [value, expected] of [[undefined, false], ["false", false], ["TRUE", false], ["true", true]]) {
    const { context } = await createHarness(value);
    assert.equal(context.isAdminApplyEnabled_(), expected);
  }
});

test("disabled admin edit and manual reprocess never reach spreadsheet mutation paths", async () => {
  const { context, calls } = await createHarness("false");
  const processResult = context.processAdminApplicationRow_(2, {});
  const editResult = context.handleAdminEdit({ range: { shouldNotBeRead: true } });
  const manualResult = context.reprocessSelectedAdminRows();
  assert.equal(processResult.code, "ADMIN_APPLY_DISABLED");
  assert.equal(editResult.code, "ADMIN_APPLY_DISABLED");
  assert.equal(manualResult.disabled, true);
  assert.equal(calls.spreadsheet, 0);
  assert.deepEqual(calls.alerts, ["管理反映は現在停止中です。"]);
});

test("disabled recovery and retry never open the spreadsheet", async () => {
  const { context, calls } = await createHarness();
  assert.equal(context.recoverInterruptedTransactions().disabled, true);
  assert.equal(context.retryTemporaryAdminErrors().disabled, true);
  assert.equal(context.runScheduledRecovery().disabled, true);
  assert.equal(calls.spreadsheet, 0);
});

test("enabled application processing retains the existing apply path", async () => {
  const { context, calls } = await createHarness("true");
  const spreadsheet = {};
  const applicationSheet = {};
  context.getAdminSpreadsheet_ = () => spreadsheet;
  context.getAdminApplicationSheet_ = () => applicationSheet;
  context.readAdminApplication_ = () => ({
    rowNumber: 2,
    record: {
      applyMark: "○",
      state: "未処理",
      applicationType: "change",
      requestId: "request-id",
      md5: "00000000000000000000000000000001",
    },
  });
  context.validateAdminApplication_ = () => {};
  context.getAdminMasterSheet_ = () => ({});
  context.ensureAdminMasterOrderForApply_ = () => { calls.ensureOrder += 1; };
  context.applyAdminChange_ = () => {
    calls.apply += 1;
    return { ok: true };
  };
  context.logAdminDiagnostic_ = () => {};
  context.markAdminApplicationFailure_ = () => {
    throw new Error("failure path must not run");
  };
  const result = context.processAdminApplicationRow_(2, {});
  assert.equal(result.ok, true);
  assert.equal(calls.apply, 1);
  assert.equal(calls.ensureOrder, 1);
});

test("multi-row edits share one lock and one spreadsheet context", async () => {
  const { context, calls } = await createHarness("true");
  const spreadsheet = {};
  const applicationSheet = {};
  const eventSheet = { getName: () => context.ADMIN_CONFIG.applicationSheetName };
  context.getAdminSpreadsheet_ = () => {
    calls.spreadsheet += 1;
    return spreadsheet;
  };
  context.getAdminApplicationSheet_ = () => applicationSheet;
  context.readAdminApplication_ = (sheet, rowNumber) => ({
    rowNumber,
    record: {
      applyMark: "○",
      state: "未処理",
      applicationType: "change",
      requestId: `request-${rowNumber}`,
      md5: String(rowNumber).padStart(32, "0"),
    },
  });
  context.validateAdminApplication_ = () => {};
  context.getAdminMasterSheet_ = () => ({});
  context.ensureAdminMasterOrderForApply_ = () => { calls.ensureOrder += 1; };
  context.applyAdminChange_ = () => {
    calls.apply += 1;
    return { ok: true };
  };
  context.logAdminDiagnostic_ = () => {};
  context.markAdminApplicationFailure_ = () => {
    throw new Error("failure path must not run");
  };
  const result = context.handleAdminEdit({
    range: {
      getSheet: () => eventSheet,
      getColumn: () => 1,
      getLastColumn: () => 1,
      getRow: () => 2,
      getLastRow: () => 3,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.processed, 2);
  assert.equal(calls.apply, 2);
  assert.equal(calls.ensureOrder, 2);
  assert.equal(calls.spreadsheet, 1);
  assert.equal(calls.lockAttempts, 1);
  assert.equal(calls.lockReleases, 1);
});

test("lock contention defers the row without writing an error state", async () => {
  const { context, calls } = await createHarness("true", { lockAvailable: false });
  let failures = 0;
  context.logAdminDiagnostic_ = () => {};
  context.markAdminApplicationFailure_ = () => { failures += 1; };
  const result = context.processAdminApplicationRow_(2, {});
  assert.equal(result.code, "LOCK_TIMEOUT");
  assert.equal(result.deferred, true);
  assert.equal(failures, 0);
  assert.equal(calls.spreadsheet, 0);
  assert.equal(calls.lockAttempts, 1);
  assert.equal(calls.lockReleases, 0);
});

test("enabled recovery retains the existing empty-scan paths", async () => {
  const { context, calls } = await createHarness("true");
  context.getAdminSpreadsheet_ = () => {
    calls.spreadsheet += 1;
    return {};
  };
  context.getAdminApplicationSheet_ = () => ({ getLastRow: () => 1 });
  context.getAdminMasterSheet_ = () => ({});
  context.findAllAdminPlannedMetadata_ = () => [];
  const result = context.runScheduledRecovery();
  assert.equal(result.metadata.recovered, 0);
  assert.equal(result.retry.retried, 0);
  assert.equal(calls.spreadsheet, 2);
});
