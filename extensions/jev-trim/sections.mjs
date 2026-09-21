/* 🍞 AI Breadcrumb — @COUPLED trim.mjs（用它切片）, config.mjs（sectionChars/maxSections）
 * @WHY 「片段」是这套机制的最小单位：判断以片段为单位、保留也以片段为单位。切片必须**不丢字**——
 *   所有字符要么落在某个片段里（被判断），要么在这次裁剪里被显式丢弃（写进省略标记）。
 *   任何「悄悄吞掉一段」的实现都会让 agent 以为自己看全了。
 * @CONTRACT 纯函数、无 IO。片段数超上限时**合并**相邻片段（粗粒度全覆盖），而不是扔掉一部分不判断——
 *   没被判断的内容不许出现在「保留下来的」集合里。
 */

const HARD_SPLIT_FACTOR = 2;

/** 单个超长段落按行硬切（尽量在换行处断，实在没有就按字符断）。 */
function hardSplit(paragraph, limit) {
  const out = [];
  let current = "";
  for (const line of paragraph.split("\n")) {
    if (current && current.length + line.length + 1 > limit) {
      out.push(current);
      current = "";
    }
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit)
        out.push(line.slice(i, i + limit));
      continue;
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) out.push(current);
  return out;
}

const firstLineOf = (text) => {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 160);
};

/**
 * 把工具结果切成片段。
 * @property sampled = 片段数超过上限、只判其中一部分（未判到的片段调用方必须原样保留）
 * @returns {{ sections: {index:number,text:string,firstLine:string}[], sampled:boolean }}
 */
export function splitSections(
  text,
  { sectionChars = 1_500, maxSections = 24 } = {},
) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) return { sections: [], sampled: false };

  const pieces = [];
  let current = "";
  const flush = () => {
    if (current.trim().length > 0) pieces.push(current);
    current = "";
  };
  for (const paragraph of normalized.split(/\n{2,}/)) {
    if (paragraph.length > sectionChars * HARD_SPLIT_FACTOR) {
      flush();
      pieces.push(...hardSplit(paragraph, sectionChars));
      continue;
    }
    if (current && current.length + paragraph.length + 2 > sectionChars)
      flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();

  /**
   * 片段数超上限时**均匀取样**，绝不合并。
   * @BUGFIX 第一版是「合并相邻片段」：每段长度变成 `总长/上限`，实测 90k 字的工具结果 → 22 段 × 4.1k 字，
   *   等于把**整份结果**塞进 state；上游按 token 限流（`state` + 最长问题 ≤ 32k token），
   *   于是每次都是 HTTP 400 `max_tokens_exceeded` —— 功能等于没生效，还白花一次调用。
   *   取样是「只判一部分」：没被判断的片段按安全规则**原样保留**，所以取样不丢字、也不会误删。
   */
  let sampled = false;
  let buckets = pieces;
  if (pieces.length > maxSections) {
    sampled = true;
    buckets = [];
    const step = pieces.length / maxSections;
    for (let i = 0; i < maxSections; i += 1)
      buckets.push(pieces[Math.floor(i * step)]);
  }
  return {
    sections: buckets.map((body, index) => ({
      index,
      text: body,
      firstLine: firstLineOf(body),
    })),
    sampled,
  };
}
