import { ApiClientError } from "./api-client.js";
import { codePointLength } from "./bmsir-parser.js";
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
});

const STYLE = `
.appamada-menu,.appamada-overlay{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.appamada-menu{position:fixed;z-index:12000;min-width:190px;padding:6px;background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 8px 24px #0004}
.appamada-menu-title{padding:6px 10px;font-weight:700;border-bottom:1px solid #ddd}
.appamada-menu button,.appamada-modal button{font:inherit}
.appamada-menu button{display:block;width:100%;padding:8px 10px;text-align:left;border:0;background:transparent;border-radius:5px;color:inherit;cursor:pointer}
.appamada-menu button:hover,.appamada-menu button:focus{background:#e8eef8;outline:2px solid #4b75b8}
.appamada-overlay{position:fixed;inset:0;z-index:12010;display:grid;place-items:center;padding:20px;background:#0008}
.appamada-modal{box-sizing:border-box;width:min(680px,100%);max-height:90vh;overflow:auto;padding:20px;background:#fff;color:#222;border-radius:12px;box-shadow:0 14px 40px #0006}
.appamada-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #ddd}
.appamada-modal-header h2{margin:0 0 12px;font-size:1.25rem;color:#222;font-weight:700;opacity:1;text-shadow:none}
.appamada-close{padding:5px 10px;border:1px solid #888;border-radius:5px;background:#fff;cursor:pointer}
.appamada-facts{display:grid;grid-template-columns:max-content 1fr;gap:5px 12px;margin:16px 0}
.appamada-facts dt{font-weight:700}.appamada-facts dd{margin:0;overflow-wrap:anywhere}
.appamada-level-grid{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px}
.appamada-level-grid button,.appamada-step button{padding:6px 10px;border:1px solid #777;border-radius:6px;background:#fff;color:#222;cursor:pointer}
.appamada-level-grid button[aria-pressed="true"]{background:#244f91;color:#fff;border-color:#244f91}
.appamada-step{display:flex;align-items:center;justify-content:center;gap:10px;margin:12px 0}
.appamada-selected{min-width:90px;text-align:center;font-weight:700;font-size:1.2rem}
.appamada-comment{display:grid;gap:5px;margin:14px 0}.appamada-comment textarea{box-sizing:border-box;width:100%;min-height:90px;padding:8px;font:inherit}
.appamada-count{text-align:right}.appamada-count-error{color:#b00020;font-weight:700}
.appamada-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.appamada-submit{padding:8px 16px;border:0;border-radius:6px;background:#244f91;color:#fff;cursor:pointer}.appamada-submit:disabled{background:#999;cursor:not-allowed}
.appamada-submit-danger{background:#a51d2d}.appamada-warning{padding:10px;border-left:4px solid #a51d2d;background:#fff1f2;color:#6f101c}
.appamada-status{margin:12px 0;padding:10px;border-radius:6px;background:#eef3fb}.appamada-status-error{background:#fdebec;color:#8b0018}.appamada-status-success{background:#e8f6ec;color:#145a28}
.appamada-subheading{margin:14px 0 4px;font-weight:700}
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
  clientVersion = "0.0.0",
  cryptoObject = window.crypto,
  addStyle,
  logger,
}) {
  const titleElement = document.querySelector("#box > h1");
  const artistElement = titleElement?.nextElementSibling;
  if (!titleElement || artistElement?.tagName !== "H2") {
    throw new Error("Parsed song elements are no longer available");
  }

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

  async function runSubmit({ payload, button, updateDisabled, statusContainer }) {
    if (button.dataset.submitting === "true") return;
    button.dataset.submitting = "true";
    button.textContent = "送信中…";
    updateDisabled();
    statusContainer.replaceChildren(statusNode(document, "申請を送信しています。"));
    try {
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
      const code = error instanceof ApiClientError ? error.code : "INTERNAL_ERROR";
      logger?.debug?.("SUBMIT_FAILED", code);
      statusContainer.replaceChildren(statusNode(document, errorMessageFor(code), "error"));
    }
    button.dataset.submitting = "false";
    button.textContent = "申請を送信";
    updateDisabled();
  }

  function renderChange(chart) {
    const shell = modalShell("不放逸 難易度変更申請");
    shell.content.append(
      facts([
        ["曲名", chart.title],
        ["artist", chart.artist],
        ["投稿者", parsedPage.user.name],
        ["現在難易度", chart.current_level],
      ]),
    );

    let selectedLevel = chart.current_level;
    const step = element(document, "div", { className: "appamada-step" });
    const harder = element(document, "button", { text: "難しく ↑", type: "button" });
    const selected = element(document, "span", { className: "appamada-selected" });
    const easier = element(document, "button", { text: "易しく ↓", type: "button" });
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
      text: "申請を送信",
      type: "button",
    });
    actions.append(submit);
    shell.content.append(statusContainer, actions);

    function selectLevel(level) {
      selectedLevel = level;
      update();
    }

    function update() {
      selected.textContent = `☸${selectedLevel}`;
      const harderLevel = getHarderLevel(selectedLevel);
      const easierLevel = getEasierLevel(selectedLevel);
      const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
      harder.disabled = busy || harderLevel === null;
      easier.disabled = busy || easierLevel === null;
      for (const button of [...specialButtons, ...normalButtons]) {
        button.setAttribute("aria-pressed", String(button.dataset.level === selectedLevel));
        button.disabled = busy;
      }
      const showNormalGrid = isSpecialLevel(chart.current_level) || isSpecialLevel(selectedLevel);
      normalHeading.hidden = !showNormalGrid;
      normalGrid.hidden = !showNormalGrid;
      submit.disabled =
        busy || selectedLevel === chart.current_level || codePointLength(comment.value) > 500;
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
      void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer });
    });
    update();
  }

  function renderNew() {
    const shell = modalShell("不放逸 新規譜面申請");
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
      text: "申請を送信",
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
      submit.disabled = busy || selectedLevel === null || codePointLength(comment.value) > 500;
    }

    submit.addEventListener("click", () => {
      if (submit.disabled) return;
      const payload = commonPayload("new", comment.value.normalize("NFC"));
      Object.assign(payload, {
        title: parsedPage.song.title,
        artist: parsedPage.song.artist,
        proposed_level: selectedLevel,
      });
      void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer });
    });
    update();
  }

  function renderDelete(chart) {
    const shell = modalShell("不放逸 削除申請");
    shell.content.append(
      facts([
        ["曲名", chart.title],
        ["artist", chart.artist],
        ["投稿者", parsedPage.user.name],
        ["現在難易度", chart.current_level],
      ]),
      element(document, "p", {
        className: "appamada-warning",
        text: "☸0未満として不放逸から削除すべき譜面のみ申請してください。採用されると管理者の○反映時にkkjから譜面行が削除されます。",
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
      text: "申請を送信",
      type: "button",
    });
    actions.append(submit);
    shell.content.append(statusContainer, actions);

    function update() {
      const busy = submit.dataset.submitting === "true" || submit.dataset.completed === "true";
      submit.disabled = busy || codePointLength(comment.value) > 500;
    }

    submit.addEventListener("click", () => {
      if (submit.disabled) return;
      const payload = commonPayload("delete", comment.value.normalize("NFC"));
      payload.proposed_level = "削除";
      void runSubmit({ payload, button: submit, updateDisabled: update, statusContainer });
    });
    update();
  }

  async function openWorkflow(applicationType) {
    closeMenu();
    const shell = modalShell("不放逸 申請");
    shell.content.append(statusNode(document, "登録状況を確認しています。"));
    try {
      const lookup = await apiClient.lookup(parsedPage.song.md5);
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
      showMessage("通信エラー", errorMessageFor(code));
    }
  }

  function showMenu(event) {
    if (event.shiftKey) return;
    event.preventDefault();
    closeMenu();
    const menu = element(document, "div", { className: "appamada-menu" });
    menu.setAttribute("role", "menu");
    menu.append(element(document, "div", { className: "appamada-menu-title", text: "☸ 不放逸" }));
    for (const [label, type] of [
      ["難易度変更申請", "change"],
      ["新規譜面申請", "new"],
      ["削除申請(難易度が☸0未満)", "delete"],
    ]) {
      const button = element(document, "button", { text: label, type: "button" });
      button.dataset.action = type;
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => void openWorkflow(type));
      menu.append(button);
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
    destroy() {
      closeMenu();
      closeModal();
      titleElement.removeEventListener("contextmenu", showMenu);
      artistElement.removeEventListener("contextmenu", showMenu);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    },
  });
}
