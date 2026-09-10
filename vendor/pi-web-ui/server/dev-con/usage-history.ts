/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-service.ts / channel-state.ts（同目录的实例私有元数据），
 *            protocol.ts（usage_history_query / usage_history 的载荷），
 *            ../agent-service.ts（recordUsage → append；queryUsageHistory → query）
 *   📖 docs/DEV-CON-PROPOSAL.md §7（逐请求记录字段）与 §8 P4 首个切片（跨渠道/项目/时间历史）
 *   @CONTRACT 本模块只做两件事：**追加**逐请求记录到实例私有 JSONL，和**只读聚合**。
 *             不参与计费、不写回会话、不改写历史；聚合的键永远是记录里已有的引用。
 *   @WHY 持久化用 append-only JSONL 而不是数据库：单进程、写多读少、崩溃最多丢最后一行，
 *        与「共享模块/独立进程仅由实际需求推动」的工程约束一致。
 *   @MAGIC MAX_BYTES=8 MiB：超过即轮转到 `<file>.1`（只保留一代），读时两代都读。
 *          MAX_RECORDS=200_000：单次查询最多扫描的记录数（超出报 truncated）。
 *   @ASSUME "day" 分组按 UTC 切分（可复现、不受服务器时区影响），界面需标注 UTC。
 * ──────────────────────────────────────────────────
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** @MAGIC 见头部说明。 */
export const USAGE_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export const USAGE_HISTORY_MAX_RECORDS = 200_000;

/** 一条持久化的逐请求记录（字段来自 lib/usage/token-usage.mjs 的 records()）。 */
export interface UsageHistoryRecord {
	id: string;
	at: number;
	runId: string | null;
	conversationId: string | null;
	cwd: string | null;
	source: string;
	channelId: string | null;
	credentialKeyName: string | null;
	providerId: string;
	modelId: string;
	bindingRevision: number | null;
	configRevision: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	costBasis: "sdk-model-pricing" | "unknown";
	currency: string | null;
}

export type UsageHistoryGroup = "channel" | "project" | "model" | "source" | "day";

export interface UsageHistoryQuery {
	/** 时间窗（含端点，ms）；省略表示不限。 */
	from?: number;
	to?: number;
	groupBy: UsageHistoryGroup;
}

export interface UsageHistoryRow {
	/** 分组键：channelId / cwd / "provider/model" / source / YYYY-MM-DD(UTC)；无归属用 "unattributed"。 */
	key: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	/** 该组里没有价目信息的请求数（费用未知，不能当成 0 用）。 */
	unpricedRequests: number;
	firstAt: number | null;
	lastAt: number | null;
}

export interface UsageHistoryResult {
	groupBy: UsageHistoryGroup;
	from: number | null;
	to: number | null;
	rows: UsageHistoryRow[];
	totals: UsageHistoryRow;
	/** 实际读入并解析成功的记录数 / 丢弃的损坏行数。 */
	scanned: number;
	skipped: number;
	/** true = 触到扫描上限，结果不完整（界面需说明）。 */
	truncated: boolean;
}

const UNATTRIBUTED = "unattributed";

function emptyRow(key: string): UsageHistoryRow {
	return { key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, unpricedRequests: 0, firstAt: null, lastAt: null };
}

function addTo(row: UsageHistoryRow, record: UsageHistoryRecord): void {
	row.requests += 1;
	row.input += record.input;
	row.output += record.output;
	row.cacheRead += record.cacheRead;
	row.cacheWrite += record.cacheWrite;
	row.total += record.total;
	row.cost += record.cost;
	if (record.costBasis === "unknown") row.unpricedRequests += 1;
	row.firstAt = row.firstAt === null ? record.at : Math.min(row.firstAt, record.at);
	row.lastAt = row.lastAt === null ? record.at : Math.max(row.lastAt, record.at);
}

/** 分组键：只用记录里已有的引用，缺失即 "unattributed"（绝不按今天的配置推断）。 */
export function groupKeyOf(record: UsageHistoryRecord, groupBy: UsageHistoryGroup): string {
	switch (groupBy) {
		case "channel":
			return record.channelId ?? UNATTRIBUTED;
		case "project":
			return record.cwd ?? UNATTRIBUTED;
		case "model":
			return `${record.providerId}/${record.modelId}`;
		case "source":
			return record.source || "user";
		case "day":
			return new Date(record.at).toISOString().slice(0, 10);
	}
}

/** 纯聚合：过时间窗 → 分组累计 → 按 total 降序（同 total 按 key 稳定排序）。 */
export function aggregateUsage(
	records: UsageHistoryRecord[],
	query: UsageHistoryQuery,
	meta: { scanned?: number; skipped?: number; truncated?: boolean } = {},
): UsageHistoryResult {
	const from = Number.isFinite(query.from) ? (query.from as number) : null;
	const to = Number.isFinite(query.to) ? (query.to as number) : null;
	const rows = new Map<string, UsageHistoryRow>();
	const totals = emptyRow("__total__");
	for (const record of records) {
		if (!Number.isFinite(record?.at)) continue;
		if (from !== null && record.at < from) continue;
		if (to !== null && record.at > to) continue;
		const key = groupKeyOf(record, query.groupBy);
		const row = rows.get(key) ?? emptyRow(key);
		addTo(row, record);
		addTo(totals, record);
		rows.set(key, row);
	}
	const ordered = [...rows.values()].sort((a, b) => (b.total - a.total) || a.key.localeCompare(b.key));
	return {
		groupBy: query.groupBy,
		from,
		to,
		rows: ordered,
		totals: { ...totals, requests: totals.requests },
		scanned: meta.scanned ?? records.length,
		skipped: meta.skipped ?? 0,
		truncated: meta.truncated ?? false,
	};
}

/**
 * 追加 + 读取的实例私有存储。写入是单行 append（崩溃最多丢最后一行）；
 * 超过 @MAGIC 上限轮转到 `<path>.1`（只保留一代），读取时两代都读。
 */
export class UsageHistoryStore {
	private readonly path: string;
	private readonly previous: string;
	private readonly maxBytes: number;
	private readonly maxRecords: number;

	constructor(path: string, opts: { maxBytes?: number; maxRecords?: number } = {}) {
		this.path = path;
		this.previous = `${path}.1`;
		this.maxBytes = opts.maxBytes ?? USAGE_HISTORY_MAX_BYTES;
		this.maxRecords = opts.maxRecords ?? USAGE_HISTORY_MAX_RECORDS;
	}

	/** 追加一条记录；失败静默（历史不能影响编码请求）。 */
	append(record: UsageHistoryRecord): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			this.rotateIfNeeded();
			appendFileSync(this.path, JSON.stringify(record) + "\n", { mode: 0o600 });
		} catch {
			/* 历史写入尽力而为 */
		}
	}

	private rotateIfNeeded(): void {
		try {
			if (!existsSync(this.path)) return;
			if (statSync(this.path).size < this.maxBytes) return;
			renameSync(this.path, this.previous);
		} catch {
			/* 轮转失败就继续往当前文件追加 */
		}
	}

	/** 读取（旧代在前）；损坏行跳过并计数，触到上限即停止并标记 truncated。 */
	read(query: UsageHistoryQuery): { records: UsageHistoryRecord[]; scanned: number; skipped: number; truncated: boolean } {
		const records: UsageHistoryRecord[] = [];
		let scanned = 0;
		let skipped = 0;
		let truncated = false;
		for (const file of [this.previous, this.path]) {
			if (!existsSync(file)) continue;
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				if (scanned >= this.maxRecords) {
					truncated = true;
					break;
				}
				let parsed: UsageHistoryRecord;
				try {
					parsed = JSON.parse(line) as UsageHistoryRecord;
				} catch {
					skipped += 1;
					continue;
				}
				if (!parsed || typeof parsed.id !== "string" || !Number.isFinite(parsed.at)) {
					skipped += 1;
					continue;
				}
				scanned += 1;
				records.push(parsed);
			}
			if (truncated) break;
		}
		return { records, scanned, skipped, truncated };
	}

	/** 读 + 聚合（唯一对外查询入口）。 */
	query(query: UsageHistoryQuery): UsageHistoryResult {
		const { records, scanned, skipped, truncated } = this.read(query);
		return aggregateUsage(records, query, { scanned, skipped, truncated });
	}

	/** 存储文件路径（诊断/测试用；不含内容）。 */
	filePath(): string {
		return this.path;
	}
}
