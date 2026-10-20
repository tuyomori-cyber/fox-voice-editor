import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, restoreState, applyVoiceResult, insertFromHistory, deleteBlock,
  moveBlock, reorderBlocks, setPinned, deleteHistory, joinedText, HISTORY_LIMIT
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

test("invalid persisted state is rejected without silent reset", () => {
  assert.throws(() => restoreState({ schemaVersion: 2, document: { blocks: [] }, history: [] }));
  assert.throws(() => restoreState({ schemaVersion: 1, document: { blocks: [{ id: "a" }] }, history: [] }));
  assert.equal(restoreState(undefined).schemaVersion, 1);
});
