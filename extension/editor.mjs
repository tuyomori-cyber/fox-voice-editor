import { DEFAULT_TARGET, validateDraft, sendDraft, statusText } from "./focodex-send.mjs";
import { DEFAULT_FX_OSK_TARGET, validExtensionId, frameUrlFromReply, supportedKey } from "./fx-osk-bridge.mjs";
import {
  FIXED_SYMBOLS, initialState, restoreState, applyVoiceResult, appendManualBlock, addTemplate, insertFromHistory, copyFromHistory, insertFromTemplate, insertSymbolBlock, deleteBlocks, moveBlock, reorderBlocks,
  deleteHistoryMany, deleteTemplatesMany, clearDocument, clearHistory, joinedText, sortEntries
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
const internalStatusNode = $("internal-status");
const internalStatusToggle = $("internal-status-toggle");
const blocksNode = $("blocks");
const blockMenu = $("block-menu");
const historyItemsNode = $("history-items");
const fixedItemsNode = $("fixed-items");
const symbolItemsNode = $("symbol-items");
const historyMenu = $("history-menu");
const templateMenu = $("template-menu");
const selectedHistoryNode = $("selected-history");
const selectedTemplateNode = $("selected-template");
const previewNode = $("preview");
const saveStatusNode = $("save-status");
const manualTextNode = $("manual-text");

let sendingFocodex = false;
let focodexTransfer = null;
let focodexTarget = DEFAULT_TARGET;
const FOCODEX_TARGET_KEY = "focodexTarget";
const FOCODEX_TRANSFER_KEY = "focodexTransfer";
const FX_OSK_TARGET_KEY = "fxOskTarget";
let fxOskTarget = DEFAULT_FX_OSK_TARGET;
let fxOskFrame = null;
let fxOskFrameOrigin = null;
let fxOskRequest = null;
let port = null;
let libraryReady = false;
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
const selectedTemplateIds = new Set();
const selectedBlockIds = new Set();
let openBlockMenuId = null;
let openHistoryMenuId = null;
let openTemplateMenuId = null;
let dragState = null;
let blockInteractionMode = "select";
const historySort = {locale: "ja", direction: "asc"};
const templateSort = {locale: "ja", direction: "asc"};
let activeSideTab = "history";

const busyStates = new Set(["preparing", "starting", "recording", "stopping", "converting", "recognizing", "cancelling", "syncing"]);
const editable = () => editorState !== null && libraryReady && !busyStates.has(hostState);
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

function libraryFromState(state) {
  return {schemaVersion: state.schemaVersion, history: state.history, templates: state.templates};
}

function saveLibraryState(state) {
  if (libraryReady) post("save_library", false, {library: libraryFromState(state)});
}

function positionInternalStatus() {
  if (internalStatusNode.hidden) return;
  const rect = internalStatusToggle.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - internalStatusNode.offsetWidth - 8));
  const below = rect.bottom + 8;
  internalStatusNode.style.left = `${left}px`;
  internalStatusNode.style.top = `${below + internalStatusNode.offsetHeight > window.innerHeight
    ? Math.max(8, rect.top - internalStatusNode.offsetHeight - 8) : below}px`;
}

function setInternalStatusOpen(open) {
  internalStatusNode.hidden = !open;
  internalStatusToggle.setAttribute("aria-expanded", String(open));
  if (open) positionInternalStatus();
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
  const block = button(item.text, () => {
    if (blockInteractionMode !== "select") return;
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
  if (blockInteractionMode === "reorder") {
    block.classList.add("external-card");
    block.setAttribute("aria-label", `${item.text}。ブロック枠へドラッグして追加`);
    block.addEventListener("pointerdown", (event) => onExternalPointerDown(event, "history", item.id));
  }
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

function positionTemplateMenu() {
  if (templateMenu.hidden || !openTemplateMenuId) return;
  const card = [...fixedItemsNode.querySelectorAll(".history-block")]
    .find((node) => node.dataset.templateId === openTemplateMenuId);
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - templateMenu.offsetWidth - 8));
  const below = rect.bottom + 8;
  templateMenu.style.left = `${left}px`;
  templateMenu.style.top = `${below + templateMenu.offsetHeight > window.innerHeight
    ? Math.max(8, rect.top - templateMenu.offsetHeight - 8) : below}px`;
}

function renderHistory() {
  historyItemsNode.replaceChildren();
  const existingIds = new Set(editorState.history.map((h) => h.id));
  for (const id of selectedHistoryIds) {
    if (!existingIds.has(id)) selectedHistoryIds.delete(id);
  }
  const selected = editorState.history.filter((h) => selectedHistoryIds.has(h.id));
  selectedHistoryNode.textContent = blockInteractionMode === "reorder"
    ? "並べ替え・追加モードです。履歴・定型をブロック枠へドラッグして追加できます。"
    : selected.length === 0
    ? "語句をタップして選択。複数選択するとまとめて削除できます。"
    : selected.length === 1
      ? `選択中: ${selected[0].text}（再タップで解除）`
      : `選択中: ${selected.length}件（削除をまとめて実行。前後挿入は1件選択時のみ）`;
  syncBlockMenuActions();
  const visibleHistory = editorState.history.slice(0, historyVisibleCount);
  const visibleIds = new Set(visibleHistory.map((h) => h.id));
  if (openHistoryMenuId && !visibleIds.has(openHistoryMenuId)) {
    openHistoryMenuId = [...selectedHistoryIds].reverse().find((id) => visibleIds.has(id)) ?? null;
  }
  if (visibleHistory.length > 0) {
    const group = document.createElement("div");
    group.className = "history-group normal";
    for (const item of visibleHistory) group.append(phraseBlock(item));
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
    $("history-delete").textContent = `履歴から削除（${count}件）`;
    positionHistoryMenu();
  }
  for (const action of historyMenu.querySelectorAll("button")) action.disabled = !editable();
  $("load-more").hidden = editorState.history.length <= historyVisibleCount;
  $("clear-history").disabled = !editable() || editorState.history.length === 0;
}

function renderTemplates() {
  fixedItemsNode.replaceChildren();
  const existingIds = new Set(editorState.templates.map((template) => template.id));
  for (const id of selectedTemplateIds) {
    if (!existingIds.has(id)) selectedTemplateIds.delete(id);
  }
  const selected = editorState.templates.filter((template) => selectedTemplateIds.has(template.id));
  selectedTemplateNode.textContent = blockInteractionMode === "reorder"
    ? "並べ替え・追加モードです。定型をブロック枠へドラッグして追加できます。"
    : selected.length === 0
      ? "定型をタップして選択。複数選択するとまとめて削除できます。"
      : selected.length === 1
        ? `選択中: ${selected[0].text}（再タップで解除）`
        : `選択中: ${selected.length}件（まとめて削除できます）`;
  if (editorState.templates.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "定型はありません。";
    fixedItemsNode.append(empty);
  } else {
    const group = document.createElement("div");
    group.className = "history-group normal";
    for (const item of editorState.templates) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "history-block";
      card.dataset.templateId = item.id;
      card.textContent = item.text;
      card.disabled = !editable();
      card.setAttribute("aria-pressed", String(selectedTemplateIds.has(item.id)));
      if (selectedTemplateIds.has(item.id)) card.classList.add("is-selected");
      if (blockInteractionMode === "reorder") {
        card.classList.add("external-card");
        card.setAttribute("aria-label", `${item.text}。ブロック枠へドラッグして追加`);
        card.addEventListener("pointerdown", (event) => onExternalPointerDown(event, "template", item.id));
      } else {
        card.setAttribute("aria-label", `${item.text}。タップで選択`);
        card.addEventListener("click", () => toggleTemplateSelection(item.id));
      }
      group.append(card);
    }
    fixedItemsNode.append(group);
  }
  templateMenu.hidden = !openTemplateMenuId || selected.length === 0;
  $("clear-template-selection").hidden = selected.length <= 1;
  if (!templateMenu.hidden) {
    $("template-delete").textContent = selected.length > 1 ? `定型から削除（${selected.length}件）` : "定型から削除";
    positionTemplateMenu();
  }
  for (const action of templateMenu.querySelectorAll("button")) action.disabled = !editable();
}

function renderSortControls() {
  const sort = activeSideTab === "history" ? historySort : templateSort;
  const enabled = activeSideTab !== "symbol" && editable();
  const language = $("side-sort-language");
  const direction = $("side-sort-direction");
  language.textContent = sort.locale === "ja" ? "日本語順" : "ABC順";
  language.setAttribute("aria-pressed", String(sort.locale === "ja"));
  direction.textContent = sort.direction === "asc" ? "昇順" : "降順";
  direction.setAttribute("aria-pressed", String(sort.direction === "asc"));
  language.disabled = !enabled;
  direction.disabled = !enabled;
  $("side-sort").disabled = !enabled;
}

function renderSymbols() {
  symbolItemsNode.replaceChildren();
  for (const symbol of FIXED_SYMBOLS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "history-block";
    const symbolLabel = symbol === " " ? "空白" : symbol === "\n" ? "改行" : symbol;
    card.textContent = symbolLabel;
    card.disabled = !editable();
    card.setAttribute("aria-label", `${symbolLabel}。タップで末尾へ追加`);
    card.addEventListener("click", () => {
      if (!editable()) return;
      mutate((state) => insertSymbolBlock(state, symbol, state.document.blocks.length, newId()));
    });
    symbolItemsNode.append(card);
  }
}

function render() {
  if (editorState === null) return;
  renderBlocks();
  renderHistory();
  renderTemplates();
  renderSymbols();
  renderSortControls();
  const preview = joinedText(editorState);
  previewNode.textContent = preview;
  manualTextNode.disabled = !editable();
  $("add-manual-block").disabled = !editable();
  $("add-template").disabled = !editable();
  $("copy").disabled = !editable() || !preview;
  $("send-focodex").disabled = !editable() || !preview || sendingFocodex;
  $("check-focodex").disabled = !focodexTransfer || sendingFocodex;
  $("clear-document").disabled = !editable() || editorState.document.blocks.length === 0;
  const modeButton = $("toggle-reorder");
  modeButton.disabled = !editable();
  modeButton.textContent = blockInteractionMode === "reorder" ? "並べ替え・追加を完了" : "並べ替え・追加";
  modeButton.setAttribute("aria-pressed", String(blockInteractionMode === "reorder"));
  for (const action of blockMenu.querySelectorAll("button")) action.disabled = !editable();
}

function setSideTab(tab) {
  activeSideTab = tab;
  for (const name of ["history", "fixed", "symbol"]) {
    const selected = name === tab;
    $(`${name}-tab`).setAttribute("aria-selected", String(selected));
    $(`${name}-view`).hidden = !selected;
  }
  if (tab !== "history") resetHistorySelection();
  if (tab !== "fixed") resetTemplateSelection();
  renderSortControls();
}

function addManualBlock() {
  if (!editable()) return;
  try {
    commit(appendManualBlock(editorState, manualTextNode.value, newId(), newId(), now()));
    manualTextNode.value = "";
    showError("");
    manualTextNode.focus();
  } catch (error) {
    showError(error.message);
  }
}

function addManualTemplate() {
  if (!editable()) return;
  try {
    commit(addTemplate(editorState, manualTextNode.value, newId(), newId(), now()));
    manualTextNode.value = "";
    showError("");
    manualTextNode.focus();
  } catch (error) {
    showError(error.message);
  }
}

function dispatchManualInput() {
  manualTextNode.dispatchEvent(new Event("input", {bubbles: true}));
}

function applyFxOskKey(key) {
  if (!editable() || !supportedKey(key)) return;
  const input = manualTextNode;
  input.focus({preventScroll: true});
  if (key === "Enter") {
    addManualBlock();
    return;
  }
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  if (key === "Backspace" || key === "Delete") {
    const deleteStart = key === "Backspace" && start === end ? Math.max(0, start - 1) : start;
    const deleteEnd = key === "Delete" && start === end ? Math.min(input.value.length, end + 1) : end;
    input.setRangeText("", deleteStart, deleteEnd, "start");
  } else if (key === "ArrowLeft" || key === "ArrowRight") {
    const position = key === "ArrowLeft"
      ? (start < end ? start : Math.max(0, start - 1))
      : (start < end ? end : Math.min(input.value.length, end + 1));
    input.setSelectionRange(position, position);
  } else {
    input.setRangeText(key, start, end, "end");
  }
  dispatchManualInput();
}

function setFxOskFrameVisible(open) {
  if (!fxOskFrame) return;
  if (open) {
    fxOskFrame.hidden = false;
    fxOskFrame.style.pointerEvents = "auto";
    return;
  }
  fxOskFrame.remove();
  fxOskFrame = null;
  fxOskFrameOrigin = null;
}

function centerManualEntry() {
  manualTextNode.scrollIntoView({block: "center", inline: "nearest", behavior: "smooth"});
}

async function showFxOsk() {
  if (!validExtensionId(fxOskTarget) || fxOskRequest) return;
  if (fxOskFrame) {
    setFxOskFrameVisible(true);
    fxOskFrame.contentWindow?.postMessage({type: "fxosk.show", version: 1}, fxOskFrameOrigin);
    return;
  }
  fxOskRequest = browser.runtime.sendMessage(fxOskTarget, {type: "fxosk.frame.request", version: 1});
  try {
    const frameUrl = frameUrlFromReply(await fxOskRequest);
    if (!fxOskFrame || fxOskFrame.src !== frameUrl.href) {
      fxOskFrame?.remove();
      fxOskFrame = document.createElement("iframe");
      fxOskFrame.id = "fx-osk-frame";
      fxOskFrame.title = "FX-OSK 仮想キーボード";
      fxOskFrame.src = frameUrl.href;
      document.body.append(fxOskFrame);
      fxOskFrameOrigin = `${frameUrl.protocol}//${frameUrl.host}`;
    }
  } catch (error) {
    showError(`FX-OSKを表示できません: ${error.message}`);
  } finally {
    fxOskRequest = null;
  }
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
  const libraryChanged = next.history !== editorState.history || next.templates !== editorState.templates;
  editorState = next;
  render();
  persist(next);
  if (libraryChanged) saveLibraryState(next);
}

function mutate(change) {
  if (!editable()) return;
  try {
    commit(change(editorState));
  } catch (error) {
    showError(error.message);
  }
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

function resetTemplateSelection() {
  selectedTemplateIds.clear();
  openTemplateMenuId = null;
  templateMenu.hidden = true;
}

function toggleTemplateSelection(templateId) {
  if (!editable() || blockInteractionMode !== "select") return;
  if (selectedTemplateIds.has(templateId)) {
    selectedTemplateIds.delete(templateId);
    openTemplateMenuId = [...selectedTemplateIds].at(-1) ?? null;
  } else {
    selectedTemplateIds.add(templateId);
    openTemplateMenuId = templateId;
  }
  renderTemplates();
}

function syncBlockMenuActions() {
  const canInsert = selectedHistoryIds.size === 1 && selectedBlockIds.size === 1;
  $("insert-before").hidden = !canInsert;
  $("insert-after").hidden = !canInsert;
  $("delete-block").textContent = selectedBlockIds.size > 1 ? `削除（${selectedBlockIds.size}件）` : "削除";
  $("clear-block-selection").hidden = selectedBlockIds.size <= 1;
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
  dragState = { kind: "document", pointerId: event.pointerId, card, blockId,
    x: event.clientX, y: event.clientY, dragged: false };
}

function onExternalPointerDown(event, kind, source) {
  if (!editable() || blockInteractionMode !== "reorder" || !event.isPrimary || dragState || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  const card = event.currentTarget;
  blocksNode.setPointerCapture(event.pointerId);
  dragState = { kind, source, pointerId: event.pointerId, card,
    x: event.clientX, y: event.clientY, dragged: false, marker: null };
}

function findDropTarget(event, draggedCard) {
  const target = [...blocksNode.children].find((card) => {
    if (card === draggedCard || card.classList.contains("symbol-drop-marker")) return false;
    const rect = card.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  return {target, after: event.clientY > rect.bottom || (event.clientY >= rect.top && event.clientX > rect.left + rect.width / 2)};
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
  const insertion = findDropTarget(event, drag.kind === "document" ? drag.card : null);
  if (drag.kind === "document") {
    if (insertion) blocksNode.insertBefore(drag.card, insertion.after ? insertion.target.nextSibling : insertion.target);
    return;
  }
  if (!drag.marker) {
    drag.marker = document.createElement("div");
    drag.marker.className = "symbol-drop-marker";
  }
  if (insertion) {
    blocksNode.insertBefore(drag.marker, insertion.after ? insertion.target.nextSibling : insertion.target);
    return;
  }
  const rect = blocksNode.getBoundingClientRect();
  if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
    blocksNode.append(drag.marker);
  } else {
    drag.marker.remove();
  }
}

function endBlockPointer(event, cancelled) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const drag = dragState;
  dragState = null;
  if (blocksNode.hasPointerCapture(event.pointerId)) blocksNode.releasePointerCapture(event.pointerId);
  drag.card.classList.remove("is-dragging");
  document.body.classList.remove("is-dragging");
  if (cancelled) {
    drag.marker?.remove();
    if (drag.dragged) renderBlocks();
  } else if (drag.dragged && drag.kind !== "document") {
    const index = drag.marker?.parentElement === blocksNode ? [...blocksNode.children].indexOf(drag.marker) : -1;
    drag.marker?.remove();
    if (index >= 0) {
      const source = drag.source;
      if (drag.kind === "history") mutate((state) => copyFromHistory(state, source, index, newId()));
      if (drag.kind === "template") mutate((state) => insertFromTemplate(state, source, index, newId(), newId(), now()));
    }
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
  toggle.disabled = editorState === null || !libraryReady || (nextState === "idle" && (!microphoneReady || engineStatus !== "ready")) || !["idle", "recording"].includes(nextState);
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
  if (!libraryReady) {
    showError("定型・履歴を読み込んでいます。完了するまでお待ちください。");
    return;
  }
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
  if (message.event === "library_loaded") {
    try {
      const libraryState = restoreState({schemaVersion: message.library?.schemaVersion, document: {blocks: []}, history: message.library?.history, templates: message.library?.templates});
      editorState = {...editorState, history: libraryState.history, templates: libraryState.templates};
      libraryReady = true;
      render();
      persist(editorState);
      if (!message.exists) saveLibraryState(editorState);
    } catch (error) {
      libraryReady = false;
      showError(`定型・履歴データを読み取れません: ${error.message}`);
      render();
    }
    return;
  }
  if (message.event === "library_saved") return;
  if (message.event === "library_error") {
    libraryReady = false;
    showError(`定型・履歴を保存できません: ${message.message || message.code}`);
    render();
    return;
  }
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
  if (port) return;
  microphoneReady = false;
  libraryReady = false;
  engineStatus = "uninitialized";
  engineGeneration = null;
  engineInitializationMs = null;
  setHostState("connecting");
  try {
    const connectedPort = browser.runtime.connectNative(HOST_NAME);
    port = connectedPort;
    connectedPort.onMessage.addListener(handleMessage);
    connectedPort.onDisconnect.addListener(() => {
      if (port !== connectedPort) return;
      showError(browser.runtime.lastError?.message || "Native Hostとの接続が切れました。");
      port = null;
      libraryReady = false;
      microphoneReady = false;
      engineStatus = "uninitialized";
      engineGeneration = null;
      engineInitializationMs = null;
      microphoneStatusNode.textContent = "マイク未確認";
      resetRecording();
      setHostState("disconnected");
    });
    setHostState("preparing");
    post("load_library", false);
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
$("template-delete").addEventListener("click", () => {
  if (!openTemplateMenuId || !editable() || selectedTemplateIds.size === 0) return;
  const ids = new Set(selectedTemplateIds);
  resetTemplateSelection();
  mutate((state) => deleteTemplatesMany(state, ids));
});
$("clear-template-selection").addEventListener("click", () => {
  if (!editable()) return;
  resetTemplateSelection();
  renderTemplates();
});
$("history-tab").addEventListener("click", () => setSideTab("history"));
$("fixed-tab").addEventListener("click", () => setSideTab("fixed"));
$("symbol-tab").addEventListener("click", () => setSideTab("symbol"));
$("side-sort-language").addEventListener("click", () => {
  if (!editable() || activeSideTab === "symbol") return;
  const sort = activeSideTab === "history" ? historySort : templateSort;
  sort.locale = sort.locale === "ja" ? "en" : "ja";
  renderSortControls();
});
$("side-sort-direction").addEventListener("click", () => {
  if (!editable() || activeSideTab === "symbol") return;
  const sort = activeSideTab === "history" ? historySort : templateSort;
  sort.direction = sort.direction === "asc" ? "desc" : "asc";
  renderSortControls();
});
$("side-sort").addEventListener("click", () => {
  if (!editable() || activeSideTab === "symbol") return;
  const sort = activeSideTab === "history" ? historySort : templateSort;
  mutate((state) => sortEntries(state, activeSideTab === "history" ? "history" : "templates", sort.locale, sort.direction));
});
$("add-manual-block").addEventListener("click", addManualBlock);
$("add-template").addEventListener("click", addManualTemplate);
manualTextNode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addManualBlock();
  }
});
manualTextNode.addEventListener("focus", () => {
  centerManualEntry();
  showFxOsk();
});
manualTextNode.addEventListener("blur", () => {
  window.setTimeout(() => {
    if (document.activeElement !== fxOskFrame) setFxOskFrameVisible(false);
  }, 0);
});
window.addEventListener("message", (event) => {
  if (!fxOskFrame || event.source !== fxOskFrame.contentWindow || event.origin !== fxOskFrameOrigin) return;
  if (event.data?.version !== 1) return;
  if (event.data.type === "fxosk.visibility" && typeof event.data.open === "boolean") {
    setFxOskFrameVisible(event.data.open);
    return;
  }
  if (event.data.type === "fxosk.key") applyFxOskKey(event.data.key);
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
    resetTemplateSelection();
  }
  render();
});
$("load-more").addEventListener("click", () => {
  historyVisibleCount += 30;
  renderHistory();
});
window.addEventListener("scroll", positionHistoryMenu, true);
window.addEventListener("scroll", positionTemplateMenu, true);
window.addEventListener("scroll", positionInternalStatus, true);
window.addEventListener("resize", positionHistoryMenu);
window.addEventListener("resize", positionTemplateMenu);
window.addEventListener("resize", positionInternalStatus);
internalStatusToggle.addEventListener("click", () => setInternalStatusOpen(internalStatusNode.hidden));
window.addEventListener("pointerdown", (event) => {
  if (!internalStatusNode.hidden && !internalStatusNode.contains(event.target) && event.target !== internalStatusToggle) {
    setInternalStatusOpen(false);
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !internalStatusNode.hidden) {
    setInternalStatusOpen(false);
    internalStatusToggle.focus();
  }
});
$("clear-document").addEventListener("click", () => {
  if (confirm("現在の文書をすべて消去しますか？")) {
    clearBlockSelection();
    mutate(clearDocument);
  }
});
$("clear-history").addEventListener("click", () => {
  if (confirm("履歴をすべて消去しますか？")) {
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
$("save-extension-targets").addEventListener("click", async () => {
  const target = $("focodex-target").value.trim();
  const oskTarget = $("fx-osk-target").value.trim();
  if (!target || target.length > 256 || !validExtensionId(oskTarget)) {
    $("focodex-status").textContent = "FocodexとFX-OSKの拡張IDを確認してください。";
    return;
  }
  try {
    await browser.storage.local.set({[FOCODEX_TARGET_KEY]: target, [FX_OSK_TARGET_KEY]: oskTarget});
    focodexTarget = target;
    fxOskTarget = oskTarget;
    fxOskFrame?.remove();
    fxOskFrame = null;
    fxOskFrameOrigin = null;
    $("focodex-status").textContent = "連携先を保存しました。既に送った文章の結果照会先は変わりません。";
  } catch { $("focodex-status").textContent = "連携先を保存できません。"; }
});
async function transferToFocodex(checkOnly = false) {
  if (sendingFocodex || (!checkOnly && !editable())) return;
  if (checkOnly && !focodexTransfer) return;
  sendingFocodex = true;
  render();
  try {
    const text = checkOnly ? focodexTransfer?.text : joinedText(editorState);
    if (!checkOnly) {
      validateDraft(text);
      // Persist the identity before sending: an interrupted response is recoverable.
      const transfer = {target: focodexTarget, requestId: crypto.randomUUID(), text};
      await browser.storage.local.set({[FOCODEX_TRANSFER_KEY]: transfer});
      focodexTransfer = transfer;
    }
    const {target, requestId} = focodexTransfer;
    const reply = await sendDraft(browser.runtime, target, requestId, text);
    $("focodex-status").textContent = statusText(reply);
  } catch (error) {
    $("focodex-status").textContent = `結果を確認できません: ${error.message} 自動再送はしません。「Focodexへ貼り付け」を再試行してください。`;
  } finally { sendingFocodex = false; render(); }
}
$("send-focodex").addEventListener("click", () => transferToFocodex());
$("check-focodex").addEventListener("click", () => transferToFocodex(true));
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  window.setTimeout(() => {
    if (editorState !== null && !port) connect();
  }, 0);
});

async function initialize() {
  try {
    const saved = await browser.storage.local.get([STORAGE_KEY, ENGINE_STORAGE_KEY, FOCODEX_TARGET_KEY, FOCODEX_TRANSFER_KEY, FX_OSK_TARGET_KEY]);
    focodexTarget = typeof saved[FOCODEX_TARGET_KEY] === "string" && saved[FOCODEX_TARGET_KEY].trim() ? saved[FOCODEX_TARGET_KEY] : DEFAULT_TARGET;
    $("focodex-target").value = focodexTarget;
    fxOskTarget = validExtensionId(saved[FX_OSK_TARGET_KEY]) ? saved[FX_OSK_TARGET_KEY] : DEFAULT_FX_OSK_TARGET;
    $("fx-osk-target").value = fxOskTarget;
    const transfer = saved[FOCODEX_TRANSFER_KEY];
    if (typeof transfer?.target === "string" && typeof transfer?.requestId === "string") {
      focodexTransfer = transfer;
      $("focodex-status").textContent = typeof transfer.text === "string" ? "前回の送信記録があります。「受信結果を確認」で同じ文章を再送できます。" : "旧形式の送信記録があります。新規送信してください。";
    }
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
