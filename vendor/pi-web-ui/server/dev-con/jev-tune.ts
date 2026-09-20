/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ./jev-model.ts（阈值 / 命题 / 三态判定的**唯一**事实源，本模块只消费）,
 *            ./jev-gate.ts（tune 的真实分数来源）, ./jev-cache.ts（--from-cache 的分数来源）,
 *            ../../scripts/jev-gate.ts（`tune` 命令：取数、退出码）,
 *            ../../scripts/jev-tune-format.ts（渲染层）
 *   📖 docs/JEV-DECISION-GATE.md §4（三态阈值：为什么留空白带 / 抖动 ~0.08）、
 *      §5.1（命题必须正向表述：分数高 = 好事 = 放行）、§9（成本：省钱靠缓存，不靠少问）
 *   @CONTRACT 纯逻辑模块：**禁止 fs / 网络 / SDK 导入**（只允许 `./jev-model.js`），
 *             也**不接触 state 正文** —— CLI 只把 0..1 的分数带进来，磁盘与密钥全在 CLI/gate 侧。
 *             判定三态一律走 decideOutcome，阈值一律走 JevThresholds，本模块不另写一份。
 *   @WHY 阈值合不合理只能拿**真实分数**回放：分数高 = 命题为真 = 放行，所以
 *        「label = should-block 的改动拿到了 approve」（误放行）是唯一不可接受的结果，
 *        它在建议排序里排第一优先级；误拦与转人工只是效率问题。
 *   @GOTCHA 官方实测同一输入的概率抖动可达 ~0.08：只采一次样就下结论必然 flaky。
 *           所以每条支持多次重复（scores 是数组），重复之间结论不一致 = flips，如实列出。
 *   @CONTRACT 缺分数绝不补 0：没有可用分数的条目进 unusable（原因如实写），不参与统计；
 *           也绝不把「没测过」渲染成一个好看的数字。
 *   @MAGIC 默认网格见 JEV_TUNE_DEFAULT_GRID（approveAt ∈ {0.8,0.85,0.9,0.95} ×
 *          blockAt ∈ {0.02,0.05,0.1,0.15}，且必须 blockAt < approveAt）；重复采样上限见
 *          JEV_TUNE_REPEAT_MAX（钱与时间都随它线性增长）。
 *          **逐命题**分析另有加宽网格 JEV_TUNE_PROPOSITION_GRID（approveAt 0.30…0.95 + 0.98，
 *          步长 0.05）：实测三个命题的可分窗口互不相同（scope 在 0.4 附近、public_api 在
 *          0.6–0.73、test_asserts_behavior 在 0.77+），窄网格连看都看不到它们。
 *   @WHY 单一全局阈值在**结构上**不可能同时合适：每个命题的分数分布不同（见上面实测）。
 *        所以逐命题分析按命题分组，且**只统计带该命题的条目** —— 一条样本带多个命题时每个
 *        命题各算它一份（propositions 是数组），其它命题的条目不得污染本命题的统计。
 *        重复采样取**均值**参与分组（逐命题只关心「这个命题的分数落在哪」，抖动由 summaries 交代）。
 *   @GOTCHA 可分窗口是 (windowLo, windowHi] 这种**半开**区间：max(block) 与 min(pass) 相等时
 *        窗口为空（不可分、重叠 0），差一点就会把该拦的放行。任一侧没有样本时不下「可分」结论。
 *   @CONTRACT 逐命题分析**不改**全局建议：`suggestThresholds` 仍用窄网格与既有排序，
 *        `JevTuneReport.suggestions` 的形状与含义不变（既有消费者/测试依赖它们）。
 * ──────────────────────────────────────────────────
 */
import {
	JEV_PROPOSITIONS,
	type JevOutcome,
	type JevThresholds,
	decideOutcome,
	defaultJevGateConfig,
	propositionById,
} from "./jev-model.js";

/** 语料标签：这条改动「本该」被放行还是被拦下（由人来判，不是模型判）。 */
export type JevTuneLabel = "should-pass" | "should-block";

/** 标签取值清单（校验与渲染共用，避免各处再写一份字面量）。 */
export const JEV_TUNE_LABELS: readonly JevTuneLabel[] = ["should-pass", "should-block"];

/** @MAGIC 同一条重复采样的上限：每多一次就多一次付费调用（见 docs §9）。 */
export const JEV_TUNE_REPEAT_MAX = 5;
/** 默认只采一次（想量抖动就显式 `--repeat 2..5`：官方实测同输入概率可移动 ~0.08）。 */
export const JEV_TUNE_REPEAT_DEFAULT = 1;

/** 一条语料：被审内容 + 该条应有的结论 + 要问的命题（JSONL 一行一条）。 */
export interface JevTuneItem {
	id: string;
	label: JevTuneLabel;
	/** 被审内容：形状不限（与 `check --state-file` 同一条约定），由调用方提供。 */
	state: unknown;
	/** 要问的命题 id（必须来自 JEV_PROPOSITIONS，解析时校验）。 */
	propositions: string[];
}

/** 语料坏行：逐行收集，绝不抛（一行写错不该让整次评测没有输出）。 */
export interface JevTuneCorpusError {
	/** 1 起的行号（与编辑器一致）。 */
	line: number;
	message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScore(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * 解析 JSONL 语料（每行一个 `JevTuneItem`）。
 * @CONTRACT 坏行（非法 JSON / 非对象 / 缺字段 / 未知命题 / id 重复）收集进 errors 并跳过，
 *   不抛异常、不猜字段；空行忽略（不算坏行）。id 只在**该行通过校验**后才计入去重集合，
 *   否则「第一行写错 + 第二行重复」会报成看不懂的重复错误。
 */
export function parseJevCorpus(text: string): { items: JevTuneItem[]; errors: JevTuneCorpusError[] } {
	const items: JevTuneItem[] = [];
	const errors: JevTuneCorpusError[] = [];
	const seenIds = new Set<string>();
	const lines = typeof text === "string" ? text.split("\n") : [];
	for (const [index, raw] of lines.entries()) {
		const line = index + 1;
		const trimmed = typeof raw === "string" ? raw.trim() : "";
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (err) {
			errors.push({ line, message: `不是合法 JSON：${(err as Error).message}` });
			continue;
		}
		if (!isObject(parsed)) {
			errors.push({ line, message: "每行必须是一个 JSON 对象" });
			continue;
		}
		const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
		if (!id) {
			errors.push({ line, message: "缺少非空字符串 id" });
			continue;
		}
		if (seenIds.has(id)) {
			errors.push({ line, message: `id 重复：${id}` });
			continue;
		}
		const label = parsed.label;
		if (label !== "should-pass" && label !== "should-block") {
			errors.push({ line, message: `label 必须是 should-pass 或 should-block（当前：${JSON.stringify(label)}）` });
			continue;
		}
		if (!("state" in parsed) || parsed.state === undefined) {
			errors.push({ line, message: "缺少 state（被审内容；不能拿空内容去问模型）" });
			continue;
		}
		const rawPropositions = parsed.propositions;
		if (!Array.isArray(rawPropositions) || rawPropositions.length === 0) {
			errors.push({ line, message: "propositions 必须是非空字符串数组" });
			continue;
		}
		const propositions: string[] = [];
		let invalid = false;
		for (const entry of rawPropositions) {
			const name = typeof entry === "string" ? entry.trim() : "";
			// 命题必须来自注册表：这里另写一份 id 就是在制造第二份事实源。
			if (!name || !propositionById(name)) {
				errors.push({ line, message: `未知命题：${JSON.stringify(entry)}（用 propositions 查看可用清单）` });
				invalid = true;
				break;
			}
			if (propositions.includes(name)) {
				errors.push({ line, message: `命题重复：${name}` });
				invalid = true;
				break;
			}
			propositions.push(name);
		}
		if (invalid) continue;
		seenIds.add(id);
		items.push({ id, label, state: parsed.state, propositions });
	}
	return { items, errors };
}

/** 三态的展示顺序（去重后按它排序，保证输出稳定、可 diff）。 */
const OUTCOME_ORDER: readonly JevOutcome[] = ["approve", "block", "review"];

/** 一条（条目 × 命题）的重复采样分数；由调用方从真实决策里收集。 */
export interface JevTunePerItemScores {
	id: string;
	proposition: string;
	scores: number[];
}

/** 一条（条目 × 命题）的抖动统计。 */
export interface JevTuneScoreSummary {
	id: string;
	proposition: string;
	/** 有效样本数（非有限值已剔除）。 */
	samples: number;
	/** 以下四项在无样本时为 null —— 不拿 0 冒充分数。 */
	min: number | null;
	max: number | null;
	mean: number | null;
	/** 样本标准差（n-1 分母）；n < 2 时为 0（一次采样本来就看不出抖动）。 */
	stdDev: number | null;
	/** 重复之间出现过的三态（按 approve → block → review 排序去重）。 */
	outcomes: JevOutcome[];
	/** 重复之间结论不一致 = 分数跨过了阈值：同一提交会时而通过、时而转人工。 */
	flips: boolean;
	/** 原始样本（保留顺序，便于人看是否单向漂移）。 */
	scores: number[];
}

/**
 * 每条（条目 × 命题）的 min / max / mean / 样本标准差 + 跨重复是否翻转。
 * @CONTRACT 「翻转」以**三态**为准（走 decideOutcome，不自己比大小）：重复之间出现两种
 *   以上结论即 flips=true。这正是 §4 说「禁止单阈值」的量化依据。
 */
export function summarizeScores(
	perItem: readonly JevTunePerItemScores[],
	thresholds: JevThresholds = defaultJevGateConfig().thresholds,
): JevTuneScoreSummary[] {
	return perItem.map((entry) => {
		const scores = (Array.isArray(entry.scores) ? entry.scores : []).filter(isScore);
		if (scores.length === 0) {
			return {
				id: entry.id,
				proposition: entry.proposition,
				samples: 0,
				min: null,
				max: null,
				mean: null,
				stdDev: null,
				outcomes: [],
				flips: false,
				scores: [],
			};
		}
		const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
		const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / Math.max(1, scores.length - 1);
		const seen = new Set(scores.map((score) => decideOutcome({ [entry.proposition]: score }, thresholds).outcome));
		return {
			id: entry.id,
			proposition: entry.proposition,
			samples: scores.length,
			min: Math.min(...scores),
			max: Math.max(...scores),
			mean,
			stdDev: Math.sqrt(variance),
			outcomes: OUTCOME_ORDER.filter((outcome) => seen.has(outcome)),
			flips: seen.size > 1,
			scores: [...scores],
		};
	});
}

/** 一条语料在评测里的分数视图：命题 → 每次重复的分数（至少一次才有意义）。 */
export interface JevTuneScoredItem {
	id: string;
	label: JevTuneLabel;
	scores: Record<string, number[]>;
}

/** 一条条目的结论归类（转人工与两类误判都点名，便于人直接去看那条语料）。 */
export interface JevTuneVerdictRef {
	id: string;
	label: JevTuneLabel;
	propositions: string[];
}

/** 某组候选阈值下的混淆矩阵（三态计数 + 四类结果 + 抖动）。 */
export interface JevTuneConfusion {
	/** 参与统计的条目数（= approve + block + review）。 */
	total: number;
	approve: number;
	block: number;
	review: number;
	/** label=should-pass 且 approve：正确放行。 */
	correctPass: number;
	/** label=should-block 且 block：正确拦下。 */
	correctBlock: number;
	/** **误放行**：label=should-block 却 approve —— 唯一不可接受的结果。 */
	falsePass: number;
	/** 误拦：label=should-pass 却 block。 */
	falseBlock: number;
	/** 该组阈值下的 label 分布（用于算比率时不必再猜分母）。 */
	labeledPass: number;
	labeledBlock: number;
	/** 重复之间结论不一致的条目（抖动直接导致同一提交时好时坏）。 */
	flips: string[];
	falsePassItems: JevTuneVerdictRef[];
	falseBlockItems: JevTuneVerdictRef[];
	/** 转人工的条目（单列：它是安全的一侧，但没人处理就等于没有门禁）。 */
	reviewItems: JevTuneVerdictRef[];
	/** 没有可用分数的条目（不补 0、不参与统计），原因如实写。 */
	unusable: { id: string; reason: string }[];
}

/** 三态的保守程度：一条有多次重复时，取最保守的那次作为代表（block > review > approve）。 */
const OUTCOME_SEVERITY: Record<JevOutcome, number> = { approve: 0, review: 1, block: 2 };

/**
 * 一条条目在每个重复序号上的结论（把该次涉及的所有命题一起交给 decideOutcome）。
 * @CONTRACT 只统计**每个命题都有分数**的那些重复（重复次数取各命题的最短长度）；
 *   一个命题都没有可用分数时返回空数组 = 该条目不可用（绝不拿缺的那部分当 0）。
 */
function itemOutcomes(item: JevTuneScoredItem, thresholds: JevThresholds): JevOutcome[] {
	const propositions = Object.keys(item.scores ?? {});
	if (propositions.length === 0) return [];
	const usable: Record<string, number[]> = {};
	let repeats = Number.POSITIVE_INFINITY;
	for (const name of propositions) {
		const scores = (item.scores[name] ?? []).filter(isScore);
		usable[name] = scores;
		repeats = Math.min(repeats, scores.length);
	}
	if (!Number.isFinite(repeats) || repeats <= 0) return [];
	const outcomes: JevOutcome[] = [];
	for (let index = 0; index < repeats; index++) {
		const checks: Record<string, number> = {};
		for (const name of propositions) checks[name] = usable[name]![index]!;
		outcomes.push(decideOutcome(checks, thresholds).outcome);
	}
	return outcomes;
}

/**
 * 某组候选阈值下的混淆矩阵（纯函数）。
 * @CONTRACT 一条条目有多次重复时，代表结论取**最保守**的那次：只有「每一次都放行」才算
 *   误放行（这正是生产里最危险的情形）；若重复之间结论不同，该条目同时记进 flips ——
 *   它说明这组阈值在这条语料上不稳定，比任何单一计数都更值得看。
 */
export function confusionAt(items: readonly JevTuneScoredItem[], thresholds: JevThresholds): JevTuneConfusion {
	const confusion: JevTuneConfusion = {
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
		flips: [],
		falsePassItems: [],
		falseBlockItems: [],
		reviewItems: [],
		unusable: [],
	};
	for (const item of items ?? []) {
		const propositions = Object.keys(item.scores ?? {});
		const outcomes = itemOutcomes(item, thresholds);
		if (outcomes.length === 0) {
			confusion.unusable.push({ id: item.id, reason: "没有可用分数（不补 0、不参与统计）" });
			continue;
		}
		confusion.total += 1;
		if (item.label === "should-pass") confusion.labeledPass += 1;
		else confusion.labeledBlock += 1;
		if (new Set(outcomes).size > 1) confusion.flips.push(item.id);
		const worst = outcomes.reduce((acc, next) => (OUTCOME_SEVERITY[next] > OUTCOME_SEVERITY[acc] ? next : acc));
		const ref: JevTuneVerdictRef = { id: item.id, label: item.label, propositions };
		confusion[worst] += 1;
		if (item.label === "should-pass" && worst === "approve") confusion.correctPass += 1;
		if (item.label === "should-block" && worst === "block") confusion.correctBlock += 1;
		if (item.label === "should-block" && worst === "approve") {
			confusion.falsePass += 1;
			confusion.falsePassItems.push(ref);
		}
		if (item.label === "should-pass" && worst === "block") {
			confusion.falseBlock += 1;
			confusion.falseBlockItems.push(ref);
		}
		if (worst === "review") confusion.reviewItems.push(ref);
	}
	return confusion;
}

/** 候选阈值网格（approveAt × blockAt；blockAt >= approveAt 的组合一律跳过）。 */
export interface JevTuneGrid {
	approveAt: number[];
	blockAt: number[];
}

/** 默认网格（见文件头 @MAGIC）；想更细就在调用处传自己的网格。 */
export const JEV_TUNE_DEFAULT_GRID: JevTuneGrid = {
	approveAt: [0.8, 0.85, 0.9, 0.95],
	blockAt: [0.02, 0.05, 0.1, 0.15],
};

/** 逐命题分析的建议步长（窗口上界下取整到它，得到可写进配置的 approveAt）。 */
export const JEV_TUNE_PROPOSITION_STEP = 0.05;

/**
 * **逐命题**用的加宽网格（见文件头 @MAGIC）。
 * @WHY 实测 `change_within_task_scope` 的分数整体在 0.4 附近，窄网格（>= 0.8）在结构上就
 *   扫不到它的窗口 —— 拿窄网格逐命题分析只会得到「所有档位都一样差」的假结论。
 *   blockAt 沿用默认网格：低分段（<= 0.15）本来就是「明确是坏事」，不需要加宽。
 */
export const JEV_TUNE_PROPOSITION_GRID: JevTuneGrid = {
	approveAt: [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98],
	blockAt: [0.02, 0.05, 0.1, 0.15],
};

/** 一档候选阈值的评测结果 + 人可读的排序依据。 */
export interface JevTuneSuggestion {
	approveAt: number;
	blockAt: number;
	confusion: JevTuneConfusion;
	/** 排序依据（一行中文，写清这一档为什么排在前面）。 */
	rationale: string;
}

/** 建议档数上限（再往后排的档位差异已经看不出来，只会刷屏）。 */
const DEFAULT_TOP = 5;

/** 排序依据文案：四个指标 + 空白带宽度，顺序与排序优先级一致。 */
function rationaleOf(approveAt: number, blockAt: number, confusion: JevTuneConfusion): string {
	return (
		`误放行 ${confusion.falsePass} / 误拦 ${confusion.falseBlock} / 转人工 ${confusion.review}` +
		` / 空白带 ${(approveAt - blockAt).toFixed(2)}`
	);
}

/**
 * 在网格上贪心挑阈值：按 ① 误放行最少 ② 误拦最少 ③ 转人工最少 ④ 空白带更宽 排序。
 * @CONTRACT 只产出**合法**档位（blockAt < approveAt，与 validateJevGateConfig 同一条约束）；
 *   被跳过的组合列在 skipped 里，不静默丢。空语料下所有档位指标全为 0 —— 这时排序纯靠
 *   ④ 空白带宽度，得到的只是「最保守的一档」，不代表任何证据（调用方必须把 total=0 讲清楚）。
 */
export function suggestThresholds(
	items: readonly JevTuneScoredItem[],
	// @CONTRACT 默认仍是**窄**网格：加宽网格只用于逐命题分析（见 JEV_TUNE_PROPOSITION_GRID），
	//   否则既有输出（`tune` 的候选阈值一节）与依赖它的消费者会整体变形。
	grid: JevTuneGrid = JEV_TUNE_DEFAULT_GRID,
	top = DEFAULT_TOP,
): {
	suggestions: JevTuneSuggestion[];
	/** 实际评估过的合法档位数。 */
	evaluated: number;
	/** 因 blockAt >= approveAt 被跳过的组合（如实列出）。 */
	skipped: { approveAt: number; blockAt: number }[];
} {
	const evaluated: JevTuneSuggestion[] = [];
	const skipped: { approveAt: number; blockAt: number }[] = [];
	for (const approveAt of grid?.approveAt ?? []) {
		for (const blockAt of grid?.blockAt ?? []) {
			if (!isScore(approveAt) || !isScore(blockAt) || !(blockAt < approveAt)) {
				skipped.push({ approveAt, blockAt });
				continue;
			}
			const confusion = confusionAt(items, { approveAt, blockAt });
			evaluated.push({ approveAt, blockAt, confusion, rationale: rationaleOf(approveAt, blockAt, confusion) });
		}
	}
	evaluated.sort(
		(a, b) =>
			a.confusion.falsePass - b.confusion.falsePass ||
			a.confusion.falseBlock - b.confusion.falseBlock ||
			a.confusion.review - b.confusion.review ||
			// ④ 空白带更宽 = 更保守：抖动 ~0.08 的模型需要留得下这条带
			b.approveAt - b.blockAt - (a.approveAt - a.blockAt) ||
			// 兜底：让排序在指标全等时也完全确定（否则不同 Node 版本可能给出不同顺序）
			b.approveAt - a.approveAt ||
			a.blockAt - b.blockAt,
	);
	const limit = Number.isInteger(top) && top > 0 ? top : DEFAULT_TOP;
	return { suggestions: evaluated.slice(0, limit), evaluated: evaluated.length, skipped };
}

/** 逐命题分析里点名的**一条样本**（id + 参与统计的均分），用于「谁挡住了可分性」。 */
export interface JevTuneWindowRef {
	id: string;
	score: number;
}

/**
 * 单个命题的「可分窗口」分析（阈值只对该命题生效）。
 * @CONTRACT 统计范围只有**带这个命题**的条目（见文件头 @WHY）；一条样本带多个命题时，
 *   每个命题各得到它自己的一份均值，互不污染。
 */
export interface JevTunePropositionAnalysis {
	proposition: string;
	/** 带该命题且有可用分数的条目数（should-pass / should-block 分开数）。 */
	passCount: number;
	blockCount: number;
	/** 每条样本取重复的均值后**升序**排列（重复为 1 时就是原分数）。 */
	passScores: number[];
	blockScores: number[];
	/** true = max(block) < min(pass)：存在一个能把两类分开的阈值。 */
	separable: boolean;
	/** 可分时：windowLo = should-block 最高分（**不含**）→ 建议判据 `t ∈ (windowLo, windowHi]`。 */
	windowLo: number | null;
	/** 可分时：windowHi = should-pass 最低分（**含**）。 */
	windowHi: number | null;
	/** 不可分时：max(block) - min(pass)（重叠，>= 0；任一侧没有样本时为 null —— 不编造窗口）。 */
	overlap: number | null;
	/** 挡住可分性的 should-block 条目（分数 >= min(pass)）：它们本就该被拦，分数却和 should-pass 撞上。 */
	overlapBlockItems: JevTuneWindowRef[];
	/** 挡住可分性的 should-pass 条目（分数 <= max(block)）。 */
	overlapPassItems: JevTuneWindowRef[];
	/** 带该命题但没有可用分数的条目 id（不补 0，已排除在统计外）。 */
	unusable: string[];
	/** 用**加宽**网格单独扫出的最佳档（排序同 suggestThresholds）；无样本时为 null。 */
	best: JevTuneSuggestion | null;
	/** 建议的独立阈值：可分时 approveAt = windowHi 下取整到 0.05；否则 null = 阈值解决不了。 */
	recommended: { approveAt: number; blockAt: number } | null;
	/** true = 可分窗口不在**全局**网格覆盖内 → 单一全局阈值在结构上就表达不了它。 */
	needsOwnThreshold: boolean;
}

/** 一条样本×命题的中间态（均值已算好，后续只排序与分组）。 */
interface PropositionSample {
	id: string;
	score: number;
}

/** 把窗口上界下取整到步长（0.71 → 0.70），用整数运算避免 0.7000000000000001 这种脏值。 */
function floorToStep(value: number, step = JEV_TUNE_PROPOSITION_STEP): number {
	if (!Number.isFinite(value) || !(step > 0)) return Number.NaN;
	return Number((Math.floor(value / step + 1e-9) * step).toFixed(4));
}

/**
 * 一条（条目 × 命题）的重复分数取**均值**；没有有效样本时返回 null（绝不补 0）。
 * @WHY 逐命题只问「这个命题的分数落在哪」：重复采样的抖动由 summarizeScores 交代，
 *   这里若取最保守的一次，会把抖动误读成「这个命题本身不可分」。
 * @GOTCHA 均值保留 4 位小数（与分数展示同精度）：否则 [0.6,0.3] 会得到 0.44999999999999996，
 *   让 windowLo / overlap 这些**会被拿去做判断**的值带上看不见的尾巴。
 */
function meanScoreOf(scores: readonly number[] | undefined): number | null {
	const usable = (scores ?? []).filter(isScore);
	if (usable.length === 0) return null;
	return roundScore(usable.reduce((sum, score) => sum + score, 0) / usable.length);
}

/** 命题的展示顺序：先按注册表顺序（人熟悉的那套），不在注册表里的按名字排在后面。 */
function orderPropositions(names: readonly string[]): string[] {
	const rank = (name: string): number => {
		const index = JEV_PROPOSITIONS.findIndex((entry) => entry.id === name);
		return index < 0 ? Number.POSITIVE_INFINITY : index;
	};
	return [...names].sort((a, b) => {
		const rankA = rank(a);
		const rankB = rank(b);
		// 两边都不在注册表里时 rank 都是 Infinity（相减会得到 NaN），直接按名字兜底。
		if (rankA !== rankB) return rankA < rankB ? -1 : 1;
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

/** 重叠值保留 4 位小数（0.79-0.39 的浮点尾巴不该出现在报告里）。 */
function roundScore(value: number): number {
	return Number(value.toFixed(4));
}

/**
 * 逐命题可分窗口分析（本轮核心交付）。
 * @CONTRACT 输入是一条条 `JevTuneScoredItem`（`scores` 的键就是该条的 propositions、值是重复分数）；
 *   **只统计带这个命题的条目**，其它命题的条目一律排除（见文件头 @WHY）。
 * @CONTRACT 可分判据是**严格半开**：`max(block) < min(pass)` 才算可分，窗口 (windowLo, windowHi]；
 *   相等（max(block) === min(pass)）时窗口为空 → 不可分，重叠 0。
 *   任一侧没有样本 → 不下结论（separable=false、overlap=null），不拿「没测过」当好消息。
 * @CONTRACT 最佳档排序与全局完全一致（① 误放行少 ② 误拦少 ③ 转人工少 ④ 空白带更宽），
 *   只是换了加宽网格、且每条样本只用该命题的均值参与判定（`decideOutcome({ [命题]: 均值 })`）。
 *   最佳档仍有误放行时由调用方按 `best.confusion.falsePass` 标出（不在这里改判）。
 */
export function analyzePropositionWindows(
	items: readonly JevTuneScoredItem[],
	grid: JevTuneGrid = JEV_TUNE_PROPOSITION_GRID,
): JevTunePropositionAnalysis[] {
	const buckets = new Map<string, { pass: PropositionSample[]; block: PropositionSample[]; unusable: string[] }>();
	for (const item of items ?? []) {
		for (const proposition of Object.keys(item.scores ?? {})) {
			const bucket = buckets.get(proposition) ?? { pass: [], block: [], unusable: [] };
			buckets.set(proposition, bucket);
			const mean = meanScoreOf(item.scores[proposition]);
			if (mean === null) {
				// 带了这个命题却一个有效样本都没有：如实列出，不进 pass/block（不补 0）。
				bucket.unusable.push(item.id);
				continue;
			}
			(item.label === "should-pass" ? bucket.pass : bucket.block).push({ id: item.id, score: mean });
		}
	}

	return orderPropositions([...buckets.keys()]).map((proposition) => {
		const bucket = buckets.get(proposition)!;
		const byScore = (a: PropositionSample, b: PropositionSample): number => a.score - b.score || (a.id < b.id ? -1 : 1);
		const pass = [...bucket.pass].sort(byScore);
		const block = [...bucket.block].sort(byScore);
		const passScores = pass.map((sample) => sample.score);
		const blockScores = block.map((sample) => sample.score);
		const passMin = pass.length > 0 ? pass[0]!.score : null;
		const blockMax = block.length > 0 ? block[block.length - 1]!.score : null;

		let separable = false;
		let windowLo: number | null = null;
		let windowHi: number | null = null;
		let overlap: number | null = null;
		let overlapBlockItems: JevTuneWindowRef[] = [];
		let overlapPassItems: JevTuneWindowRef[] = [];
		if (passMin !== null && blockMax !== null) {
			if (blockMax < passMin) {
				separable = true;
				windowLo = blockMax;
				windowHi = passMin;
			} else {
				overlap = roundScore(blockMax - passMin);
				// 挡住可分性的两边：本该拦下却高到撞上 should-pass 的，与本该放行却低到撞上 should-block 的。
				overlapBlockItems = block.filter((sample) => sample.score >= passMin).map((sample) => ({ ...sample }));
				overlapPassItems = pass.filter((sample) => sample.score <= blockMax).map((sample) => ({ ...sample }));
			}
		}

		// 最佳档：每条样本只用**该命题的均值**（单样本判定 = decideOutcome 对该分数直接判三态）。
		const meanItems: JevTuneScoredItem[] = [
			...pass.map((sample) => ({
				id: sample.id,
				label: "should-pass" as JevTuneLabel,
				scores: { [proposition]: [sample.score] },
			})),
			...block.map((sample) => ({
				id: sample.id,
				label: "should-block" as JevTuneLabel,
				scores: { [proposition]: [sample.score] },
			})),
		];
		// 一条样本都没有时不出最佳档：空语料下所有档位指标全为 0，那只是「最保守的一档」，不是证据。
		const best = meanItems.length > 0 ? (suggestThresholds(meanItems, grid, 1).suggestions[0] ?? null) : null;

		const approveAt = windowHi !== null ? floorToStep(windowHi) : Number.NaN;
		// @GOTCHA 下取整后的值必须**仍落在窗口里**：窗口 (0.60, 0.61] 只有 0.01 宽，
		//   floorToStep(0.61) = 0.60 恰好是窗口下界（不含）—— 拿它当建议会把 0.60 的 should-block 放行。
		//   落不进去就不给建议（null），由渲染层如实说「窗口太窄」。
		const windowFits =
			separable && windowLo !== null && windowHi !== null && windowLo < approveAt && approveAt <= windowHi;
		// 建议的 blockAt 取经验最佳档，但必须严格小于建议的 approveAt（与 validateJevGateConfig 同一条约束）。
		const recommended = windowFits
			? {
					approveAt,
					blockAt: Math.max(
						0,
						Math.min(best ? best.blockAt : JEV_TUNE_DEFAULT_GRID.blockAt[0]!, roundScore(approveAt - 0.05)),
					),
				}
			: null;
		// 窗口是否被全局网格覆盖：有全局 approveAt 落在 (windowLo, windowHi] 里 = 全局阈值能表达它。
		const needsOwnThreshold =
			separable && windowLo !== null && windowHi !== null
				? !JEV_TUNE_DEFAULT_GRID.approveAt.some((candidate) => windowLo! < candidate && candidate <= windowHi!)
				: false;

		return {
			proposition,
			passCount: pass.length,
			blockCount: block.length,
			passScores,
			blockScores,
			separable,
			windowLo,
			windowHi,
			overlap,
			overlapBlockItems,
			overlapPassItems,
			unusable: [...bucket.unusable],
			best,
			recommended,
			needsOwnThreshold,
		};
	});
}

/** 逐判定项的建议值（两个字段都给：可直接写进 `thresholds.perProposition`）。 */
export interface JevTunePropositionOverride {
	approveAt: number;
	blockAt: number;
}

/**
 * 「逐命题建议」的落地形态：一个全局基档 + 各判定项的独立阈值。
 * @WHY 单一全局阈值在结构上不可能合适（三个命题的窗口互不相同，见文件头 @WHY），
 *   所以最终交给人的**不是**一个数，而是「基档 + 覆盖」这一对东西。
 */
export interface JevTunePropositionRecommendation {
	/** 全局基档（调用方给；本仓 CLI 传窄网格的 top 档）。 */
	base: { approveAt: number; blockAt: number };
	/** 逐判定项覆盖：只给**需要且能表达**的判定项（判定项名 → 一对阈值）。 */
	overrides: Record<string, JevTunePropositionOverride>;
	/** 逐命题建议解决不了的判定项（阈值这条路走不通，如实写原因）。 */
	unresolved: { proposition: string; reason: string }[];
	/** base + overrides 实际生效的阈值：可直接写进配置，也可直接喂 confusionAt。 */
	thresholds: JevThresholds;
	/** 这组阈值（按**逐项解析**生效后）在语料上的四类统计。 */
	confusion: JevTuneConfusion;
}

/**
 * 逐命题建议 + 它在语料上的四类统计（用完逐项阈值）。
 * @CONTRACT 两层判据：
 *   ① 可分且基档的 approveAt 已落在窗口 (windowLo, windowHi] 内 → **不加覆盖**（基档自己够用，
 *      少配一项就少一份不一致的可能）；
 *   ② 可分但基档落不进去 → 用该命题的 `recommended`（= windowHi 下取整）作覆盖；
 *   ③ 不可分 / 样本不足 / 窗口窄于步长 → 进 unresolved（**不编造**一对值），保持全局基档。
 * @GOTCHA 「需要覆盖」的判据是「基档的 approveAt 是否落在该命题窗口内」，**不是** needsOwnThreshold：
 *   后者问的是「全局网格有没有档位」，前者问的是「**我们真要用的这一档**够不够用」。
 * @CONTRACT 覆盖值必须仍满足 blockAt < approveAt（与 validateJevGateConfig 同一条约束）：
 *   analyzePropositionWindows 已保证，这里只做透传与回归断言。
 */
export function recommendPropositionThresholds(
	items: readonly JevTuneScoredItem[],
	base: { approveAt: number; blockAt: number },
	analyses: readonly JevTunePropositionAnalysis[] = analyzePropositionWindows(items),
): JevTunePropositionRecommendation {
	const overrides: Record<string, JevTunePropositionOverride> = {};
	const unresolved: { proposition: string; reason: string }[] = [];
	for (const entry of analyses) {
		if (entry.passCount === 0 || entry.blockCount === 0) {
			unresolved.push({
				proposition: entry.proposition,
				reason: `样本不足（should-pass ${entry.passCount} / should-block ${entry.blockCount}）：不下可分结论`,
			});
			continue;
		}
		if (!entry.separable || entry.windowLo === null || entry.windowHi === null) {
			unresolved.push({
				proposition: entry.proposition,
				reason: `分数分布重叠（重叠 ${entry.overlap}）：任何阈值都只能二选一`,
			});
			continue;
		}
		// ① 基档已经落在窗口里：这一项不需要覆盖（override 越少，配置越不容易自相矛盾）。
		if (entry.windowLo < base.approveAt && base.approveAt <= entry.windowHi) continue;
		// ③ 可分但步长表达不了（窗口窄于 0.05）：不硬凑一个会误放行的值。
		if (!entry.recommended) {
			unresolved.push({
				proposition: entry.proposition,
				reason: `窗口 (${entry.windowLo}, ${entry.windowHi}] 窄于 ${JEV_TUNE_PROPOSITION_STEP} 步长：没有能落进窗口的 approveAt`,
			});
			continue;
		}
		overrides[entry.proposition] = { ...entry.recommended };
	}
	const thresholds: JevThresholds =
		Object.keys(overrides).length > 0
			? { approveAt: base.approveAt, blockAt: base.blockAt, perProposition: overrides }
			: { approveAt: base.approveAt, blockAt: base.blockAt };
	return {
		base: { approveAt: base.approveAt, blockAt: base.blockAt },
		overrides,
		unresolved,
		thresholds,
		// 三态与逐项阈值解析全走 decideOutcome（唯一事实源）：这里不写第二份判定。
		confusion: confusionAt(items, thresholds),
	};
}
