import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const headers = [
  "反映", "申請種別", "投稿日時", "BMSIRユーザー名", "BMSIRプレイヤーID",
  "曲名", "artist", "md5", "投稿時現難易度", "難易度案", "コメント", "IR URL",
  "状態", "反映日時", "処理メモ", "request_id", "client_version", "エラーコード", "再試行回数",
];

class Range {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? "",
      ),
    );
  }

  setValues(values) {
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      const targetRow = this.row - 1 + rowOffset;
      this.sheet.rows[targetRow] ??= [];
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        this.sheet.rows[targetRow][this.column - 1 + columnOffset] = values[rowOffset][columnOffset];
      }
    }
  }
}

class Sheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map((row) => [...row]);
    this.frozenRows = 0;
  }

  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new Range(this, row, column, rowCount, columnCount);
  }
  setFrozenRows(value) { this.frozenRows = value; }
}

class Spreadsheet {
  constructor(sheet) {
    this.sheet = sheet;
  }

  getSheetByName(name) {
    return this.sheet?.name === name ? this.sheet : null;
  }

  insertSheet(name) {
    this.sheet = new Sheet(name);
    return this.sheet;
  }

  getId() { return "test-spreadsheet"; }
}

async function loadSetup(initialSheet) {
  const spreadsheet = new Spreadsheet(initialSheet);
  const rawWrites = [];
  const context = vm.createContext({
    ADMIN_APPLICATION_HEADERS: Object.freeze(headers),
    ADMIN_CONFIG: Object.freeze({ applicationSheetName: "申請一覧" }),
    getAdminSpreadsheet_() { return spreadsheet; },
    throwAdminError_(code, message, state) {
      const error = new Error(message);
      Object.assign(error, { code, state });
      throw error;
    },
    Sheets: {
      Spreadsheets: {
        Values: {
          update(resource, spreadsheetId, range, options) {
            const match = /^'申請一覧'!M(\d+):S\1$/.exec(range);
            if (!match || spreadsheetId !== spreadsheet.getId()) throw new Error("bad range");
            spreadsheet.sheet.getRange(Number(match[1]), 13, 1, 7).setValues(resource.values);
            rawWrites.push({ resource, spreadsheetId, range, options });
          },
        },
      },
    },
  });
  const source = await readFile(new URL("../apps-script/admin/ApplicationSheet.gs", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "ApplicationSheet.gs" });
  return { context, spreadsheet, rawWrites };
}

test("admin setup creates the A:S application sheet without production identifiers", async () => {
  const { context, spreadsheet } = await loadSetup(null);
  const result = context.setupAdminApplicationSheet();
  assert.equal(result.created, true);
  assert.equal(result.columns, 19);
  assert.deepEqual(spreadsheet.sheet.rows[0], headers);
  assert.equal(spreadsheet.sheet.frozenRows, 1);
});

test("admin setup preserves an existing valid sheet and its data", async () => {
  const existingRow = ["", "change", "2026/08/11 12:00:00"];
  const sheet = new Sheet("申請一覧", [headers, existingRow]);
  const { context } = await loadSetup(sheet);
  const before = structuredClone(sheet.rows);
  const result = context.setupAdminApplicationSheet();
  assert.equal(result.created, false);
  assert.deepEqual(sheet.rows, before);
  assert.equal(sheet.frozenRows, 1);
});

test("admin setup rejects an existing incompatible sheet instead of overwriting it", async () => {
  const sheet = new Sheet("申請一覧", [["wrong", "schema"], ["keep", "this"]]);
  const { context } = await loadSetup(sheet);
  const before = structuredClone(sheet.rows);
  assert.throws(() => context.setupAdminApplicationSheet(), (error) => error.code === "SHEET_SCHEMA_INVALID");
  assert.deepEqual(sheet.rows, before);
});

test("application outcomes update only M:S with RAW input", async () => {
  const applicationRow = [
    "○", "new", "2026/08/14 12:00:00", "User", "190072",
    "=Literal Title", "+Literal Artist", "00000000000000000000000000000001", "", "13-",
    "comment", "https://bms-ir.org/new/song?songmd5=00000000000000000000000000000001",
    "未処理", "", "", "request-id", "0.4.2", "", 0,
  ];
  const sheet = new Sheet("申請一覧", [headers, applicationRow]);
  const { context, rawWrites } = await loadSetup(sheet);
  const protectedValues = sheet.rows[1].slice(0, 12);
  context.updateAdminApplicationOutcome_(context.getAdminSpreadsheet_(), sheet, 2, {
    state: "反映済",
    appliedAt: "2026/08/14 12:34:56",
    memo: "kkj反映完了",
    errorCode: "",
    retryCount: 1,
  });
  assert.deepEqual(sheet.rows[1].slice(0, 12), protectedValues);
  assert.deepEqual(sheet.rows[1].slice(12, 19), [
    "反映済", "2026/08/14 12:34:56", "kkj反映完了", "request-id", "0.4.2", "", 1,
  ]);
  assert.equal(rawWrites.length, 1);
  assert.equal(rawWrites[0].range, "'申請一覧'!M2:S2");
  assert.equal(rawWrites[0].options.valueInputOption, "RAW");
});
