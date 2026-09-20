/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED jev-samples.ts（样本来源）, jev-tune.ts（导出语料的消费方格式）,
 *            scripts/jev-gate.ts（review 命令）, ../agent-service.ts（底栏「待复盘」回执）
 *   @WHY 为什么单独一个模块：**到期判定**与**导出语料**是纯逻辑（不碰磁盘、不碰网络），
 *         磁盘读写留在 CLI/服务层 —— 这样「什么算该复盘了」可以单测，不依赖时钟与文件系统。
 *   @CONTRACT 导出语料的 label 只从**当时的结论**推：approve→should-pass、block→should-block。
 *         review **不导出**（门禁转人工 = 没有真值，硬填一个 label 就是自己骗自己）——
 *         它们只计数，提醒里写清「N 条转人工需人判」。
 *   @GOTCHA 复盘的价值全在「人改 label」：导出只是草稿，`labelFromOutcome: true` 标记了哪些是机器预填。
 * ──────────────────────────────────────────────────
 */
import type { JevSampleEntry } from "./jev-samples.js";

/** @MAGIC 复盘触发条件：攒够 40 条**或**最早一条已等 7 天（先到先触发）。 */
export const JEV_REVIEW_MIN_ENTRIES = 40;
export const JEV_REVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export type JevReviewDueReason = "entries" | "age";

export interface JevReviewStatus {
	/** 上次确认（ack）之后新增的样本数。 */
	pending: number;
	/** 是否到期该复盘。 */
	due: boolean;
	/** 触发原因（未到期时为 null）。 */
	reason: JevReviewDueReason | null;
	/** 待复盘样本里最早/最新一条的时间（无待复盘时为 null）。 */
	oldestPendingAt: number | null;
	newestPendingAt: number | null;
	/** 待复盘样本里 outcome=review 的条数（这些没有真值，只能人判）。 */
	needsHumanLabel: number;
	/** 触发阈值（回执里写出来，避免「为什么现在提醒」成黑盒）。 */
	thresholds: { minEntries: number; maxAgeMs: number };
	/** 上次确认时间（从未确认 = null）。 */
	lastAckAt: number | null;
}

/**
 * 到期判定（纯函数）。
 * @CONTRACT `lastAckAt` 为 null（从未确认）时，**从最早的样本算起**：第一次跑一周后要能提醒。
 */
export function reviewStatus(
	entries: readonly JevSampleEntry[],
	options: { lastAckAt: number | null; now: number; minEntries?: number; maxAgeMs?: number },
): JevReviewStatus {
	const minEntries = options.minEntries ?? JEV_REVIEW_MIN_ENTRIES;
	const maxAgeMs = options.maxAgeMs ?? JEV_REVIEW_MAX_AGE_MS;
	const lastAckAt = options.lastAckAt;
	const pending = lastAckAt === null ? [...entries] : entries.filter((entry) => entry.at > lastAckAt);
	const oldest = pending.length > 0 ? pending[0]!.at : null;
	const newest = pending.length > 0 ? pending[pending.length - 1]!.at : null;
	let reason: JevReviewDueReason | null = null;
	if (pending.length >= minEntries) reason = "entries";
	else if (oldest !== null && options.now - oldest >= maxAgeMs) reason = "age";
	return {
		pending: pending.length,
		due: reason !== null,
		reason,
		oldestPendingAt: oldest,
		newestPendingAt: newest,
		needsHumanLabel: pending.filter((entry) => entry.outcome === "review").length,
		thresholds: { minEntries, maxAgeMs },
		lastAckAt,
	};
}

/** tune 语料行（与 `jev-tune.ts` 的 CorpusItem 对齐）。 */
export interface JevReviewCorpusItem {
	id: string;
	label: "should-pass" | "should-block";
	/** 机器**预填**的 label（人必须复核）。 */
	labelFromOutcome: true;
	propositions: string[];
	state: unknown;
}

export interface JevReviewExport {
	items: JevReviewCorpusItem[];
	/** 没导出的原因分类（不静默丢弃：报告里逐项给出条数）。 */
	skipped: {
		/** outcome=review：没有真值，导不出 label。 */
		unlabeledOutcome: number;
		/** state 被省略（密钥形状）或为空：没有内容可复盘。 */
		noState: number;
		/** 同一 (stateHash, 命题) 已有更新的一条（保留最新）。 */
		duplicate: number;
	};
}

/** 稳定短 id：同一内容 + 同一命题永远得到同一个 id（tune 报告里可对回样本）。 */
function corpusId(entry: JevSampleEntry, proposition: string): string {
	const base = entry.stateHash || String(entry.at);
	return `${base.slice(0, 12)}-${proposition}`;
}

/** state 是 JSON 文本就还原成对象（tune 的 state 形状不限，但对象更省空间、更好读）。 */
function reviveState(state: string): unknown {
	const text = state.trim();
	if (!(text.startsWith("{") || text.startsWith("["))) return state;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed ?? state;
	} catch {
		return state;
	}
}

/**
 * 把样本导成 tune 能直接吃的语料草稿（纯函数）。
 * @CONTRACT 一条样本带多个命题 ⇒ 每个命题各出一条（tune 的统计按命题分组，其它命题不得污染）。
 *   去重按 (stateHash, proposition) 保留**最新**一条：早的那条是同内容的旧采样。
 */
export function samplesToCorpus(
	entries: readonly JevSampleEntry[],
	options: { since?: number | null } = {},
): JevReviewExport {
	const since = options.since ?? null;
	const skipped = { unlabeledOutcome: 0, noState: 0, duplicate: 0 };
	const byKey = new Map<string, JevReviewCorpusItem>();
	for (const entry of entries) {
		if (since !== null && entry.at <= since) continue;
		if (entry.outcome === "review") {
			skipped.unlabeledOutcome += 1;
			continue;
		}
		if (!entry.state) {
			skipped.noState += 1;
			continue;
		}
		const label = entry.outcome === "approve" ? "should-pass" : "should-block";
		for (const proposition of entry.propositions) {
			const key = `${entry.stateHash}::${proposition}`;
			if (byKey.has(key)) skipped.duplicate += 1;
			// 后写覆盖前写 = 保留最新（loadJevSamples 已按时间升序）。
			byKey.set(key, {
				id: corpusId(entry, proposition),
				label,
				labelFromOutcome: true,
				propositions: [proposition],
				state: reviveState(entry.state),
			});
		}
	}
	return { items: [...byKey.values()], skipped };
}

/** 导出成 JSONL 文本（末尾有换行；tune 逐行解析）。 */
export function corpusToJsonl(items: readonly JevReviewCorpusItem[]): string {
	return items.map((item) => JSON.stringify(item)).join("\n") + (items.length > 0 ? "\n" : "");
}
