import {
  initialState, restoreState, applyVoiceResult, insertFromHistory, deleteBlock, moveBlock, reorderBlocks,
  setPinned, deleteHistory, clearDocument, clearHistory, joinedText
} from "./model.mjs";

const HOST_NAME = "fox_voice_editor";
const STORAGE_KEY = "editorState";
const $ = (id) => document.getElementById(id);
const statusNode = $("status");
const errorNode = $("error");
const timerNode = $("timer");
const blocksNode = $("blocks");
const blockMenu = $("block-menu");
const historyItemsNode = $("history-items");
const selectedHistoryNode = $("selected-history");
const previewNode = $("preview");
const saveStatusNode = $("save-status");

let port = null;
let hostState = "connecting";
let editorState = null;
let saveQueue = Promise.resolve();
let recordingId = null;
let pendingTarget = null;
let activeTarget = null;
let stopAt = null;
let cancelRequested = false;
let historyVisibleCount = 30;
let selectedHistoryId = null;
let selectedBlockId = null;
let openHistoryMenuId = null;
let dragState = null;

const busyStates = new Set(["starting", "recording", "stopping", "converting", "recognizing", "cancelling", "syncing"]);
const editable = () => editorState !== null && !busyStates.has(hostState);
const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function button(label, onClick, disabled = false) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.disabled = disabled;
  element.addEventListener("click", onClick);
  return element;
}

function showError(message) {
  errorNode.textContent = message;
}

function renderBlocks() {
  blocksNode.replaceChildren();
  const blocks = editorState.document.blocks;
  for (const block of blocks) {
    const article = document.createElement("article");
    article.className = "block";
    article.dataset.blockId = block.id;
    article.tabIndex = editable() ? 0 : -1;
    article.setAttribute("role", "button");
    article.setAttribute("aria-label", `${block.text}。タップで操作、ドラッグで並べ替え`);
    article.textContent = block.text;
    if (block.id === selectedBlockId) article.classList.add("is-selected");
    article.addEventListener("pointerdown", (event) => onBlockPointerDown(event, block.id));
    article.addEventListener("keydown", (event) => {
      if (!editable()) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openBlockMenu(block.id);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        mutate((state) => moveBlock(state, block.id, event.key === "ArrowLeft" ? -1 : 1));
      }
    });
    blocksNode.append(article);
  }
  if (!blocks.some((block) => block.id === selectedBlockId)) closeBlockMenu();
  else if (!blockMenu.hidden) positionBlockMenu();
}

function phraseRow(item) {
  const row = document.createElement("div");
  row.className = "phrase-row";
  const label = button(item.pinned ? `📌 ${item.text}` : item.text, () => {
    selectedHistoryId = selectedHistoryId === item.id ? null : item.id;
    renderHistory();
  }, !editable());
  label.className = "history-text";
  label.setAttribute("aria-pressed", String(selectedHistoryId === item.id));
  if (selectedHistoryId === item.id) row.classList.add("is-selected");
  const more = button("…", () => {
    openHistoryMenuId = openHistoryMenuId === item.id ? null : item.id;
    renderHistory();
  }, !editable());
  more.className = "more-button";
  more.setAttribute("aria-label", `${item.text}の操作`);
  more.setAttribute("aria-expanded", String(openHistoryMenuId === item.id));
  row.append(label, more);
  if (openHistoryMenuId === item.id) {
    const actions = document.createElement("div");
    actions.className = "history-actions";
    actions.append(
      button(item.pinned ? "ピンを外す" : "ピン留め", () => {
        openHistoryMenuId = null;
        mutate((state) => setPinned(state, item.id, !item.pinned));
      }, !editable()),
      button("履歴から削除", () => {
        openHistoryMenuId = null;
        if (selectedHistoryId === item.id) selectedHistoryId = null;
        mutate((state) => deleteHistory(state, item.id));
      }, !editable())
    );
    row.append(actions);
  }
  return row;
}

function renderHistory() {
  historyItemsNode.replaceChildren();
  const pinned = editorState.history.filter((h) => h.pinned);
  const normal = editorState.history.filter((h) => !h.pinned);
  if (selectedHistoryId && !editorState.history.some((h) => h.id === selectedHistoryId)) selectedHistoryId = null;
  const selected = editorState.history.find((h) => h.id === selectedHistoryId);
  selectedHistoryNode.textContent = selected
    ? `選択中: ${selected.text}（再タップで解除）`
    : "語句を選択して前後に挿入。未選択ならその位置へ録音。";
  for (const item of [...pinned, ...normal.slice(0, historyVisibleCount)]) {
    historyItemsNode.append(phraseRow(item));
  }
  if (editorState.history.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "履歴はありません。";
    historyItemsNode.append(empty);
  }
  $("load-more").hidden = normal.length <= historyVisibleCount;
  $("clear-history").disabled = !editable() || editorState.history.length === 0;
}

function render() {
  if (editorState === null) return;
  renderBlocks();
  renderHistory();
  const preview = joinedText(editorState);
  previewNode.textContent = preview;
  $("copy").disabled = !editable() || !preview;
  $("clear-document").disabled = !editable() || editorState.document.blocks.length === 0;
  for (const action of blockMenu.querySelectorAll("button")) action.disabled = !editable();
  $("rerecord").disabled = hostState !== "idle";
}

function persist(snapshot) {
  saveStatusNode.textContent = "保存中…";
  saveQueue = saveQueue.catch(() => {}).then(() => browser.storage.local.set({ [STORAGE_KEY]: snapshot }));
  saveQueue.then(() => {
    if (editorState === snapshot) saveStatusNode.textContent = "保存済み";
  }).catch((error) => {
    saveStatusNode.textContent = "保存に失敗しました。画面を閉じる前に再操作してください。";
    showError(`保存エラー: ${error.message}`);
  });
}

function commit(next) {
  if (next === editorState) return;
  editorState = next;
  render();
  persist(next);
}

function mutate(change) {
  if (!editable()) return;
  try {
    commit(change(editorState));
  } catch (error) {
    showError(error.message);
  }
}

function positionBlockMenu() {
  const card = [...blocksNode.children].find((node) => node.dataset.blockId === selectedBlockId);
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const width = blockMenu.offsetWidth;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 8;
  blockMenu.style.left = `${left}px`;
  blockMenu.style.top = `${below + blockMenu.offsetHeight > window.innerHeight ? Math.max(8, rect.top - blockMenu.offsetHeight - 8) : below}px`;
}

function closeBlockMenu() {
  selectedBlockId = null;
  blockMenu.hidden = true;
  for (const card of blocksNode.children) card.classList.remove("is-selected");
}

function openBlockMenu(blockId) {
  if (!editable()) return;
  if (selectedBlockId === blockId && !blockMenu.hidden) {
    closeBlockMenu();
    return;
  }
  selectedBlockId = blockId;
  for (const card of blocksNode.children) card.classList.toggle("is-selected", card.dataset.blockId === blockId);
  blockMenu.hidden = false;
  positionBlockMenu();
}

function insertRelative(after) {
  if (!editable() || !selectedBlockId) return;
  const index = editorState.document.blocks.findIndex((block) => block.id === selectedBlockId);
  if (index < 0) return;
  const insertionIndex = index + Number(after);
  closeBlockMenu();
  if (selectedHistoryId) {
    mutate((state) => insertFromHistory(state, selectedHistoryId, insertionIndex, newId(), now()));
  } else {
    beginRecording({ kind: "insert", index: insertionIndex });
  }
}

function onBlockPointerDown(event, blockId) {
  if (!editable() || event.button !== 0 || dragState) return;
  dragState = { pointerId: event.pointerId, card: event.currentTarget, blockId,
    x: event.clientX, y: event.clientY, dragged: false };
  window.addEventListener("pointermove", onBlockPointerMove);
  window.addEventListener("pointerup", onBlockPointerEnd);
  window.addEventListener("pointercancel", onBlockPointerCancel);
}

function onBlockPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const drag = dragState;
  if (!drag.dragged && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
  if (!drag.dragged) {
    drag.dragged = true;
    closeBlockMenu();
    drag.card.classList.add("is-dragging");
    document.body.classList.add("is-dragging");
  }
  event.preventDefault();
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".block");
  if (!target || target === drag.card || target.parentElement !== blocksNode) return;
  const rect = target.getBoundingClientRect();
  const after = event.clientY > rect.bottom || (event.clientY >= rect.top && event.clientX > rect.left + rect.width / 2);
  blocksNode.insertBefore(drag.card, after ? target.nextSibling : target);
}

function endBlockPointer(event, cancelled) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const drag = dragState;
  dragState = null;
  window.removeEventListener("pointermove", onBlockPointerMove);
  window.removeEventListener("pointerup", onBlockPointerEnd);
  window.removeEventListener("pointercancel", onBlockPointerCancel);
  drag.card.classList.remove("is-dragging");
  document.body.classList.remove("is-dragging");
  if (cancelled) {
    if (drag.dragged) renderBlocks();
  } else if (drag.dragged) {
    const order = [...blocksNode.children].map((card) => card.dataset.blockId);
    mutate((state) => reorderBlocks(state, order));
  } else {
    openBlockMenu(drag.blockId);
  }
}

function onBlockPointerEnd(event) { endBlockPointer(event, false); }
function onBlockPointerCancel(event) { endBlockPointer(event, true); }

function setHostState(nextState) {
  hostState = nextState;
  const labels = {
    connecting: "接続中…", idle: "待機", starting: "録音を開始中…", recording: "録音中",
    stopping: "停止中…", converting: "音声変換中…", recognizing: "文字起こし中…",
    cancelling: "キャンセル中…", syncing: "状態を確認中…", disconnected: "接続が切れました"
  };
  statusNode.textContent = labels[nextState] || nextState;
  const toggle = $("record-toggle");
  toggle.textContent = nextState === "recording" || nextState === "stopping" ? "録音停止" : "録音開始";
  toggle.disabled = editorState === null || !["idle", "recording"].includes(nextState);
  $("cancel").disabled = !["recording", "stopping", "converting", "recognizing"].includes(nextState);
  render();
}

function post(action, clearError = true) {
  if (clearError) showError("");
  try {
    if (!port) throw new Error("Native Hostに接続されていません。");
    port.postMessage({ action });
    return true;
  } catch (error) {
    showError(`Native Hostへの送信に失敗しました: ${error.message}`);
    resetRecording();
    setHostState("disconnected");
    return false;
  }
}

function beginRecording(target) {
  if (hostState !== "idle" || editorState === null) return;
  pendingTarget = target;
  closeBlockMenu();
  setHostState("starting");
  post("start_recording");
}

function resetRecording() {
  recordingId = null;
  pendingTarget = null;
  activeTarget = null;
  stopAt = null;
  cancelRequested = false;
}

function finishRecording() {
  resetRecording();
  setHostState("idle");
}

function handleMessage(message) {
  if (message.event === "error") {
    showError(`${message.message} (${message.code})`);
    if (hostState === "syncing") {
      resetRecording();
      setHostState("disconnected");
    } else {
      setHostState("syncing");
      post("get_status", false);
    }
    return;
  }
  if (message.event === "status") {
    if (message.state === "idle") {
      finishRecording();
      return;
    }
    if (message.recordingId !== recordingId) {
      activeTarget = null;
      pendingTarget = null;
      stopAt = null;
      if (!activeTarget) showError("録音先を確認できません。結果は文書へ追加されません。");
    }
    recordingId = message.recordingId;
    setHostState(cancelRequested ? "cancelling" : message.state);
  } else if (message.event === "started") {
    recordingId = message.recordingId;
    activeTarget = pendingTarget;
    pendingTarget = null;
    stopAt = null;
    timerNode.textContent = "";
    setHostState("recording");
  } else if (message.event === "stopping" && message.recordingId === recordingId) {
    if (!cancelRequested) setHostState("stopping");
  } else if (message.event === "processing" && message.recordingId === recordingId) {
    if (!cancelRequested) setHostState(message.state);
  } else if (message.event === "result" && message.recordingId === recordingId) {
    if (cancelRequested) {
      timerNode.textContent = "録音をキャンセルしました。";
    } else if (activeTarget) {
      try {
        commit(applyVoiceResult(editorState, message.text, activeTarget, newId(), newId(), now()));
      } catch (error) {
        showError(error.message);
      }
    } else {
      showError("録音先を確認できないため、認識結果は文書へ追加されませんでした。");
    }
    const browserDuration = stopAt === null ? null : Math.round(performance.now() - stopAt);
    const hostDuration = `Host処理（モデル読み込みを含む）: ${(message.elapsedMs / 1000).toFixed(2)}秒`;
    const loadDuration = typeof message.modelLoadMs === "number" ? ` / モデル読み込み: ${message.modelLoadMs.toFixed(0)}ms` : "";
    if (!cancelRequested) {
      timerNode.textContent = browserDuration === null
        ? `${hostDuration}${loadDuration}`
        : `停止ボタンから結果表示まで: ${(browserDuration / 1000).toFixed(2)}秒 / ${hostDuration}${loadDuration}`;
    }
    finishRecording();
  } else if (message.event === "cancelled" && message.recordingId === recordingId) {
    finishRecording();
  }
}

function connect() {
  setHostState("connecting");
  try {
    port = browser.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(() => {
      showError(browser.runtime.lastError?.message || "Native Hostとの接続が切れました。");
      port = null;
      resetRecording();
      setHostState("disconnected");
    });
    post("get_status");
  } catch (error) {
    showError(error.message);
    setHostState("disconnected");
  }
}

$("record-toggle").addEventListener("click", () => {
  if (hostState === "idle") {
    beginRecording({ kind: "insert", index: editorState.document.blocks.length });
  } else if (hostState === "recording") {
    stopAt = performance.now();
    setHostState("stopping");
    post("stop_recording");
  }
});
$("cancel").addEventListener("click", () => {
  if (!["recording", "stopping", "converting", "recognizing"].includes(hostState)) return;
  cancelRequested = true;
  setHostState("cancelling");
  post("cancel_recording");
});
$("insert-before").addEventListener("click", () => insertRelative(false));
$("insert-after").addEventListener("click", () => insertRelative(true));
$("rerecord").addEventListener("click", () => {
  if (!selectedBlockId) return;
  beginRecording({ kind: "replace", blockId: selectedBlockId });
});
$("delete-block").addEventListener("click", () => {
  if (!selectedBlockId) return;
  const id = selectedBlockId;
  closeBlockMenu();
  mutate((state) => deleteBlock(state, id));
});
$("load-more").addEventListener("click", () => {
  historyVisibleCount += 30;
  renderHistory();
});
$("clear-document").addEventListener("click", () => {
  if (confirm("現在の文書をすべて消去しますか？")) {
    closeBlockMenu();
    mutate(clearDocument);
  }
});
$("clear-history").addEventListener("click", () => {
  if (confirm("ピン留めを含む履歴をすべて消去しますか？")) {
    selectedHistoryId = null;
    openHistoryMenuId = null;
    mutate(clearHistory);
  }
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(joinedText(editorState));
    saveStatusNode.textContent = "プレビューと同じ文字列をコピーしました。";
  } catch (error) {
    showError(`コピーに失敗しました: ${error.message}`);
  }
});
window.addEventListener("pagehide", () => port?.disconnect());

async function initialize() {
  try {
    const saved = await browser.storage.local.get(STORAGE_KEY);
    editorState = restoreState(saved[STORAGE_KEY]);
    if (saved[STORAGE_KEY] === undefined) persist(editorState);
    render();
    connect();
  } catch (error) {
    showError(`保存データを読み取れません: ${error.message}`);
    setHostState("disconnected");
  }
}

initialize();
