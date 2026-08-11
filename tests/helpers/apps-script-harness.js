import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

export const APPLICATION_HEADERS = [
  "反映", "申請種別", "投稿日時", "BMSIRユーザー名", "BMSIRプレイヤーID",
  "曲名", "artist", "md5", "投稿時現難易度", "難易度案", "コメント", "IR URL",
  "状態", "反映日時", "処理メモ", "request_id", "client_version", "エラーコード", "再試行回数",
];

const SOURCE_FILES = [
  "Config.gs",
  "Validation.gs",
  "Logging.gs",
  "Lookup.gs",
  "RateLimit.gs",
  "SheetStore.gs",
  "Submit.gs",
  "Api.gs",
];

class FakeTextFinder {
  constructor(range, query) {
    this.range = range;
    this.query = String(query);
    this.caseSensitive = false;
  }

  matchEntireCell() {
    return this;
  }

  matchCase(value) {
    this.caseSensitive = value;
    return this;
  }

  findAll() {
    const matches = [];
    const values = this.range.getValues();
    for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < values[rowOffset].length; columnOffset += 1) {
        const value = String(values[rowOffset][columnOffset]);
        const equal = this.caseSensitive
          ? value === this.query
          : value.toLowerCase() === this.query.toLowerCase();
        if (equal) {
          matches.push(
            new FakeRange(
              this.range.sheet,
              this.range.row + rowOffset,
              this.range.column + columnOffset,
              1,
              1,
            ),
          );
        }
      }
    }
    return matches;
  }
}

class FakeRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getRow() {
    return this.row;
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

  createTextFinder(query) {
    return new FakeTextFinder(this, query);
  }
}

class FakeSheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map((row) => [...row]);
    this.frozenRows = 0;
  }

  getName() {
    return this.name;
  }

  getLastRow() {
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (this.rows[index].some((value) => value !== "" && value !== null && value !== undefined)) {
        return index + 1;
      }
    }
    return 0;
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }

  setFrozenRows(count) {
    this.frozenRows = count;
  }
}

class FakeSpreadsheet {
  constructor(sheets) {
    this.sheets = new Map(sheets.map((sheet) => [sheet.name, sheet]));
  }

  getSheetByName(name) {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

class FakeCache {
  constructor() {
    this.values = new Map();
  }

  get(key) {
    return this.values.get(key) ?? null;
  }

  put(key, value) {
    this.values.set(key, String(value));
  }
}

function textOutput(content) {
  return {
    content,
    mimeType: null,
    setMimeType(mimeType) {
      this.mimeType = mimeType;
      return this;
    },
    getContent() {
      return this.content;
    },
  };
}

export async function createAppsScriptHarness({
  kkjRows = [],
  applicationHeaders = APPLICATION_HEADERS,
  includeApplicationSheet = true,
  properties = {},
  lockAvailable = true,
  writeFails = false,
} = {}) {
  const kkj = new FakeSheet("kkj", kkjRows);
  const application = includeApplicationSheet
    ? new FakeSheet("申請一覧", [applicationHeaders])
    : null;
  const spreadsheet = new FakeSpreadsheet([kkj, ...(application ? [application] : [])]);
  const cache = new FakeCache();
  const scriptProperties = new Map(Object.entries({
    SPREADSHEET_ID: "test-spreadsheet",
    SUBMIT_ENABLED: "true",
    ...properties,
  }));
  const rawWrites = [];
  const logs = [];
  const lockState = { available: lockAvailable, released: false };

  const context = vm.createContext({
    console: {
      log(value) {
        logs.push(String(value));
      },
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(name) {
            return scriptProperties.get(name) ?? null;
          },
        };
      },
    },
    CacheService: {
      getScriptCache() {
        return cache;
      },
    },
    LockService: {
      getScriptLock() {
        return {
          tryLock() {
            return lockState.available;
          },
          releaseLock() {
            lockState.released = true;
          },
        };
      },
    },
    SpreadsheetApp: {
      openById(id) {
        if (id !== "test-spreadsheet") throw new Error("Unknown spreadsheet");
        return spreadsheet;
      },
    },
    Sheets: {
      Spreadsheets: {
        Values: {
          update(resource, spreadsheetId, range, options) {
            if (writeFails) throw new Error("write failed");
            const match = /^'申請一覧'!A(\d+):S\1$/.exec(range);
            if (!match || spreadsheetId !== "test-spreadsheet") throw new Error("bad range");
            const target = spreadsheet.getSheetByName("申請一覧");
            target.getRange(Number(match[1]), 1, 1, 19).setValues(resource.values);
            rawWrites.push({ resource, spreadsheetId, range, options });
          },
        },
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest(_algorithm, value) {
        return [...createHash("sha256").update(String(value)).digest()];
      },
      formatDate(date, _timezone, format) {
        if (format === "yyyy/MM/dd HH:mm:ss") return "2026/08/11 12:34:56";
        return date.toISOString();
      },
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: textOutput,
    },
  });

  for (const file of SOURCE_FILES) {
    const source = await readFile(
      new URL(`../../apps-script/api/${file}`, import.meta.url),
      "utf8",
    );
    vm.runInContext(source, context, { filename: file });
  }

  return {
    context,
    logs,
    rawWrites,
    spreadsheet,
    lockState,
    applications() {
      const sheet = spreadsheet.getSheetByName("申請一覧");
      return sheet ? sheet.rows.slice(1) : [];
    },
    get(parameters) {
      const mapped = Object.fromEntries(
        Object.entries(parameters).map(([key, value]) => [key, Array.isArray(value) ? value : [value]]),
      );
      return JSON.parse(context.doGet({ parameters: mapped }).getContent());
    },
    post(payload) {
      return JSON.parse(
        context.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent(),
      );
    },
  };
}
