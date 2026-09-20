/*
 * 🍞 AI Breadcrumb — @COUPLED ./jev-gate.ts（`samples` / `review` 命令）,
 *   ../server/dev-con/jev-samples.ts（样本读写/统计/ack 的事实源）,
 *   ../server/dev-con/jev-review.ts（到期判定与导出统计的事实源）
 * 📖 ../../../docs/JEV-DECISION-GATE.md §「CLI」、§4（阈值与抖动：为什么需要真实样本）
 *
 * `npm run jev -- samples|review` 的**渲染层**：只把样本统计、复盘状态与导出结果
 * 翻译成人可读文本。这里不做任何判定、不读盘、不碰密钥。
 * `--json` 输出不经本模块：直接把内核对象序列化（机器可读，形状稳定）。
 * @CONTRACT 报告里**只有计数/时间/来源**，绝不回显被审内容：`--json` 与文本都可以安全贴进
 *   PR/CI 日志（要内容就显式 `review export --out <file>`，那是另一条明确的路径）。
 * @GOTCHA `review export` 的正文走 **stdout**（必须是纯 JSONL：能直接重定向成语料文件），
 *   于是本模块所有「给人看」的话都必须走 **stderr**（console.error）—— 混进 stdout 就毁了那次重定向。
 * @WHY 为什么样本也要有「概览」命令：样本是本项目**唯一**会落盘被审文本的地方，
 *   必须能一眼看出「攒了多少 / 有多老 / 截断或省略了几条 / 删掉会损失什么」，否则没人敢开它。
 */
import type { JevReviewStatus } from "../server/dev-con/jev-review.js";
import type { JevSampleSource, JevSamplesStats } from "../server/dev-con/jev-samples.js";

/** 字节数（1.2 MiB / 800 B）：上限是 MiB 级，用 KiB/MiB 读起来才有概念。 */
function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}

/** 时间戳（取不到显示 —，不用 0 顶）。 */
function formatTime(at: number | null): string {
	return at === null ? "—" : new Date(at).toLocaleString();
}

/** 时长（7 天 → 「7 天」）：阈值要能被人一眼核对，不能只给毫秒。 */
function formatDuration(ms: number): string {
	const day = 24 * 60 * 60_000;
	if (ms >= day && ms % day === 0) return `${ms / day} 天`;
	if (ms >= 60 * 60_000 && ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)} 小时`;
	if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
	return `${ms}ms`;
}

/** 来源分布（只打出现过的；顺序固定，便于逐次对比）。 */
const SOURCE_ORDER: readonly JevSampleSource[] = ["tool", "ws", "cli", "probe", "unknown"];

function formatSourceCounts(bySource: Record<string, number>): string {
	const known = SOURCE_ORDER.filter((name) => (bySource[name] ?? 0) > 0);
	const extra = Object.keys(bySource)
		.filter((name) => !SOURCE_ORDER.includes(name as JevSampleSource) && bySource[name]! > 0)
		.sort();
	const all = [...known, ...extra];
	if (all.length === 0) return "—";
	return all.map((name) => `${name} ${bySource[name]}`).join(" / ");
}

export function printSamplesUsage(): void {
	console.log(
		[
			"  samples [--json]             真实样本概览（条数 / 占用 / 时间范围 / 结论与来源分布 / 截断与抹除）",
			"  samples clear [--json]       删除样本（当前 + 上一代；删了就再也复盘不了，先 export 再删）",
		].join("\n"),
	);
}

export function printReviewUsage(): void {
	console.log(
		[
			"  review [--json]              是否该复盘了（到期退出码 0 / 未到期 1）",
			"  review export [--since <7d|24h|30m|ISO>] [--out <path|->]   导出 tune 语料草稿（stdout 是纯 JSONL）",
			"  review ack [--at <ISO>]      确认已复盘（写 lastAckAt；默认 now）",
		].join("\n"),
	);
}

/** 样本概览（只读；条目里虽然存着被审内容，这里也只显示计数与时间）。 */
export function printSamplesStats(
	stats: JevSamplesStats,
	paths: { previousPath: string; previousExists: boolean },
): void {
	if (stats.entries === 0 && stats.skipped === 0) {
		console.log(`样本文件: ${stats.path}（还没有样本）`);
		console.log(
			"\n注: 样本在**真实调用**（cache=miss）后写入：缓存命中/磁盘回放不记（同一内容重放一百次也只有一个真相）。",
		);
		console.log(`    记录开关：npm run jev -- config --record-samples（默认开）`);
		return;
	}
	console.log(`样本文件: ${stats.path}`);
	// 计数是**两代合计**（轮转后旧条目不会消失）：不说清楚会被读成「当前文件里有这么多」。
	if (paths.previousExists) console.log(`上一代: ${paths.previousPath}（下面的计数已含它）`);
	console.log(`条目: ${stats.entries}  占用: ${formatBytes(stats.bytes)}`);
	console.log(`时间范围: ${formatTime(stats.oldestAt)} → ${formatTime(stats.newestAt)}`);
	console.log(
		`结论分布: 通过 ${stats.byOutcome.approve} / 阻断 ${stats.byOutcome.block} / 转人工 ${stats.byOutcome.review}`,
	);
	console.log(`来源分布: ${formatSourceCounts(stats.bySource)}`);
	console.log(
		`截断: ${stats.truncated} 条（内容不完整，只能看前半段）  抹掉密钥形状: ${stats.redacted} 条（原地抹成 «redacted»）`,
	);
	if (stats.skipped > 0) console.log(`损坏行（已跳过）: ${stats.skipped}`);
	console.log(
		"\n注: 样本是本项目**唯一**落盘被审内容的地方（截断 + 密钥形状检测 + 单文件轮转）；",
	);
	console.log("    复盘完请 `samples clear`，日常看是否到期用 `review`。");
}

/** 清空结果（删了哪几个文件 / 共多少字节）。 */
export function printSamplesClear(path: string, cleared: { removed: string[]; bytes: number }): void {
	if (cleared.removed.length === 0) {
		console.log(`没有可清理的样本文件（${path}）`);
		return;
	}
	console.log(`已删除 ${cleared.removed.length} 个样本文件（共 ${formatBytes(cleared.bytes)}）：`);
	for (const file of cleared.removed) console.log(`  ${file}`);
	console.log("\n注意: 样本不可再生（漏采样无法事后补）。要校准阈值请先 `review export` 留一份语料。");
}

/** 复盘状态（人类可读；退出码由调用方按 `due` 决定：到期 0 / 未到期 1）。 */
export function printReviewStatus(
	status: JevReviewStatus,
	paths: { samplesPath: string; ackPath: string },
): void {
	const { minEntries, maxAgeMs } = status.thresholds;
	console.log(`样本文件: ${paths.samplesPath}`);
	console.log(`确认文件: ${paths.ackPath}`);
	console.log(`阈值: 攒够 ${minEntries} 条 或 最早一条等满 ${formatDuration(maxAgeMs)}（先到先触发）`);
	console.log(`上次确认: ${formatTime(status.lastAckAt)}${status.lastAckAt === null ? "（从未确认，从最早的样本算起）" : ""}`);
	console.log(`待复盘: ${status.pending} 条`);
	if (status.pending > 0) {
		console.log(`待复盘时间范围: ${formatTime(status.oldestPendingAt)} → ${formatTime(status.newestPendingAt)}`);
		console.log(`其中转人工（没有真值，只能人判）: ${status.needsHumanLabel} 条`);
	}
	if (status.due) {
		const reason =
			status.reason === "entries" ? `攒够 ${minEntries} 条` : `最早一条已等满 ${formatDuration(maxAgeMs)}`;
		console.log(`状态: **该复盘了**（${reason}）`);
		console.log("");
		console.log("下一步:");
		console.log("  1) npm run jev -- review export --out /tmp/jev-corpus.jsonl   # 导出语料草稿（机器预填 label）");
		console.log("  2) 人工复核 label（approve→should-pass / block→should-block / 转人工那批没有真值）");
		console.log("  3) npm run jev -- tune --corpus /tmp/jev-corpus.jsonl          # 用真实分数重估阈值/判据");
		console.log("  4) npm run jev -- review ack                                   # 确认已复盘（重置待复盘计数）");
		return;
	}
	console.log("状态: 还没到期（继续攒真实样本）");
}

/** 导出回执（走 stderr：stdout 留给纯 JSONL 语料）。 */
export function printReviewExportSummary(input: {
	/** null = stdout（没有写文件）。 */
	out: string | null;
	items: number;
	since: number | null;
	skipped: { unlabeledOutcome: number; noState: number; duplicate: number };
}): void {
	console.error(`已导出 ${input.items} 条语料${input.out ? ` → ${input.out}` : " → stdout"}`);
	if (input.since !== null) console.error(`时间过滤: 只取 ${formatTime(input.since)} 之后的样本（--since）`);
	console.error(
		`跳过: 转人工无真值 ${input.skipped.unlabeledOutcome} 条 / 无内容可复盘 ${input.skipped.noState} 条 / 同内容旧采样 ${input.skipped.duplicate} 条`,
	);
	if (input.items === 0) {
		console.error("没有任何可导出的条目（转人工的样本没有真值，导出来只会自欺欺人）。");
		return;
	}
	console.error("注意: label 是**按当时的结论机器预填**的（labelFromOutcome=true），必须人工复核后再拿去 tune。");
	console.error("下一步: npm run jev -- tune --corpus <上面那个文件>");
}

/** 确认回执（写 lastAckAt；ack 只影响提醒，不动样本）。 */
export function printReviewAck(input: {
	ackPath: string;
	lastAckAt: number;
	acknowledged: number;
	previousAckAt: number | null;
}): void {
	console.log(`已确认复盘: lastAckAt = ${formatTime(input.lastAckAt)}（${input.ackPath}）`);
	console.log(
		`本次确认掉 ${input.acknowledged} 条待复盘样本（上次确认: ${formatTime(input.previousAckAt)}）`,
	);
	console.log("注: 样本**没有**被删除，只是不再计入「待复盘」；要真要留就把语料导出去，要清就 `samples clear`。");
}
