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
 * ──────────────────────────────────────────────────
 */
import {
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
