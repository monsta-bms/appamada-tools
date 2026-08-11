var AppamadaAdminLogic = (function () {
  "use strict";

  var PUBLISH_LEVEL_ORDER = Object.freeze([
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "10-", "10", "10+", "11-", "11", "11+", "12-", "12", "12+",
    "13", "13+", "14", "15", "16",
    "★★4?", "★★5?", "★★6?", "★★7?", "?",
  ]);
  var MD5_PATTERN = /^[0-9a-f]{32}$/i;
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var INVALID_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  var RETRYABLE_ERROR_CODES = Object.freeze(["LOCK_TIMEOUT", "GOOGLE_SERVICE_ERROR"]);
  var REVIEW_ERROR_CODES = Object.freeze([
    "STALE_CURRENT_LEVEL",
    "TABLE_ORDER_INVALID",
    "CHART_DUPLICATED",
    "CHART_ALREADY_EXISTS",
    "CHART_NOT_FOUND",
    "CELL_FORMULA_NOT_ALLOWED",
    "CELL_TEXT_INVALID",
    "CELL_TEXT_NOT_NORMALIZED",
    "METADATA_CONFLICT",
    "RECOVERY_FAILED",
    "APPLICATION_TYPE_INVALID",
    "MD5_INVALID",
    "REQUEST_ID_INVALID",
    "LEVEL_INVALID",
    "SAME_AS_CURRENT",
  ]);

  function text(value) {
    return String(value === null || value === undefined ? "" : value);
  }

  function fail(code, detail) {
    return { ok: false, code: code, detail: detail };
  }

  function analyzeTableOrder(rows, startRow) {
    var firstSheetRow = Number(startRow || 1);
    var levelIndexes = Object.create(null);
    PUBLISH_LEVEL_ORDER.forEach(function (level, index) { levelIndexes[level] = index; });
    var blocks = [];
    var seenLevels = Object.create(null);
    var seenMd5 = Object.create(null);
    var previousLevelIndex = -1;

    for (var index = 0; index < rows.length; index += 1) {
      var row = Array.isArray(rows[index]) ? rows[index] : [];
      var sheetRow = firstSheetRow + index;
      var isBlank = row.slice(0, 5).every(function (value) { return text(value) === ""; });
      if (isBlank) return fail("TABLE_ORDER_INVALID", "blank row at " + sheetRow);

      var level = text(row[0]);
      var md5 = text(row[3]).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(levelIndexes, level)) {
        return fail("TABLE_ORDER_INVALID", "unknown level at " + sheetRow + ": " + level);
      }
      if (!MD5_PATTERN.test(md5)) {
        return fail("TABLE_ORDER_INVALID", "invalid md5 at " + sheetRow);
      }
      if (seenMd5[md5]) {
        return fail("CHART_DUPLICATED", "duplicate md5 at " + seenMd5[md5] + " and " + sheetRow);
      }
      seenMd5[md5] = sheetRow;

      var levelIndex = levelIndexes[level];
      var previousBlock = blocks.length ? blocks[blocks.length - 1] : null;
      if (previousBlock && previousBlock.level === level) {
        previousBlock.endRow = sheetRow;
        previousBlock.endIndex = index;
        continue;
      }
      if (seenLevels[level]) {
        return fail("TABLE_ORDER_INVALID", "split level block: " + level);
      }
      if (levelIndex < previousLevelIndex) {
        return fail("TABLE_ORDER_INVALID", "level block out of order: " + level);
      }
      seenLevels[level] = true;
      previousLevelIndex = levelIndex;
      blocks.push({
        level: level,
        startRow: sheetRow,
        endRow: sheetRow,
        startIndex: index,
        endIndex: index,
      });
    }
    return { ok: true, blocks: blocks, md5Count: Object.keys(seenMd5).length };
  }

  function insertionIndex(rows, level) {
    var targetOrder = PUBLISH_LEVEL_ORDER.indexOf(level);
    if (targetOrder === -1) return fail("LEVEL_INVALID", "unknown target level: " + level);
    var analysis = analyzeTableOrder(rows, 1);
    if (!analysis.ok) return analysis;
    for (var index = 0; index < analysis.blocks.length; index += 1) {
      var block = analysis.blocks[index];
      if (block.level === level) return { ok: true, index: block.endIndex + 1 };
      if (PUBLISH_LEVEL_ORDER.indexOf(block.level) > targetOrder) {
        return { ok: true, index: block.startIndex };
      }
    }
    return { ok: true, index: rows.length };
  }

  function planMove(rows, sourceIndex, targetLevel) {
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= rows.length) {
      return fail("TABLE_ORDER_INVALID", "source row is outside table");
    }
    var before = analyzeTableOrder(rows, 1);
    if (!before.ok) return before;
    var remaining = rows.map(function (row) { return row.slice(); });
    var moved = remaining.splice(sourceIndex, 1)[0];
    moved[0] = targetLevel;
    var insertion = insertionIndex(remaining, targetLevel);
    if (!insertion.ok) return insertion;
    remaining.splice(insertion.index, 0, moved);
    var after = analyzeTableOrder(remaining, 1);
    if (!after.ok) return after;
    return {
      ok: true,
      sourceIndex: sourceIndex,
      finalIndex: insertion.index,
      rows: remaining,
    };
  }

  function moveRowsDestinationIndex(sourceRow, finalRow, rowCount) {
    var count = Number(rowCount || 1);
    return finalRow > sourceRow ? finalRow + count : finalRow;
  }

  function moveTouchesFrozenRows(sourceRow, finalRow, frozenRows) {
    var count = Number(frozenRows || 0);
    return count > 0 && (sourceRow <= count || finalRow <= count);
  }

  function moveCrossesRow(sourceRow, finalRow, rowNumber) {
    return Math.min(sourceRow, finalRow) <= rowNumber && rowNumber <= Math.max(sourceRow, finalRow);
  }

  function appendCommentHistory(existingComment, history) {
    var existing = text(existingComment);
    var item = text(history);
    if (!item) return existing;
    var parts = existing ? existing.split(" / ") : [];
    if (parts.indexOf(item) !== -1) return existing;
    return existing ? existing + " / " + item : item;
  }

  function validateCellText(value, maximum) {
    if (typeof value !== "string" || value.length === 0) {
      return fail("CELL_TEXT_INVALID", "cell must contain non-empty text");
    }
    if (value.trim() !== value || INVALID_CONTROL_PATTERN.test(value)) {
      return fail("CELL_TEXT_INVALID", "cell text has invalid edges or controls");
    }
    if (value.normalize("NFC") !== value) {
      return fail("CELL_TEXT_NOT_NORMALIZED", "cell text must be NFC");
    }
    if (Array.from(value).length > maximum) {
      return fail("CELL_TEXT_INVALID", "cell text is too long");
    }
    return { ok: true, value: value };
  }

  function validateApplication(record, formulas, allowError) {
    var formulaMap = formulas || {};
    var protectedFields = ["md5", "originalLevel", "targetLevel", "requestId"];
    if (record.applicationType === "new") protectedFields.push("title", "artist");
    if (protectedFields.some(function (field) { return Boolean(formulaMap[field]); })) {
      return fail("CELL_FORMULA_NOT_ALLOWED", "a field used for apply contains a formula");
    }
    if (record.applyMark !== "○") return fail("NOT_APPROVED", "apply mark is not ○");
    if (!canProcessState(record.state, allowError)) {
      return fail("STATE_NOT_PROCESSABLE", "state is not processable: " + text(record.state));
    }
    if (record.applicationType !== "change" && record.applicationType !== "new") {
      return fail("APPLICATION_TYPE_INVALID", "application type is invalid");
    }
    if (!MD5_PATTERN.test(text(record.md5))) return fail("MD5_INVALID", "md5 is invalid");
    if (!UUID_PATTERN.test(text(record.requestId))) {
      return fail("REQUEST_ID_INVALID", "request_id is invalid");
    }
    if (PUBLISH_LEVEL_ORDER.indexOf(text(record.targetLevel)) === -1) {
      return fail("LEVEL_INVALID", "target level is invalid");
    }
    if (record.applicationType === "change") {
      if (PUBLISH_LEVEL_ORDER.indexOf(text(record.originalLevel)) === -1) {
        return fail("LEVEL_INVALID", "original level is invalid");
      }
      if (record.originalLevel === record.targetLevel) {
        return fail("SAME_AS_CURRENT", "target equals original level");
      }
    } else {
      if (text(record.originalLevel) !== "") {
        return fail("CELL_TEXT_INVALID", "new application original level must be empty");
      }
      var title = validateCellText(record.title, 1000);
      if (!title.ok) return title;
      var artist = validateCellText(record.artist, 500);
      if (!artist.ok) return artist;
    }
    return { ok: true };
  }

  function isRetryableError(code) {
    return RETRYABLE_ERROR_CODES.indexOf(text(code)) !== -1;
  }

  function failureState(code) {
    return REVIEW_ERROR_CODES.indexOf(text(code)) !== -1 ? "要確認" : "エラー";
  }

  function canProcessState(state, allowError) {
    return state === "未処理" || (Boolean(allowError) && state === "エラー");
  }

  return Object.freeze({
    PUBLISH_LEVEL_ORDER: PUBLISH_LEVEL_ORDER,
    RETRYABLE_ERROR_CODES: RETRYABLE_ERROR_CODES,
    analyzeTableOrder: analyzeTableOrder,
    insertionIndex: insertionIndex,
    planMove: planMove,
    moveRowsDestinationIndex: moveRowsDestinationIndex,
    moveTouchesFrozenRows: moveTouchesFrozenRows,
    moveCrossesRow: moveCrossesRow,
    appendCommentHistory: appendCommentHistory,
    validateCellText: validateCellText,
    validateApplication: validateApplication,
    isRetryableError: isRetryableError,
    failureState: failureState,
    canProcessState: canProcessState,
  });
}());
