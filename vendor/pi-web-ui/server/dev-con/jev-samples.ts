/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED jev-gate.ts（真实决策后写入；唯一 hook 点）,
 *            jev-review.ts（到期判定/导出语料/ack）,
 *            scripts/jev-gate.ts（samples / review 命令）,
 *            ../agent-service.ts（把回执里的「待复盘」推给底栏）
 *   @CONTRACT 唯一可写事实源：<agentDir>/dev-con/jev-samples.jsonl（0600，append-only）。
 *   @WHY 与 jev-decisions-cache.jsonl 的分工是**故意不同**的：
 *         缓存只存 cacheKey 摘要 + 分数（可回放、不含被审内容）；
 *         样本文档**要存被审内容**（截断），因为「一周后拿真实样本复盘」必须有内容可看 ——
 *         只有分数分布无法判断某条 approve 是对是错，也就无法校准。
 *         ⇒ 这是本项目**唯一**会落盘被审文本的地方，所以它自带三条约束：
 *           ① 截断（JEV_SAMPLE_STATE_MAX_CHARS）；② 密钥**形状**的 token 原地抹成 «redacted»；
 *           ③ 单文件 + 一代轮转 + 条目上限，可一键清空（samples clear）。
 *   @GOTCHA 只记**真实调用**（cache=miss）。缓存回放不是新样本：同一内容重放一百次也只有一个真相。
 *   @GOTCHA 抹除是**按值形状**的：≥32 位的不透明串（长 sha/base64）也会被抹成 «redacted» ——
 *     少数正常的长哈希因此变不可读，这是「宁可误抹」的代价（复盘看结构仍够用）。
 *   @MAGIC 上限：单条 state 4000 字符 / 2000 条 / 8MB（超出轮转）。
 * ──────────────────────────────────────────────────
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import type { JevOutcome } from "./jev-model.js";
import { looksLikeLiteralSecret } from "./account-template.js";

/** 落盘版本号：结构不兼容变更时 +1。 */
export const JEV_SAMPLES_VERSION = 1;

/** @MAGIC 单条被审内容的最大落盘长度（超出截断并标记）。 */
export const JEV_SAMPLE_STATE_MAX_CHARS = 4_000;
/** @MAGIC 条目上限（超出轮转）。 */
export const JEV_SAMPLES_MAX_ENTRIES = 2_000;
/** @MAGIC 文件字节上限（超出轮转）。 */
export const JEV_SAMPLES_MAX_BYTES = 8 * 1024 * 1024;
/** 短字段（理由/模型/来源）的最大长度，超出即丢弃。 */
const MAX_FIELD_CHARS = 600;

/** 决策来源：复盘时要能区分「agent 主动问的」与「脚本/CI 跑的」。 */
export type JevSampleSource = "tool" | "cli" | "probe" | "ws" | "unknown";

export interface JevSampleError {
	code: string;
	error: string;
	errorEn: string;
}

export interface JevSampleEntry {
	v: number;
	at: number;
	/** 本次问了哪些命题（顺序无关；写入前排序去重）。 */
	propositions: string[];
	/** 命题 → 0..1 分数（拿不到的命题不出现，**不补 0**）。 */
	checks: Record<string, number>;
	outcome: JevOutcome;
	reason: string;
	reasonEn: string;
	source: JevSampleSource;
	model: string;
	/** 被审内容（截断 + 抹掉密钥形状 token 之后）。 */
	state: string;
	/** 截断**前**的长度（复盘时知道丢了多少）。 */
	stateChars: number;
	/** 与被审内容绑定的摘要（去重、关联缓存、导出语料时做 id）。 */
	stateHash: string;
	/** 写入前被抹掉的「像密钥的 token」个数（>0 = 内容被改写，复盘时要知道）。 */
	stateRedacted?: number;
	/** 门禁失败的样本：outcome 必为 review（坏了不等于放行）。 */
	error?: JevSampleError;
}

/** 采集输入（gate 侧把手上已有的东西交进来，本模块负责截断/脱敏/归一）。 */
export interface JevSampleInput {
	at: number;
	state: string;
	propositions: readonly string[];
	checks: Record<string, number>;
	outcome: JevOutcome;
	reason: string;
	reasonEn: string;
	source: JevSampleSource;
	model: string;
	stateHash: string;
	error?: JevSampleError;
}

export interface JevSamplesStats {
	path: string;
	entries: number;
	bytes: number;
	/** 损坏行（无法解析/形状不符）：读时跳过并计数，不抛。 */
	skipped: number;
	oldestAt: number | null;
	newestAt: number | null;
	/** 因超长被截断的条数（复盘时提示「内容不完整」）。 */
	truncated: number;
	/** 写入前抹过密钥形状 token 的条数。 */
	redacted: number;
	byOutcome: Record<JevOutcome, number>;
	bySource: Record<string, number>;
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

const SOURCES: readonly JevSampleSource[] = ["tool", "cli", "probe", "ws", "unknown"];

function normalizeSource(value: unknown): JevSampleSource {
	return SOURCES.includes(value as JevSampleSource) ? (value as JevSampleSource) : "unknown";
}

/** 分数表：只接受 0..1 的有限数（丢弃越界项；空表保留——review 也可能没有分数）。 */
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

function normalizePropositions(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out = raw
		.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= MAX_FIELD_CHARS)
		.map((item) => item.trim())
		.filter(Boolean);
	return [...new Set(out)].sort();
}

/** @MAGIC 不透明长 token 阈值：≥ 32 位的 base64/hex/JWT 形状一律当密钥处理（宁可误抹）。 */
const OPAQUE_TOKEN = /^[A-Za-z0-9_+/=-]{32,}$/;

/**
 * 抹掉文本里「像密钥」的 token（纯函数）。
 * @WHY 用**值形状**而不是键名：`findSecretMaterial` 是按键名（key/token/secret）判的，
 *   用在 diff 上会把所有提到 `token` 变量的正常改动都判成密钥 —— 那样日志就废了。
 *   这里只杀“就是密钥”的形状：`sk-/ghp_/…` 前缀串，以及 ≥ 32 位不透明串。
 * @CONTRACT 命中即**原地抹掉**（保留 diff 的可读性）并返回命中个数；绝不整条丢掉。
 */
export function redactSecretTokens(text: string): { text: string; hits: number } {
	let hits = 0;
	const redacted = text.replace(/[^\s,;()[\]{}'"`<>|]+/g, (token) => {
		const trimmed = token.replace(/^[=:]+|[=:]+$/g, "");
		if (!looksLikeLiteralSecret(trimmed) && !OPAQUE_TOKEN.test(trimmed)) return token;
		hits += 1;
		return token.replace(trimmed, "\u00abredacted\u00bb");
	});
	return { text: redacted, hits };
}

/**
 * 采集一条样本（纯函数）：截断被审内容、抹掉密钥形状 token、字段白名单。
 * @CONTRACT 命中密钥形状 ⇒ 原地抹成 «redacted» + 记 `stateRedacted`：
 *   这一条仍然可复盘（diff 结构全在），但磁盘上不留密钥正文。
 */
export function captureJevSample(input: JevSampleInput): JevSampleEntry {
	const rawState = typeof input.state === "string" ? input.state : "";
	const stateChars = rawState.length;
	const entry: JevSampleEntry = {
		v: JEV_SAMPLES_VERSION,
		at: input.at,
		propositions: normalizePropositions(input.propositions),
		checks: normalizeChecks(input.checks),
		outcome: input.outcome,
		reason: shortString(input.reason) ?? "",
		reasonEn: shortString(input.reasonEn) ?? "",
		source: normalizeSource(input.source),
		model: shortString(input.model) ?? "",
		state: "",
		stateChars,
		stateHash: shortString(input.stateHash) ?? "",
	};
	if (input.error) {
		entry.error = {
			code: typeof input.error.code === "string" ? input.error.code.slice(0, MAX_FIELD_CHARS) : "",
			error: typeof input.error.error === "string" ? input.error.error.slice(0, MAX_FIELD_CHARS) : "",
			errorEn: typeof input.error.errorEn === "string" ? input.error.errorEn.slice(0, MAX_FIELD_CHARS) : "",
		};
	}
	if (rawState.length > 0) {
		const { text, hits } = redactSecretTokens(rawState);
		if (hits > 0) entry.stateRedacted = hits;
		entry.state = text.slice(0, JEV_SAMPLE_STATE_MAX_CHARS);
	}
	return entry;
}

/** 形状校验 + 归一化（append 与 load 都过这里；返回 null = 条目不可用）。 */
export function normalizeJevSampleEntry(raw: unknown): JevSampleEntry | null {
	if (!isObject(raw)) return null;
	if (raw.v !== JEV_SAMPLES_VERSION) return null;
	const at = finiteNumber(raw.at);
	const outcome = raw.outcome;
	if (at === undefined) return null;
	if (outcome !== "approve" && outcome !== "block" && outcome !== "review") return null;
	const state = typeof raw.state === "string" ? raw.state.slice(0, JEV_SAMPLE_STATE_MAX_CHARS) : "";
	const stateChars = finiteNumber(raw.stateChars) ?? state.length;
	const entry: JevSampleEntry = {
		v: JEV_SAMPLES_VERSION,
		at,
		propositions: normalizePropositions(raw.propositions),
		checks: normalizeChecks(raw.checks),
		outcome,
		reason: shortString(raw.reason) ?? "",
		reasonEn: shortString(raw.reasonEn) ?? "",
		source: normalizeSource(raw.source),
		model: shortString(raw.model) ?? "",
		state,
		stateChars,
		stateHash: shortString(raw.stateHash) ?? "",
	};
	if (typeof raw.stateRedacted === "number" && Number.isFinite(raw.stateRedacted) && raw.stateRedacted > 0) {
		entry.stateRedacted = raw.stateRedacted;
	}
	if (isObject(raw.error)) {
		entry.error = {
			code: typeof raw.error.code === "string" ? raw.error.code.slice(0, MAX_FIELD_CHARS) : "",
			error: typeof raw.error.error === "string" ? raw.error.error.slice(0, MAX_FIELD_CHARS) : "",
			errorEn: typeof raw.error.errorEn === "string" ? raw.error.errorEn.slice(0, MAX_FIELD_CHARS) : "",
		};
	}
	return entry;
}

export function jevSamplesPath(agentDir: string): string {
	return join(agentDir, "dev-con", "jev-samples.jsonl");
}

/** 上一代文件（轮转目标）。 */
export function jevSamplesPreviousPath(path: string): string {
	return `${path}.1`;
}

/**
 * 读取样本（旧代在前，保序；损坏行跳过并计数，不抛）。
 * @CONTRACT 样本是**时间序列**，不做 key 去重（同一内容在不同时间各算一条：那正是抖动/漂移证据）。
 */
export function loadJevSamples(path: string): { entries: JevSampleEntry[]; skipped: number; bytes: number } {
	const entries: JevSampleEntry[] = [];
	let skipped = 0;
	let bytes = 0;
	for (const file of [jevSamplesPreviousPath(path), path]) {
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
			const entry = normalizeJevSampleEntry(parsed);
			if (!entry) {
				skipped += 1;
				continue;
			}
			entries.push(entry);
		}
	}
	entries.sort((a, b) => a.at - b.at);
	return { entries, skipped, bytes };
}

/** 超过字节上限就轮转（只留一代，旧 `.1` 被 rename 覆盖）。 */
function rotateIfNeeded(path: string): void {
	try {
		if (!existsSync(path)) return;
		if (statSync(path).size < JEV_SAMPLES_MAX_BYTES) return;
		renameSync(path, jevSamplesPreviousPath(path));
	} catch {
		/* 轮转失败就继续往当前文件追加 */
	}
}

/**
 * 追加一条样本（append-only，0600）。
 * @CONTRACT **尽力而为**：任何失败都静默返回 —— 样本写不进去绝不能阻塞判定（对标 appendJevCacheEntry）。
 *   条目在这里再归一化一次：即使调用方传了多余字段，落盘的也只有白名单字段。
 * @GOTCHA 条目上限只在**读**侧生效（capJevSamples）：append 不做全量重写，避免判定路径上的 O(n) IO。
 */
export function appendJevSample(path: string, entry: JevSampleEntry): void {
	try {
		const normalized = normalizeJevSampleEntry(entry);
		if (!normalized) return;
		mkdirSync(dirname(path), { recursive: true });
		rotateIfNeeded(path);
		appendFileSync(path, JSON.stringify(normalized) + "\n", { mode: 0o600 });
	} catch {
		/* 样本写入尽力而为 */
	}
}

/** 读侧条目上限：超出保留最新（按时间）。 */
export function capJevSamples(entries: JevSampleEntry[]): JevSampleEntry[] {
	if (entries.length <= JEV_SAMPLES_MAX_ENTRIES) return entries;
	return entries.slice(entries.length - JEV_SAMPLES_MAX_ENTRIES);
}

/** 条目数 / 字节数 / 时间范围 / 分布（只读；文本只用于统计，不回显）。 */
export function jevSamplesStats(path: string): JevSamplesStats {
	const { entries, skipped, bytes } = loadJevSamples(path);
	const byOutcome: Record<JevOutcome, number> = { approve: 0, block: 0, review: 0 };
	const bySource: Record<string, number> = {};
	let truncated = 0;
	let redacted = 0;
	for (const entry of entries) {
		byOutcome[entry.outcome] += 1;
		bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
		if (entry.stateChars > entry.state.length) truncated += 1;
		if (entry.stateRedacted) redacted += 1;
	}
	return {
		path,
		entries: entries.length,
		bytes,
		skipped,
		oldestAt: entries.length > 0 ? entries[0]!.at : null,
		newestAt: entries.length > 0 ? entries[entries.length - 1]!.at : null,
		truncated,
		redacted,
		byOutcome,
		bySource,
	};
}

/** 删除样本（当前 + `.1`），返回删掉了哪些文件与总字节数。 */
export function clearJevSamples(path: string): { removed: string[]; bytes: number } {
	const removed: string[] = [];
	let bytes = 0;
	for (const file of [path, jevSamplesPreviousPath(path)]) {
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

/** 复盘确认状态：只存一个时间戳（“我看到了哪些样本”），不存被审内容。 */
export interface JevReviewAck {
	version: number;
	lastAckAt: number;
}

export const JEV_REVIEW_ACK_VERSION = 1;

export function jevReviewAckPath(agentDir: string): string {
	return join(agentDir, "dev-con", "jev-review.json");
}

/** 读确认状态（缺失/损坏一律当作“从未确认”，不抛）。 */
export function loadJevReviewAck(path: string): JevReviewAck | null {
	try {
		if (!existsSync(path)) return null;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isObject(parsed) || parsed.version !== JEV_REVIEW_ACK_VERSION) return null;
		const lastAckAt = finiteNumber(parsed.lastAckAt);
		return lastAckAt === undefined ? null : { version: JEV_REVIEW_ACK_VERSION, lastAckAt };
	} catch {
		return null;
	}
}

/** 写确认状态（tmp + rename 原子写，0600）。失败返回 false，不抛。 */
export function saveJevReviewAck(path: string, lastAckAt: number): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const payload: JevReviewAck = { version: JEV_REVIEW_ACK_VERSION, lastAckAt };
		const tmp = `${path}.${process.pid}.tmp`;
		appendFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}
