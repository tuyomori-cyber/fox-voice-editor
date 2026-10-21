import {
  initialState, restoreState, applyVoiceResult, insertFromHistory, deleteBlocks, moveBlock, reorderBlocks,
  setPinnedMany, deleteHistoryMany, clearDocument, clearHistory, joinedText
} from "./model.mjs";

const HOST_NAME = "fox_voice_editor";
const STORAGE_KEY = "editorState";
const ENGINE_STORAGE_KEY = "recognitionEngine";
const $ = (id) => document.getElementById(id);
const statusNode = $("status");
const microphoneStatusNode = $("microphone-status");
const engineStatusNode = $("engine-status");
const errorNode = $("error");
const timerNode = $("timer");
const blocksNode = $("blocks");
const blockMenu = $("block-menu");
const historyItemsNode = $("history-items");
const historyMenu = $("history-menu");
const selectedHistoryNode = $("selected-history");
const previewNode = $("preview");
const saveStatusNode = $("save-status");

let port = null;
let hostState = "connecting";
let microphoneReady = false;
let selectedEngine = "whisper";
let engineStatus = "uninitialized";
let engineGeneration = null;
let engineStartedAt = null;
let engineInitializationMs = null;
let activeEngine = null;
let activeGeneration = null;
let editorState = null;
let saveQueue = Promise.resolve();
let recordingId = null;
let pendingTarget = null;
let activeTarget = null;
let stopAt = null;
let cancelRequested = false;
let historyVisibleCount = 30;
const selectedHistoryIds = new Set();
const selectedBlockIds = new Set();
let openBlockMenuId = null;
let openHistoryMenuId = null;
let dragState = null;
let blockInteractionMode = "select";

const busyStates = new Set(["preparing", "starting", "recording", "stopping", "converting", "recognizing", "cancelling", "syncing"]);
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
  blocksNode.classList.toggle("is-reordering", blockInteractionMode === "reorder");
  const blocks = editorState.document.blocks;
  const existingIds = new Set(blocks.map((block) => block.id));
  for (const id of selectedBlockIds) {
    if (!existingIds.has(id)) selectedBlockIds.delete(id);
  }
  if (openBlockMenuId && !selectedBlockIds.has(openBlockMenuId)) {
    openBlockMenuId = [...selectedBlockIds].at(-1) ?? null;
  }
  for (const block of blocks) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "block";
    card.dataset.blockId = block.id;
    card.disabled = !editable();
    card.setAttribute("aria-label", blockInteractionMode === "reorder"
      ? `${block.text}。ドラッグで並べ替え`
      : `${block.text}。タップで操作`);
    card.textContent = block.text;
    card.setAttribute("aria-pressed", String(selectedBlockIds.has(block.id)));
    card.setAttribute("aria-expanded", String(openBlockMenuId === block.id));
    if (selectedBlockIds.has(block.id)) card.classList.add("is-selected");
    card.addEventListener("click", () => {
      if (!editable() || blockInteractionMode !== "select" || card.dataset.ignoreClick === "true") return;
      toggleBlockSelection(block.id);
    });
    card.addEventListener("pointerdown", (event) => onBlockPointerDown(event, block.id));
    card.addEventListener("keydown", (event) => {
      if (!editable()) return;
      if (blockInteractionMode === "reorder" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        mutate((state) => moveBlock(state, block.id, event.key === "ArrowLeft" ? -1 : 1));
      }
    });
    blocksNode.append(card);
  }
  blockMenu.hidden = !openBlockMenuId || selectedBlockIds.size === 0;
  syncBlockMenuActions();
}

function phraseBlock(item) {
  const block = button(item.pinned ? `📌 ${item.text}` : item.text, () => {
    if (selectedHistoryIds.has(item.id)) {
      selectedHistoryIds.delete(item.id);
      openHistoryMenuId = [...selectedHistoryIds].at(-1) ?? null;
    } else {
      selectedHistoryIds.add(item.id);
      openHistoryMenuId = item.id;
    }
    renderHistory();
  }, !editable());
  block.className = "history-block";
  block.dataset.historyId = item.id;
  block.setAttribute("aria-pressed", String(selectedHistoryIds.has(item.id)));
  block.setAttribute("aria-expanded", String(openHistoryMenuId === item.id));
  if (selectedHistoryIds.has(item.id)) block.classList.add("is-selected");
  return block;
}

function positionHistoryMenu() {
  if (historyMenu.hidden || !openHistoryMenuId) return;
  const block = [...historyItemsNode.querySelectorAll(".history-block")]
    .find((node) => node.dataset.historyId === openHistoryMenuId);
  if (!block) return;
  const rect = block.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - historyMenu.offsetWidth - 8));
  const below = rect.bottom + 8;
  historyMenu.style.left = `${left}px`;
  historyMenu.style.top = `${below + historyMenu.offsetHeight > window.innerHeight
    ? Math.max(8, rect.top - historyMenu.offsetHeight - 8) : below}px`;
}

function renderHistory() {
  historyItemsNode.replaceChildren();
  const pinned = editorState.history.filter((h) => h.pinned);
  const normal = editorState.history.filter((h) => !h.pinned);
  const existingIds = new Set(editorState.history.map((h) => h.id));
  for (const id of selectedHistoryIds) {
    if (!existingIds.has(id)) selectedHistoryIds.delete(id);
  }
  const selected = editorState.history.filter((h) => selectedHistoryIds.has(h.id));
  selectedHistoryNode.textContent = selected.length === 0
    ? "語句をタップして選択。複数選択するとまとめてピン留め・削除できます。"
    : selected.length === 1
      ? `選択中: ${selected[0].text}（再タップで解除）`
      : `選択中: ${selected.length}件（ピン留め・削除をまとめて実行。前後挿入は1件選択時のみ）`;
  syncBlockMenuActions();
  const visibleNormal = normal.slice(0, historyVisibleCount);
  const visibleIds = new Set([...pinned, ...visibleNormal].map((h) => h.id));
  if (openHistoryMenuId && !visibleIds.has(openHistoryMenuId)) {
    openHistoryMenuId = [...selectedHistoryIds].reverse().find((id) => visibleIds.has(id)) ?? null;
  }
  for (const [items, kind] of [[pinned, "pinned"], [visibleNormal, "normal"]]) {
    if (items.length === 0) continue;
    const group = document.createElement("div");
    group.className = `history-group ${kind}`;
    for (const item of items) group.append(phraseBlock(item));
    historyItemsNode.append(group);
  }
  if (editorState.history.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "履歴はありません。";
    historyItemsNode.append(empty);
  }
  historyMenu.hidden = !openHistoryMenuId || selected.length === 0;
  $("clear-history-selection").hidden = selected.length <= 1;
  if (!historyMenu.hidden) {
    const count = selected.length;
    $("history-pin").textContent = selected.every((item) => item.pinned)
      ? `ピンを外す（${count}件）` : `ピン留め（${count}件）`;
    $("history-delete").textContent = `履歴から削除（${count}件）`;
    positionHistoryMenu();
  }
  for (const action of historyMenu.querySelectorAll("button")) action.disabled = !editable();
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
  const modeButton = $("toggle-reorder");
  modeButton.disabled = !editable() || editorState.document.blocks.length < 2;
  modeButton.textContent = blockInteractionMode === "reorder" ? "並べ替えを完了" : "並べ替え";
  modeButton.setAttribute("aria-pressed", String(blockInteractionMode === "reorder"));
  for (const action of blockMenu.querySelectorAll("button")) action.disabled = !editable();
}

function renderEngine() {
  const select = $("recognition-engine");
  select.value = selectedEngine;
  select.disabled = !port || hostState !== "idle";
  $("retry-engine").hidden = engineStatus !== "error";
  $("retry-engine").disabled = !port || hostState !== "idle";
  const name = selectedEngine === "whisper" ? "Whisper（ggml-base.bin）" : "ReazonSpeech K2（INT8）";
  if (engineStatus === "preparing") {
    const elapsed = engineStartedAt === null ? 0 : Math.floor((performance.now() - engineStartedAt) / 1000);
    engineStatusNode.textContent = `${name}：モデル準備中（${elapsed}秒）`;
  } else {
    const label = {ready: "準備完了", error: "準備失敗", uninitialized: "未準備"}[engineStatus] || engineStatus;
    const elapsed = engineStatus === "ready" && selectedEngine === "reazonspeech_k2" && typeof engineInitializationMs === "number"
      ? `（${(engineInitializationMs / 1000).toFixed(2)}秒）` : "";
    engineStatusNode.textContent = `${name}：${label}${elapsed}`;
  }
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
  if (blockMenu.hidden || !openBlockMenuId) return;
  const card = [...blocksNode.children].find((node) => node.dataset.blockId === openBlockMenuId);
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const width = blockMenu.offsetWidth;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 8;
  blockMenu.style.left = `${left}px`;
  blockMenu.style.top = `${below + blockMenu.offsetHeight > window.innerHeight ? Math.max(8, rect.top - blockMenu.offsetHeight - 8) : below}px`;
}

function hideBlockMenu() {
  openBlockMenuId = null;
  blockMenu.hidden = true;
  for (const card of blocksNode.children) card.setAttribute("aria-expanded", "false");
}

function clearBlockSelection() {
  selectedBlockIds.clear();
  hideBlockMenu();
  for (const card of blocksNode.children) {
    card.classList.remove("is-selected");
    card.setAttribute("aria-pressed", "false");
  }
}

function resetHistorySelection() {
  selectedHistoryIds.clear();
  openHistoryMenuId = null;
  historyMenu.hidden = true;
}

function syncBlockMenuActions() {
  const canInsert = selectedHistoryIds.size === 1 && selectedBlockIds.size === 1;
  $("insert-before").hidden = !canInsert;
  $("insert-after").hidden = !canInsert;
  $("delete-block").textContent = selectedBlockIds.size > 1 ? `削除（${selectedBlockIds.size}件）` : "削除";
  $("clear-block-selection").hidden = selectedBlockIds.size <= 1;
  if (!blockMenu.hidden) positionBlockMenu();
}

function toggleBlockSelection(blockId) {
  if (!editable()) return;
  if (selectedBlockIds.has(blockId)) {
    selectedBlockIds.delete(blockId);
    openBlockMenuId = [...selectedBlockIds].at(-1) ?? null;
  } else {
    selectedBlockIds.add(blockId);
    openBlockMenuId = blockId;
  }
  openHistoryMenuId = null;
  historyMenu.hidden = true;
  renderBlocks();
  renderHistory();
}

function insertRelative(after) {
  if (!editable() || selectedBlockIds.size !== 1 || selectedHistoryIds.size !== 1) return;
  const blockId = selectedBlockIds.values().next().value;
  const index = editorState.document.blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return;
  const insertionIndex = index + Number(after);
  const historyId = selectedHistoryIds.values().next().value;
  clearBlockSelection();
  mutate((state) => insertFromHistory(state, historyId, insertionIndex, newId(), now()));
}

function onBlockPointerDown(event, blockId) {
  if (!editable() || blockInteractionMode !== "reorder" || !event.isPrimary || dragState || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  const card = event.currentTarget;
  blocksNode.setPointerCapture(event.pointerId);
  dragState = { pointerId: event.pointerId, card, blockId,
    x: event.clientX, y: event.clientY, dragged: false };
}

function onBlockPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const drag = dragState;
  if (!drag.dragged && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
  if (!drag.dragged) {
    drag.dragged = true;
    hideBlockMenu();
    drag.card.classList.add("is-dragging");
    document.body.classList.add("is-dragging");
  }
  event.preventDefault();
  const target = [...blocksNode.children].find((card) => {
    if (card === drag.card) return false;
    const rect = card.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const after = event.clientY > rect.bottom || (event.clientY >= rect.top && event.clientX > rect.left + rect.width / 2);
  blocksNode.insertBefore(drag.card, after ? target.nextSibling : target);
}

function endBlockPointer(event, cancelled) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const drag = dragState;
  dragState = null;
  if (blocksNode.hasPointerCapture(event.pointerId)) blocksNode.releasePointerCapture(event.pointerId);
  drag.card.classList.remove("is-dragging");
  document.body.classList.remove("is-dragging");
  if (cancelled) {
    if (drag.dragged) renderBlocks();
  } else if (drag.dragged) {
    drag.card.dataset.ignoreClick = "true";
    const order = [...blocksNode.children].map((card) => card.dataset.blockId);
    mutate((state) => reorderBlocks(state, order));
  } else if (blockInteractionMode === "select") {
    // Pointer Capture makes the compatibility click target the editor area,
    // so finish a tap here while preserving keyboard click handling.
    drag.card.dataset.ignoreClick = "true";
    toggleBlockSelection(drag.blockId);
  }
}

function onBlockPointerEnd(event) { endBlockPointer(event, false); }
function onBlockPointerCancel(event) { endBlockPointer(event, true); }

blocksNode.addEventListener("pointermove", onBlockPointerMove);
blocksNode.addEventListener("pointerup", onBlockPointerEnd);
blocksNode.addEventListener("pointercancel", onBlockPointerCancel);

function setHostState(nextState) {
  hostState = nextState;
  const labels = {
    connecting: "接続中…", preparing: "マイクを確認中…", idle: "待機", starting: "録音を開始中…", recording: "録音中",
    stopping: "停止中…", converting: "音声変換中…", recognizing: "文字起こし中…",
    cancelling: "キャンセル中…", syncing: "状態を確認中…", disconnected: "接続が切れました"
  };
  statusNode.textContent = labels[nextState] || nextState;
  const toggle = $("record-toggle");
  toggle.textContent = nextState === "recording" || nextState === "stopping" ? "録音停止" : "録音開始";
  toggle.disabled = editorState === null || (nextState === "idle" && (!microphoneReady || engineStatus !== "ready")) || !["idle", "recording"].includes(nextState);
  $("cancel").disabled = !["recording", "stopping", "converting", "recognizing"].includes(nextState);
  $("check-microphone").disabled = nextState !== "idle" || !port;
  renderEngine();
  render();
}

function post(action, clearError = true, extra = {}) {
  if (clearError) showError("");
  try {
    if (!port) throw new Error("Native Hostに接続されていません。");
    port.postMessage({ action, ...extra });
    return true;
  } catch (error) {
    showError(`Native Hostへの送信に失敗しました: ${error.message}`);
    resetRecording();
    setHostState("disconnected");
    return false;
  }
}

function beginRecording() {
  if (hostState !== "idle" || editorState === null) return;
  if (!microphoneReady) {
    showError("録音の前にマイクを再確認してください。");
    return;
  }
  if (engineStatus !== "ready") {
    showError("録音の前に認識エンジンの準備を完了してください。");
    return;
  }
  pendingTarget = { kind: "insert", index: editorState.document.blocks.length };
  clearBlockSelection();
  setHostState("starting");
  post("start_recording");
}

function resetRecording() {
  recordingId = null;
  pendingTarget = null;
  activeTarget = null;
  stopAt = null;
  cancelRequested = false;
  activeEngine = null;
  activeGeneration = null;
}

function finishRecording() {
  resetRecording();
  setHostState("idle");
}

function handleMessage(message) {
  if (message.event === "engine_prepared") {
    if (message.engine !== selectedEngine) return;
    engineStatus = message.engineStatus;
    engineGeneration = message.engineGeneration;
    if (engineStatus === "preparing") engineStartedAt = performance.now();
    if (engineStatus === "ready") {
      engineStartedAt = null;
      if (typeof message.initializationMs === "number") engineInitializationMs = message.initializationMs;
    }
    if (engineStatus === "error") showError(`${message.message || "モデル準備に失敗しました。"} (${message.code || "ENGINE_FAILED"})`);
    setHostState(hostState);
    return;
  }
  if (message.event === "microphone_prepared") {
    if (hostState !== "preparing") return;
    microphoneReady = ["skipped", "unchanged", "adjusted"].includes(message.status);
    if (microphoneReady) {
      const checkedAt = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
      const description = {
        skipped: "補正無効", unchanged: "ブースト値0・変更なし", adjusted: "ブースト値を0へ補正"
      }[message.status];
      microphoneStatusNode.textContent = message.status === "skipped"
        ? "マイク補正は無効（録音可能）"
        : `マイク最終確認 ${checkedAt}：${description}。録音時は自動再確認しません。`;
      showError("");
    } else {
      microphoneStatusNode.textContent = "マイク未確認。再確認してください。";
      showError(`${message.message || "マイクの確認に失敗しました。"} (${message.code || "MICROPHONE_PREPARATION_FAILED"})`);
    }
    setHostState("idle");
    return;
  }
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
    if (message.engine === selectedEngine) {
      engineStatus = message.engineStatus;
      engineGeneration = message.engineGeneration;
    } else {
      engineStatus = "uninitialized";
      showError("選択エンジンとHostの状態が一致しません。モデルを再準備してください。");
    }
    microphoneReady = Boolean(message.microphoneReady);
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
    activeEngine = message.engine;
    activeGeneration = message.engineGeneration;
    activeTarget = pendingTarget;
    pendingTarget = null;
    stopAt = null;
    timerNode.textContent = "";
    setHostState("recording");
    if (activeEngine !== selectedEngine || activeGeneration !== engineGeneration) {
      activeTarget = null;
      cancelRequested = true;
      setHostState("cancelling");
      post("cancel_recording", false);
    }
  } else if (message.event === "stopping" && message.recordingId === recordingId) {
    if (!cancelRequested) setHostState("stopping");
  } else if (message.event === "processing" && message.recordingId === recordingId) {
    if (!cancelRequested) setHostState(message.state);
  } else if (message.event === "result" && message.recordingId === recordingId) {
    if (cancelRequested) {
      timerNode.textContent = "録音をキャンセルしました。";
    } else if (activeTarget && message.engine === activeEngine && message.engineGeneration === activeGeneration &&
               message.engine === selectedEngine && message.engineGeneration === engineGeneration) {
      try {
        commit(applyVoiceResult(editorState, message.text, activeTarget, newId(), newId(), now()));
      } catch (error) {
        showError(error.message);
      }
    } else {
      showError("録音先を確認できないため、認識結果は文書へ追加されませんでした。");
    }
    const browserDuration = stopAt === null ? null : Math.round(performance.now() - stopAt);
    const duration = (value) => typeof value === "number" ? `${(value / 1000).toFixed(2)}秒` : "計測不可";
    if (!cancelRequested) {
      const lines = message.engine === "reazonspeech_k2"
        ? [
            `A 録音停止〜音声変換完了: ${duration(message.conversionMs)}`,
            "B モデル読み込み: セッション開始時に実施（録音ごとにはなし）",
            `C 推論: ${duration(message.recognitionMs)}`
          ]
        : [
            `A 録音停止〜音声変換完了: ${duration(message.conversionMs)}`,
            `B whisper-cli起動〜モデル読み込み完了: ${duration(message.modelStartupMs)}`,
            `C モデル読み込み完了〜認識終了: ${duration(message.recognitionMs)}`
          ];
      timerNode.textContent = [...lines, `停止ボタン〜結果表示: ${duration(browserDuration)}`,
        `使用モデル: ${message.modelName || "不明"}`].join("\n");
    }
    finishRecording();
  } else if (message.event === "cancelled" && message.recordingId === recordingId) {
    finishRecording();
  }
}

function connect() {
  microphoneReady = false;
  engineStatus = "uninitialized";
  engineGeneration = null;
  engineInitializationMs = null;
  setHostState("connecting");
  try {
    port = browser.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(() => {
      showError(browser.runtime.lastError?.message || "Native Hostとの接続が切れました。");
      port = null;
      microphoneReady = false;
      engineStatus = "uninitialized";
      engineGeneration = null;
      engineInitializationMs = null;
      microphoneStatusNode.textContent = "マイク未確認";
      resetRecording();
      setHostState("disconnected");
    });
    setHostState("preparing");
    post("prepare_microphone");
    post("prepare_engine", false, {engine: selectedEngine});
  } catch (error) {
    showError(error.message);
    setHostState("disconnected");
  }
}

function prepareSelectedEngine() {
  engineStatus = "uninitialized";
  engineGeneration = null;
  engineStartedAt = null;
  engineInitializationMs = null;
  renderEngine();
  post("prepare_engine", true, {engine: selectedEngine});
  setHostState(hostState);
}

$("recognition-engine").addEventListener("change", async (event) => {
  if (hostState !== "idle") return;
  selectedEngine = event.target.value;
  prepareSelectedEngine();
  try {
    await browser.storage.local.set({[ENGINE_STORAGE_KEY]: selectedEngine});
  } catch (error) {
    showError(`エンジン設定を保存できません: ${error.message}`);
  }
});
$("retry-engine").addEventListener("click", () => {
  if (hostState === "idle") prepareSelectedEngine();
});
setInterval(() => {
  if (engineStatus === "preparing") renderEngine();
}, 1000);

$("record-toggle").addEventListener("click", () => {
  if (hostState === "idle") {
    beginRecording();
  } else if (hostState === "recording") {
    stopAt = performance.now();
    setHostState("stopping");
    post("stop_recording");
  }
});
$("check-microphone").addEventListener("click", () => {
  if (hostState !== "idle") return;
  microphoneReady = false;
  microphoneStatusNode.textContent = "マイクを確認中…";
  setHostState("preparing");
  post("prepare_microphone");
});
$("cancel").addEventListener("click", () => {
  if (!["recording", "stopping", "converting", "recognizing"].includes(hostState)) return;
  cancelRequested = true;
  setHostState("cancelling");
  post("cancel_recording");
});
$("insert-before").addEventListener("click", () => insertRelative(false));
$("insert-after").addEventListener("click", () => insertRelative(true));
$("history-pin").addEventListener("click", () => {
  if (!openHistoryMenuId || !editable() || selectedHistoryIds.size === 0) return;
  const ids = new Set(selectedHistoryIds);
  const selected = editorState.history.filter((entry) => ids.has(entry.id));
  const pinned = !selected.every((entry) => entry.pinned);
  resetHistorySelection();
  mutate((state) => setPinnedMany(state, ids, pinned));
});
$("history-delete").addEventListener("click", () => {
  if (!openHistoryMenuId || !editable() || selectedHistoryIds.size === 0) return;
  const ids = new Set(selectedHistoryIds);
  resetHistorySelection();
  mutate((state) => deleteHistoryMany(state, ids));
});
$("clear-history-selection").addEventListener("click", () => {
  if (!editable()) return;
  resetHistorySelection();
  renderHistory();
});
$("delete-block").addEventListener("click", () => {
  if (!editable() || selectedBlockIds.size === 0) return;
  const ids = new Set(selectedBlockIds);
  clearBlockSelection();
  mutate((state) => deleteBlocks(state, ids));
});
$("clear-block-selection").addEventListener("click", () => {
  if (!editable()) return;
  clearBlockSelection();
});
$("toggle-reorder").addEventListener("click", () => {
  if (!editable()) return;
  blockInteractionMode = blockInteractionMode === "reorder" ? "select" : "reorder";
  if (blockInteractionMode === "reorder") {
    clearBlockSelection();
    resetHistorySelection();
  }
  render();
});
$("load-more").addEventListener("click", () => {
  historyVisibleCount += 30;
  renderHistory();
});
window.addEventListener("scroll", positionHistoryMenu, true);
window.addEventListener("scroll", positionBlockMenu, true);
window.addEventListener("resize", positionHistoryMenu);
window.addEventListener("resize", positionBlockMenu);
$("clear-document").addEventListener("click", () => {
  if (confirm("現在の文書をすべて消去しますか？")) {
    clearBlockSelection();
    mutate(clearDocument);
  }
});
$("clear-history").addEventListener("click", () => {
  if (confirm("ピン留めを含む履歴をすべて消去しますか？")) {
    resetHistorySelection();
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
    const saved = await browser.storage.local.get([STORAGE_KEY, ENGINE_STORAGE_KEY]);
    selectedEngine = ["whisper", "reazonspeech_k2"].includes(saved[ENGINE_STORAGE_KEY]) ? saved[ENGINE_STORAGE_KEY] : "whisper";
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
