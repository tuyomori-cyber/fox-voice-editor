export const DEFAULT_FX_OSK_TARGET = "fx-osk-touch@tuyomori-cyber.github.io";

export function validExtensionId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/i.test(value);
}

export function frameUrlFromReply(reply) {
  if (reply?.type !== "fxosk.frame.response" || reply.version !== 1 || typeof reply.url !== "string") {
    throw new Error("FX-OSKから有効な連携情報を受け取れませんでした。");
  }
  const url = new URL(reply.url);
  if (url.protocol !== "moz-extension:" || !url.host || url.pathname !== "/keyboard-frame.html") {
    throw new Error("FX-OSKから受け取った画面URLが不正です。");
  }
  return url;
}

export function supportedKey(value) {
  return typeof value === "string" && (value.length === 1 || ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Enter"].includes(value));
}
