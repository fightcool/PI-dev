/**
 * 压缩阈值策略（server/compaction-policy.ts）单测：触发点必须是整窗口的 86%。
 *
 * 契约来源：SDK 判据 `contextTokens > contextWindow - reserveTokens`
 * （@earendil-works/pi-coding-agent dist/core/compaction/compaction.js:163），
 * 因此 86% 触发 ⇔ reserveTokens = ceil(窗口 × 14%)。
 */
import { describe, expect, it } from "vitest";
import {
	COMPACTION_MIN_RESERVE_TOKENS,
	COMPACTION_TRIGGER_PERCENT,
	compactionTriggerTokens,
	describeCompactionPolicy,
	reserveTokensForContextWindow,
} from "../../server/compaction-policy.js";

const RATIO = COMPACTION_TRIGGER_PERCENT / 100;

describe("reserveTokensForContextWindow", () => {
	it("按 14% 换算 reserveTokens（本项目在用的窗口）", () => {
		expect(reserveTokensForContextWindow(200_000)).toBe(28_000);
		expect(reserveTokensForContextWindow(1_000_000)).toBe(140_000);
		expect(reserveTokensForContextWindow(1_050_000)).toBe(147_000);
	});

	it("触发点正好落在 86%", () => {
		for (const window of [200_000, 262_144, 1_000_000, 1_050_000]) {
			const trigger = compactionTriggerTokens(window)!;
			const reserve = reserveTokensForContextWindow(window)!;
			expect(window - reserve).toBe(trigger);
			// reserve 取整 ⇒ 触发点只可能略早于 86%，绝不会晚于它
			expect(trigger / window).toBeLessThanOrEqual(RATIO);
			expect(trigger / window).toBeGreaterThan(RATIO - 0.001);
		}
	});

	it("小窗口退到下限，不会把 reserve 压到 0", () => {
		expect(reserveTokensForContextWindow(50_000)).toBe(COMPACTION_MIN_RESERVE_TOKENS);
		expect(compactionTriggerTokens(50_000)).toBe(50_000 - COMPACTION_MIN_RESERVE_TOKENS);
	});

	it("窗口未知/非法时不接管（返回 undefined，让调用方回退 settings.json）", () => {
		for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(reserveTokensForContextWindow(bad)).toBeUndefined();
			expect(compactionTriggerTokens(bad)).toBeUndefined();
		}
	});
});

describe("describeCompactionPolicy", () => {
	it("给出窗口、触发点与 reserve；窗口未知时说明回退", () => {
		const text = describeCompactionPolicy(1_000_000);
		expect(text).toContain("window=1000000");
		expect(text).toContain("860000");
		expect(text).toContain("86%");
		expect(text).toContain("reserve=140000");
		expect(describeCompactionPolicy(undefined)).toContain("window unknown");
	});
});
