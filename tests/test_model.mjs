import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, restoreState, applyVoiceResult, appendManualBlock, addTemplate, insertFromHistory, insertFromTemplate, insertSymbolBlock, deleteBlock, deleteBlocks,
  moveBlock, reorderBlocks, setPinned, deleteHistory, setPinnedMany, deleteHistoryMany,
  joinedText, HISTORY_LIMIT
} from "../extension/model.mjs";

const time = "2026-10-19T00:00:00.000Z";

function voice(state, text, index, id) {
  return applyVoiceResult(state, text, { kind: "insert", index }, id, `history-${id}`, time);
}

test("voice blocks insert, move and join without separators", () => {
  let state = voice(initialState(), "Firefox", 0, "b1");
  state = voice(state, "を", 1, "b2");
  state = voice(state, "変更する", 2, "b3");
  assert.equal(joinedText(state), "Firefoxを変更する");
  state = moveBlock(state, "b2", -1);
  assert.equal(joinedText(state), "をFirefox変更する");
  const before = state;
  assert.throws(() => applyVoiceResult(state, "失敗", { kind: "replace", blockId: "b2" }, "x", "h", time));
  assert.equal(state, before);
});

test("history reuse creates independent block and deletion preserves document", () => {
  let state = voice(initialState(), "既存機能は維持", 0, "b1");
  const history = state.history.find((h) => h.text === "既存機能は維持");
  assert.equal(history.pinned, true);
  assert.equal(state.history.filter((h) => h.text === history.text).length, 1);
  state = insertFromHistory(state, history.id, 1, "b2", time);
  assert.equal(state.document.blocks[1].origin, "history");
  assert.equal(state.document.blocks[1].id, "b2");
  assert.equal(state.history.find((h) => h.id === history.id).useCount, 2);
  state = deleteHistory(state, history.id);
  assert.equal(state.document.blocks.length, 2);
  state = deleteBlock(state, "b1");
  assert.equal(state.document.blocks[0].id, "b2");
});

test("manual entry appends an independently editable block and adds it to history", () => {
  let state = voice(initialState(), "音声", 0, "voice");
  const historyBefore = state.history;
  state = appendManualBlock(state, "手入力", "manual", "history-manual", time);
  assert.deepEqual(state.document.blocks.map((block) => [block.id, block.text, block.origin]), [
    ["voice", "音声", "voice"], ["manual", "手入力", "manual"]
  ]);
  assert.equal(joinedText(state), "音声手入力");
  assert.notEqual(state.history, historyBefore);
  assert.ok(state.history.some((item) => item.text === "手入力"));
  assert.throws(() => appendManualBlock(state, "   ", "empty", "history-empty", time));
});

test("manual template entry is stored separately and also added to history", () => {
  let state = initialState();
  state = addTemplate(state, "確認してください", "template-1", "history-template-1", time);
  assert.deepEqual(state.templates.map((item) => item.text), ["確認してください"]);
  assert.ok(state.history.some((item) => item.text === "確認してください"));
  state = addTemplate(state, "確認してください", "template-2", "history-template-2", time);
  assert.equal(state.templates.length, 1);
  assert.equal(state.templates[0].useCount, 2);
});

test("template and fixed-symbol drags insert distinct document blocks", () => {
  let state = voice(initialState(), "前", 0, "before");
  state = addTemplate(state, "定型句", "template-1", "template-history-1", time);
  state = insertFromTemplate(state, "template-1", 1, "template-block", "template-history-2", time);
  state = insertSymbolBlock(state, "、", 2, "symbol-block");
  state = insertSymbolBlock(state, "？", 3, "fullwidth-symbol-block");
  state = insertSymbolBlock(state, "\\", 4, "halfwidth-symbol-block");
  assert.deepEqual(state.document.blocks.map((block) => [block.text, block.origin]), [
    ["前", "voice"], ["定型句", "template"], ["、", "symbol"], ["？", "symbol"], ["\\", "symbol"]
  ]);
  assert.equal(state.templates[0].useCount, 2);
  assert.ok(state.history.some((item) => item.text === "定型句"));
  assert.throws(() => insertSymbolBlock(state, "あ", 0, "invalid"));
});


test("bulk block deletion preserves unselected blocks and history", () => {
  let state = voice(initialState(), "A", 0, "a");
  state = voice(state, "B", 1, "b");
  state = voice(state, "C", 2, "c");
  const historyBefore = state.history;
  state = deleteBlocks(state, ["a", "c"]);
  assert.deepEqual(state.document.blocks.map((block) => block.id), ["b"]);
  assert.equal(joinedText(state), "B");
  assert.equal(state.history, historyBefore);
});

test("drag order persists as an exact permutation of block ids", () => {
  let state = voice(initialState(), "A", 0, "a");
  state = voice(state, "B", 1, "b");
  state = voice(state, "C", 2, "c");
  const reordered = reorderBlocks(state, ["c", "a", "b"]);
  assert.equal(joinedText(reordered), "CAB");
  assert.equal(reorderBlocks(reordered, ["c", "a", "b"]), reordered);
  assert.throws(() => reorderBlocks(reordered, ["c", "a", "a"]));
  assert.throws(() => reorderBlocks(reordered, ["c", "a", "missing"]));
});

test("unpinned history is capped while pinned entries survive", () => {
  let state = initialState();
  const pinnedId = state.history[0].id;
  for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
    state = voice(state, `項目${i}`, state.document.blocks.length, `b${i}`);
  }
  assert.equal(state.history.length, HISTORY_LIMIT);
  assert.ok(state.history.some((h) => h.id === pinnedId));
  assert.ok(!state.history.some((h) => h.text === "項目0"));
  state = setPinned(state, pinnedId, false);
  assert.equal(state.history.find((h) => h.id === pinnedId).pinned, false);
});

test("bulk pin and deletion affect only selected history, not document blocks", () => {
  let state = voice(initialState(), "追加A", 0, "a");
  state = voice(state, "追加B", 1, "b");
  const selectedIds = state.history.filter((h) => ["追加A", "追加B"].includes(h.text)).map((h) => h.id);
  const other = state.history.find((h) => h.text !== "追加A" && h.text !== "追加B");
  state = setPinnedMany(state, selectedIds, true);
  assert.ok(selectedIds.every((id) => state.history.find((h) => h.id === id).pinned));
  assert.equal(state.history.find((h) => h.id === other.id).pinned, other.pinned);
  state = setPinnedMany(state, selectedIds, false);
  assert.ok(selectedIds.every((id) => !state.history.find((h) => h.id === id).pinned));
  state = deleteHistoryMany(state, selectedIds);
  assert.ok(selectedIds.every((id) => !state.history.some((h) => h.id === id)));
  assert.ok(state.history.some((h) => h.id === other.id));
  assert.equal(joinedText(state), "追加A追加B");
});

test("invalid persisted state is rejected without silent reset", () => {
  assert.throws(() => restoreState({ schemaVersion: 2, document: { blocks: [] }, history: [] }));
  assert.throws(() => restoreState({ schemaVersion: 1, document: { blocks: [{ id: "a" }] }, history: [] }));
  const legacy = initialState();
  delete legacy.templates;
  assert.deepEqual(restoreState(legacy).templates, []);
  assert.equal(restoreState(undefined).schemaVersion, 1);
});
