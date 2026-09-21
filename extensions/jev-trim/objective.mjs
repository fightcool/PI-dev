/* 🍞 AI Breadcrumb — @COUPLED index.ts（调用方）, trim.mjs（判定「与目标相关」就靠它）
 * @WHY 没有目标就没法判「相关」——所以取不到目标时**必须放弃裁剪**（宁可多花 token，也不要凭猜测删内容）。
 *   取最后一条 **user** 消息（不是 assistant：助手的复述会带上它自己刚生成的一大堆推理）。
 * @CONTRACT 纯函数。只取文本，截断到 `maxChars`（目标只是判定依据，不需要全文）；
 *   整条 user 消息里可能包含大段粘贴的代码 —— 同样截断，避免把 state 撑爆。
 */

/** 从消息内容里抽纯文本（字符串 / parts 数组都支持）。 */
export function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string"
      )
        return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 从会话分支里取「当前目标」。
 * @param entries `ctx.sessionManager.getBranch()` 的结果
 * @returns 目标文本；取不到返回 null
 */
export function objectiveFromEntries(entries, maxChars = 600) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "user") continue;
    const text = messageText(message.content).trim();
    if (text.length === 0) continue;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return null;
}
