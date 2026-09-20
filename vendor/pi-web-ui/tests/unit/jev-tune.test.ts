/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-tune.ts
 * 📖 docs/JEV-DECISION-GATE.md §4（三态阈值：为什么留空白带 / 抖动 ~0.08）、§9（成本）
 * 纯逻辑单测：语料解析坏行、抖动统计、混淆矩阵、建议排序、网格约束、空语料不编造。
 * 全部数据都是合成/注入的（零真实网络、零真实语料）；真实分数的评测见 `npm run jev -- tune`。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { type JevTuneReport, printTuneReport } from "../../scripts/jev-tune-format.js";
import {
	JEV_TUNE_DEFAULT_GRID,
	JEV_TUNE_PROPOSITION_GRID,
	JEV_TUNE_PROPOSITION_STEP,
	JEV_TUNE_REPEAT_MAX,
	analyzePropositionWindows,
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

describe("analyzePropositionWindows", () => {
	const P = "change_preserves_public_api";
	const S = "change_within_task_scope";

	it("gives windowLo / windowHi and the floored approval threshold for a separable proposition", () => {
		const items = [
			scored("p1", "should-pass", { [P]: [0.95] }),
			scored("p2", "should-pass", { [P]: [0.8] }),
			scored("p3", "should-pass", { [P]: [0.73] }),
			scored("b1", "should-block", { [P]: [0.6] }),
			scored("b2", "should-block", { [P]: [0.08] }),
		];
		const [first] = analyzePropositionWindows(items);
		expect(first!.proposition).toBe(P);
		expect(first!.passCount).toBe(3);
		expect(first!.blockCount).toBe(2);
		// 分数按升序排列（人一眼就能看出两类有没有重叠）。
		expect(first!.passScores).toEqual([0.73, 0.8, 0.95]);
		expect(first!.blockScores).toEqual([0.08, 0.6]);
		expect(first!.separable).toBe(true);
		// 建议判据 t ∈ (windowLo, windowHi] = (0.6, 0.73]：0.61..0.73 都既不误放行也不误拦。
		expect(first!.windowLo).toBe(0.6);
		expect(first!.windowHi).toBe(0.73);
		expect(first!.overlap).toBeNull();
		expect(first!.overlapBlockItems).toEqual([]);
		expect(first!.overlapPassItems).toEqual([]);
		expect(first!.unusable).toEqual([]);
		// 最佳档由加宽网格扫出，且该命题的最佳档必须无误放行（排序第一优先级）。
		expect(first!.best!.confusion.falsePass).toBe(0);
		expect(first!.best!.confusion.falseBlock).toBe(0);
		// 建议值 = windowHi 下取整到 0.05（0.73 → 0.70），blockAt 取经验最佳档且严格小于 approveAt。
		expect(first!.recommended!.approveAt).toBe(0.7);
		expect(first!.recommended!.blockAt).toBeLessThan(first!.recommended!.approveAt);
		// 窗口 (0.6, 0.73] 不在全局网格 {0.8,0.85,0.9,0.95} 覆盖内 → 这个命题需要独立阈值。
		expect(first!.needsOwnThreshold).toBe(true);
	});

	it("floors the suggestion to the step but never above the window (0.71 → 0.70)", () => {
		const items = [scored("p", "should-pass", { [P]: [0.71] }), scored("b", "should-block", { [P]: [0.39] })];
		const [analysis] = analyzePropositionWindows(items);
		expect(analysis!.separable).toBe(true);
		expect(analysis!.recommended!.approveAt).toBe(0.7);
		// 最佳档用该命题的均值单独扫描：0.71 准确放行、0.39 转人工（不误拦也不误放行）。
		expect(analysis!.recommended!.blockAt).toBeLessThan(analysis!.recommended!.approveAt);
		expect(analysis!.best!.confusion.correctPass).toBe(1);
		expect(analysis!.best!.confusion.falsePass).toBe(0);
		expect(analysis!.best!.confusion.falseBlock).toBe(0);
	});

	it("reports overlap and names the entries that block separability", () => {
		// 实测形状：scope 的 should-block 最高 0.79 高于 should-pass 最低 0.39 → 没有可分窗口。
		const items = [
			scored("p1", "should-pass", { [S]: [0.71] }),
			scored("p2", "should-pass", { [S]: [0.5] }),
			scored("p3", "should-pass", { [S]: [0.39] }),
			scored("b1", "should-block", { [S]: [0.79] }),
			scored("b2", "should-block", { [S]: [0.4] }),
		];
		const [analysis] = analyzePropositionWindows(items);
		expect(analysis!.separable).toBe(false);
		expect(analysis!.windowLo).toBeNull();
		expect(analysis!.windowHi).toBeNull();
		// overlap = max(block) - min(pass) = 0.79 - 0.39 = 0.40（浮点尾巴已收干净）。
		expect(analysis!.overlap).toBe(0.4);
		// 挡住可分性的条目：should-block 里 >= min(pass)=0.39 的两条（各带分数）。
		expect(analysis!.overlapBlockItems).toEqual([
			{ id: "b2", score: 0.4 },
			{ id: "b1", score: 0.79 },
		]);
		// should-pass 里 <= max(block)=0.79 的三条。
		expect(analysis!.overlapPassItems.map((entry) => entry.id)).toEqual(["p3", "p2", "p1"]);
		// 不可分时不给建议值 —— 阈值解决不了它，不能编一个好看的数。
		expect(analysis!.recommended).toBeNull();
		expect(analysis!.needsOwnThreshold).toBe(false);
		// 最佳档最多能压到 0 误放行（代价是把一切都转人工）：这里必须如实给出。
		expect(analysis!.best!.confusion.falsePass).toBe(0);
		expect(analysis!.best!.confusion.review).toBeGreaterThan(0);
	});

	it("treats an empty window (max(block) === min(pass)) as not separable, overlap 0", () => {
		const items = [scored("p", "should-pass", { [P]: [0.5] }), scored("b", "should-block", { [P]: [0.5] })];
		const [analysis] = analyzePropositionWindows(items);
		// 判据是半开区间：t ∈ (0.5, 0.5] 是空集 —— 相等不算可分。
		expect(analysis!.separable).toBe(false);
		expect(analysis!.overlap).toBe(0);
		expect(analysis!.overlapBlockItems).toEqual([{ id: "b", score: 0.5 }]);
		expect(analysis!.overlapPassItems).toEqual([{ id: "p", score: 0.5 }]);
	});

	it("counts a multi-proposition item once per proposition and never mixes groups", () => {
		const items = [
			// 一条样本带两个命题：两边都要算它一份。
			scored("both", "should-pass", { [P]: [0.9], [S]: [0.42] }),
			// 只带 scope 的条目不得污染 public_api 的统计。
			scored("scope-only", "should-block", { [S]: [0.05] }),
			scored("api-only", "should-block", { [P]: [0.2] }),
		];
		const analyses = analyzePropositionWindows(items);
		// 顺序取注册表顺序（propositions 命令里看到的那套），便于人对照。
		expect(analyses.map((entry) => entry.proposition)).toEqual([P, S]);
		const api = analyses[0]!;
		const scope = analyses[1]!;
		expect(api.passScores).toEqual([0.9]);
		expect(api.blockScores).toEqual([0.2]);
		expect(api.passCount + api.blockCount).toBe(2);
		// scope 只看得到带该命题的两条：both（pass 0.42）与 scope-only（block 0.05）。
		expect(scope.passScores).toEqual([0.42]);
		expect(scope.blockScores).toEqual([0.05]);
		expect(scope.separable).toBe(true);
		expect(scope.windowLo).toBe(0.05);
		expect(scope.windowHi).toBe(0.42);
		expect(scope.recommended!.approveAt).toBe(0.4);
	});

	it("sweeps the widened grid down to ~0.4 where the narrow grid cannot reach", () => {
		// 实测形状：scope 类命题的窗口就在 0.4 附近 —— 窄网格（>= 0.8）只能把两类都判成转人工。
		const items = [scored("p", "should-pass", { [S]: [0.42] }), scored("b", "should-block", { [S]: [0.35] })];
		expect(JEV_TUNE_DEFAULT_GRID.approveAt).not.toContain(0.4);
		expect(JEV_TUNE_PROPOSITION_GRID.approveAt).toContain(0.4);
		expect(JEV_TUNE_PROPOSITION_STEP).toBe(0.05);
		const narrow = suggestThresholds(items, JEV_TUNE_DEFAULT_GRID, 1).suggestions[0]!;
		// 窄网格：没有任何档位能放行 0.42（最小 approveAt 0.8），两条都只能转人工。
		expect(narrow.approveAt).toBeGreaterThanOrEqual(0.8);
		expect(narrow.confusion.review).toBe(2);
		const [analysis] = analyzePropositionWindows(items);
		expect(analysis!.best!.approveAt).toBe(0.4);
		expect(analysis!.best!.blockAt).toBeLessThan(0.4);
		// 加宽网格把「0.42 正确放行」找了出来（窄网格两条都只能转人工）：转人工 2 → 1。
		expect(analysis!.best!.confusion.correctPass).toBe(1);
		expect(analysis!.best!.confusion.falsePass).toBe(0);
		expect(analysis!.best!.confusion.falseBlock).toBe(0);
		expect(analysis!.best!.confusion.review).toBe(1);
	});

	it("uses the mean of repeated samples and keeps one entry per item", () => {
		const items = [
			// 抖动样本：均值 0.7（不是最保守的 0.45，也不是最乐观的 0.95）。
			scored("pass-jitter", "should-pass", { [P]: [0.95, 0.45] }),
			scored("block-jitter", "should-block", { [P]: [0.6, 0.3] }),
		];
		const [analysis] = analyzePropositionWindows(items);
		expect(analysis!.passCount).toBe(1);
		expect(analysis!.blockCount).toBe(1);
		expect(analysis!.passScores).toEqual([0.7]);
		expect(analysis!.blockScores).toEqual([0.45]);
		expect(analysis!.separable).toBe(true);
		expect(analysis!.windowLo).toBe(0.45);
		expect(analysis!.windowHi).toBe(0.7);
		// 无效样本（NaN/Infinity）剔除后再取均值（0.5+0.7)/2 = 0.6，不是把 NaN 当 0。
		const [filtered] = analyzePropositionWindows([
			scored("x", "should-pass", { [P]: [Number.NaN, 0.5, 0.7, Infinity] }),
		]);
		expect(filtered!.passScores).toEqual([0.6]);
	});

	it("names items that carry the proposition without a usable score and refuses to judge", () => {
		const items = [
			scored("empty", "should-block", { [P]: [] }),
			scored("nan", "should-block", { [P]: [Number.NaN] }),
			scored("pass", "should-pass", { [P]: [0.9] }),
		];
		const [analysis] = analyzePropositionWindows(items);
		// 不补 0：没样本的条目进 unusable，绝不变成一次假的拦截。
		expect(analysis!.unusable).toEqual(["empty", "nan"]);
		expect(analysis!.blockCount).toBe(0);
		expect(analysis!.passCount).toBe(1);
		// 只有一侧样本 → 不下「可分」结论（拿半边数据算窗口比没有窗口更危险）。
		expect(analysis!.separable).toBe(false);
		expect(analysis!.overlap).toBeNull();
		expect(analysis!.windowLo).toBeNull();
		expect(analysis!.windowHi).toBeNull();
		expect(analysis!.recommended).toBeNull();
	});

	it("returns nothing for an empty corpus and no best tier without samples", () => {
		expect(analyzePropositionWindows([])).toEqual([]);
		// 语料里没有任何条目引用该命题时，根本不产生这一组。
		expect(analyzePropositionWindows([scored("a", "should-pass", { [S]: [0.9] })])).toHaveLength(1);
	});
});

/** 用真实函数拼一份 JevTuneReport（与 `tune` 命令同一条拼装路径，只是分数是注入的）。 */
function buildReport(items: JevTuneScoredItem[]): JevTuneReport {
	const thresholds = { approveAt: 0.9, blockAt: 0.1 };
	const perItemScores = items.flatMap((item) =>
		Object.entries(item.scores).map(([proposition, scores]) => ({ id: item.id, proposition, scores })),
	);
	const { suggestions, evaluated, skipped } = suggestThresholds(items);
	const top = suggestions[0];
	return {
		corpus: "corpus.jsonl",
		model: "typesafe/jev-1.13",
		repeats: 1,
		fromCache: false,
		items: items.length,
		scored: items.length,
		calls: {
			total: items.length,
			errors: 0,
			cached: 0,
			fresh: items.length,
			cost: 0,
			inputTokens: 0,
			outputTokens: 0,
			replayedCost: 0,
			replayedInputTokens: 0,
			replayedOutputTokens: 0,
		},
		failures: [],
		summaries: summarizeScores(perItemScores, thresholds),
		current: { thresholds, confusion: confusionAt(items, thresholds) },
		perProposition: analyzePropositionWindows(items),
		recommended: top ? { approveAt: top.approveAt, blockAt: top.blockAt } : null,
		suggestions,
		evaluated,
		skipped,
	};
}

describe("tune 报告（逐命题一节 + JSON 字段）", () => {
	const P = "change_preserves_public_api";
	const S = "change_within_task_scope";
	const items = [
		scored("p-api", "should-pass", { [P]: [0.95] }),
		scored("p-api2", "should-pass", { [P]: [0.73] }),
		scored("b-api", "should-block", { [P]: [0.6] }),
		scored("b-api2", "should-block", { [P]: [0.08] }),
		// scope 类命题：不可分（实测形状）。
		scored("p-scope", "should-pass", { [S]: [0.71] }),
		scored("p-scope2", "should-pass", { [S]: [0.5] }),
		scored("p-scope3", "should-pass", { [S]: [0.39] }),
		scored("b-scope", "should-block", { [S]: [0.79] }),
		scored("b-scope2", "should-block", { [S]: [0.4] }),
	];

	it("adds perProposition to the JSON without dropping or reshaping existing fields", () => {
		const report = buildReport(items);
		const json = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
		// 既有顶层字段一个都不能少（既有消费者依赖 summaries / current / suggestions 等）。
		for (const field of [
			"corpus",
			"model",
			"repeats",
			"fromCache",
			"items",
			"scored",
			"calls",
			"failures",
			"summaries",
			"current",
			"recommended",
			"suggestions",
			"evaluated",
			"skipped",
		]) {
			expect(Object.keys(json)).toContain(field);
		}
		// 既有字段的形状/内容不变（抽查每个子结构的判定字段）。
		expect(json.summaries).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "p-api", proposition: P, samples: 1 })]),
		);
		expect((json.current as { thresholds: unknown }).thresholds).toEqual({ approveAt: 0.9, blockAt: 0.1 });
		expect((json.current as { confusion: { total: number } }).confusion.total).toBe(items.length);
		expect((json.suggestions as { rationale: string }[])[0]!.rationale).toContain("误放行");
		// 新增字段：逐命题结构完整可机读。
		const perProposition = json.perProposition as Record<string, unknown>[];
		expect(perProposition.map((entry) => entry.proposition)).toEqual([P, S]);
		expect(perProposition[0]).toMatchObject({
			passCount: 2,
			blockCount: 2,
			separable: true,
			windowLo: 0.6,
			windowHi: 0.73,
			overlap: null,
			needsOwnThreshold: true,
		});
		expect(perProposition[1]).toMatchObject({ separable: false, overlap: 0.4, recommended: null });
	});

	it("renders the per-proposition section without touching the existing sections", () => {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map((arg) => String(arg)).join(" "));
		});
		try {
			printTuneReport(buildReport(items));
		} finally {
			spy.mockRestore();
		}
		const text = lines.join("\n");
		// 既有章节仍在（顺序：真实分数 → 逐命题窗口 → 当前阈值 → 候选阈值 → 建议）。
		const sections = [
			"真实分数（命题视角：分数高 = 命题为真 = 放行）",
			"逐命题可分窗口（",
			"当前阈值（通过 ≥ 0.9",
			"候选阈值（排序",
			"建议: 通过 ≥",
		];
		let cursor = -1;
		for (const section of sections) {
			const at = text.indexOf(section);
			expect(at, `缺少章节：${section}`).toBeGreaterThan(-1);
			expect(at, `章节顺序变了：${section}`).toBeGreaterThan(cursor);
			cursor = at;
		}
		// 可分命题一行：窗口 + 该命题单独扫出的最佳档。
		expect(text).toContain(
			`${P}  pass n=2 [0.73 … 0.95]  block n=2 [0.08 … 0.6]  → 可分 t ∈ (0.6, 0.73]  最佳档 0.7/0.1（误放行 0 误拦 0 转人工 1）`,
		);
		expect(text).toContain("→ 该命题需要独立阈值：建议 approveAt = 0.7 阻断 ≤ 0.1");
		// 不可分命题一行：重叠值 + 点名两边的极端条目；**零误放行零误拦时给「仍可用」而不是「解决不了」**
		// （严格不可分 ≠ 阈值没用：重叠区落转人工就安全了，只有连零错误档都没有才该改判据）。
		expect(text).toContain(
			`${S}  pass n=3 [0.39 … 0.71]  block n=2 [0.4 … 0.79]  → 严格不可分：重叠 0.4（should-block 最高 0.79 b-scope / should-pass 最低 0.39 p-scope3）；最佳档 0.98/0.02（误放行 0 误拦 0 转人工 5）`,
		);
		expect(text).toContain("→ 仍可用：零误放行零误拦档位存在");
		expect(text).not.toContain("→ 阈值解决不了这条命题");
	});

	it("says thresholds cannot fix a proposition when even the best tier still errs", () => {
		// 拦截侧分数 0.99 超出网格上限 0.98：任何可表达的档位都留着一个误放行。
		const items = [scored("p1", "should-pass", { [S]: [0.9] }), scored("b1", "should-block", { [S]: [0.99] })];
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map((arg) => String(arg)).join(" "));
		});
		try {
			printTuneReport(buildReport(items));
		} finally {
			spy.mockRestore();
		}
		const text = lines.join("\n");
		expect(text).toContain("严格不可分：重叠 0.09");
		expect(text).toContain("仍有误放行 1");
		expect(text).toContain("→ 阈值解决不了这条命题：需要改判据（把命题写得更可判）或接受更多转人工");
		expect(text).not.toContain("→ 仍可用：");
	});

	it("renders a no-sample proposition as unjudgeable instead of inventing a window", () => {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map((arg) => String(arg)).join(" "));
		});
		try {
			printTuneReport(buildReport([scored("only-pass", "should-pass", { [S]: [0.9] })]));
		} finally {
			spy.mockRestore();
		}
		const text = lines.join("\n");
		expect(text).toContain("pass n=1 [0.9 … 0.9]  block n=0 []  → 无法判可分：没有 should-block 样本（不编造窗口）");
		// 没有最佳档时不能凭空给一个批准阈值。
		expect(text).not.toContain("该命题需要独立阈值");
	});
});
