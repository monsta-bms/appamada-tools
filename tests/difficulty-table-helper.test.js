import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const DELETED_MD5 = "00000000000000000000000000000001";
const NORMAL_MD5 = "00000000000000000000000000000002";

class Range {
  constructor(sheet, row, column, rowCount, columnCount) {
    Object.assign(this, { sheet, row, column, rowCount, columnCount });
  }
  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? "",
      ),
    );
  }
  setValues(values) {
    values.forEach((valuesRow, rowOffset) => {
      const target = this.row - 1 + rowOffset;
      this.sheet.rows[target] ??= [];
      valuesRow.forEach((value, columnOffset) => {
        this.sheet.rows[target][this.column - 1 + columnOffset] = value;
      });
    });
  }
  setValue(value) {
    this.setValues([[value]]);
  }
}

class Sheet {
  constructor(name, rows) {
    this.name = name;
    this.rows = rows.map((row) => [...row]);
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getDataRange() {
    const width = Math.max(1, ...this.rows.map((row) => row.length));
    return new Range(this, 1, 1, this.rows.length, width);
  }
  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new Range(this, row, column, rowCount, columnCount);
  }
  deleteRows(start, count) {
    this.rows.splice(start - 1, count);
  }
}

test("仮置き reflection blocks deleted MD5 in G while normal rows still move", async () => {
  const karioki = new Sheet("仮置き", [
    ["反映", "level", "title", "artist", "md5", "comment", "処理コメント"],
    ["○", "10", "Deleted", "Artist", DELETED_MD5, "old", ""],
    ["○", "10-", "Normal", "Artist", NORMAL_MD5, "2026.6.1 new", ""],
  ]);
  const main = new Sheet("kkj", [["level", "title", "artist", "md5", "comment"]]);
  const deleted = new Sheet("削除済", [
    ["level", "title", "artist", "md5", "comment"],
    ["0", "Deleted", "Artist", DELETED_MD5, "old"],
  ]);
  const sheets = new Map([[karioki.name, karioki], [main.name, main], [deleted.name, deleted]]);
  const alerts = [];
  const context = vm.createContext({
    addAdminMenu_() {},
    SpreadsheetApp: {
      getUi() {
        return {
          ButtonSet: { OK: "OK" },
          alert(...args) { alerts.push(args); },
        };
      },
      getActiveSpreadsheet() {
        return { getSheetByName(name) { return sheets.get(name) ?? null; } };
      },
    },
    LockService: {
      getDocumentLock() {
        return { tryLock: () => true, releaseLock() {} };
      },
    },
    normalizeAdminCommentDates_(value) {
      return String(value).replace("2026.6.1", "2026/06/01");
    },
  });
  const source = await readFile(
    new URL("../apps-script/admin/DifficultyTableHelper.gs", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, context, { filename: "DifficultyTableHelper.gs" });
  context.reflectCheckedRowsToMain();

  assert.equal(karioki.rows.length, 2);
  assert.equal(karioki.rows[1][0], "○");
  assert.equal(karioki.rows[1][6], "削除済重複");
  assert.deepEqual(main.rows[1], ["10-", "Normal", "Artist", NORMAL_MD5, "2026/06/01 new"]);
  assert.equal(deleted.rows.length, 2);
  assert.match(alerts.at(-1)[1], /削除済重複: 1件/);
});
