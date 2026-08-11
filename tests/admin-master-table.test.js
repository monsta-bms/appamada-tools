import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function md5(number) {
  return Number(number).toString(16).padStart(32, "0");
}

function row(level, number) {
  return [level, `Title ${number}`, `Artist ${number}`, md5(number), ""];
}

class Range {
  constructor(sheet, startRow, startColumn, rowCount, columnCount) {
    this.sheet = sheet;
    this.startRow = startRow;
    this.startColumn = startColumn;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.rows[this.startRow - 1 + rowOffset]?.[this.startColumn - 1 + columnOffset] ?? "",
      ),
    );
  }
}

class Sheet {
  constructor(rows) {
    this.rows = rows.map((value) => [...value]);
  }

  getLastRow() { return this.rows.length; }
  getRange(startRow, startColumn, rowCount = 1, columnCount = 1) {
    return new Range(this, startRow, startColumn, rowCount, columnCount);
  }
}

async function loadMasterTable(sheet) {
  const logicSource = await readFile(new URL("../apps-script/admin/AdminLogic.js", import.meta.url), "utf8");
  const masterSource = await readFile(new URL("../apps-script/admin/MasterTable.gs", import.meta.url), "utf8");
  const spreadsheet = { getSheetByName() { return sheet; } };
  const context = vm.createContext({
    ADMIN_CONFIG: Object.freeze({ masterSheetName: "kkj" }),
    getAdminSpreadsheet_() { return spreadsheet; },
    throwAdminError_(code, detail, state) {
      const error = new Error(detail);
      Object.assign(error, { code, detail, state });
      throw error;
    },
  });
  vm.runInContext(logicSource, context, { filename: "AdminLogic.js" });
  vm.runInContext(masterSource, context, { filename: "MasterTable.gs" });
  return context;
}

async function loadRecovery(dataRows) {
  const logicSource = await readFile(new URL("../apps-script/admin/AdminLogic.js", import.meta.url), "utf8");
  const recoverySource = await readFile(new URL("../apps-script/admin/Recovery.gs", import.meta.url), "utf8");
  const moves = [];
  const context = vm.createContext({
    readAdminMasterRows_() { return dataRows.map((value) => [...value]); },
    moveAdminMasterRow_(sheet, sourceRow, finalRow) { moves.push({ sheet, sourceRow, finalRow }); },
    throwAdminError_(code, detail, state) {
      const error = new Error(detail);
      Object.assign(error, { code, detail, state });
      throw error;
    },
  });
  vm.runInContext(logicSource, context, { filename: "AdminLogic.js" });
  vm.runInContext(recoverySource, context, { filename: "Recovery.gs" });
  return { context, moves };
}

test("production kkj header is excluded from order analysis", async () => {
  const sheet = new Sheet([
    ["level", "title", "artist", "md5", "comment"],
    row("0", 1),
    row("9", 2),
    row("10", 3),
  ]);
  const context = await loadMasterTable(sheet);
  assert.deepEqual(context.readAdminMasterRows_(sheet).map((value) => value[0]), ["0", "9", "10"]);
  const analysis = context.assertAdminTableOrder_(sheet);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.md5Count, 3);
  assert.equal(analysis.blocks[0].startRow, 2);
});

test("move and insertion plans retain real spreadsheet row coordinates", async () => {
  const sheet = new Sheet([
    ["level", "title", "artist", "md5", "comment"],
    row("0", 1),
    row("9", 2),
    row("10", 3),
  ]);
  const context = await loadMasterTable(sheet);
  const move = context.planAdminMasterMove_(sheet, 2, "10");
  assert.equal(move.finalRow, 4);
  assert.deepEqual(Array.from(move.rows, (value) => value[0]), ["9", "10", "10"]);
  assert.equal(context.planAdminMasterInsertion_(sheet, "1"), 3);
});

test("duplicate audit reports real rows and never treats the header as data", async () => {
  const duplicate = row("10", 2);
  duplicate[3] = md5(1);
  const sheet = new Sheet([
    ["level", "title", "artist", "md5", "comment"],
    row("0", 1),
    row("9", 3),
    duplicate,
  ]);
  const context = await loadMasterTable(sheet);
  assert.throws(
    () => context.auditAdminMd5Duplicates_(),
    (error) => error.code === "CHART_DUPLICATED" && error.detail.includes('"rows":[2,4]'),
  );
});

test("recovery maps metadata rows through the production header offset", async () => {
  const dataRows = [row("0", 1), row("9", 2), row("10", 3)];
  const { context, moves } = await loadRecovery(dataRows);
  const sheet = {};
  assert.equal(context.positionRecoveredAdminChange_(sheet, 2, "10"), 4);
  assert.deepEqual(moves, [{ sheet, sourceRow: 2, finalRow: 4 }]);
});
