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
 * @returns {{ sections: {index:number,text:string,firstLine:string}[], merged:boolean }}
 */
export function splitSections(
  text,
  { sectionChars = 1_500, maxSections = 24 } = {},
) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) return { sections: [], merged: false };

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

  let merged = false;
  let buckets = pieces;
  if (pieces.length > maxSections) {
    merged = true;
    const size = Math.ceil(pieces.length / maxSections);
    buckets = [];
    for (let i = 0; i < pieces.length; i += size)
      buckets.push(pieces.slice(i, i + size).join("\n\n"));
  }
  return {
    sections: buckets.map((body, index) => ({
      index,
      text: body,
      firstLine: firstLineOf(body),
    })),
    merged,
  };
}
