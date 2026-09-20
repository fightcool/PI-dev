/*
 * 🍞 AI Breadcrumb — @COUPLED ./jev-gate.ts（`tune` 命令）, ./jev-tune-format.ts 的消费者
 *   ../server/dev-con/jev-tune.ts（纯逻辑：统计/混淆矩阵/建议）, ../server/dev-con/jev-model.ts
 *   （阈值与三态事实源）, ../server/dev-con/jev-gate.ts（分数来源）
 * 📖 ../../../docs/JEV-DECISION-GATE.md §4（阈值与抖动）、§5.1（命题必须正向）、§9（成本）
 *
 * `npm run jev -- tune` 的**渲染层**：只把评测结果翻译成人可读文本。
 * 这里不做任何判定、不读语料、不碰密钥 —— 阈值与三态一律来自 dev-con/jev-model.ts，
 * 统计一律来自 dev-con/jev-tune.ts，避免在 CLI 里长出第二套阈值。
 * `--json` 输出不经本模块：直接把 JevTuneReport 序列化（机器可读，形状稳定）。
 * @CONTRACT 报告里**只有分数与元数据**，没有 state 正文、没有密钥正文：`--json` 可以安全贴进
 *   PR/CI 日志（语料是仓库里的文本，本来也不该进日志）。
 */
import type {
	JevTuneConfusion,
	JevTuneCorpusError,
	JevTuneLabel,
	JevTuneScoreSummary,
	JevTuneSuggestion,
} from "../server/dev-con/jev-tune.js";
import { JEV_TUNE_REPEAT_MAX } from "../server/dev-con/jev-tune.js";
import type { JevThresholds } from "../server/dev-con/jev-model.js";

/** 一条拿不到分数的条目（调用失败 / 缓存无此条）：如实列出，绝不补一个好看的数。 */
export interface JevTuneFailure {
	id: string;
	label: JevTuneLabel;
	proposition: string;
	reason: string;
}

/**
 * 本次评测的调用账（复用 gate 的审计字段，不新增第二份计费事实源）。
 * @GOTCHA 缓存回放命中的条目会带出**当初那次**的 token/cost（磁盘缓存只存分数与审计元数据），
 *   它不是本次花费。两者必须分开算：否则一次全命中的跑分会被读成「刚刚花了这些钱」。
 */
export interface JevTuneCallStats {
	total: number;
	errors: number;
	/** 命中内存/磁盘缓存的次数（命中=本次没花钱，但分数是真的）。 */
	cached: number;
	/** cache === "miss" 的次数：**本次真正付费**的调用。 */
	fresh: number;
	/** 以下是**本次真正付费**那部分的账（fresh = 0 时全为 0）。 */
	cost: number;
	inputTokens: number;
	outputTokens: number;
	/** 缓存回放带出的历史记录值（不是本次花费，也不是本次用量）。 */
	replayedCost: number;
	replayedInputTokens: number;
	replayedOutputTokens: number;
}

/** `tune` 的完整结果（人类可读与 `--json` 共用同一份数据）。 */
export interface JevTuneReport {
	corpus: string;
	model: string;
	/** 每条重复采样几次（1 = 不量抖动）。 */
	repeats: number;
	/** true = --from-cache：只读磁盘缓存里已有的分数，全程不联网。 */
	fromCache: boolean;
	/** 语料校验通过的条目数。 */
	items: number;
	/** 真正拿到分数的条目数（< items 时下面的结论不完整）。 */
	scored: number;
	calls: JevTuneCallStats;
	/** 未拿到分数的条目（调用失败 / 缓存无此条）：如实列出，不参与统计。 */
	failures: JevTuneFailure[];
	summaries: JevTuneScoreSummary[];
	current: { thresholds: JevThresholds; confusion: JevTuneConfusion };
	/** top 建议（无误放行的档位优先）；没有任何合法档位时为 null。 */
	recommended: { approveAt: number; blockAt: number } | null;
	suggestions: JevTuneSuggestion[];
	evaluated: number;
	skipped: { approveAt: number; blockAt: number }[];
}

/** 金额（接口按输入 token 计费，单次 <$0.0001，所以固定 6 位小数）。 */
function formatCost(cost: number): string {
	return `$${(Number.isFinite(cost) ? cost : 0).toFixed(6)}`;
}

/** 分数（最多 4 位小数，去掉尾随 0）：与 jev-gate-format 的判定项展示同款。 */
function formatScore(score: number | null): string {
	if (score === null || !Number.isFinite(score)) return "—";
	return String(Number(score.toFixed(4)));
}

/** 一条条目的结论分布（approve,block → 两行紧凑文本）。 */
function formatOutcomes(summary: JevTuneScoreSummary): string {
	if (summary.outcomes.length === 0) return "无样本";
	return summary.outcomes.join(",");
}

/** 四类结果 + 三态计数（人类可读一行，含最危险的误放行）。 */
function confusionLines(confusion: JevTuneConfusion): string[] {
	const lines = [
		`结论: 通过 ${confusion.approve} / 阻断 ${confusion.block} / 转人工 ${confusion.review}（共 ${confusion.total} 条）`,
		`四类: 正确放行 ${confusion.correctPass}  正确拦下 ${confusion.correctBlock}  ` +
			`误放行 ${confusion.falsePass}  误拦 ${confusion.falseBlock}  转人工 ${confusion.review}（单列）`,
	];
	lines.push(
		`抖动翻转: ${confusion.flips.length} 条${confusion.flips.length > 0 ? `（${confusion.flips.join(", ")}）` : ""}` +
			" —— 重复之间结论不一致 = 同一提交会时好时坏",
	);
	lines.push(
		confusion.falsePassItems.length > 0
			? `⚠ 误放行条目（should-block 却放行，最危险）: ${confusion.falsePassItems
					.map((item) => `${item.id}[${item.propositions.join("+")}]`)
					.join(", ")}`
			: "误放行条目: 无",
	);
	if (confusion.falseBlockItems.length > 0) {
		lines.push(`误拦条目: ${confusion.falseBlockItems.map((item) => item.id).join(", ")}`);
	}
	if (confusion.reviewItems.length > 0) {
		lines.push(`转人工条目: ${confusion.reviewItems.map((item) => `${item.id}(${item.label})`).join(", ")}`);
	}
	if (confusion.unusable.length > 0) {
		lines.push(`不可用条目: ${confusion.unusable.map((item) => `${item.id}（${item.reason}）`).join(", ")}`);
	}
	return lines;
}

/** `tune` 的用法（jev-gate.ts 的 help 分支会跟在通用用法后面打印）。 */
export function printTuneUsage(): void {
	console.log(
		[
			"",
			"  tune --corpus <path.jsonl> [--repeat <n>] [--no-cache] [--json] [--from-cache]",
			"                               用真实分数评测阈值是否合理（JSONL 语料：id/label/state/propositions）",
			`  --repeat <1..${JEV_TUNE_REPEAT_MAX}>               每条重复采样几次（默认 1）：官方实测同输入概率可移动 ~0.08，`,
			"                               >1 时自动禁用缓存（读缓存会拿到同一个分数，量不出抖动）且会多花钱",
			"  --from-cache                 不联网，只读 jev-decisions-cache.jsonl 里已记录的分数（缺条目如实报「缓存无此条」）",
			"",
			"退出码（tune）：0 有建议且无误放行 / 1 建议档位仍存在误放行（需要人看）/ 2 语料或输入问题 / 3 出错（含任一条拿不到分数）",
		].join("\n"),
	);
}

/** 语料坏行（逐行列出）：坏行不是「跳过继续」，而是整次评测不启动 —— 语料错了不该花钱。 */
export function printCorpusErrors(corpus: string, errors: readonly JevTuneCorpusError[], items: number): void {
	console.error(`语料有 ${errors.length} 行不合格（${corpus}；合格 ${items} 条）：`);
	for (const error of errors) console.error(`  第 ${error.line} 行: ${error.message}`);
	console.error("已中止：语料是测量工具，坏语料会让阈值看起来比实际更好。修好再跑。");
}

/**
 * 评测报告（人类可读）。
 * @CONTRACT 顺序刻意是「分数 → 当前阈值 → 候选阈值」：先看真实分数长什么样，
 *   再看现在的阈值把这些分数判成了什么，最后才是该换成哪一档。
 */
export function printTuneReport(report: JevTuneReport): void {
	console.log(`语料: ${report.corpus}  条目: ${report.items}（拿到分数 ${report.scored}）`);
	console.log(
		`模型: ${report.model}  重复: ${report.repeats} 次/条  来源: ${report.fromCache ? "--from-cache（只读磁盘缓存，不联网）" : "调用 Decisions"}`,
	);
	console.log(
		report.fromCache
			? "调用: 0 次（--from-cache 未联网；分数全部来自磁盘缓存）"
			: `调用: ${report.calls.total} 次（本次付费 ${report.calls.fresh}，缓存回放 ${report.calls.cached}，失败 ${report.calls.errors}）  ` +
					`本次费用: ${formatCost(report.calls.cost)}  本次用量: 输入 ${report.calls.inputTokens} / 输出 ${report.calls.outputTokens}`,
	);
	// @GOTCHA 缓存命中会带出当初那一次的 token/cost：分开说，否则“费用”会被读成本次花费。
	if (report.calls.cached > 0 && !report.fromCache) {
		console.log(
			`  其中缓存回放带出的是历史记录值（不是本次花费）：输入 ${report.calls.replayedInputTokens} / ` +
				`输出 ${report.calls.replayedOutputTokens} / ${formatCost(report.calls.replayedCost)}`,
		);
	}
	if (report.failures.length > 0) {
		console.log(`\n⚠ ${report.failures.length} 条未拿到分数（不补 0，未参与统计）：`);
		for (const failure of report.failures) {
			console.log(`  [${failure.id}] ${failure.label} ← ${failure.reason}`);
		}
	}

	console.log("\n真实分数（命题视角：分数高 = 命题为真 = 放行）");
	for (const summary of report.summaries) {
		const jitter = summary.flips ? " ⚠ 跨阈值翻转" : "";
		console.log(
			`  [${summary.id}] ${summary.proposition}  样本 ${summary.samples}  ` +
				`min ${formatScore(summary.min)} max ${formatScore(summary.max)} mean ${formatScore(summary.mean)} ` +
				`σ ${formatScore(summary.stdDev)}  → ${formatOutcomes(summary)}${jitter}`,
		);
	}
	if (report.summaries.length === 0) console.log("  （没有分数：没有任何条目被评测）");

	const thresholds = report.current.thresholds;
	console.log(`\n当前阈值（通过 ≥ ${thresholds.approveAt} / 阻断 ≤ ${thresholds.blockAt} / 其余转人工）`);
	for (const line of confusionLines(report.current.confusion)) console.log(`  ${line}`);

	console.log("\n候选阈值（排序：① 误放行少 ② 误拦少 ③ 转人工少 ④ 空白带更宽；blockAt < approveAt）");
	if (report.suggestions.length === 0) {
		console.log("  （没有任何合法档位：检查网格是否满足 blockAt < approveAt）");
	} else {
		for (const [index, suggestion] of report.suggestions.entries()) {
			const same =
				suggestion.approveAt === thresholds.approveAt && suggestion.blockAt === thresholds.blockAt
					? "   ← 与当前配置一致"
					: "";
			console.log(
				`  ${index + 1}) 通过 ≥ ${suggestion.approveAt} 阻断 ≤ ${suggestion.blockAt}  ${suggestion.rationale}${same}`,
			);
		}
		console.log(`  已评估 ${report.evaluated} 档（网格组合数，跳过 ${report.skipped.length} 档非法组合）`);
	}

	if (report.recommended) {
		console.log(
			`\n建议: 通过 ≥ ${report.recommended.approveAt} 阻断 ≤ ${report.recommended.blockAt}` +
				"（改配置：`npm run jev -- config --approve <值> --block <值>`）",
		);
	}
	if (report.current.confusion.flips.length > 0) {
		console.log("注: 出现翻转说明这些条目的分数离阈值太近 —— 抖动 ~0.08 会把它们从「通过」推到「转人工」。");
	}
	console.log("注: 语料标签由人判，结论只说明「这组阈值在你给的语料上表现如何」，不是模型准确率的证明。");
}
