export const DEFAULT_TARGET = "focodex@foxbook.example";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateDraft(text) { if (typeof text !== "string" || !text.trim()) throw Error("送信する文章がありません。"); if (text.length > 20000) throw Error("送信できる文章は20,000文字単位以内です。文章を短くしてください。"); }
export async function sendDraft(runtime, target, requestId, text) {
  validateDraft(text); if (typeof target !== "string" || !target.trim() || target.length > 256 || !UUID.test(requestId)) throw Error("送信先または要求IDを確認してください。");
  let timer; try { const reply = await Promise.race([runtime.sendMessage(target, {type: "focodex.buffer.receive", version: 1, requestId, text}), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("応答がありません。")), 5000); })]); if (!reply || reply.version !== 1 || reply.requestId !== requestId || !["accepted", "duplicate", "rejected"].includes(reply.status)) throw Error("対応する受信結果を確認できません。"); return reply; } finally { clearTimeout(timer); }
}
export function statusText(reply) { const labels = {accepted: "Focodexの受信バッファへ保存しました。", duplicate: "Focodexは同じ送信を既に受理しています。"}; const reasons = {unauthorized: "送信元が許可されていません。", invalid_message: "通信形式に対応していません。", rate_limited: "短時間の要求が多いため、少し待ってください。", request_id_conflict: "同じ送信IDに異なる文章があります。新規送信してください。", storage_error: "Focodexで文章を保存できません。"}; return reply.status === "rejected" ? `受け付けられませんでした。${reasons[reply.reason] || "Focodexを確認してください。"}` : labels[reply.status]; }
