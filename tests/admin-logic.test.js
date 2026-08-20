import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const sourceUrl = new URL("../apps-script/admin/AdminLogic.js", import.meta.url);

async function loadLogic() {
  const source = await readFile(sourceUrl, "utf8");
  const context = vm.createContext({});
  new vm.Script(`${source}\nglobalThis.__logic = AppamadaAdminLogic;`).runInContext(context);
  return context.__logic;
}

function md5(number) {
  return Number(number).toString(16).padStart(32, "0");
}

function rows(levels) {
  return levels.map((level, index) => [level, `Title ${index}`, `Artist ${index}`, md5(index + 1), ""]);
}

function record(overrides = {}) {
  return {
    applyMark: "○",
    applicationType: "change",
    title: "Title",
    artist: "Artist",
    md5: md5(1),
    originalLevel: "9",
    targetLevel: "10+",
    state: "未処理",
    requestId: "10000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

test("publish order preserves the current kkj/public JSON special ordering", async () => {
  const logic = await loadLogic();
  assert.deepEqual(Array.from(logic.PUBLISH_LEVEL_ORDER).slice(10, 22), [
    "10-", "10", "10+", "11-", "11", "11+", "12-", "12", "12+", "13-", "13", "13+",
  ]);
  assert.deepEqual(Array.from(logic.PUBLISH_LEVEL_ORDER).slice(-6), [
    "★★4?", "★★5?", "★★6?", "★★7?", "隔離", "?",
  ]);
});

test("table order accepts contiguous blocks and missing levels", async () => {
  const logic = await loadLogic();
  const result = logic.analyzeTableOrder(rows(["0", "0", "1", "1", "10-", "10", "10+", "?"]), 1);
  assert.equal(result.ok, true);
  assert.equal(result.blocks.length, 6);
  assert.deepEqual({ ...result.blocks[0] }, {
    level: "0", startRow: 1, endRow: 2, startIndex: 0, endIndex: 1,
  });
});

for (const [name, levels, code] of [
  ["split block", ["9", "9", "10", "9"], "TABLE_ORDER_INVALID"],
  ["reverse block", ["10", "9"], "TABLE_ORDER_INVALID"],
  ["unknown level", ["hst1"], "TABLE_ORDER_INVALID"],
]) {
  test(`table order rejects ${name}`, async () => {
    const logic = await loadLogic();
    assert.equal(logic.analyzeTableOrder(rows(levels), 1).code, code);
  });
}

test("table order rejects internal blanks and duplicate MD5 values", async () => {
  const logic = await loadLogic();
  assert.equal(logic.analyzeTableOrder([rows(["9"])[0], ["", "", "", "", ""], rows(["10"])[0]], 1).code, "TABLE_ORDER_INVALID");
  const duplicate = rows(["9", "10"]);
  duplicate[1][3] = duplicate[0][3];
  assert.equal(logic.analyzeTableOrder(duplicate, 1).code, "CHART_DUPLICATED");
});

test("table order accepts the existing Spreadsheet sorter special block order", async () => {
  const logic = await loadLogic();
  assert.equal(logic.analyzeTableOrder(rows(["16", "★★4?", "★★5?", "★★6?", "★★7?", "隔離", "?"]), 1).ok, true);
});

test("stable table sort repairs level order while preserving order within each level", async () => {
  const logic = await loadLogic();
  const table = rows(["10", "0", "10", "?", "0", "★★4?"]);
  const originalMd5ByLevel = Object.fromEntries(
    ["0", "10", "★★4?", "?"].map((level) => [
      level,
      table.filter((row) => row[0] === level).map((row) => row[3]),
    ]),
  );
  const plan = logic.planStableTableSort(table, 2);
  assert.equal(plan.ok, true);
  assert.equal(plan.changed, true);
  assert.deepEqual(Array.from(plan.rows, (row) => row[0]), ["0", "0", "10", "10", "★★4?", "?"]);
  for (const [level, md5s] of Object.entries(originalMd5ByLevel)) {
    assert.deepEqual(Array.from(plan.rows.filter((row) => row[0] === level), (row) => row[3]), md5s);
  }
  assert.equal(logic.analyzeTableOrder(plan.rows, 2).ok, true);
});

test("stable table sort refuses structural corruption", async () => {
  const logic = await loadLogic();
  const blank = [rows(["0"])[0], ["", "", "", "", ""]];
  assert.equal(logic.planStableTableSort(blank, 2).code, "TABLE_ORDER_INVALID");
  assert.equal(logic.planStableTableSort(rows(["hst1"]), 2).code, "TABLE_ORDER_INVALID");
  const duplicate = rows(["10", "0"]);
  duplicate[1][3] = duplicate[0][3];
  assert.equal(logic.planStableTableSort(duplicate, 2).code, "CHART_DUPLICATED");
});

test("insertion uses an existing block end", async () => {
  const logic = await loadLogic();
  assert.equal(logic.insertionIndex(rows(["9", "10", "10", "11"]), "10").index, 3);
});

for (const [name, levels, target, expected] of [
  ["missing middle", ["11", "12-"], "11+", 1],
  ["first level", ["1", "10"], "0", 0],
  ["last level", ["16", "★★4?"], "?", 2],
  ["special level", ["16", "★★5?", "?"], "★★4?", 1],
]) {
  test(`insertion handles ${name}`, async () => {
    const logic = await loadLogic();
    assert.equal(logic.insertionIndex(rows(levels), target).index, expected);
  });
}

for (const [from, to] of [
  ["9", "10+"], ["12", "10"], ["0", "16"], ["16", "0"],
  ["10", "★★4?"], ["★★4?", "10"], ["?", "12"], ["12", "?"],
]) {
  test(`move ${from} to ${to} leaves one ordered block`, async () => {
    const logic = await loadLogic();
    const table = rows(Array.from(logic.PUBLISH_LEVEL_ORDER));
    const sourceIndex = table.findIndex((row) => row[0] === from);
    const movedMd5 = table[sourceIndex][3];
    const plan = logic.planMove(table, sourceIndex, to);
    assert.equal(plan.ok, true);
    assert.equal(logic.analyzeTableOrder(plan.rows, 1).ok, true);
    assert.equal(plan.rows.filter((row) => row[0] === to).length, 2);
    assert.equal(plan.rows.find((row) => row[3] === movedMd5)[0], to);
  });
}

test("moveRows destination uses pre-move coordinates", async () => {
  const logic = await loadLogic();
  assert.equal(logic.moveRowsDestinationIndex(2, 5, 1), 6);
  assert.equal(logic.moveRowsDestinationIndex(5, 2, 1), 2);
  assert.equal(logic.moveRowsDestinationIndex(3, 3, 1), 3);
});

test("row moves only unfreeze when the source or final row touches the frozen area", async () => {
  const logic = await loadLogic();
  assert.equal(logic.moveTouchesFrozenRows(1, 10, 1), true);
  assert.equal(logic.moveTouchesFrozenRows(10, 1, 1), true);
  assert.equal(logic.moveTouchesFrozenRows(2, 10, 1), false);
  assert.equal(logic.moveTouchesFrozenRows(1, 10, 0), false);
});

test("row moves detect whether they cross a filter header", async () => {
  const logic = await loadLogic();
  assert.equal(logic.moveCrossesRow(1, 10, 1), true);
  assert.equal(logic.moveCrossesRow(10, 1, 1), true);
  assert.equal(logic.moveCrossesRow(2, 10, 1), false);
  assert.equal(logic.moveCrossesRow(2, 10, 5), true);
});

test("comment history appends once with the required separator", async () => {
  const logic = await loadLogic();
  const history = "2026.8.11 9→9+";
  assert.equal(logic.appendCommentHistory("", history), history);
  assert.equal(
    logic.appendCommentHistory("2024.11.24 stella4660", history),
    `2024.11.24 stella4660 / ${history}`,
  );
  assert.equal(logic.appendCommentHistory(history, history), history);
});

test("new validation accepts literal formula prefixes when cells contain no formula", async () => {
  const logic = await loadLogic();
  for (const prefix of ["=", "+", "-", "@"]) {
    const result = logic.validateApplication(record({
      applicationType: "new",
      originalLevel: "",
      title: `${prefix}Title`,
      artist: `${prefix}Artist`,
    }), {}, false);
    assert.equal(result.ok, true);
  }
});

test("new validation rejects formulas, edge whitespace, controls, non-NFC, and length", async () => {
  const logic = await loadLogic();
  const base = record({ applicationType: "new", originalLevel: "" });
  assert.equal(logic.validateApplication(base, { title: "=1+1" }, false).code, "CELL_FORMULA_NOT_ALLOWED");
  assert.equal(logic.validateApplication({ ...base, title: " Title" }, {}, false).code, "CELL_TEXT_INVALID");
  assert.equal(logic.validateApplication({ ...base, artist: "A\u0000B" }, {}, false).code, "CELL_TEXT_INVALID");
  assert.equal(logic.validateApplication({ ...base, title: "e\u0301" }, {}, false).code, "CELL_TEXT_NOT_NORMALIZED");
  assert.equal(logic.validateApplication({ ...base, artist: "a".repeat(501) }, {}, false).code, "CELL_TEXT_INVALID");
});

test("change validation rejects same level and formulas in management fields", async () => {
  const logic = await loadLogic();
  assert.equal(logic.validateApplication(record({ targetLevel: "9" }), {}, false).code, "SAME_AS_CURRENT");
  assert.equal(logic.validateApplication(record(), { md5: "=A1" }, false).code, "CELL_FORMULA_NOT_ALLOWED");
});

test("delete validation requires an allowed original level and the fixed delete target", async () => {
  const logic = await loadLogic();
  const valid = record({ applicationType: "delete", originalLevel: "隔離", targetLevel: "削除" });
  assert.equal(logic.validateApplication(valid, {}, false).ok, true);
  assert.equal(logic.validateApplication({ ...valid, targetLevel: "0" }, {}, false).code, "LEVEL_INVALID");
  assert.equal(logic.validateApplication({ ...valid, originalLevel: "hst1" }, {}, false).code, "LEVEL_INVALID");
});

test("state and retry rules exclude review, rejected, and applied rows", async () => {
  const logic = await loadLogic();
  assert.equal(logic.canProcessState("未処理", false), true);
  assert.equal(logic.canProcessState("エラー", false), false);
  assert.equal(logic.canProcessState("エラー", true), true);
  for (const state of ["要確認", "却下", "反映済"]) assert.equal(logic.canProcessState(state, true), false);
  assert.equal(logic.isRetryableError("LOCK_TIMEOUT"), true);
  assert.equal(logic.isRetryableError("GOOGLE_SERVICE_ERROR"), true);
  assert.equal(logic.isRetryableError("STALE_CURRENT_LEVEL"), false);
  assert.equal(logic.failureState("STALE_CURRENT_LEVEL"), "要確認");
  assert.equal(logic.failureState("GOOGLE_SERVICE_ERROR"), "エラー");
});

test("admin manifest and source tree keep the bound script split by responsibility", async () => {
  const manifest = JSON.parse(await readFile(new URL("../apps-script/admin/appsscript.json", import.meta.url), "utf8"));
  assert.equal(manifest.timeZone, "Asia/Tokyo");
  assert.equal(manifest.runtimeVersion, "V8");
  assert.equal(manifest.dependencies.enabledAdvancedServices[0].serviceId, "sheets");
  assert.equal(manifest.webapp, undefined);
  const names = [
    "Main.gs", "Config.gs", "Validation.gs", "ApplicationSheet.gs", "MasterTable.gs",
    "TableOrder.gs", "ApplyChange.gs", "ApplyNew.gs", "ApplyDelete.gs", "Metadata.gs", "Recovery.gs",
    "AdminMenu.gs", "TriggerSetup.gs", "Logging.gs", "IntegrationTest.gs",
  ];
  const sources = [];
  for (const name of names) {
    sources.push(await readFile(new URL(`../apps-script/admin/${name}`, import.meta.url), "utf8"));
    assert.equal((await readFile(new URL(`../apps-script/admin/${name}`, import.meta.url), "utf8")).length > 0, true);
  }
  assert.doesNotThrow(() => new vm.Script(sources.join("\n")));
});
