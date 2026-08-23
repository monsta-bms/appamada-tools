import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const MD5 = "00000000000000000000000000000001";
const HEADERS = ["level", "title", "artist", "md5", "comment"];

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
}

class Sheet {
  constructor(rows) {
    this.rows = rows.map((row) => [...row]);
  }
  getName() { return "削除済"; }
  getLastRow() { return this.rows.length; }
  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new Range(this, row, column, rowCount, columnCount);
  }
}

async function loadHarness(rows = [HEADERS]) {
  const sheet = new Sheet(rows);
  const spreadsheet = {
    getId() { return "spreadsheet"; },
    getSheetByName(name) { return name === "削除済" ? sheet : null; },
  };
  const writes = [];
  const context = vm.createContext({
    ADMIN_CONFIG: Object.freeze({ deletedSheetName: "削除済" }),
    throwAdminError_(code, message, state) {
      const error = new Error(message);
      Object.assign(error, { code, state });
      throw error;
    },
    Sheets: {
      Spreadsheets: {
        Values: {
          update(resource, spreadsheetId, range, options) {
            const match = /^'削除済'!A(\d+):E\1$/.exec(range);
            if (!match || spreadsheetId !== "spreadsheet") throw new Error("bad range");
            sheet.getRange(Number(match[1]), 1, 1, 5).setValues(resource.values);
            writes.push({ resource, spreadsheetId, range, options });
          },
        },
      },
    },
  });
  const source = await readFile(new URL("../apps-script/admin/DeletedTable.gs", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "DeletedTable.gs" });
  return { context, sheet, spreadsheet, writes };
}

test("deleted chart lookup rejects new applications with the exact state", async () => {
  const { context, spreadsheet } = await loadHarness([
    HEADERS,
    ["0", "Old", "Artist", MD5.toUpperCase(), "deleted"],
  ]);
  assert.throws(
    () => context.assertAdminChartNotDeleted_(spreadsheet, MD5, {}),
    (error) => error.code === "DELETED_CHART_DUPLICATE" &&
      error.message === "削除済重複" && error.state === "削除済重複",
  );
});

test("delete archival appends A:E with RAW and is idempotent", async () => {
  const { context, sheet, spreadsheet, writes } = await loadHarness();
  const shared = {};
  const row = ["0", "=Literal title", "+Literal artist", MD5, "@Literal comment"];
  const first = context.archiveAdminDeletedChart_(spreadsheet, row, shared);
  const second = context.archiveAdminDeletedChart_(spreadsheet, row, shared);
  assert.deepEqual({ ...first }, { ok: true, alreadyArchived: false, rowNumber: 2 });
  assert.deepEqual({ ...second }, { ok: true, alreadyArchived: true, rowNumber: 2 });
  assert.deepEqual(sheet.rows[1], row);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].range, "'削除済'!A2:E2");
  assert.equal(writes[0].options.valueInputOption, "RAW");
});

test("deleted sheet requires the exact A:E schema and valid MD5 values", async () => {
  const badHeader = await loadHarness([["md5", "title"]]);
  assert.throws(
    () => badHeader.context.getAdminDeletedState_(badHeader.spreadsheet, {}),
    (error) => error.code === "SHEET_SCHEMA_INVALID",
  );
  const badMd5 = await loadHarness([HEADERS, ["0", "Title", "Artist", "bad", ""]]);
  assert.throws(
    () => badMd5.context.getAdminDeletedState_(badMd5.spreadsheet, {}),
    (error) => error.code === "SHEET_SCHEMA_INVALID",
  );
});
