/**
 * 🍞 AI Breadcrumb Navigation — @COUPLED=highlight-subset.ts（语法注册表）、Markdown.tsx.
 * @WHY `rehype-highlight` 只能整包带上 lowlight 的 37 门 `common` 语法（≈300 KB），
 *      而我们实际需要的是「名单内可用 + 子集内自动嗅探」。这个插件用自建 lowlight
 *      实例做同样的事，包体只含注册过的语法。
 * @CONTRACT 产出与 rehype-highlight 对齐：`code` 元素带 `hljs` 类；自动嗅探命中时
 *      追加 `language-<name>`；未注册/未命中的语言保持原样（不高亮、不报错）。
 * @GOTCHA 必须在 hast 层工作：lowlight 返回的是 hast 子节点，直接替换 `code.children`，
 *      下游 `splitCodeLines` 才能按行还原（与 rehype-highlight 的行为一致）。
 */
import { toText } from "hast-util-to-text";
import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";
import { lowlight } from "./highlight-subset";

export interface HighlightSubsetOptions {
	/** Only these languages are tried when guessing an UNLABELED block. */
	subset: readonly string[];
	/** Guess the language of unlabeled blocks (same meaning as rehype-highlight). */
	detect?: boolean;
	prefix?: string;
}

/** Languages whose content must stay verbatim (no highlighting, no guessing). */
const PLAIN = new Set(["plaintext", "text", "txt", "no-highlight", "nohighlight"]);

/** Mirror of rehype-highlight's language resolution: `language-x` / `lang-x`. */
function languageOf(node: Element): string | undefined {
	const classes = Array.isArray(node.properties?.className) ? node.properties.className : [];
	for (const value of classes) {
		const match = /^(?:language|lang)-(.+)$/.exec(String(value));
		if (match) return match[1].toLowerCase();
	}
	return undefined;
}

export function rehypeHighlightSubset(options: HighlightSubsetOptions) {
	const { subset, detect = false, prefix = "hljs-" } = options;
	return (tree: Root) => {
		visit(tree, "element", (node: Element, index, parent) => {
			if (node.tagName !== "code" || !parent || parent.type !== "element" || parent.tagName !== "pre") return;
			const code = toText(node, { whitespace: "pre" });
			const lang = languageOf(node);
			if (lang && PLAIN.has(lang)) return;
			// lowlight 返回的是 hast Root（其 children 为 RootContent）；写回 code 元素时
			// 取它的 children 即可（高亮的 span 都是 ElementContent）。
			let result: { children: unknown[]; data?: { language?: string } } | undefined;
			try {
				if (lang) {
					// 显式标注：只认注册过的语法；未注册的按普通代码块处理（同 ignoreMissing）。
					if (!lowlight.registered(lang)) return;
					result = lowlight.highlight(lang, code, { prefix });
				} else if (detect && subset.length > 0) {
					result = lowlight.highlightAuto(code, { prefix, subset: [...subset] });
					// highlightAuto 以 plaintext 兜底：没有命中时不高亮（同 rehype-highlight 的观感）。
					if (!result.data?.language) return;
				} else {
					return;
				}
			} catch {
				// 坏语法/异常输入只影响这一块：保持原样比让整条消息渲染失败好。
				return;
			}
			const className = Array.isArray(node.properties.className) ? [...node.properties.className] : [];
			if (!className.includes("hljs")) className.unshift("hljs");
			if (!lang && result.data?.language) className.push(`language-${result.data.language}`);
			node.properties.className = className;
			if (result.children.length > 0) node.children = result.children as Element["children"];

			void index;
			return "skip" as const;
		});
	};
}
