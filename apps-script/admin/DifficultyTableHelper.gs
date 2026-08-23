// 難易度表作成補助ツール v0.8
// 仮置き -> 難易度表本体(kkj) 反映用 Apps Script
// 既存のWeb公開用 doGet() はこのファイルには入れていません。
// Apps Scriptエディタで新規ファイルとして追加するか、既存コードの下へ追記してください。

const KARIOKI_SHEET_NAME = '仮置き';
const MAIN_SHEET_NAME = 'kkj';
const DELETED_SHEET_NAME = '削除済';
const MENU_NAME = '難易度表補助';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(MENU_NAME)
    .addItem('○付き行をkkjへ反映', 'reflectCheckedRowsToMain')
    .addItem('kkjをlevel順ソート', 'sortMainSheetFromMenu')
    .addItem('重複行を削除', 'deleteDuplicateRowsFromKarioki')
    .addToUi();
  addAdminMenu_();
}

/**
 * 仮置きシートの「反映」列が完全一致で「○」の行だけを、kkjへ移動する。
 *
 * 仕様:
 * - 仮置き必須ヘッダー: 反映, level, title, artist, md5, comment
 * - 本体必須ヘッダー: level, title, artist, md5, comment
 * - 列位置は固定しない。ヘッダー名で判定する。
 * - md5が32桁hexでない行は反映列へ「失敗」と記入し、仮置きに残す。
 * - 削除済に同じmd5がある行はG列へ「削除済重複」と記入し、仮置きに残す。
 * - kkjに同じmd5がある行は反映列へ「重複」と記入し、仮置きに残す。
 * - 追記成功行だけ仮置きから削除する。
 * - level空欄は「?」としてkkjへ入れる。
 * - kkjはlevel昇順でソートする。10- -> 10 -> 10+ の順に対応し、「?」は末尾に置く。
 */
function reflectCheckedRowsToMain() {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    ui.alert('別の処理が実行中です。少し待ってから再実行してください。');
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const karioki = getSheetOrThrow_(ss, KARIOKI_SHEET_NAME);
    const main = getSheetOrThrow_(ss, MAIN_SHEET_NAME);
    const deleted = getSheetOrThrow_(ss, DELETED_SHEET_NAME);

    const kariokiData = getDataWithHeader_(karioki, ['反映', 'level', 'title', 'artist', 'md5', 'comment']);
    const mainData = getDataWithHeader_(main, ['level', 'title', 'artist', 'md5', 'comment']);
    const deletedData = getDataWithHeader_(deleted, ['level', 'title', 'artist', 'md5', 'comment']);

    const kReflect = kariokiData.headerMap['反映'];
    const kLevel = kariokiData.headerMap['level'];
    const kTitle = kariokiData.headerMap['title'];
    const kArtist = kariokiData.headerMap['artist'];
    const kMd5 = kariokiData.headerMap['md5'];
    const kComment = kariokiData.headerMap['comment'];

    const mainMd5Set = buildMainMd5Set_(mainData);
    const deletedMd5Set = buildMainMd5Set_(deletedData);
    const pendingMd5Set = new Set();

    const appendRows = [];
    const deleteRowNumbers = [];
    const statusUpdates = [];
    const deletedStatusUpdates = [];
    let successCount = 0;
    let duplicateCount = 0;
    let deletedDuplicateCount = 0;
    let failCount = 0;
    let targetCount = 0;

    for (let i = kariokiData.headerRowIndex + 1; i < kariokiData.values.length; i++) {
      const row = kariokiData.values[i];
      const reflect = cellText_(row[kReflect]).trim();
      if (reflect !== '○') continue;
      targetCount++;

      const md5Original = cellText_(row[kMd5]).trim();
      const md5 = md5Original.toLowerCase();
      if (!isValidMd5_(md5)) {
        statusUpdates.push({ rowNumber: i + 1, value: '失敗' });
        failCount++;
        continue;
      }

      if (deletedMd5Set.has(md5)) {
        deletedStatusUpdates.push({ rowNumber: i + 1, value: '削除済重複' });
        deletedDuplicateCount++;
        continue;
      }

      if (mainMd5Set.has(md5) || pendingMd5Set.has(md5)) {
        statusUpdates.push({ rowNumber: i + 1, value: '重複' });
        duplicateCount++;
        continue;
      }

      const mainRow = new Array(mainData.headers.length).fill('');
      mainRow[mainData.headerMap['level']] = normalizeLevel_(row[kLevel]);
      mainRow[mainData.headerMap['title']] = cellText_(row[kTitle]).trim();
      mainRow[mainData.headerMap['artist']] = cellText_(row[kArtist]).trim();
      mainRow[mainData.headerMap['md5']] = md5;
      mainRow[mainData.headerMap['comment']] = cellText_(row[kComment]).trim();

      appendRows.push(mainRow);
      deleteRowNumbers.push(i + 1);
      pendingMd5Set.add(md5);
      successCount++;
    }

    // 失敗・重複ステータスを先に書く。成功行は後で削除する。
    writeStatusUpdates_(karioki, kReflect + 1, statusUpdates);
    writeStatusUpdates_(karioki, 7, deletedStatusUpdates);

    if (appendRows.length > 0) {
      appendRowsToMain_(main, mainData, appendRows);
      deleteRowsByNumber_(karioki, deleteRowNumbers);
      sortMainSheetByLevel_(main);
    }

    ui.alert(
      'kkj反映完了',
      '対象: ' + targetCount + '件\n' +
      '移動成功: ' + successCount + '件\n' +
      '削除済重複: ' + deletedDuplicateCount + '件\n' +
      '重複: ' + duplicateCount + '件\n' +
      '失敗: ' + failCount + '件',
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('反映処理エラー', String(e && e.message ? e.message : e), ui.ButtonSet.OK);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * kkjをlevel順に並び替える。
 * 追加反映なしで、既存本体だけを並び替えたい時に使う。
 */
function sortMainSheetFromMenu() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const main = getSheetOrThrow_(ss, MAIN_SHEET_NAME);
  sortMainSheetByLevel_(main);
  ui.alert('kkjソート完了', '10- → 10 → 10+、?末尾の順で並び替えました。', ui.ButtonSet.OK);
}

/**
 * 仮置きシートの反映列が「重複」の行だけ削除する。
 */
function deleteDuplicateRowsFromKarioki() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const karioki = getSheetOrThrow_(ss, KARIOKI_SHEET_NAME);
  const data = getDataWithHeader_(karioki, ['反映']);

  const reflectCol = data.headerMap['反映'];
  const deleteRowNumbers = [];
  for (let i = data.headerRowIndex + 1; i < data.values.length; i++) {
    const reflect = cellText_(data.values[i][reflectCol]).trim();
    if (reflect === '重複') deleteRowNumbers.push(i + 1);
  }

  deleteRowsByNumber_(karioki, deleteRowNumbers);
  ui.alert('重複行削除', '削除: ' + deleteRowNumbers.length + '件', ui.ButtonSet.OK);
}

function appendRowsToMain_(main, mainData, appendRows) {
  if (!appendRows || appendRows.length === 0) return;

  const width = mainData.headers.length;
  const lastRow = Math.max(main.getLastRow(), mainData.headerRowNumber);
  main.getRange(lastRow + 1, 1, appendRows.length, width).setValues(appendRows);
}

function buildMainMd5Set_(mainData) {
  const md5Col = mainData.headerMap['md5'];
  const result = new Set();
  for (let i = mainData.headerRowIndex + 1; i < mainData.values.length; i++) {
    const md5 = cellText_(mainData.values[i][md5Col]).trim().toLowerCase();
    if (md5) result.add(md5);
  }
  return result;
}

function writeStatusUpdates_(sheet, reflectColumnNumber, statusUpdates) {
  if (!statusUpdates || statusUpdates.length === 0) return;
  for (const update of statusUpdates) {
    sheet.getRange(update.rowNumber, reflectColumnNumber).setValue(update.value);
  }
}

function sortMainSheetByLevel_(sheet) {
  const data = getDataWithHeader_(sheet, ['level']);
  const width = data.headers.length;
  const startRow = data.headerRowNumber + 1;
  const bodyRowCount = sheet.getLastRow() - data.headerRowNumber;
  if (bodyRowCount <= 0) return;

  const body = sheet.getRange(startRow, 1, bodyRowCount, width).getValues();
  const levelCol = data.headerMap['level'];
  const normalized = body.map((row, idx) => {
    while (row.length < width) row.push('');
    if (cellText_(row[levelCol]).trim() === '') row[levelCol] = '?';
    return { row: row.slice(0, width), idx: idx, key: sortKeyForLevel_(row[levelCol]) };
  });

  normalized.sort((a, b) => {
    if (a.key.rank !== b.key.rank) return a.key.rank - b.key.rank;
    if (a.key.num !== b.key.num) return a.key.num - b.key.num;
    if (a.key.suffix !== b.key.suffix) return a.key.suffix - b.key.suffix;
    if (a.key.text < b.key.text) return -1;
    if (a.key.text > b.key.text) return 1;
    return a.idx - b.idx;
  });

  sheet.getRange(startRow, 1, normalized.length, width).setValues(normalized.map(x => x.row));
}

function sortKeyForLevel_(value) {
  const s = cellText_(value).trim();

  // 「?」は必ず末尾。空欄は事前に「?」へ正規化される。
  if (s === '?') return { rank: 2, num: 0, suffix: 0, text: '' };

  // 10- -> 10 -> 10+ の順にする。
  // 先頭の - は負数として扱い、末尾の +/- だけを難易度補正記号として扱う。
  const m = s.match(/^(-?\d+(?:\.\d+)?)([+-])?$/);
  if (m) {
    const base = Number(m[1]);
    if (Number.isFinite(base)) {
      const suffixRank = m[2] === '-' ? -1 : (m[2] === '+' ? 1 : 0);
      return { rank: 0, num: base, suffix: suffixRank, text: '' };
    }
  }

  // 数値化できない特殊表記は、数値難易度の後ろ、?の前へ置く。
  return { rank: 1, num: 0, suffix: 0, text: s };
}

function normalizeLevel_(value) {
  const s = cellText_(value).trim();
  return s === '' ? '?' : s;
}

function isValidMd5_(value) {
  return /^[0-9a-fA-F]{32}$/.test(cellText_(value).trim());
}

function cellText_(value) {
  // GASの空セルは主に ''。ただし数値0を空欄扱いしないため、|| '' は使わない。
  if (value === null || value === undefined) return '';
  return String(value);
}

function getSheetOrThrow_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('シートがありません: ' + sheetName);
  return sheet;
}

function getDataWithHeader_(sheet, requiredHeaders) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length === 0) throw new Error(sheet.getName() + 'シートが空です');

  const headerRowIndex = findHeaderRowIndex_(values, requiredHeaders);
  const headers = values[headerRowIndex].map(v => cellText_(v).trim());
  const headerMap = {};
  headers.forEach((h, i) => { if (h) headerMap[h] = i; });
  requireHeaders_(headerMap, requiredHeaders, sheet.getName());

  return {
    values: values,
    headers: headers,
    headerMap: headerMap,
    headerRowIndex: headerRowIndex,
    headerRowNumber: headerRowIndex + 1
  };
}

function findHeaderRowIndex_(values, requiredHeaders) {
  for (let i = 0; i < values.length; i++) {
    const found = {};
    values[i].forEach(v => {
      const s = cellText_(v).trim();
      if (s) found[s] = true;
    });
    const ok = requiredHeaders.every(h => found[h]);
    if (ok) return i;
  }
  throw new Error('必須ヘッダー行が見つかりません: ' + requiredHeaders.join(', '));
}

function requireHeaders_(headerMap, required, sheetName) {
  const missing = required.filter(h => !(h in headerMap));
  if (missing.length > 0) {
    throw new Error(sheetName + 'シートに必須列がありません: ' + missing.join(', '));
  }
}

function deleteRowsByNumber_(sheet, rowNumbers) {
  if (!rowNumbers || rowNumbers.length === 0) return;
  const sorted = rowNumbers.slice().sort((a, b) => b - a);
  let start = sorted[0];
  let count = 1;

  for (let i = 1; i < sorted.length; i++) {
    const row = sorted[i];
    if (row === start - count) {
      count++;
    } else {
      sheet.deleteRows(start - count + 1, count);
      start = row;
      count = 1;
    }
  }
  sheet.deleteRows(start - count + 1, count);
}
