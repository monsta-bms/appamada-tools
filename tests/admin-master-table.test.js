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

function columnName(column) {
  var value = column;
  var result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function columnNumber(name) {
  return Array.from(name).reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0);
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

  getRow() { return this.startRow; }
  getLastRow() { return this.startRow + this.rowCount - 1; }
  getColumn() { return this.startColumn; }
  getLastColumn() { return this.startColumn + this.columnCount - 1; }
  getA1Notation() {
    return `${columnName(this.startColumn)}${this.startRow}:${columnName(this.getLastColumn())}${this.getLastRow()}`;
  }
  createFilter() {
    this.sheet.filter = new BasicFilter(this.sheet, this, new Map());
    return this.sheet.filter;
  }
}

class BasicFilter {
  constructor(sheet, range, criteria) {
    this.sheet = sheet;
    this.range = range;
    this.criteria = new Map(criteria);
    this.removed = false;
  }

  getRange() { return this.range; }
  getColumnFilterCriteria(column) { return this.criteria.get(column) ?? null; }
  setColumnFilterCriteria(column, value) { this.criteria.set(column, value); }
  remove() {
    this.removed = true;
    this.sheet.filter = null;
  }
}

class Sheet {
  constructor(rows) {
    this.rows = rows.map((value) => [...value]);
    this.maxRows = 17041;
    this.filter = null;
    this.insertions = [];
    this.deletions = [];
    this.moves = [];
    this.frozenRows = 1;
  }

  getLastRow() { return this.rows.length; }
  getMaxRows() { return this.maxRows; }
  getFilter() { return this.filter; }
  getFrozenRows() { return this.frozenRows; }
  setFrozenRows(value) { this.frozenRows = value; }
  getRange(startRow, startColumn, rowCount = 1, columnCount = 1) {
    if (typeof startRow === "string") {
      const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(startRow);
      if (!match) throw new Error(`Unsupported A1 range: ${startRow}`);
      const parsedStartColumn = columnNumber(match[1]);
      const parsedStartRow = Number(match[2]);
      const parsedLastColumn = columnNumber(match[3]);
      const parsedLastRow = Number(match[4]);
      return new Range(
        this,
        parsedStartRow,
        parsedStartColumn,
        parsedLastRow - parsedStartRow + 1,
        parsedLastColumn - parsedStartColumn + 1,
      );
    }
    return new Range(this, startRow, startColumn, rowCount, columnCount);
  }
  insertRowsBefore(rowNumber, count) {
    this.insertions.push({ type: "before", rowNumber, count });
    this.maxRows += count;
  }
  insertRowsAfter(rowNumber, count) {
    this.insertions.push({ type: "after", rowNumber, count });
    this.maxRows += count;
  }
  deleteRow(rowNumber) {
    this.deletions.push(rowNumber);
    if (this.filter) {
      const range = this.filter.range;
      if (rowNumber >= range.startRow && rowNumber <= range.getLastRow()) range.rowCount -= 1;
    }
    this.rows.splice(rowNumber - 1, 1);
    this.maxRows -= 1;
  }
  moveRows(range, destinationIndex) {
    const sourceIndex = range.startRow - 1;
    const moved = this.rows.splice(sourceIndex, range.rowCount);
    const insertionIndex = destinationIndex - 1 - (destinationIndex > range.startRow ? range.rowCount : 0);
    this.rows.splice(insertionIndex, 0, ...moved);
    this.moves.push({ sourceRow: range.startRow, rowCount: range.rowCount, destinationIndex });
  }
}

async function loadMasterTable(sheet) {
  const logicSource = await readFile(new URL("../apps-script/admin/AdminLogic.js", import.meta.url), "utf8");
  const masterSource = await readFile(new URL("../apps-script/admin/MasterTable.gs", import.meta.url), "utf8");
  const spreadsheet = { getSheetByName() { return sheet; } };
  const logs = [];
  const context = vm.createContext({
    ADMIN_CONFIG: Object.freeze({ masterSheetName: "kkj" }),
    getAdminSpreadsheet_() { return spreadsheet; },
    throwAdminError_(code, detail, state) {
      const error = new Error(detail);
      Object.assign(error, { code, detail, state });
      throw error;
    },
    logAdminDiagnostic_(entry) { logs.push(entry); },
  });
  vm.runInContext(logicSource, context, { filename: "AdminLogic.js" });
  vm.runInContext(masterSource, context, { filename: "MasterTable.gs" });
  context.__logs = logs;
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

test("approval order repair stably sorts valid kkj rows in contiguous runs", async () => {
  const sheet = new Sheet([
    ["level", "title", "artist", "md5", "comment"],
    row("10", 1),
    row("0", 2),
    row("0", 3),
    row("?", 4),
    row("10", 5),
    row("★★4?", 6),
  ]);
  const context = await loadMasterTable(sheet);
  const state = context.ensureAdminMasterOrderForApply_(sheet, {});
  assert.deepEqual(sheet.rows.slice(1).map((value) => value[0]), ["0", "0", "10", "10", "★★4?", "?"]);
  assert.deepEqual(
    sheet.rows.slice(1).filter((value) => value[0] === "10").map((value) => value[3]),
    [md5(1), md5(5)],
  );
  assert.equal(state.analysis.ok, true);
  assert.equal(state.orderRepairMoveCount, 3);
  assert.equal(sheet.moves.length, 3);
  assert.equal(context.__logs.length, 1);
  assert.equal(context.__logs[0].action, "repair_table_order");
  assert.equal(context.__logs[0].result, "success");
});

test("approval order repair refuses unknown levels and duplicate MD5 without moving rows", async () => {
  for (const [dataRows, code] of [
    [[row("10", 1), row("hst1", 2)], "TABLE_ORDER_INVALID"],
    [[row("10", 1), { ...row("0", 2), 3: md5(1) }], "CHART_DUPLICATED"],
  ]) {
    const normalizedRows = dataRows.map((value) => Array.isArray(value) ? value : Object.assign([], value));
    const sheet = new Sheet([["level", "title", "artist", "md5", "comment"], ...normalizedRows]);
    const context = await loadMasterTable(sheet);
    assert.throws(() => context.ensureAdminMasterOrderForApply_(sheet, {}), (error) => error.code === code);
    assert.equal(sheet.moves.length, 0);
  }
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

test("new row insertion restores the exact basic filter range and criteria", async () => {
  const sheet = new Sheet([
    ["level", "title", "artist", "md5", "comment"],
    row("0", 1),
  ]);
  const hiddenTitles = Object.freeze({ hiddenValues: ["Hidden Title"] });
  const originalFilter = new BasicFilter(
    sheet,
    sheet.getRange(1, 1, 14954, 5),
    new Map([[2, hiddenTitles]]),
  );
  sheet.filter = originalFilter;
  const context = await loadMasterTable(sheet);

  context.insertAdminMasterBlankRow_(sheet, 3);

  assert.equal(originalFilter.removed, true);
  assert.deepEqual(sheet.insertions, [{ type: "before", rowNumber: 3, count: 1 }]);
  assert.equal(sheet.filter.getRange().getA1Notation(), "A1:E14954");
  assert.equal(sheet.filter.getColumnFilterCriteria(2), hiddenTitles);
});

test("delete row preserves filter criteria and shrinks a covering range", async () => {
  const sheet = new Sheet([
    ["level", "title", "artist", "md5", "comment"],
    row("0", 1),
    row("1", 2),
  ]);
  const hiddenTitles = Object.freeze({ hiddenValues: ["Hidden Title"] });
  const originalFilter = new BasicFilter(
    sheet,
    sheet.getRange(1, 1, 3, 5),
    new Map([[2, hiddenTitles]]),
  );
  sheet.filter = originalFilter;
  const context = await loadMasterTable(sheet);

  context.deleteAdminMasterRow_(sheet, 2);

  assert.equal(originalFilter.removed, false);
  assert.deepEqual(sheet.deletions, [2]);
  assert.equal(sheet.filter.getRange().getA1Notation(), "A1:E2");
  assert.equal(sheet.filter.getColumnFilterCriteria(2), hiddenTitles);
  assert.deepEqual(sheet.rows.map((value) => value[0]), ["level", "1"]);
});
