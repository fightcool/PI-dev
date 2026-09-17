/**
 * 系统级上下文策略（server/context-policy.ts）单测。
 *
 * 契约来自业界惯例（本机 Codex 源码 openai/codex）：
 *  - 有效窗口 = 声明窗口 × effective_context_window_percent（默认 95）
 *  - auto_compact_token_limit 可选，配置可覆盖模型默认值（一处生效）
 *  - pi 侧换算：reserveTokens = 真实窗口 − 触发点
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CODEX_EQUIVALENT_TOKEN_LIMIT,
	DEFAULT_CONTEXT_POLICY,
	describeContextBudget,
	makeContextPolicyLoader,
	normalizeContextPolicy,
	resolveContextBudget,
} from "../../server/context-policy.js";

const policy = (over: Partial<typeof DEFAULT_CONTEXT_POLICY> = {}) => ({ ...DEFAULT_CONTEXT_POLICY, ...over });

describe("resolveContextBudget", () => {
	it("默认（无绝对上限）= 有效窗口：Codex 同族模型 272k 声明 → 258.4k 触发", () => {
		const budget = resolveContextBudget(272_000, policy())!;
		expect(budget.effectiveWindow).toBe(258_400); // 272000 × 95%
		expect(budget.triggerTokens).toBe(258_400);
		expect(budget.reserveTokens).toBe(272_000 - 258_400); // 13,600
		expect(budget.cappedByLimit).toBe(false);
	});

	it("绝对上限收口全局：1,050,000 窗口被压到 258,400（Codex 实跑预算）", () => {
		const budget = resolveContextBudget(1_050_000, policy({ autoCompactTokenLimit: CODEX_EQUIVALENT_TOKEN_LIMIT }))!;
		expect(budget.effectiveWindow).toBe(997_500); // 1050000 × 95%
		expect(budget.triggerTokens).toBe(258_400);
		expect(budget.reserveTokens).toBe(791_600);
		expect(budget.cappedByLimit).toBe(true);
	});

	it("绝对上限不会反噬小窗口模型（取两者较小）", () => {
		const budget = resolveContextBudget(200_000, policy({ autoCompactTokenLimit: CODEX_EQUIVALENT_TOKEN_LIMIT }))!;
		expect(budget.effectiveWindow).toBe(190_000);
		expect(budget.triggerTokens).toBe(190_000); // 190k < 258.4k
		expect(budget.cappedByLimit).toBe(false);
	});

	it("百分比可调，且 reserve 永远严格小于窗口（不会每轮都压缩）", () => {
		for (const percent of [50, 80, 95, 100]) {
			for (const window of [8_000, 200_000, 1_050_000]) {
				const budget = resolveContextBudget(window, policy({ effectiveWindowPercent: percent }))!;
				expect(budget.reserveTokens).toBeGreaterThan(0);
				expect(budget.reserveTokens).toBeLessThan(window);
				expect(budget.triggerTokens).toBe(window - budget.reserveTokens);
				expect(budget.triggerTokens).toBe(Math.min(Math.floor((window * percent) / 100), window - 1));
			}
		}
		// 极小窗口也成立：8k 窗口在 95% 处触发，仍留 400 token 余量
		const tiny = resolveContextBudget(8_000, policy())!;
		expect(tiny.triggerTokens).toBe(7_600);
		expect(tiny.reserveTokens).toBe(400);
	});

	it("窗口未知/非法时不接管（交给 settings.json）", () => {
		for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(resolveContextBudget(bad as number | null | undefined, policy())).toBeUndefined();
		}
	});

	it("exemptModels 豁免绝对上限：只留有效窗口（含裸 id 与 provider/id 两种写法）", () => {
		const capped = policy({ autoCompactTokenLimit: CODEX_EQUIVALENT_TOKEN_LIMIT });
		// 未豁免：被收口
		expect(resolveContextBudget(1_050_000, capped, "rightcode/gpt-6-astra")!.triggerTokens).toBe(258_400);
		// 豁免（写完整 provider/id）：用有效窗口
		const full = resolveContextBudget(1_050_000, policy({ ...capped, exemptModels: ["rightcode/gpt-6-astra"] }), "rightcode/gpt-6-astra")!;
		expect(full.exempt).toBe(true);
		expect(full.triggerTokens).toBe(997_500);
		expect(full.cappedByLimit).toBe(false);
		// 豁免（只写裸 id）也能命中
		const bare = resolveContextBudget(1_050_000, policy({ ...capped, exemptModels: ["gpt-6-astra"] }), "rightcode/gpt-6-astra")!;
		expect(bare.triggerTokens).toBe(997_500);
		// 匹配大小写不敏感；不相关模型不受影响
		expect(resolveContextBudget(1_050_000, policy({ ...capped, exemptModels: ["GPT-6-ASTRA"] }), "rightcode/gpt-6-astra")!.triggerTokens).toBe(997_500);
		expect(resolveContextBudget(1_000_000, policy({ ...capped, exemptModels: ["gpt-6-astra"] }), "deepseek/deepseek-flash")!.triggerTokens).toBe(258_400);
	});

	it("豁免只影响绝对上限：小窗口模型本来就由有效窗口决定", () => {
		const p = policy({ autoCompactTokenLimit: CODEX_EQUIVALENT_TOKEN_LIMIT, exemptModels: ["claude-opus-5"] });
		expect(resolveContextBudget(200_000, p, "micu_claude/claude-opus-5")!.triggerTokens).toBe(190_000);
	});
});

describe("normalizeContextPolicy", () => {
	it("缺省字段用默认值，非法字段回落而不抛错", () => {
		expect(normalizeContextPolicy({})).toEqual(DEFAULT_CONTEXT_POLICY);
		expect(normalizeContextPolicy({ effectiveWindowPercent: 0 }).effectiveWindowPercent).toBe(95);
		expect(normalizeContextPolicy({ effectiveWindowPercent: 120 }).effectiveWindowPercent).toBe(95);
		expect(normalizeContextPolicy({ effectiveWindowPercent: 80.7 }).effectiveWindowPercent).toBe(80);
		expect(normalizeContextPolicy({ autoCompactTokenLimit: -5 }).autoCompactTokenLimit).toBeNull();
		expect(normalizeContextPolicy({ keepRecentTokens: "x" }).keepRecentTokens).toBeNull();
	});

	it("保留合法值并透传 note", () => {
		expect(normalizeContextPolicy({ effectiveWindowPercent: 90, autoCompactTokenLimit: 258_400, keepRecentTokens: 40_000, note: "跟着 codex" })).toEqual({
			effectiveWindowPercent: 90,
			autoCompactTokenLimit: 258_400,
			keepRecentTokens: 40_000,
			exemptModels: [],
			note: "跟着 codex",
		});
	});

	it("exemptModels 去重、去空白；非数组回落空表", () => {
		expect(normalizeContextPolicy({ exemptModels: [" deepseek-flash ", "deepseek-flash", "rightcode/gpt-6-astra"] }).exemptModels).toEqual([
			"deepseek-flash",
			"rightcode/gpt-6-astra",
		]);
		expect(normalizeContextPolicy({ exemptModels: "deepseek-flash" }).exemptModels).toEqual([]);
		expect(normalizeContextPolicy({ exemptModels: [1, null, ""] }).exemptModels).toEqual([]);
	});
});

describe("describeContextBudget", () => {
	it("写清窗口、触发点与来源", () => {
		const text = describeContextBudget(resolveContextBudget(1_050_000, policy({ autoCompactTokenLimit: CODEX_EQUIVALENT_TOKEN_LIMIT })), policy({ autoCompactTokenLimit: CODEX_EQUIVALENT_TOKEN_LIMIT }));
		expect(text).toContain("窗口 1050000");
		expect(text).toContain("258400");
		expect(text).toContain("绝对上限");
		expect(describeContextBudget(undefined, policy())).toContain("窗口未知");
	});
});

describe("makeContextPolicyLoader", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-context-policy-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("文件缺失 → 默认策略；文件出现/改动 → 立即生效（按 mtime）", async () => {
		const load = makeContextPolicyLoader(dir);
		expect(load()).toEqual(DEFAULT_CONTEXT_POLICY);
		const file = join(dir, "context-policy.json");
		writeFileSync(file, JSON.stringify({ autoCompactTokenLimit: 258_400 }));
		expect(load().autoCompactTokenLimit).toBe(258_400);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file, JSON.stringify({ autoCompactTokenLimit: 400_000, note: "调过" }));
		expect(load().autoCompactTokenLimit).toBe(400_000);
		expect(load().note).toBe("调过");
	});

	it("坏 JSON 时不抛错，回落默认", () => {
		const load = makeContextPolicyLoader(dir);
		writeFileSync(join(dir, "context-policy.json"), "{ 坏");
		expect(load()).toEqual(DEFAULT_CONTEXT_POLICY);
	});
});
