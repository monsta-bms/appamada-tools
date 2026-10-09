import { ApiClientError } from "./api-client.js";
import { codePointLength, resolveSongElements } from "./bmsir-parser.js";
import { OFFLINE_NOTICE, isCommunicationError } from "./outbox.js";
import {
  SPECIAL_LEVELS,
  STEP_LEVELS,
  getEasierLevel,
  getHarderLevel,
  isSpecialLevel,
} from "./levels.js";

const ERROR_MESSAGES = Object.freeze({
  API_NETWORK_ERROR: "通信に失敗しました。時間を置いて再度お試しください。",
  API_TIMEOUT: "通信がタイムアウトしました。時間を置いて再度お試しください。",
  API_INVALID_RESPONSE: "サーバーから正しい応答を取得できませんでした。",
  API_NOT_CONFIGURED: "申請APIが設定されていません。",
  SUBMISSIONS_DISABLED: "現在、不放逸への申請受付を一時停止しています。",
  BAD_REQUEST: "送信内容を確認できませんでした。",
  APPLICATION_TYPE_INVALID: "申請種別が正しくありません。",
  LOGIN_NAME_MISSING: "BMSIRのログインユーザー名を取得できませんでした。",
  PLAYER_ID_INVALID: "BMSIRプレイヤーIDを確認できませんでした。",
  MD5_INVALID: "譜面MD5が正しくありません。",
  MD5_MISMATCH: "BMSIR URLと譜面MD5が一致しません。",
  IR_URL_INVALID: "BMSIR譜面URLが正しくありません。",
  CHART_NOT_FOUND: "不放逸に登録されていません。",
  CHART_DUPLICATED: "同じMD5の譜面が複数登録されています。管理者へご連絡ください。",
  CHART_ALREADY_EXISTS: "すでに不放逸に登録されています。",
  CURRENT_LEVEL_UNSUPPORTED: "現在の難易度は申請対象外です。",
  TITLE_REQUIRED: "曲名を取得できませんでした。",
  TITLE_TOO_LONG: "曲名が長すぎます。",
  ARTIST_REQUIRED: "artistを取得できませんでした。",
  ARTIST_TOO_LONG: "artistが長すぎます。",
  LEVEL_REQUIRED: "難易度を選択してください。",
  LEVEL_INVALID: "選択した難易度が正しくありません。",
  SAME_AS_CURRENT: "現在と異なる難易度を選択してください。",
  COMMENT_TOO_LONG: "コメントは500文字以内にしてください。",
  CLIENT_VERSION_INVALID: "Userscriptのバージョン情報が正しくありません。",
  REQUEST_ID_INVALID: "送信識別子を生成できませんでした。",
  RATE_LIMITED: "短時間の投稿数が多すぎます。少し待ってください。",
  LOCK_TIMEOUT: "サーバーが混み合っています。時間を置いて再度お試しください。",
  SHEET_NOT_FOUND: "申請先シートが設定されていません。",
  SHEET_SCHEMA_INVALID: "申請先シートの構成が正しくありません。",
  REQUEST_ID_CONFLICT: "送信識別子が競合しました。画面を開き直してください。",
  WRITE_FAILED: "申請一覧へ保存できませんでした。",
  INTERNAL_ERROR: "サーバー内部でエラーが発生しました。",
  OUTBOX_STORAGE_UNAVAILABLE: "保存した提案の読み書きができませんでした。保存権限や空き容量を確認してください。送信状況は「保存した提案」で確認してください。",
  OUTBOX_INVALID_DATA: "保存した提案を読み取れませんでした。データは削除していません。",
  OUTBOX_FULL: "保存件数が上限に達しました。保存した提案から送信済み・受付不可の項目を消してください。",
  OUTBOX_CONFLICT: "同じ申請の保存内容が一致しません。保存した提案を確認してください。",
  OUTBOX_CANNOT_CANCEL: "送信を試みた提案は、受け付けられた可能性があるため取り消せません。",
  OUTBOX_BUSY: "保存した提案を送信中です。少し待ってください。",
});

const STYLE = `
.appamada-menu,.appamada-overlay{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.appamada-menu{position:fixed;z-index:12000;min-width:190px;padding:6px;background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 8px 24px #0004}
.appamada-menu-title{padding:6px 10px;font-weight:700;border-bottom:1px solid #ddd}
.appamada-menu button,.appamada-modal button{font:inherit}
.appamada-menu button{display:block;width:100%;padding:8px 10px;text-align:left;border:0;background:transparent;border-radius:5px;color:inherit;cursor:pointer}
.appamada-menu button:hover,.appamada-menu button:focus{background:#e8eef8;outline:2px solid #4b75b8}
.appamada-overlay{position:fixed;inset:0;z-index:12010;display:grid;place-items:center;padding:20px;background:#0008}
.appamada-modal{box-sizing:border-box;width:min(680px,100%);max-height:90vh;overflow:auto;padding:20px;background:#fff;color:#222;color-scheme:light;border-radius:12px;box-shadow:0 14px 40px #0006}
.appamada-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #ddd}
.appamada-modal-header h2{margin:0 0 12px;font-size:1.25rem;color:#222;font-weight:700;opacity:1;text-shadow:none}
.appamada-close{padding:5px 10px;border:1px solid #888;border-radius:5px;background:#fff;color:#222;opacity:1;-webkit-text-fill-color:#222;cursor:pointer}
.appamada-modal .appamada-close:disabled{background:#eee;color:#777;-webkit-text-fill-color:#777;cursor:not-allowed}
.appamada-facts{display:grid;grid-template-columns:max-content 1fr;gap:5px 12px;margin:16px 0}
.appamada-facts dt{font-weight:700}.appamada-facts dd{margin:0;overflow-wrap:anywhere}
.appamada-level-grid{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px}
.appamada-level-grid button,.appamada-step button{padding:6px 10px;border:1px solid #777;border-radius:6px;background:#fff;color:#222;cursor:pointer}
.appamada-level-grid button[aria-pressed="true"]{background:#244f91;color:#fff;border-color:#244f91}
.appamada-step button:disabled,.appamada-level-grid button:disabled{background:#eee;color:#777;cursor:not-allowed;opacity:1}
.appamada-step{display:flex;align-items:center;justify-content:center;gap:10px;margin:12px 0}
.appamada-selected{min-width:90px;text-align:center;font-weight:700;font-size:1.2rem}
.appamada-comment{display:grid;gap:5px;margin:14px 0}.appamada-comment textarea{box-sizing:border-box;width:100%;min-height:90px;padding:8px;border:1px solid #777;background:#fff;color:#222;color-scheme:light;opacity:1;-webkit-text-fill-color:#222;caret-color:#222;font:inherit}
.appamada-count{text-align:right}.appamada-count-error{color:#b00020;font-weight:700}
.appamada-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.appamada-submit{padding:8px 16px;border:0;border-radius:6px;background:#244f91;color:#fff;cursor:pointer}.appamada-submit:disabled{background:#999;cursor:not-allowed}
.appamada-submit-danger{background:#a51d2d}.appamada-warning{padding:10px;border-left:4px solid #a51d2d;background:#fff1f2;color:#6f101c}
.appamada-status{margin:12px 0;padding:10px;border-radius:6px;background:#eef3fb}.appamada-status-error{background:#fdebec;color:#8b0018}.appamada-status-success{background:#e8f6ec;color:#145a28}
.appamada-subheading{margin:14px 0 4px;font-weight:700}
.appamada-saved-item{padding:12px 0;border-bottom:1px solid #ddd}.appamada-saved-item p{overflow-wrap:anywhere}
`;

function element(document, tagName, options = {}) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  return node;
}

function addFact(document, list, label, value) {
  list.append(element(document, "dt", { text: label }), element(document, "dd", { text: value }));
}

export function createRequestId(cryptoObject) {
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  if (typeof cryptoObject?.getRandomValues !== "function") {
    throw new Error("Secure UUID generation is unavailable");
  }
  const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function errorMessageFor(code) {
  return ERROR_MESSAGES[code] ?? "申請を処理できませんでした。時間を置いて再度お試しください。";
}

export function installSubmissionUi({
  document,
  window,
  parsedPage,
  apiClient,
  outbox,
  clientVersion = "0.0.0",
  cryptoObject = window.crypto,
  addStyle,
  logger,
}) {
  const resolvedSongElements = resolveSongElements(document);
  if (!resolvedSongElements.ok) {
    const error = new Error("Parsed song elements are no longer available");
    error.code = resolvedSongElements.error;
    throw error;
  }
  const { titleElement, artistElement } = resolvedSongElements;

  if (typeof addStyle === "function") {
    addStyle(STYLE);
  } else if (!document.querySelector("style[data-appamada-style]")) {
    const style = element(document, "style");
    style.dataset.appamadaStyle = "true";
    style.textContent = STYLE;
    document.head.append(style);
  }

  let activeMenu = null;
  let activeModal = null;
  let lookupUnavailableUntil = 0;

  function markLookupUnavailable(code) {
    if (isCommunicationError(code)) lookupUnavailableUntil = Date.now() + 30_000;
  }

  function offlineInfo(shell) {
    shell.content.append(statusNode(document, OFFLINE_NOTICE), statusNode(document,
      outbox ? "提案はこのブラウザに保存され、通信が回復したら順番に送信されます。"
        : errorMessageFor("OUTBOX_STORAGE_UNAVAILABLE"), outbox ? "info" : "error"));
  }

  function closeMenu() {
    activeMenu?.remove();
    activeMenu = null;
  }

  function closeModal() {
    activeModal?.overlay.remove();
    activeModal = null;
  }

  function modalShell(title) {
    closeModal();
    const overlay = element(document, "div", { className: "appamada-overlay" });
    const modal = element(document, "section", { className: "appamada-modal" });
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const header = element(document, "header", { className: "appamada-modal-header" });
    const heading = element(document, "h2", { text: title });
    const close = element(document, "button", {
      className: "appamada-close",
      text: "閉じる",
      type: "button",
    });
    close.addEventListener("click", closeModal);
    header.append(heading, close);
    const content = element(document, "div");
    modal.append(header, content);
    overlay.append(modal);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeModal();
    });
    document.body.append(overlay);
    activeModal = { overlay, modal, content };
    close.focus();
    return activeModal;
  }

  function statusNode(document, message, kind = "info") {
    const status = element(document, "p", {
      className: `appamada-status${kind === "error" ? " appamada-status-error" : ""}${kind === "success" ? " appamada-status-success" : ""}`,
      text: message,
    });
    status.setAttribute("role", kind === "error" ? "alert" : "status");
    return status;
  }

  function showMessage(title, message, kind = "error") {
    const shell = modalShell(title);
    shell.content.append(statusNode(document, message, kind));
  }

  function facts(values) {
    const list = element(document, "dl", { className: "appamada-facts" });
    for (const [label, value] of values) addFact(document, list, label, String(value));
    return list;
  }

  function commentField(onChange) {
    const wrapper = element(document, "label", { className: "appamada-comment" });
    wrapper.append(element(document, "span", { text: "コメント（任意）" }));
    const textarea = element(document, "textarea");
    const count = element(document, "span", { className: "appamada-count", text: "0 / 500" });
    textarea.addEventListener("input", () => {
      const length = codePointLength(textarea.value);
      count.textContent = `${length} / 500`;
      count.classList.toggle("appamada-count-error", length > 500);
      onChange();
    });
    wrapper.append(textarea, count);
    return { wrapper, textarea };
  }

  function levelButton(level, onSelect) {
    const button = element(document, "button", { text: level, type: "button" });
    button.dataset.level = level;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => onSelect(level));
    return button;
  }

  function commonPayload(applicationType, comment) {
    return {
      application_type: applicationType,
      request_id: createRequestId(cryptoObject),
      md5: parsedPage.song.md5,
      proposed_level: "",
      comment,
      bmsir_user_name: parsedPage.user.name,
      bmsir_player_id: parsedPage.user.playerId,
      ir_url: parsedPage.song.irUrl,
      client_version: clientVersion,
    };
  }

  async function runSubmit({ payload, button, updateDisabled, statusContainer, offline = false }) {
    if (button.dataset.submitting === "true") return;
    button.dataset.submitting = "true";
    button.textContent = offline ? "保存中…" : "送信中…";
    updateDisabled();
    statusContainer.replaceChildren(statusNode(document, offline ? "提案をブラウザに保存しています。" : "申請を送信しています。"));
    try {
      if (outbox) {
        const entry = await outbox.enqueue(payload, parsedPage.song, { defer: offline });
        const result = offline ? entry : await outbox.send(entry.payload.request_id);
        if (result.status === "sent") {
          statusContainer.replaceChildren(statusNode(document, "申請を送信しました。", "success"));
          button.textContent = "送信済み";
        } else if (result.status === "rejected") {
          statusContainer.replaceChildren(statusNode(document, errorMessageFor(result.errorCode), "error"));
          button.dataset.submitting = "false";
          button.textContent = offline ? "ブラウザに保存" : "申請を送信";
          updateDisabled();
          return;
        } else {
          markLookupUnavailable(result.errorCode);
          const reason = result.errorCode && !isCommunicationError(result.errorCode)
            ? `${errorMessageFor(result.errorCode)} ` : "";
          statusContainer.replaceChildren(statusNode(document,
            `${isCommunicationError(result.errorCode) ? `${OFFLINE_NOTICE}。 ` : ""}${reason}提案をブラウザに保存しました。まだ送信完了していません。通信が回復したら再送します。右クリックの「保存した提案」から確認できます。`));
          button.textContent = "保存済み（送信待ち）";
        }
        button.dataset.completed = "true";
        updateDisabled();
        return;
      }
      const result = await apiClient.submit(payload);
      if (result.ok) {
        const message = result.deduplicated
          ? "この申請はすでに送信済みです。"
          : "申請を送信しました。";
        statusContainer.replaceChildren(statusNode(document, message, "success"));
        button.textContent = "送信済み";
        button.dataset.completed = "true";
        return;
      }
      logger?.debug?.("SUBMIT_FAILED", result.error.code);
      statusContainer.replaceChildren(
        statusNode(document, errorMessageFor(result.error.code), "error"),
      );
    } catch (error) {
      const code = error?.code ?? "INTERNAL_ERROR";
      logger?.debug?.("SUBMIT_FAILED", code);
      statusContainer.replaceChildren(statusNode(document, errorMessageFor(code), "error"));
    }
    button.dataset.submitting = "false";
    button.textContent = offline ? "ブラウザに保存" : "申請を送信";
    updateDisabled();
  }

  function renderChange(chart, offline = false) {
    const shell = modalShell("不放逸 難易度変更申請");
    if (offline) offlineInfo(shell);
    shell.content.append(
      facts([
        ["曲名", chart.title],
        ["artist", chart.artist],
        ["投稿者", parsedPage.user.name],
        ["現在難易度", offline ? "取得できません" : chart.current_level],
      ]),
    );

    let selectedLevel = offline ? null : chart.current_level;
    const step = element(document, "div", { className: "appamada-step" });
    const harder = element(document, "button", { text: "難しく ↑", type: "button" });
    const selected = element(document, "span", { className: "appamada-selected" });
    const easier = element(document, "button", { text: "易しく ↓", type: "button" });
    if (offline) {
      for (const button of [harder, easier]) {
        button.title = "現在難易度を取得できないため選択できません。下のレベルから直接選んでください。";
        button.setAttribute("aria-label", `${button.textContent}（現在難易度を取得できないため選択できません）`);
      }
    }
    step.append(harder, selected, easier);

    shell.content.append(element(document, "p", { className: "appamada-subheading", text: "変更案" }), step);

    const specialGrid = element(document, "div", { className: "appamada-level-grid" });
    const specialButtons = SPECIAL_LEVELS.map((level) => levelButton(level, selectLevel));
    specialGrid.append(...specialButtons);
    shell.content.append(
      element(document, "p", { className: "appamada-subheading", text: "特殊レベル" }),
      specialGrid,
    );

    const normalHeading = element(document, "p", {
      className: "appamada-subheading",
      text: "通常レベルを直接選択",
    });
    const normalGrid = element(document, "div", { className: "appamada-level-grid" });
    const normalButtons = STEP_LEVELS.map((level) => levelButton(level, selectLevel));
    normalGrid.append(...normalButtons);
    shell.content.append(normalHeading, normalGrid);

    let comment;
    const commentControl = commentField(update);
    comment = commentControl.textarea;
    shell.content.append(commentControl.wrapper);
    const statusContainer = element(document, "div");
    const actions = element(document, "div", { className: "appamada-actions" });
    const submit = element(document, "button", {
      className: "appamada-submit",
      text: offline ? "ブラウザに保存" : "申請を送信",
      type: "button",
    });
    actions.append(submit);
    shell.content.append(statusContainer, actions);

    function selectLevel(level) {
      selectedLevel = level;
      update();
    }

    function update() {
      selected.textContent = selectedLevel === null ? "選択してください" : `卍${selectedLevel}`;
      const harderLevel = getHarderLevel(selectedLevel);
      const easierLevel = getEasierLevel(selectedLevel);
      const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
      harder.disabled = offline || busy || harderLevel === null;
      easier.disabled = offline || busy || easierLevel === null;
      for (const button of [...specialButtons, ...normalButtons]) {
        button.setAttribute("aria-pressed", String(button.dataset.level === selectedLevel));
        button.disabled = busy;
      }
      const showNormalGrid = offline || isSpecialLevel(chart.current_level) || isSpecialLevel(selectedLevel);
      normalHeading.hidden = !showNormalGrid;
      normalGrid.hidden = !showNormalGrid;
      submit.disabled =
        busy || (offline && !outbox) || selectedLevel === null ||
        (!offline && selectedLevel === chart.current_level) || codePointLength(comment.value) > 500;
    }

    harder.addEventListener("click", () => {
      const level = getHarderLevel(selectedLevel);
      if (level !== null) selectLevel(level);
    });
    easier.addEventListener("click", () => {
      const level = getEasierLevel(selectedLevel);
      if (level !== null) selectLevel(level);
    });
    submit.addEventListener("click", () => {
      if (submit.disabled) return;
      const payload = commonPayload("change", comment.value.normalize("NFC"));
      payload.proposed_level = selectedLevel;
      void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer, offline });
    });
    update();
  }

  function renderNew(offline = false) {
    const shell = modalShell("不放逸 新規譜面申請");
    if (offline) offlineInfo(shell);
    shell.content.append(
      facts([
        ["曲名", parsedPage.song.title],
        ["artist", parsedPage.song.artist],
        ["md5", parsedPage.song.md5],
        ["投稿者", parsedPage.user.name],
      ]),
      element(document, "p", { className: "appamada-subheading", text: "難易度" }),
    );

    let selectedLevel = null;
    const groups = [
      ["通常", STEP_LEVELS.slice(0, 10)],
      ["10～12", STEP_LEVELS.slice(10, 19)],
      ["高難度", STEP_LEVELS.slice(19)],
      ["特殊", SPECIAL_LEVELS],
    ];
    const levelButtons = [];
    for (const [label, levels] of groups) {
      const grid = element(document, "div", { className: "appamada-level-grid" });
      const buttons = levels.map((level) => levelButton(level, selectLevel));
      levelButtons.push(...buttons);
      grid.append(...buttons);
      shell.content.append(
        element(document, "p", { className: "appamada-subheading", text: label }),
        grid,
      );
    }

    let comment;
    const commentControl = commentField(update);
    comment = commentControl.textarea;
    shell.content.append(commentControl.wrapper);
    const statusContainer = element(document, "div");
    const actions = element(document, "div", { className: "appamada-actions" });
    const submit = element(document, "button", {
      className: "appamada-submit",
      text: offline ? "ブラウザに保存" : "申請を送信",
      type: "button",
    });
    actions.append(submit);
    shell.content.append(statusContainer, actions);

    function selectLevel(level) {
      selectedLevel = level;
      update();
    }

    function update() {
      const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
      for (const button of levelButtons) {
        button.setAttribute("aria-pressed", String(button.dataset.level === selectedLevel));
        button.disabled = busy;
      }
      submit.disabled = busy || (offline && !outbox) || selectedLevel === null || codePointLength(comment.value) > 500;
    }

    submit.addEventListener("click", () => {
      if (submit.disabled) return;
      const payload = commonPayload("new", comment.value.normalize("NFC"));
      Object.assign(payload, {
        title: parsedPage.song.title,
        artist: parsedPage.song.artist,
        proposed_level: selectedLevel,
      });
      void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer, offline });
    });
    update();
  }

  function renderDelete(chart, offline = false) {
    const shell = modalShell("不放逸 削除申請");
    if (offline) offlineInfo(shell);
    shell.content.append(
      facts([
        ["曲名", chart.title],
        ["artist", chart.artist],
        ["投稿者", parsedPage.user.name],
        ["現在難易度", offline ? "取得できません" : chart.current_level],
      ]),
      element(document, "p", {
        className: "appamada-warning",
        text: "卍0未満として不放逸から削除すべき譜面のみ申請してください。",
      }),
    );

    let comment;
    const commentControl = commentField(update);
    comment = commentControl.textarea;
    shell.content.append(commentControl.wrapper);
    const statusContainer = element(document, "div");
    const actions = element(document, "div", { className: "appamada-actions" });
    const submit = element(document, "button", {
      className: "appamada-submit appamada-submit-danger",
      text: offline ? "ブラウザに保存" : "申請を送信",
      type: "button",
    });
    actions.append(submit);
    shell.content.append(statusContainer, actions);

    function update() {
      const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
      submit.disabled = busy || (offline && !outbox) || codePointLength(comment.value) > 500;
    }

    submit.addEventListener("click", () => {
      if (submit.disabled) return;
      const payload = commonPayload("delete", comment.value.normalize("NFC"));
      payload.proposed_level = "削除";
      void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer, offline });
    });
    update();
  }

  async function openWorkflow(applicationType) {
    closeMenu();
    function renderOffline() {
      if (applicationType === "change") renderChange(parsedPage.song, true);
      else if (applicationType === "delete") renderDelete(parsedPage.song, true);
      else renderNew(true);
    }
    if (lookupUnavailableUntil > Date.now()) { renderOffline(); return; }
    const shell = modalShell("不放逸 申請");
    shell.content.append(statusNode(document, "登録状況を確認しています。"));
    try {
      const lookup = await apiClient.lookup(parsedPage.song.md5);
      if (activeModal !== shell) return;
      lookupUnavailableUntil = 0;
      if (!lookup.ok) {
        logger?.debug?.("LOOKUP_FAILED", lookup.error.code);
        showMessage("申請できません", errorMessageFor(lookup.error.code));
        return;
      }
      if ((applicationType === "change" || applicationType === "delete") && !lookup.exists) {
        showMessage(
          "申請できません",
          "不放逸に未登録です。新規譜面申請を利用してください。",
        );
        return;
      }
      if (applicationType === "new" && lookup.exists) {
        showMessage(
          "申請できません",
          "すでに不放逸に登録されています。難易度変更申請を利用してください。",
        );
        return;
      }
      if (applicationType === "change") renderChange(lookup.chart);
      else if (applicationType === "delete") renderDelete(lookup.chart);
      else renderNew();
    } catch (error) {
      const code = error instanceof ApiClientError ? error.code : "INTERNAL_ERROR";
      logger?.debug?.("LOOKUP_FAILED", code);
      if (activeModal !== shell) return;
      if (isCommunicationError(code)) {
        markLookupUnavailable(code);
        renderOffline();
      } else showMessage("通信エラー", errorMessageFor(code));
    }
  }

  async function showSaved() {
    closeMenu();
    const shell = modalShell("不放逸 保存した提案");
    shell.content.append(statusNode(document,
      "このブラウザに保存した提案です。BMS-IRの譜面ページを開いている間、送信待ちの提案を順番に送信します。"));
    const actions = element(document, "div", { className: "appamada-actions" });
    const retry = element(document, "button", { className: "appamada-submit", type: "button", text: "送信待ちを再送" });
    const refresh = element(document, "button", { className: "appamada-close", type: "button", text: "表示を更新" });
    const backup = element(document, "button", { className: "appamada-close", type: "button", text: "控えを保存" });
    const status = element(document, "div");
    const items = element(document, "div");
    actions.append(retry, refresh, backup);
    shell.content.append(actions, status, items);
    async function updateList() {
      try {
        const entries = await outbox.list();
        if (activeModal !== shell) return;
        items.replaceChildren();
        if (!entries.length) items.append(statusNode(document, "保存した提案はありません。"));
        for (const entry of entries) {
          const item = element(document, "section", { className: "appamada-saved-item" });
          const labels = { change: "難易度変更", new: "新規譜面", delete: "削除" };
          const states = { pending: "送信待ち", sending: "送信結果を確認中", sent: "送信済み", rejected: "受付不可" };
          item.append(facts([
            ["曲名", entry.metadata.title], ["artist", entry.metadata.artist],
            ["提案", `${labels[entry.payload.application_type]}：${entry.payload.proposed_level}`],
            ["状態", states[entry.status]], ["コメント", entry.payload.comment],
          ]));
          if (entry.errorCode && entry.status !== "sent") item.append(statusNode(document, errorMessageFor(entry.errorCode), "error"));
          const remove = element(document, "button", { className: "appamada-close", type: "button",
            text: ["sent", "rejected"].includes(entry.status) ? "控えを消す" : "保存を取り消す" });
          remove.disabled = !["sent", "rejected"].includes(entry.status) && entry.attempts > 0;
          if (remove.disabled) remove.title = "送信を試みたため、受付状況が確定するまで取り消せません。";
          remove.addEventListener("click", async () => {
            try { await outbox.remove(entry.payload.request_id); await updateList(); }
            catch (error) { status.replaceChildren(statusNode(document, errorMessageFor(error.code), "error")); }
          });
          item.append(remove);
          items.append(item);
        }
      } catch (error) { status.replaceChildren(statusNode(document, errorMessageFor(error.code), "error")); }
    }
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      status.replaceChildren(statusNode(document, "保存した提案を確認・送信しています。"));
      try {
        await outbox.flush({ manual: true });
        status.replaceChildren(statusNode(document, "送信状況を確認してください。通信不調や投稿間隔の制限がある場合は、時間を置いて再送します。"));
      } catch (error) { status.replaceChildren(statusNode(document, errorMessageFor(error.code), "error")); }
      retry.disabled = false;
      await updateList();
    });
    refresh.addEventListener("click", () => void updateList());
    backup.addEventListener("click", async () => {
      try {
        const data = await outbox.exportData();
        const link = element(document, "a", { text: "保存した提案の控えをダウンロード" });
        link.href = `data:application/json;charset=utf-8,${encodeURIComponent(data)}`;
        link.download = "appamada-saved-proposals.json";
        status.replaceChildren(link);
      } catch (error) { status.replaceChildren(statusNode(document, errorMessageFor(error.code), "error")); }
    });
    shell.savedRefresh = updateList;
    await updateList();
  }

  const unsubscribe = outbox?.subscribe(() => {
    // Only refresh the saved list; never replace a form the user is editing.
    if (activeModal?.savedRefresh) void activeModal.savedRefresh();
  });

  function showMenu(event) {
    if (event.shiftKey) return;
    event.preventDefault();
    closeMenu();
    const menu = element(document, "div", { className: "appamada-menu" });
    menu.setAttribute("role", "menu");
    menu.append(element(document, "div", { className: "appamada-menu-title", text: "卍 不放逸" }));
    for (const [label, type] of [
      ["難易度変更申請", "change"],
      ["新規譜面申請", "new"],
      ["削除申請(難易度が卍0未満)", "delete"],
    ]) {
      const button = element(document, "button", { text: label, type: "button" });
      button.dataset.action = type;
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => void openWorkflow(type));
      menu.append(button);
    }
    if (outbox) {
      const saved = element(document, "button", { text: "保存した提案", type: "button" });
      saved.dataset.action = "saved";
      saved.setAttribute("role", "menuitem");
      saved.addEventListener("click", () => void showSaved());
      menu.append(saved);
    }
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    activeMenu = menu;
    menu.querySelector("button")?.focus();
  }

  function onDocumentClick(event) {
    if (activeMenu && !activeMenu.contains(event.target)) closeMenu();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      closeMenu();
      closeModal();
    }
  }

  titleElement.addEventListener("contextmenu", showMenu);
  artistElement.addEventListener("contextmenu", showMenu);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", closeMenu, true);
  window.addEventListener("resize", closeMenu);

  return Object.freeze({
    closeMenu,
    closeModal,
    markLookupUnavailable,
    destroy() {
      closeMenu();
      closeModal();
      unsubscribe?.();
      titleElement.removeEventListener("contextmenu", showMenu);
      artistElement.removeEventListener("contextmenu", showMenu);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    },
  });
}
