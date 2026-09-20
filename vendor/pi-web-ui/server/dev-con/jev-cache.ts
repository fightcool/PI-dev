/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED jev-gate.ts（唯一消费者：evaluate 的第二级缓存）,
 *            ../agent-service.ts（装配时传 cachePath）, ../../scripts/jev-gate.ts（cache stats / clear）,
 *            usage-history.ts（轮转/逐行容错的同款范本）, channel-store.ts（同目录 tmp/0600 的范本）
 *   📖 docs/JEV-DECISION-GATE.md §9（成本与限额：省钱的正确做法是缓存）
 *   @CONTRACT 这是**派生、可丢**的缓存，不是事实源：删掉只损失一次调用费用，
 *             不参与计费、不参与用量统计、不回写会话。
 *             因此**只存 cacheKey 的摘要与元数据**：绝不存 `state` 正文、密钥正文、
 *             任何被审文本，也不存模型回答的原文（只存 0..1 分数）。
 *             需要「谁被审了什么」时去会话/用量历史里查，不要来这里捞。
 *   @WHY 为什么要落盘（而不是只有进程内 TTL 缓存）：官方实测同一输入的概率抖动可达 ~0.08，
 *         磁盘缓存让同一提交在任何一次重放里都得到同一结论（CI 确定性回放），顺带省钱 ——
 *         决策近似是 (model, questions, state) 的纯函数，可 memoize。
 *   @GOTCHA 命中必须**校验条目与当前请求同构**（model 相同 + 命题集合相同），
 *         否则改一条命题文本后旧答案会被当成本次答案（错配比 miss 危险得多，见 jev-gate.ts）。
 *   @MAGIC 8 MiB 轮转只留一代（`.1`）/ 条目上限 20_000（超出丢最旧）。
 * ──────────────────────────────────────────────────
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JevOutcome } from "./jev-model.js";

/** 落盘版本号：结构不兼容变更时 +1（读到时版本号不符的条目一律丢弃）。 */
export const JEV_CACHE_VERSION = 1;
/** @MAGIC 单文件上限：超过即轮转到 `<file>.1`（只保留一代），读时两代都读。 */
export const JEV_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** @MAGIC 内存镜像/读取后的条目上限：超出保留最新（按 at），防止读盘把内存撑爆。 */
export const JEV_CACHE_MAX_ENTRIES = 20_000;
/** @MAGIC 单条字段的长度上限（防御手改文件塞进超长字符串）。 */
const MAX_FIELD_CHARS = 256;

/** 审计元数据（与决策事件的审计同形；不含 cache 字段：来源由条目本身决定）。 */
export interface JevCacheAudit {
	requestId?: string;
	model?: string;
	provider?: string;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	elapsedMs: number;
}

/** 一条持久化的决策缓存记录（**不含 state / 密钥 / 被审文本**）。 */
export interface JevCacheEntry {
	v: number;
	/** cacheKey 的 sha256 摘要（不是 state 本身，也无法反推出 state）。 */
	key: string;
	/** 写入时刻（ms）。 */
	at: number;
	/** 产生这条决策的模型 id：与当前配置不一致即视为 miss。 */
	model: string;
	outcome: JevOutcome;
	/** 命题名 → 0..1 置信度（命题名来自注册表 id，不是被审内容）。 */
	checks: Record<string, number>;
	audit: JevCacheAudit;
}

export interface JevCacheStats {
	path: string;
	/** 两代合计的有效条目数。 */
	entries: number;
	/** 两代合计字节数。 */
	bytes: number;
	/** 损坏行（无法解析/形状不符）的条数：读时跳过并计数，不抛。 */
	skipped: number;
	oldestAt: number | null;
	newestAt: number | null;
}

export function jevCachePath(agentDir: string): string {
	return join(agentDir, "dev-con", "jev-decisions-cache.jsonl");
}

/** 上一代文件（轮转目标）；导出供 clear/诊断使用（避免别处再拼一次字符串）。 */
export function jevCachePreviousPath(path: string): string {
	return `${path}.1`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 短字符串字段：类型/长度不符即丢弃（不回显超长或可疑内容）。 */
function shortString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_CHARS ? value : undefined;
}

/** 分数表：只接受 0..1 的有限数；空表 = 没有证据 → 条目无效（见 Normalize 的说明）。 */
function normalizeChecks(raw: unknown): Record<string, number> {
	if (!isObject(raw)) return {};
	const out: Record<string, number> = {};
	for (const [name, value] of Object.entries(raw)) {
		const score = finiteNumber(value);
		if (!name || name.length > MAX_FIELD_CHARS || score === undefined || score < 0 || score > 1) continue;
		out[name] = score;
	}
	return out;
}

/** 审计白名单：只保留已知字段（手改文件塞进的其他键一律不带到决策/回显里）。 */
function normalizeAudit(raw: unknown, fallbackElapsed: number): JevCacheAudit {
	const r = isObject(raw) ? raw : {};
	const audit: JevCacheAudit = { elapsedMs: finiteNumber(r.elapsedMs) ?? fallbackElapsed };
	const requestId = shortString(r.requestId);
	const model = shortString(r.model);
	const provider = shortString(r.provider);
	const cost = finiteNumber(r.cost);
	const inputTokens = finiteNumber(r.inputTokens);
	const outputTokens = finiteNumber(r.outputTokens);
	if (requestId) audit.requestId = requestId;
	if (model) audit.model = model;
	if (provider) audit.provider = provider;
	if (cost !== undefined) audit.cost = cost;
	if (inputTokens !== undefined) audit.inputTokens = inputTokens;
	if (outputTokens !== undefined) audit.outputTokens = outputTokens;
	return audit;
}

/**
 * 形状校验 + 归一化（唯一入口：append 与 load 都过这里）。
 * @CONTRACT 返回 null = 条目不可用（版本号不符/缺关键字段/分数越界/checks 为空）。
 *   checks 为空一律拒绝：磁盘上的「没有证据」绝不能变成一次放行或拦截。
 */
export function normalizeJevCacheEntry(raw: unknown): JevCacheEntry | null {
	if (!isObject(raw)) return null;
	if (raw.v !== JEV_CACHE_VERSION) return null;
	const key = shortString(raw.key);
	const at = finiteNumber(raw.at);
	const outcome = raw.outcome;
	if (!key || at === undefined) return null;
	if (outcome !== "approve" && outcome !== "block" && outcome !== "review") return null;
	const checks = normalizeChecks(raw.checks);
	if (Object.keys(checks).length === 0) return null;
	return {
		v: JEV_CACHE_VERSION,
		key,
		at,
		model: shortString(raw.model) ?? "",
		outcome,
		checks,
		audit: normalizeAudit(raw.audit, 0),
	};
}

/** 条目上限：超出保留最新（按 at，同 at 按 key 稳定排序）。 */
export function capJevCacheEntries(entries: Iterable<JevCacheEntry>): Map<string, JevCacheEntry> {
	const all = [...entries];
	if (all.length <= JEV_CACHE_MAX_ENTRIES) return new Map(all.map((entry) => [entry.key, entry]));
	all.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
	return new Map(all.slice(0, JEV_CACHE_MAX_ENTRIES).map((entry) => [entry.key, entry]));
}

/** 读两代（旧代在前）；损坏行跳过并计数，同 key 后写覆盖前写。 */
function readEntries(path: string): { entries: Map<string, JevCacheEntry>; skipped: number; bytes: number } {
	const entries = new Map<string, JevCacheEntry>();
	let skipped = 0;
	let bytes = 0;
	for (const file of [jevCachePreviousPath(path), path]) {
		if (!existsSync(file)) continue;
		let text: string;
		try {
			bytes += statSync(file).size;
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				skipped += 1;
				continue;
			}
			const entry = normalizeJevCacheEntry(parsed);
			if (!entry) {
				skipped += 1;
				continue;
			}
			entries.set(entry.key, entry);
		}
	}
	return { entries: capJevCacheEntries(entries.values()), skipped, bytes };
}

/**
 * 读取磁盘缓存（缺失/损坏一律返回空表，不抛；服务与 CLI 都必须能继续跑）。
 * @CONTRACT 同 key 后写覆盖前写（`<file>.1` 是上一代，先读它）。
 */
export function loadJevCache(path: string): Map<string, JevCacheEntry> {
	try {
		return readEntries(path).entries;
	} catch {
		return new Map();
	}
}

/** 超过上限就把当前文件轮转为 `.1`（只留一代：旧 `.1` 由 rename 覆盖）。 */
function rotateIfNeeded(path: string): void {
	try {
		if (!existsSync(path)) return;
		if (statSync(path).size < JEV_CACHE_MAX_BYTES) return;
		renameSync(path, jevCachePreviousPath(path));
	} catch {
		/* 轮转失败就继续往当前文件追加 */
	}
}

/**
 * 追加一条记录（append-only，0600）。
 * @CONTRACT **尽力而为**：任何失败都静默返回 —— 缓存写不进去绝不能阻塞判定。
 *   条目在这里再归一化一次：即使调用方传了多余字段（例如不小心把 state 带上），
 *   写进文件的内容也只由白名单字段组成（隐私约束的最后一环）。
 */
export function appendJevCacheEntry(path: string, entry: JevCacheEntry): void {
	try {
		const normalized = normalizeJevCacheEntry(entry);
		if (!normalized) return;
		mkdirSync(dirname(path), { recursive: true });
		rotateIfNeeded(path);
		appendFileSync(path, JSON.stringify(normalized) + "\n", { mode: 0o600 });
	} catch {
		/* 缓存写入尽力而为 */
	}
}

/** 删除缓存（当前 + `.1`），返回删掉了哪些文件与总字节数（供 CLI 显示）。 */
export function clearJevCache(path: string): { removed: string[]; bytes: number } {
	const removed: string[] = [];
	let bytes = 0;
	for (const file of [path, jevCachePreviousPath(path)]) {
		try {
			const size = statSync(file).size;
			unlinkSync(file);
			removed.push(file);
			bytes += size;
		} catch {
			/* 不存在/删不掉：如实不列入 removed */
		}
	}
	return { removed, bytes };
}

/** 条目数 / 字节数 / 时间范围（只读；不含任何被审内容）。 */
export function jevCacheStats(path: string): JevCacheStats {
	const { entries, skipped, bytes } = readEntries(path);
	let oldestAt: number | null = null;
	let newestAt: number | null = null;
	for (const entry of entries.values()) {
		oldestAt = oldestAt === null ? entry.at : Math.min(oldestAt, entry.at);
		newestAt = newestAt === null ? entry.at : Math.max(newestAt, entry.at);
	}
	return { path, entries: entries.size, bytes, skipped, oldestAt, newestAt };
}

/**
 * 条目与当前请求同构吗（**命中前的强制校验**）。
 * @CONTRACT ① model 必须等于本次模型；② checks 的键集合必须与本次要求的命题名集合**完全相等**。
 *   @WHY 只比 key 不够：cacheKey 由 (model, questions, state) 决定，但旧文件可能是
 *   不同命题集合/不同代码版本写下的；键集合不同就说明「它回答的不是这次问的问题」。
 */
export function cacheEntryMatches(entry: JevCacheEntry, model: string, names: readonly string[]): boolean {
	if (entry.model !== model) return false;
	const have = Object.keys(entry.checks);
	if (have.length !== names.length) return false;
	const wanted = new Set(names);
	return have.every((name) => wanted.has(name));
}
