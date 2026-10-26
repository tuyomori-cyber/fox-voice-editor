export const HISTORY_LIMIT = 500;
// 日本語JIS配列で直接入力または日本語入力で全角化して使う代表的な記号。
// 半角・全角はプレビュー上も別の文字として扱うため、意図して両方を並べる。
export const FIXED_SYMBOLS = [
  "、", "。", "・", "「", "」", "『", "』", "【", "】", "〈", "〉", "《", "》", "〔", "〕", "｡", "｢", "｣", "､", "･", "ﾞ", "ﾟ",
  "！", "＂", "＃", "＄", "％", "＆", "＇", "（", "）", "＊", "＋", "，", "－", "．", "／", "：", "；", "＜", "＝", "＞", "？", "＠", "［", "＼", "］", "＾", "＿", "｀", "｛", "｜", "｝", "～", "￥",
  "…", "‥", "―", "ー", "〜", "￠", "￡", "€",
  "!", "\"", "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/", ":", ";", "<", "=", ">", "?", "@", "[", "\\", "]", "^", "_", "`", "{", "|", "}", "~", "¥"
];
const DEFAULT_PHRASES = ["の", "を", "ただし", "ではなく", "まず現状を調査", "既存機能は維持"];

export function initialState() {
  return {
    schemaVersion: 2,
    document: { blocks: [] },
    templates: [],
    history: DEFAULT_PHRASES.map((text, index) => ({
      id: `preset-${index}`, text, lastUsedAt: null, useCount: 0
    }))
  };
}

export function restoreState(raw) {
  if (raw === undefined) return initialState();
  if (![1, 2].includes(raw?.schemaVersion) || !Array.isArray(raw.document?.blocks) || !Array.isArray(raw.history)) {
    throw new Error("保存データの形式を読み取れません。内容は上書きしません。");
  }
  const blocks = raw.document.blocks;
  const history = raw.history;
  const templates = raw.templates === undefined ? [] : raw.templates;
  const isValidEntry = (entry) => typeof entry?.id === "string" && typeof entry?.text === "string"
    && (entry.lastUsedAt === null || typeof entry.lastUsedAt === "string")
    && Number.isInteger(entry.useCount) && entry.useCount >= 0
    && (raw.schemaVersion === 2 || typeof entry.pinned === "boolean");
  const withoutPinned = ({pinned, ...entry}) => entry;
  if (blocks.some((b) => typeof b?.id !== "string" || typeof b?.text !== "string") ||
      history.some((h) => !isValidEntry(h)) ||
      !Array.isArray(templates) ||
      templates.some((t) => !isValidEntry(t)) ||
      new Set(blocks.map((b) => b.id)).size !== blocks.length ||
      new Set(history.map((h) => h.id)).size !== history.length ||
      new Set(templates.map((t) => t.id)).size !== templates.length) {
    throw new Error("保存データが不正です。内容は上書きしません。");
  }
  const pinnedHistory = raw.schemaVersion === 1 ? history.filter((entry) => entry.pinned) : [];
  const migratedTemplates = [...templates, ...pinnedHistory.filter((entry) => !templates.some((template) => template.text === entry.text))]
    .map(withoutPinned);
  return {
    schemaVersion: 2,
    document: { blocks: blocks.map((b) => ({ ...b })) },
    templates: migratedTemplates,
    history: (raw.schemaVersion === 1 ? history.filter((entry) => !entry.pinned) : history).map(withoutPinned)
  };
}

function withBlocks(state, blocks) {
  return { ...state, document: { ...state.document, blocks } };
}

function trimHistory(history) {
  const result = [...history];
  while (result.length > HISTORY_LIMIT) {
    result.shift();
  }
  return result;
}

function touchHistory(state, text, now, id) {
  const existing = state.history.find((h) => h.text === text);
  const updated = existing
    ? { ...existing, lastUsedAt: now, useCount: (existing.useCount || 0) + 1 }
    : { id, text, lastUsedAt: now, useCount: 1 };
  return { ...state, history: trimHistory([...state.history.filter((h) => h !== existing), updated]) };
}

function touchTemplate(state, text, now, id) {
  const existing = state.templates.find((t) => t.text === text);
  const updated = existing
    ? { ...existing, lastUsedAt: now, useCount: (existing.useCount || 0) + 1 }
    : { id, text, lastUsedAt: now, useCount: 1 };
  return { ...state, templates: trimHistory([...state.templates.filter((t) => t !== existing), updated]) };
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

export function copyFromHistory(state, historyId, index, blockId) {
  const item = state.history.find((h) => h.id === historyId);
  if (!item) throw new Error("履歴が見つかりません。");
  return insertBlock(state, index, { id: blockId, text: item.text, origin: "history" });
}

export function insertFromTemplate(state, templateId, index, blockId, historyId, now) {
  const item = state.templates.find((t) => t.id === templateId);
  if (!item) throw new Error("定型が見つかりません。");
  return touchTemplate(
    touchHistory(insertBlock(state, index, { id: blockId, text: item.text, origin: "template" }), item.text, now, historyId),
    item.text, now, templateId
  );
}

export function insertSymbolBlock(state, text, index, blockId) {
  if (!FIXED_SYMBOLS.includes(text)) throw new Error("追加する記号が不正です。");
  return insertBlock(state, index, { id: blockId, text, origin: "symbol" });
}

export function appendManualBlock(state, text, blockId, historyId, now) {
  if (!text.trim()) throw new Error("追加する文章を入力してください。");
  return touchHistory(
    insertBlock(state, state.document.blocks.length, { id: blockId, text, origin: "manual" }), text, now, historyId
  );
}

export function addTemplate(state, text, templateId, historyId, now) {
  if (!text.trim()) throw new Error("定型へ追加する文章を入力してください。");
  return touchTemplate(touchHistory(state, text, now, historyId), text, now, templateId);
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

export function sortEntries(state, collection, locale, direction) {
  if (!['history', 'templates'].includes(collection) || !['ja', 'en'].includes(locale) || !['asc', 'desc'].includes(direction)) {
    throw new Error("並べ替え条件が不正です。");
  }
  const collator = new Intl.Collator(locale, {numeric: true, sensitivity: "base"});
  const multiplier = direction === "asc" ? 1 : -1;
  const sorted = state[collection]
    .map((entry, index) => ({entry, index}))
    .sort((left, right) => multiplier * (collator.compare(left.entry.text, right.entry.text) || left.index - right.index))
    .map(({entry}) => entry);
  if (sorted.every((entry, index) => entry === state[collection][index])) return state;
  return {...state, [collection]: sorted};
}

export function deleteHistory(state, historyId) {
  return deleteHistoryMany(state, [historyId]);
}

export function deleteHistoryMany(state, historyIds) {
  const ids = new Set(historyIds);
  return { ...state, history: state.history.filter((h) => !ids.has(h.id)) };
}

export function deleteTemplatesMany(state, templateIds) {
  const ids = new Set(templateIds);
  return { ...state, templates: state.templates.filter((template) => !ids.has(template.id)) };
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
