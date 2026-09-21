/* 🍞 AI Breadcrumb — @COUPLED index.ts（调用方）, sections.mjs, ask.mjs, ../../docs/JEV-HARNESS-PLAN.md §3-P0
 * @WHY 这里的规则都是**安全规则**，不是优化：①没被判断的片段一律保留（模型没回答 ≠ 不重要）；
 *   ②失败/错误结果一律不裁（`isError` 的正文通常就是全部信息）；③判完全留就等于没裁（别白花一次调用）；
 *   ④省不到阈值就不改（改写本身有风险，收益必须明显）。
 * @CONTRACT 绝不丢 `details`/`isError`/非文本 part —— 只重写 `content` 里的文本。
 */

/** 省略标记：必须**显式可见**（agent 要能看出这是被过滤过的结果）且给可执行的补救方式。 */
export function elisionMarker(section) {
  const preview = section.firstLine ? ` 首行：${section.firstLine}` : "";
  return [
    `[jev-trim 已省略 ${section.text.length} 字（Jev 判定与当前目标无关）]`,
    preview.trim(),
    "  需要这段原文：用更精确的命令重跑（例如 grep/head/rg 收窄范围），原文已不在上下文里。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 纯函数：根据分数算出新文本。
 * @returns null = 不该改写（全留 / 收益不足）；否则 `{ text, kept, elided, charsBefore, charsAfter, savedRatio }`
 */
export function planTrim({
  text,
  sections,
  scores,
  keepAt,
  minSavingRatio = 0.15,
  maxKeptRatio = 0.8,
}) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const scoreOf = (index) => {
    const value = scores?.[`section_${index}`];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  };
  const unscored = sections
    .filter((s) => scoreOf(s.index) === undefined)
    .map((s) => s.index);
  let kept = sections.filter((s) => {
    const score = scoreOf(s.index);
    return score === undefined || score >= keepAt;
  });
  if (kept.length === sections.length) return null;
  if (kept.length === 0) {
    // 全判无关也要留一段：整段清空是「凭一次概率删掉全部输出」，风险不对称。
    const best = sections.reduce((a, b) =>
      (scoreOf(b.index) ?? -1) > (scoreOf(a.index) ?? -1) ? b : a,
    );
    kept = [best];
  }
  const keptIds = new Set(kept.map((s) => s.index));
  const elided = sections.filter((s) => !keptIds.has(s.index));
  if (kept.length / sections.length > maxKeptRatio) return null;

  const parts = [];
  parts.push(
    `[jev-trim 已过滤工具结果：保留 ${kept.length}/${sections.length} 段（Jev 判定与当前目标相关）；省略段见下方标记]`,
  );
  for (const section of sections) {
    parts.push(
      keptIds.has(section.index) ? section.text : elisionMarker(section),
    );
  }
  const result = parts.join("\n\n");
  const charsAfter = result.length;
  const savedRatio = text.length > 0 ? 1 - charsAfter / text.length : 0;
  if (savedRatio < minSavingRatio) return null;
  return {
    text: result,
    kept: kept.map((s) => s.index).sort((a, b) => a - b),
    elided: elided.map((s) => s.index).sort((a, b) => a - b),
    unscored,
    charsBefore: text.length,
    charsAfter,
    savedRatio,
  };
}

/** 从工具结果内容里取纯文本（只取文本 part；非文本 part 保持不动）。 */
export function textParts(content) {
  const list = Array.isArray(content) ? content : [content];
  return list
    .map((part, index) => {
      if (typeof part === "string")
        return { index, kind: "string", text: part };
      if (
        part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return { index, kind: "part", text: part.text };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * 把新文本写回 content：**只**替换文本 part。
 * @CONTRACT 当有多个文本 part 时，把裁剪后的整段文本放进第一个 part，其余文本 part 清空
 *   （我们按整份结果切片，无法忠实地再把片段映射回原始 part 边界）。
 */
export function applyTrimmedText(content, trimmed) {
  if (typeof content === "string") return trimmed;
  const list = Array.isArray(content) ? [...content] : null;
  if (!list) return content;
  const first = list.findIndex(
    (part) => part && typeof part === "object" && part.type === "text",
  );
  if (first < 0) return content;
  list[first] = { ...list[first], text: trimmed };
  for (let i = first + 1; i < list.length; i += 1) {
    const part = list[i];
    if (part && typeof part === "object" && part.type === "text")
      list[i] = { ...part, text: "" };
  }
  return list;
}
