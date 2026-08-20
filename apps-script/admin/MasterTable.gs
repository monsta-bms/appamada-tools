function getAdminMasterSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(ADMIN_CONFIG.masterSheetName);
  if (!sheet) throwAdminError_("SHEET_NOT_FOUND", "kkj sheet was not found", "エラー");
  return sheet;
}

function readAdminMasterRows_(sheet) {
  var lastRow = sheet.getLastRow();
  return lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 5).getValues();
}

function readValidatedAdminMasterState_(sheet) {
  var rows = readAdminMasterRows_(sheet);
  var analysis = AppamadaAdminLogic.analyzeTableOrder(rows, 2);
  if (!analysis.ok) throwAdminError_(analysis.code, analysis.detail, "要確認");
  return { rows: rows, analysis: analysis };
}

function getAdminMasterState_(sheet, context) {
  if (context && context.masterState) return context.masterState;
  var state = readValidatedAdminMasterState_(sheet);
  if (context) context.masterState = state;
  return state;
}

function refreshAdminMasterState_(sheet, context) {
  var state = readValidatedAdminMasterState_(sheet);
  if (context) context.masterState = state;
  return state;
}

function assertAdminTableOrder_(sheet) {
  return readValidatedAdminMasterState_(sheet).analysis;
}

function findAdminMasterIndexesByMd5_(rows, md5) {
  var normalized = String(md5).toLowerCase();
  var matches = [];
  rows.forEach(function (row, index) {
    if (String(row[3]).toLowerCase() === normalized) matches.push(index);
  });
  return matches;
}

function findAdminMasterRowsByMd5_(sheet, md5) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet
    .getRange(2, 4, lastRow - 1, 1)
    .createTextFinder(md5)
    .matchEntireCell(true)
    .matchCase(false)
    .findAll()
    .map(function (range) { return range.getRow(); });
}

function writeAdminMasterRowRaw_(spreadsheet, sheet, rowNumber, row) {
  var range = "'" + sheet.getName().replace(/'/g, "''") + "'!A" + rowNumber + ":E" + rowNumber;
  try {
    Sheets.Spreadsheets.Values.update(
      { values: [row] },
      spreadsheet.getId(),
      range,
      { valueInputOption: "RAW" },
    );
  } catch (error) {
    throwAdminError_("GOOGLE_SERVICE_ERROR", "kkj row could not be written", "エラー");
  }
}

function insertAdminMasterBlankRow_(sheet, rowNumber) {
  var filterSnapshot = captureAdminFilterForInsert_(sheet, rowNumber);
  var filterRemoved = false;
  var operationError = null;
  try {
    if (filterSnapshot) {
      filterSnapshot.filter.remove();
      filterRemoved = true;
    }
    if (rowNumber <= sheet.getMaxRows()) sheet.insertRowsBefore(rowNumber, 1);
    else sheet.insertRowsAfter(sheet.getMaxRows(), rowNumber - sheet.getMaxRows());
  } catch (error) {
    operationError = error;
  } finally {
    if (filterRemoved) {
      try {
        restoreAdminFilter_(sheet, filterSnapshot);
      } catch (filterRestoreError) {
        if (!operationError) operationError = filterRestoreError;
      }
    }
  }
  if (operationError) {
    throwAdminError_(
      "GOOGLE_SERVICE_ERROR",
      "kkj blank row could not be inserted: " + String(operationError.message || operationError),
      "エラー",
    );
  }
}

function deleteAdminMasterRow_(sheet, rowNumber) {
  if (rowNumber < 2 || rowNumber > sheet.getLastRow()) {
    throwAdminError_("CHART_NOT_FOUND", "kkj delete target is outside the data rows", "要確認");
  }
  try {
    sheet.deleteRow(rowNumber);
  } catch (error) {
    throwAdminError_(
      "GOOGLE_SERVICE_ERROR",
      "kkj row could not be deleted: " + String(error.message || error),
      "エラー",
    );
  }
}

function captureAdminFilter_(sheet) {
  var filter = sheet.getFilter();
  if (!filter) return null;
  var range = filter.getRange();
  var criteria = [];
  for (var column = range.getColumn(); column <= range.getLastColumn(); column += 1) {
    var value = filter.getColumnFilterCriteria(column);
    if (value) criteria.push({ column: column, value: value });
  }
  return {
    filter: filter,
    rangeA1: range.getA1Notation(),
    lastRow: range.getLastRow(),
    criteria: criteria,
  };
}

function captureAdminFilterForInsert_(sheet, rowNumber) {
  var snapshot = captureAdminFilter_(sheet);
  return snapshot && rowNumber <= snapshot.lastRow ? snapshot : null;
}

function captureAdminFilterForMove_(sheet, sourceRow, finalRow) {
  var snapshot = captureAdminFilter_(sheet);
  if (!snapshot) return null;
  var range = snapshot.filter.getRange();
  if (!AppamadaAdminLogic.moveCrossesRow(sourceRow, finalRow, range.getRow())) return null;
  return snapshot;
}

function restoreAdminFilter_(sheet, snapshot) {
  var filter = sheet.getRange(snapshot.rangeA1).createFilter();
  snapshot.criteria.forEach(function (item) {
    filter.setColumnFilterCriteria(item.column, item.value);
  });
}

function moveAdminMasterRows_(sheet, sourceRow, finalRow, rowCount) {
  var count = Number(rowCount || 1);
  if (sourceRow === finalRow || count < 1) return;
  var destination = AppamadaAdminLogic.moveRowsDestinationIndex(sourceRow, finalRow, count);
  var frozenRows = sheet.getFrozenRows();
  var temporarilyUnfrozen = AppamadaAdminLogic.moveTouchesFrozenRows(
    sourceRow,
    finalRow,
    frozenRows,
  );
  var filterSnapshot = captureAdminFilterForMove_(sheet, sourceRow, finalRow);
  var filterRemoved = false;
  var operationError = null;
  try {
    if (filterSnapshot) {
      filterSnapshot.filter.remove();
      filterRemoved = true;
    }
    if (temporarilyUnfrozen) sheet.setFrozenRows(0);
    sheet.moveRows(sheet.getRange(sourceRow, 1, count, 1), destination);
  } catch (error) {
    operationError = error;
  } finally {
    if (filterRemoved) {
      try {
        restoreAdminFilter_(sheet, filterSnapshot);
      } catch (filterRestoreError) {
        if (!operationError) operationError = filterRestoreError;
      }
    }
    if (temporarilyUnfrozen) {
      try {
        sheet.setFrozenRows(frozenRows);
      } catch (restoreError) {
        if (!operationError) operationError = restoreError;
      }
    }
  }
  if (operationError) {
    throwAdminError_(
      "GOOGLE_SERVICE_ERROR",
      "kkj row could not be moved: " + String(operationError.message || operationError),
      "エラー",
    );
  }
}

function moveAdminMasterRow_(sheet, sourceRow, finalRow) {
  moveAdminMasterRows_(sheet, sourceRow, finalRow, 1);
}

function ensureAdminMasterOrderForApply_(sheet, context) {
  if (context && context.masterState) return context.masterState;
  var rows = readAdminMasterRows_(sheet);
  var analysis = AppamadaAdminLogic.analyzeTableOrder(rows, 2);
  if (analysis.ok) {
    var validState = { rows: rows, analysis: analysis };
    if (context) context.masterState = validState;
    return validState;
  }
  if (analysis.code !== "TABLE_ORDER_INVALID") {
    throwAdminError_(analysis.code, analysis.detail, "要確認");
  }

  var plan = AppamadaAdminLogic.planStableTableSort(rows, 2);
  if (!plan.ok) throwAdminError_(plan.code, plan.detail, "要確認");
  if (!plan.changed) throwAdminError_(analysis.code, analysis.detail, "要確認");

  var currentRows = rows.map(function (row) { return row.slice(); });
  var cursor = 0;
  var moveCount = 0;
  AppamadaAdminLogic.PUBLISH_LEVEL_ORDER.forEach(function (level) {
    while (cursor < currentRows.length) {
      var sourceIndex = -1;
      for (var index = cursor; index < currentRows.length; index += 1) {
        if (String(currentRows[index][0]) === level) {
          sourceIndex = index;
          break;
        }
      }
      if (sourceIndex === -1) break;
      var runLength = 1;
      while (
        sourceIndex + runLength < currentRows.length &&
        String(currentRows[sourceIndex + runLength][0]) === level
      ) runLength += 1;
      if (sourceIndex !== cursor) {
        moveAdminMasterRows_(sheet, sourceIndex + 2, cursor + 2, runLength);
        var movedRows = currentRows.splice(sourceIndex, runLength);
        currentRows = currentRows.slice(0, cursor).concat(movedRows, currentRows.slice(cursor));
        moveCount += 1;
      }
      cursor += runLength;
    }
  });

  var repairedState = refreshAdminMasterState_(sheet, context);
  logAdminDiagnostic_({ action: "repair_table_order", result: "success" });
  repairedState.orderRepairMoveCount = moveCount;
  return repairedState;
}

function planAdminMasterMove_(sheet, sourceRow, targetLevel, rows) {
  rows = rows || readAdminMasterRows_(sheet);
  var plan = AppamadaAdminLogic.planMove(rows, sourceRow - 2, targetLevel);
  if (!plan.ok) throwAdminError_(plan.code, plan.detail, "要確認");
  return { finalRow: plan.finalIndex + 2, rows: plan.rows };
}

function planAdminMasterInsertion_(sheet, targetLevel, rows) {
  rows = rows || readAdminMasterRows_(sheet);
  var insertion = AppamadaAdminLogic.insertionIndex(rows, targetLevel);
  if (!insertion.ok) throwAdminError_(insertion.code, insertion.detail, "要確認");
  return insertion.index + 2;
}

function auditAdminMd5Duplicates_() {
  var spreadsheet = getAdminSpreadsheet_();
  var sheet = getAdminMasterSheet_(spreadsheet);
  var rows = readAdminMasterRows_(sheet);
  var seen = Object.create(null);
  var duplicates = [];
  rows.forEach(function (row, index) {
    var md5 = String(row[3] || "").toLowerCase();
    if (seen[md5]) duplicates.push({ md5: md5, rows: [seen[md5], index + 2] });
    else seen[md5] = index + 2;
  });
  if (duplicates.length) throwAdminError_("CHART_DUPLICATED", JSON.stringify(duplicates), "要確認");
  return { ok: true, duplicateCount: 0, rowCount: rows.length };
}

function auditAdminTableOrder_() {
  var spreadsheet = getAdminSpreadsheet_();
  var sheet = getAdminMasterSheet_(spreadsheet);
  var result = assertAdminTableOrder_(sheet);
  return { ok: true, blockCount: result.blocks.length, rowCount: result.md5Count };
}
