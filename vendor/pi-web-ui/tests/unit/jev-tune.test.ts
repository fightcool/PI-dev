/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-tune.ts
 * 📖 docs/JEV-DECISION-GATE.md §4（三态阈值：为什么留空白带 / 抖动 ~0.08）、§9（成本）
 * 纯逻辑单测：语料解析坏行、抖动统计、混淆矩阵、建议排序、网格约束、空语料不编造。
 * 全部数据都是合成/注入的（零真实网络、零真实语料）；真实分数的评测见 `npm run jev -- tune`。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	JEV_TUNE_DEFAULT_GRID,
	JEV_TUNE_REPEAT_MAX,
	confusionAt,
	parseJevCorpus,
	suggestThresholds,
	summarizeScores,
	type JevTuneLabel,
	type JevTuneScoredItem,
} from "../../server/dev-con/jev-tune.js";

const T = { approveAt: 0.9, blockAt: 0.1 };

function scored(id: string, label: JevTuneLabel, scores: Record<string, number[]>): JevTuneScoredItem {
	return { id, label, scores };
}

describe("parseJevCorpus", () => {
	it("parses one item per line and ignores blank lines", () => {
		const text = [
			JSON.stringify({
				id: " a ",
				label: "should-pass",
				state: { objective: "add an optional parameter", diff: "+options?: X" },
				propositions: ["change_preserves_public_api"],
			}),
			"",
			"   ",
			JSON.stringify({ id: "b", label: "should-block", state: "raw text", propositions: ["test_asserts_behavior"] }),
		].join("\n");
		const { items, errors } = parseJevCorpus(text);
		expect(errors).toEqual([]);
		expect(items.map((item) => item.id)).toEqual(["a", "b"]);
		expect(items[0]!.state).toEqual({ objective: "add an optional parameter", diff: "+options?: X" });
		// state 形状不限（字符串也是合法 state），原样带出，不做二次加工。
		expect(items[1]!.state).toBe("raw text");
	});

	it("collects bad lines with 1-based line numbers instead of throwing", () => {
		const text = [
			"{ not json", // 1
			"42", // 2
			JSON.stringify({ label: "should-pass", state: {}, propositions: ["change_preserves_public_api"] }), // 3 缺 id
			JSON.stringify({ id: "c", label: "maybe", state: {}, propositions: ["change_preserves_public_api"] }), // 4
			JSON.stringify({ id: "d", label: "should-pass", propositions: ["change_preserves_public_api"] }), // 5 缺 state
			JSON.stringify({ id: "e", label: "should-pass", state: {}, propositions: [] }), // 6
			JSON.stringify({ id: "f", label: "should-pass", state: {}, propositions: ["is_breaking_change"] }), // 7 退场命题
			JSON.stringify({
				id: "g",
				label: "should-pass",
				state: {},
				propositions: ["change_preserves_public_api", "change_preserves_public_api"],
			}), // 8 命题重复
			JSON.stringify({ id: "h", label: "should-pass", state: {}, propositions: ["change_preserves_public_api"] }), // 9 ok
			JSON.stringify({ id: "h", label: "should-block", state: {}, propositions: ["change_preserves_public_api"] }), // 10 id 重复
		].join("\n");
		const { items, errors } = parseJevCorpus(text);
		expect(items.map((item) => item.id)).toEqual(["h"]);
		expect(errors.map((error) => error.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
		expect(errors[0]!.message).toContain("JSON");
		expect(errors[2]!.message).toContain("id");
		expect(errors[3]!.message).toContain("label");
		expect(errors[4]!.message).toContain("state");
		expect(errors[6]!.message).toContain("未知命题");
		expect(errors[8]!.message).toContain("id 重复");
	});

	it("returns empty results for empty / non-string input (no fabrication)", () => {
		expect(parseJevCorpus("")).toEqual({ items: [], errors: [] });
		expect(parseJevCorpus("\n\n")).toEqual({ items: [], errors: [] });
		expect(parseJevCorpus(undefined as unknown as string)).toEqual({ items: [], errors: [] });
	});
});

describe("summarizeScores", () => {
	it("computes min / max / mean / sample standard deviation", () => {
		const [summary] = summarizeScores(
			[{ id: "a", proposition: "change_preserves_public_api", scores: [0.6, 0.7, 0.8] }],
			T,
		);
		expect(summary!.samples).toBe(3);
		expect(summary!.min).toBe(0.6);
		expect(summary!.max).toBe(0.8);
		expect(summary!.mean).toBeCloseTo(0.7, 10);
		// 样本标准差（n-1 分母）：sqrt((0.01+0+0.01)/2) = 0.1
		expect(summary!.stdDev).toBeCloseTo(0.1, 10);
		expect(summary!.scores).toEqual([0.6, 0.7, 0.8]);
		// 三个样本都落在空白带（0.1 < p < 0.9）→ 结论一致，不算翻转。
		expect(summary!.outcomes).toEqual(["review"]);
		expect(summary!.flips).toBe(false);
		// 单次采样看不出抖动 → 0（不是「没有抖动」的证明）。
		expect(summarizeScores([{ id: "a", proposition: "p", scores: [0.95] }], T)[0]!.stdDev).toBe(0);
	});

	it("flags a repeat that crosses a threshold as a flip (verdict, not raw comparison)", () => {
		const [summary] = summarizeScores(
			[{ id: "a", proposition: "change_preserves_public_api", scores: [0.05, 0.5, 0.95] }],
			T,
		);
		expect(summary!.flips).toBe(true);
		// 三态由 decideOutcome 决定：0.05 → block，0.5 → review，0.95 → approve（默认区间含边界）。
		expect(summary!.outcomes).toEqual(["approve", "block", "review"]);
	});

	it("keeps the decideOutcome boundary semantics (>= approveAt / <= blockAt)", () => {
		expect(summarizeScores([{ id: "a", proposition: "p", scores: [0.9] }], T)[0]!.outcomes).toEqual(["approve"]);
		expect(summarizeScores([{ id: "a", proposition: "p", scores: [0.1] }], T)[0]!.outcomes).toEqual(["block"]);
	});

	it("reports nulls for no samples instead of inventing a score", () => {
		const [empty] = summarizeScores([{ id: "a", proposition: "p", scores: [] }], T);
		expect(empty).toMatchObject({
			samples: 0,
			min: null,
			max: null,
			mean: null,
			stdDev: null,
			flips: false,
			outcomes: [],
			scores: [],
		});
		// 非有限值（NaN/Infinity）不是分数：剔除而不是当成 0 或 1。
		const [filtered] = summarizeScores([{ id: "b", proposition: "p", scores: [Number.NaN, 0.95, Infinity] }], T);
		expect(filtered!.samples).toBe(1);
		expect(filtered!.scores).toEqual([0.95]);
		expect(summarizeScores([], T)).toEqual([]);
	});
});

describe("confusionAt", () => {
	it("splits approve/block/review and the four categories, review counted separately", () => {
		const items = [
			scored("pass-ok", "should-pass", { change_preserves_public_api: [0.95] }),
			scored("block-ok", "should-block", { change_preserves_public_api: [0.02] }),
			scored("pass-mid", "should-pass", { change_preserves_public_api: [0.5] }),
			scored("pass-blocked", "should-pass", { change_preserves_public_api: [0.05] }),
			scored("block-passed", "should-block", { change_preserves_public_api: [0.97] }),
		];
		const confusion = confusionAt(items, T);
		expect(confusion).toMatchObject({
			total: 5,
			approve: 2,
			block: 2,
			review: 1,
			correctPass: 1,
			correctBlock: 1,
			falsePass: 1,
			falseBlock: 1,
			labeledPass: 3,
			labeledBlock: 2,
		});
		expect(confusion.falsePassItems.map((item) => item.id)).toEqual(["block-passed"]);
		expect(confusion.falseBlockItems.map((item) => item.id)).toEqual(["pass-blocked"]);
		expect(confusion.reviewItems.map((item) => item.id)).toEqual(["pass-mid"]);
		expect(confusion.flips).toEqual([]);
	});

	it("counts an item as false-pass only when every repeat approved, and lists the flip", () => {
		const items = [
			scored("solid-block", "should-block", { change_preserves_public_api: [0.02, 0.04] }),
			scored("flip", "should-block", { change_preserves_public_api: [0.02, 0.95] }),
			scored("solid-pass", "should-block", { change_preserves_public_api: [0.95, 0.97] }),
		];
		const confusion = confusionAt(items, T);
		// 抖动的那条按最保守的结论归类（block 一次就算拦下），但必须出现在 flips 里。
		expect(confusion.correctBlock).toBe(2);
		expect(confusion.falsePass).toBe(1);
		expect(confusion.falsePassItems.map((item) => item.id)).toEqual(["solid-pass"]);
		expect(confusion.flips).toEqual(["flip"]);
	});

	it("excludes items without scores (no fake 0) and lists the reason", () => {
		const items = [
			scored("no-scores", "should-block", {}),
			scored("empty-array", "should-block", { change_preserves_public_api: [] }),
			scored("ok", "should-block", { change_preserves_public_api: [0.01] }),
		];
		const confusion = confusionAt(items, T);
		expect(confusion.total).toBe(1);
		expect(confusion.correctBlock).toBe(1);
		expect(confusion.unusable.map((entry) => entry.id)).toEqual(["no-scores", "empty-array"]);
		expect(confusion.unusable[0]!.reason).toContain("不补 0");
	});

	it("returns all-zero counts for an empty corpus", () => {
		const confusion = confusionAt([], T);
		expect(confusion).toMatchObject({
			total: 0,
			approve: 0,
			block: 0,
			review: 0,
			correctPass: 0,
			correctBlock: 0,
			falsePass: 0,
			falseBlock: 0,
			labeledPass: 0,
			labeledBlock: 0,
		});
		expect(confusion.flips).toEqual([]);
		expect(confusion.unusable).toEqual([]);
	});
});

describe("suggestThresholds", () => {
	it("ships the documented grid and refuses to evaluate blockAt >= approveAt", () => {
		expect(JEV_TUNE_DEFAULT_GRID).toEqual({ approveAt: [0.8, 0.85, 0.9, 0.95], blockAt: [0.02, 0.05, 0.1, 0.15] });
		expect(JEV_TUNE_REPEAT_MAX).toBe(5);
		const { suggestions, evaluated, skipped } = suggestThresholds([], {
			approveAt: [0.5],
			blockAt: [0.6, 0.5, 0.1],
		});
		expect(evaluated).toBe(1);
		expect(skipped).toEqual([
			{ approveAt: 0.5, blockAt: 0.6 },
			{ approveAt: 0.5, blockAt: 0.5 },
		]);
		expect(suggestions.map((s) => [s.approveAt, s.blockAt])).toEqual([[0.5, 0.1]]);
	});

	it("ranked by fewest false passes first", () => {
		const items = [
			// 0.92 会被 approveAt 0.8/0.85/0.9 放行（误放行），只有 0.95 拦得住。
			scored("near-miss", "should-block", { change_preserves_public_api: [0.92] }),
			scored("clean", "should-pass", { change_preserves_public_api: [0.97] }),
		];
		const { suggestions } = suggestThresholds(items);
		expect(suggestions[0]!.approveAt).toBe(0.95);
		expect(suggestions[0]!.confusion.falsePass).toBe(0);
		// 排序单调：误放行数量从头到尾不下降。
		const falsePassCounts = suggestions.map((suggestion) => suggestion.confusion.falsePass);
		expect(falsePassCounts).toEqual([...falsePassCounts].sort((a, b) => a - b));
		// 依据文案必须写清四个指标（人靠它判断这一档为什么排在前面）。
		expect(suggestions[0]!.rationale).toContain("误放行 0");
		expect(suggestions[0]!.rationale).toContain("空白带");
	});

	it("breaks ties by the wider blank band, deterministically", () => {
		const items = [scored("mid", "should-pass", { change_preserves_public_api: [0.5] })];
		const { suggestions } = suggestThresholds(items, undefined, 4);
		// 所有档位都同样是「转人工 1」，于是比空白带（approveAt - blockAt）更宽的排前面。
		expect(suggestions.map((s) => [s.approveAt, s.blockAt])).toEqual([
			[0.95, 0.02],
			[0.95, 0.05],
			[0.9, 0.02],
			[0.95, 0.1],
		]);
		// 同一输入两次调用必须完全一致（否则建议不可复现）。
		expect(suggestThresholds(items, undefined, 4).suggestions).toEqual(suggestions);
	});

	it("keeps the default top limit and reports empty corpora without fabricating", () => {
		const { suggestions, evaluated } = suggestThresholds([]);
		expect(evaluated).toBe(16);
		expect(suggestions).toHaveLength(5);
		for (const suggestion of suggestions) {
			expect(suggestion.confusion.total).toBe(0);
			expect(suggestion.confusion.falsePass).toBe(0);
			expect(suggestion.approveAt).toBeGreaterThan(suggestion.blockAt);
		}
	});
});

describe("pure-logic contract", () => {
	it("imports no fs / network / SDK (only the model module)", () => {
		const source = readFileSync(new URL("../../server/dev-con/jev-tune.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/node:(fs|net|http|https|child_process)/);
		expect(source).not.toMatch(/\bfetch\(/);
		// 只允许向同目录的模型模块取事实源；出现 `../` 说明它开始依赖外层（CLI/gate/磁盘）。
		expect(source).not.toMatch(/from "\.\.\//);
		expect(source).toContain('from "./jev-model.js"');
	});
});
