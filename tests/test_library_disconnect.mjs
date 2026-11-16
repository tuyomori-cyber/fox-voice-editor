import assert from "node:assert/strict";

class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.style = {}; this.listeners = {};
    this.classList = {add() {}, remove() {}, toggle() {}, contains() { return false; }};
    this.hidden = true; this.value = ""; this.textContent = "";
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  querySelectorAll() { return []; }
  click() { this.listeners.click?.({}); }
}
class Port {
  constructor() {
    this.sent = [];
    this.onMessage = {addListener: (fn) => { this.message = fn; }};
    this.onDisconnect = {addListener: (fn) => { this.disconnect = fn; }};
  }
  postMessage(message) { this.sent.push(message); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => realSetInterval(...args).unref();

async function setup(index) {
  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  globalThis.document = {getElementById: node, createElement: () => new Element(), body: new Element()};
  globalThis.window = {addEventListener() {}, innerWidth: 1000, innerHeight: 800, setTimeout};
  const library = new Port(); const speech = new Port();
  const saved = {schemaVersion: 2, document: {blocks: [{id: "existing", text: "保存済み"}]}, history: [], templates: []};
  globalThis.browser = {
    storage: {local: {get: async () => ({editorState: saved}), set: async () => {}}},
    runtime: {connectNative: (name) => name === "fox_voice_editor" ? library : speech}
  };
  await import(`../extension/editor.mjs?test=${index}`);
  await tick();
  library.message({event: "library_loaded", exists: true, library: {schemaVersion: 2, history: [], templates: []}});
  speech.message({event: "microphone_prepared", status: "ready"});
  speech.message({event: "engine_prepared", engine: "whisper", engineStatus: "ready", engineGeneration: 0});
  node("record-toggle").click();
  return {node, speech, library};
}

for (const [index, phase] of ["starting", "recording", "stopping", "converting", "recognizing"].entries()) {
  const {node, speech, library} = await setup(index);
  const started = {event: "started", recordingId: "rec", engine: "whisper", engineGeneration: 0};
  if (phase !== "starting") speech.message(started);
  if (phase === "stopping") speech.message({event: "stopping", recordingId: "rec"});
  if (["converting", "recognizing"].includes(phase)) speech.message({event: "processing", recordingId: "rec", state: phase});
  library.disconnect();
  if (phase === "starting") {
    assert.equal(speech.sent.filter((m) => m.action === "cancel_recording").length, 0);
    speech.message(started);
  }
  assert.deepEqual(speech.sent.filter((m) => m.action === "cancel_recording"), [{version: 1, action: "cancel_recording", recordingId: "rec"}], phase);
  assert.equal(node("record-toggle").disabled, true);
  speech.message({event: "result", recordingId: "rec", engine: "whisper", engineGeneration: 0, text: "破棄"});
  assert.equal(node("preview").textContent, "保存済み", phase);
  assert.equal(node("record-toggle").disabled, true);
}
{
  const {node, speech} = await setup("auto-stop");
  speech.message({event: "started", recordingId: "auto", engine: "whisper", engineGeneration: 0});
  speech.message({event: "stopping", recordingId: "auto", state: "stopping", reason: "recording_limit"});
  speech.message({event: "processing", recordingId: "auto", state: "recognizing"});
  speech.message({event: "result", recordingId: "auto", engine: "whisper", engineGeneration: 0, text: "自動認識"});
  assert.equal(node("preview").textContent, "保存済み自動認識");
  assert.match(node("timer").textContent, /自動停止〜結果表示/);
  assert.equal(node("record-toggle").disabled, false);
}
console.log("library disconnect cancellation: ok");
