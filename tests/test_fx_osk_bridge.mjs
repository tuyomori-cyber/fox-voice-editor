import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FX_OSK_TARGET, validExtensionId, frameUrlFromReply, supportedKey } from "../extension/fx-osk-bridge.mjs";

test("FX-OSK bridge accepts configured extension IDs and its frame response only", () => {
  assert.ok(validExtensionId(DEFAULT_FX_OSK_TARGET));
  assert.ok(validExtensionId("keyboard@example.invalid"));
  assert.ok(!validExtensionId("https://example.invalid"));
  const url = frameUrlFromReply({type: "fxosk.frame.response", version: 1, url: "moz-extension://opaque-id/keyboard-frame.html"});
  assert.equal(url.protocol, "moz-extension:");
  assert.throws(() => frameUrlFromReply({type: "fxosk.frame.response", version: 1, url: "https://example.invalid/keyboard-frame.html"}));
  assert.throws(() => frameUrlFromReply({type: "other", version: 1, url: "moz-extension://opaque-id/keyboard-frame.html"}));
});

test("FX-OSK bridge accepts one character and editing keys only", () => {
  assert.ok(supportedKey("あ"));
  assert.ok(supportedKey("Backspace"));
  assert.ok(!supportedKey("PasteEverything"));
});
