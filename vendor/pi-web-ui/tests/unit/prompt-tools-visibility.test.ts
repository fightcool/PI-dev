/*
 * 🍞 @COUPLED server/agent-service.ts「sessionPromptSnapshot」, server/prompt-composer.ts
 * @CONTRACT 回归：**能调用的工具必须在系统提示的 `Available tools:` 里可见**。
 *
 * SDK 的 system-prompt.js 只列出具 snippet 的工具：
 *   const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
 * 没有 snippet 的已注册工具因此对模型隐形 —— 实测后果是模型真诚地回答
 * 「当前会话没有文件系统或终端工具」，而同一会话下一轮又正常调用 read/bash
 * （2026-09-13，/home/dev/project/fayu，rightcode/gpt-6-astra）。
 */
import { describe, expect, it, vi } from "vitest";

const baseInputs = (over: Record<string, unknown> = {}) => ({
	cwd: "/home/dev/project/fayu",
	builtinSoul: "soul",
	selectedTools: [] as string[],
	toolSnippets: {} as Record<string, string>,
	toolGuidelines: [] as string[],
	piReadme: "/r/README.md",
	piDocs: "/r/docs",
	piExamples: "/r/examples",
	appendFiles: [] as string[],
	windowsPersona: "",
	terminalGuidance: "",
	markersGuidance: "",
	contextFiles: [] as { path: string; content: string }[],
	skills: [] as unknown[],
	...over,
});

describe("Available tools 必须覆盖所有可调用工具", () => {
	it("有 snippet 的工具正常出现在列表里", async () => {
		const { resolveSectionTexts } = await import("../../server/prompt-composer.js");
		const texts = resolveSectionTexts(
			baseInputs({
				selectedTools: ["bash", "read"],
				toolSnippets: { bash: "run shell commands", read: "read files" },
			}) as never,
		);
		expect(texts.tools).toContain("- bash: run shell commands");
		expect(texts.tools).toContain("- read: read files");
	});

	it("工具清单为空时显示 (none) 而不是静默省略整段", async () => {
		const { resolveSectionTexts } = await import("../../server/prompt-composer.js");
		const texts = resolveSectionTexts(baseInputs() as never);
		expect(texts.tools).toContain("Available tools:");
		expect(texts.tools).toContain("(none)");
	});

	it("工具没有 snippet 时会被列表丢掉（这正是要修的行为，锁住上游补齐）", async () => {
		const { resolveSectionTexts } = await import("../../server/prompt-composer.js");
		const texts = resolveSectionTexts(
			baseInputs({ selectedTools: ["bash", "mystery_tool"], toolSnippets: { bash: "run shell commands" } }) as never,
		);
		// prompt-composer 只负责渲染；缺 snippet 的工具在这里必然看不见 ——
		// 因此 agent-service 必须在传入前用 description 兜底补齐（见下一条）。
		expect(texts.tools).toContain("- bash:");
		expect(texts.tools).not.toContain("mystery_tool");
	});

	it("agent-service 用 description 兜底补齐缺失的 snippet", async () => {
		// 直接验证兜底规则本身：snippet 优先，缺失时回落 description，都为空白则仍缺席。
		const snippetOf = (def: { promptSnippet?: string; description?: string }): string | undefined => {
			const snippet = def.promptSnippet?.trim() || def.description?.trim();
			return snippet || undefined;
		};
		expect(snippetOf({ promptSnippet: "short", description: "long" })).toBe("short");
		expect(snippetOf({ description: "long" })).toBe("long");
		expect(snippetOf({ promptSnippet: "   ", description: "long" })).toBe("long");
		expect(snippetOf({ promptSnippet: "  ", description: "  " })).toBeUndefined();
	});
});

describe("agent-service 提示快照的兜底实现", () => {
	it("源码里不再只按 promptSnippet 收集（否则工具会隐形）", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
		// 旧写法：if (def.promptSnippet && def.promptSnippet.trim()) snippets[name] = def.promptSnippet;
		// 它会让无 snippet 的工具永远进不了 Available tools。
		expect(src).toContain("def.promptSnippet?.trim() || def.description?.trim()");
	});

	it("兜底注释说明了原因，避免以后被当成冗余代码删掉", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
		expect(src).toMatch(/没有 snippet 的工具因此\*\*在提示词里完全隐形/);
	});
});

// 静默未使用告警（vi 用于未来的行为级断言）。
void vi;
