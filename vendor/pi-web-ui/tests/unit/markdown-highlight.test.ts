// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Markdown, detectSubset, rehypePlugins } from "../../web/src/components/Markdown.js";
import { LanguageProvider } from "../../web/src/i18n.js";

// React 在测试环境下需要显式声明才有 act 支持（同其余 jsdom 单测）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Markdown 高亮（jsdom）：锁定 `detect` 语言集的**配置契约**与自动嗅探行为。
 *
 * 目的是防止有人把 subset 悄悄去掉：那会把每个无标注围栏的成本重新拉回 37 种
 * 语法全跑（实测 40 行块 16.7ms → 53.0ms，短块 1.6ms → 6.2ms，见 Markdown.tsx
 * 的 @PERF 注释）。
 */

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
	host = undefined;
});

function render(markdown: string): string {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(Markdown, { text: markdown })));
	});
	return host.innerHTML;
}

describe("markdown 高亮语言集", () => {
	it("rehype-highlight 开启 detect 且限定在 detectSubset 内", () => {
		const [, options] = rehypePlugins[0] as [unknown, { detect?: boolean; subset?: readonly string[] }];
		expect(options.detect).toBe(true);
		expect(options.subset).toBe(detectSubset);
	});

	it("detectSubset 覆盖 agent 输出里的高频语言", () => {
		for (const lang of ["bash", "shell", "python", "javascript", "typescript", "json", "yaml", "diff"]) {
			expect(detectSubset).toContain(lang);
		}
	});

	it("无标注围栏在集合内仍自动猜语言并高亮", () => {
		const html = render("```\n$ npm run build\n> tsc -p tsconfig.server.json\n```");
		expect(html).toMatch(/<span class="hljs-/);
	});

	it("带语言标注的围栏照常高亮", () => {
		const html = render("```ts\nexport const answer: number = 42;\n```");
		expect(html).toMatch(/<span class="hljs-/);
	});
});
