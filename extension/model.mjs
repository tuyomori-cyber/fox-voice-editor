export const HISTORY_LIMIT = 500;
const DEFAULT_PHRASES = ["の", "を", "ただし", "ではなく", "まず現状を調査", "既存機能は維持"];

export function initialState() {
  return {
    schemaVersion: 1,
    document: { blocks: [] },
    history: DEFAULT_PHRASES.map((text, index) => ({
      id: `preset-${index}`, text, pinned: true, lastUsedAt: null, useCount: 0
    }))
  };
}

export function restoreState(raw) {
  if (raw === undefined) return initialState();
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.document?.blocks) || !Array.isArray(raw.history)) {
    throw new Error("保存データの形式を読み取れません。内容は上書きしません。");
  }
  const blocks = raw.document.blocks;
  const history = raw.history;
  if (blocks.some((b) => typeof b?.id !== "string" || typeof b?.text !== "string") ||
      history.some((h) => typeof h?.id !== "string" || typeof h?.text !== "string" || typeof h?.pinned !== "boolean") ||
      new Set(blocks.map((b) => b.id)).size !== blocks.length ||
      new Set(history.map((h) => h.id)).size !== history.length) {
    throw new Error("保存データが不正です。内容は上書きしません。");
  }
  return {
    schemaVersion: 1,
    document: { blocks: blocks.map((b) => ({ ...b })) },
    history: history.map((h) => ({ ...h }))
  };
}

function withBlocks(state, blocks) {
  return { ...state, document: { ...state.document, blocks } };
}

function trimHistory(history) {
  const result = [...history];
  while (result.length > HISTORY_LIMIT) {
    let oldest = result.length - 1;
    while (oldest >= 0 && result[oldest].pinned) oldest -= 1;
    if (oldest < 0) break;
    result.splice(oldest, 1);
  }
  return result;
}

function touchHistory(state, text, now, id) {
  const existing = state.history.find((h) => h.text === text);
  const updated = existing
    ? { ...existing, lastUsedAt: now, useCount: (existing.useCount || 0) + 1 }
    : { id, text, pinned: false, lastUsedAt: now, useCount: 1 };
  return { ...state, history: trimHistory([updated, ...state.history.filter((h) => h !== existing)]) };
}

function insertBlock(state, index, block) {
  const blocks = [...state.document.blocks];
  if (!Number.isInteger(index) || index < 0 || index > blocks.length) throw new Error("挿入位置が不正です。");
  blocks.splice(index, 0, block);
  return withBlocks(state, blocks);
}

export function applyVoiceResult(state, text, target, blockId, historyId, now) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("空の認識結果は追加できません。");
  if (target?.kind !== "insert") throw new Error("録音対象が不正です。");
  const next = insertBlock(state, target.index, { id: blockId, text: trimmed, origin: "voice" });
  return touchHistory(next, trimmed, now, historyId);
}

export function insertFromHistory(state, historyId, index, blockId, now) {
  const item = state.history.find((h) => h.id === historyId);
  if (!item) throw new Error("履歴が見つかりません。");
  return touchHistory(
    insertBlock(state, index, { id: blockId, text: item.text, origin: "history" }),
    item.text, now, historyId
  );
}

export function deleteBlock(state, blockId) {
  return deleteBlocks(state, [blockId]);
}

export function deleteBlocks(state, blockIds) {
  const ids = new Set(blockIds);
  return withBlocks(state, state.document.blocks.filter((b) => !ids.has(b.id)));
}

export function moveBlock(state, blockId, direction) {
  const index = state.document.blocks.findIndex((b) => b.id === blockId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= state.document.blocks.length) return state;
  const blocks = [...state.document.blocks];
  [blocks[index], blocks[destination]] = [blocks[destination], blocks[index]];
  return withBlocks(state, blocks);
}

export function reorderBlocks(state, orderedIds) {
  const blocks = state.document.blocks;
  if (orderedIds.length !== blocks.length || new Set(orderedIds).size !== blocks.length) {
    throw new Error("ブロックの並び順が不正です。");
  }
  const byId = new Map(blocks.map((block) => [block.id, block]));
  if (orderedIds.some((id) => !byId.has(id))) throw new Error("ブロックの並び順が不正です。");
  if (orderedIds.every((id, index) => id === blocks[index].id)) return state;
  return withBlocks(state, orderedIds.map((id) => byId.get(id)));
}

export function setPinned(state, historyId, pinned) {
  return setPinnedMany(state, [historyId], pinned);
}

export function deleteHistory(state, historyId) {
  return deleteHistoryMany(state, [historyId]);
}

export function setPinnedMany(state, historyIds, pinned) {
  const ids = new Set(historyIds);
  return { ...state, history: state.history.map((h) => ids.has(h.id) ? { ...h, pinned } : h) };
}

export function deleteHistoryMany(state, historyIds) {
  const ids = new Set(historyIds);
  return { ...state, history: state.history.filter((h) => !ids.has(h.id)) };
}

export function clearDocument(state) {
  return withBlocks(state, []);
}

export function clearHistory(state) {
  return { ...state, history: [] };
}

export function joinedText(state) {
  return state.document.blocks.map((b) => b.text).join("");
}
