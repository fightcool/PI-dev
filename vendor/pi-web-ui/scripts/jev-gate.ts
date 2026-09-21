#!/usr/bin/env node
/*
 * 🍞 AI Breadcrumb — @COUPLED ../server/dev-con/jev-model.ts, ../server/dev-con/jev-gate.ts,
 *   ../server/dev-con/jev-cache.ts, ../server/dev-con/jev-settings.ts, ../server/model-admin.ts,
 *   ../server/dev-con/channel-accounts.ts（openRouterAdapter）, ./jev-gate-format.ts,
 *   ../server/dev-con/jev-tune.ts（tune 的纯逻辑）, ./jev-tune-format.ts（tune 的渲染）
 * 📖 ../../../docs/JEV-DECISION-GATE.md §「CLI」、§4（阈值与抖动）、§5.1（命题必须正向）、§9（成本）
 *
 * Jev 决策门禁 CLI —— 编码过程中的二元判断入口。
 *
 * 设计约束（与 Web 端共用同一份内核，绝不重复实现判断逻辑）：
 *   - 配置读/写走 dev-con/jev-settings.ts（0600 原子写、读-合并-写）；
 *   - 判断执行走 dev-con/jev-gate.ts 的 JevGate（有界 HTTP、内存 TTL 缓存、持久缓存、单飞去重）；
 *   - 三态判定与命题定义走 dev-con/jev-model.ts（阈值不可在 CLI 里另定一套）；
 *   - 密钥只按名字引用，经 model-admin 解析，**任何输出都不含密钥正文**；
 *   - 额度查询复用既有的 OpenRouter 账户查询适配器，不新增第二份余额事实源；
 *   - 持久决策缓存（jev-cache.ts）是派生可丢的：`cache stats` / `cache clear` 只看/只删它。
 *   - 样本（jev-samples.ts）是本项目**唯一**落盘被审内容的地方：`samples` / `review` / `samples clear`
 *     只看/只删/只导它（真实调用后写入，见 jev-gate.ts 的 captureSample）。
 *   - `tune` 用**真实分数**评测阈值：命题/阈值/三态一律取 dev-con/jev-model.ts，统计与建议一律
 *     取 dev-con/jev-tune.ts；本文件只负责读语料、调用 gate、拼报告与定退出码。
 *
 * Usage: node --import tsx scripts/jev-gate.ts <command> [options]
 * 退出码：0 通过 / 1 阻断 / 2 转人工 / 3 出错（仅 check、probe 使用）
 * 退出码（tune）：0 有建议且无误放行 / 1 建议档位仍存在误放行 / 2 语料或输入问题 / 3 出错
 * 退出码（review）：0 到期该复盘 / 1 未到期 / 3 参数或 IO 问题（便于放进定时任务判断）
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { JevGate } from "../server/dev-con/jev-gate.js";
import {
	cacheEntryMatches,
	clearJevCache,
	jevCachePath,
	jevCacheStats,
	loadJevCache,
} from "../server/dev-con/jev-cache.js";
import {
	JEV_PROPOSITIONS,
	buildJevQuestions,
	cacheKey,
	redactJevGateConfigForEcho,
	type JevGateConfig,
} from "../server/dev-con/jev-model.js";
import {
	clearJevSamples,
	jevReviewAckPath,
	jevSamplesPath,
	jevSamplesPreviousPath,
	jevSamplesStats,
	loadJevReviewAck,
	loadJevSamples,
	saveJevReviewAck,
	type JevSampleSource,
} from "../server/dev-con/jev-samples.js";
import { corpusToJsonl, reviewStatus as computeReviewStatus, samplesToCorpus } from "../server/dev-con/jev-review.js";
import {
	JEV_TUNE_REPEAT_DEFAULT,
	JEV_TUNE_REPEAT_MAX,
	type JevTuneScoredItem,
	analyzePropositionWindows,
	confusionAt,
	parseJevCorpus,
	recommendPropositionThresholds,
	suggestThresholds,
	summarizeScores,
} from "../server/dev-con/jev-tune.js";
import { JevAskError, askExitCode, parseAskQuestions } from "../server/dev-con/jev-ask.js";
import { jevSettingsPath, loadJevSettings, saveJevSettings } from "../server/dev-con/jev-settings.js";
import { ModelAdminService, type ModelAdminHost } from "../server/model-admin.js";
import { openRouterAdapter } from "../server/dev-con/channel-accounts.js";
import type { ChannelRecord } from "../server/dev-con/channel-model.js";
import {
	PROBE_STATE,
	printCacheClear,
	printCacheStats,
	printConfig,
	printDecision,
	printPropositions,
	printStatus,
	printUsage,
} from "./jev-gate-format.js";
import {
	printReviewAck,
	printReviewExportSummary,
	printReviewStatus,
	printSamplesClear,
	printSamplesStats,
} from "./jev-review-format.js";
import {
	type JevTuneFailure,
	type JevTuneReport,
	printCorpusErrors,
	printTuneReport,
	printTuneUsage,
} from "./jev-tune-format.js";

const OUTCOME_EXIT: Record<string, number> = { approve: 0, block: 1, review: 2 };
const HARD_TIMEOUT_MS = 30_000;
const CREDENTIAL_PROVIDER = "openrouter";

type Flags = Map<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; flags: Flags; positional: string[] } {
	const [command = "help", ...rest] = argv;
	const flags: Flags = new Map();
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i]!;
		if (!token.startsWith("--")) {
			// 位置参数（目前只有 `cache stats|clear` 用）：不是 flag 的值就收进 positional。
			positional.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		if (eq > 0) {
			flags.set(token.slice(2, eq), token.slice(eq + 1));
			continue;
		}
		const name = token.slice(2);
		const next = rest[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(name, next);
			i++;
		} else {
			flags.set(name, true);
		}
	}
	return { command, flags, positional };
}

function agentDirOf(flags: Flags): string {
	const override = flags.get("agent-dir");
	return typeof override === "string" ? override : (process.env.PI_CODING_AGENT_DIR ?? getAgentDir());
}

function numFlag(flags: Flags, name: string): number | undefined {
	const raw = flags.get(name);
	if (typeof raw !== "string") return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 密钥解析：只走 model-admin 这个唯一拥有者。
 * 这里构造一个最小 host —— 只有 `agentDir` 会被 resolveProviderKeyValue 用到，
 * 其余成员是 ModelAdminHost 的形状要求，CLI 中一律不触发（触发即抛，避免静默假值）。
 */
function resolveApiKey(agentDir: string, providerId: string, keyName: string): string | null {
	const unreachable = () => {
		throw new Error("CLI 不应触发 ModelAdminHost 的运行时成员");
	};
	const host = {
		agentDir,
		emit: unreachable,
		flushSnapshot: unreachable,
		isDisposed: () => false,
		modelRuntime: unreachable,
		invalidatePiConfig: unreachable,
		pushModels: unreachable,
	} as unknown as ModelAdminHost;
	return new ModelAdminService(host).resolveProviderKeyValue(providerId, keyName);
}

/**
 * 读 `--questions-file`（`-` = stdin）并做形状校验。
 * @CONTRACT 失败信息只报 id 与原因，**永不回显** state 或载荷正文（可能是整份源码/diff）。
 */
function readAskQuestions(flags: Flags): ReturnType<typeof parseAskQuestions> {
	const file = flags.get("questions-file");
	if (typeof file !== "string") {
		throw new JevAskError(
			'缺少 --questions-file：提供命题 JSON（{ "<id>": { "type": "noul", "instructions": …, "criteria": … } }），或用 - 从 stdin 读',
		);
	}
	const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new JevAskError("--questions-file 不是合法 JSON");
	}
	return parseAskQuestions(parsed);
}

async function readState(flags: Flags): Promise<unknown> {
	const inline = flags.get("state");
	if (typeof inline === "string") return JSON.parse(inline);
	const file = flags.get("state-file");
	if (typeof file !== "string") {
		throw new Error("缺少 state：用 --state '<json>' 或 --state-file <path|-> 提供被审内容");
	}
	const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
	const looksJson = file.endsWith(".json") || raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[");
	if (!looksJson) return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/** 命题 id → questions 负载。只走官方组装函数，保证与 Web 端负载形状一致。 */
function questionsFor(ids: string[]): unknown {
	for (const id of ids) {
		if (!JEV_PROPOSITIONS.some((p) => p.id === id)) {
			throw new Error(`未知命题: ${id}（用 propositions 查看可用清单）`);
		}
	}
	return buildJevQuestions(ids);
}

async function runDecision(
	gate: JevGate,
	state: unknown,
	ids: string[],
	apiKey: string,
	asJson: boolean,
	/** false = --no-cache：强制新鲜判定（内存与磁盘缓存都不读也不写）。 */
	useCache: boolean,
	/** 样本来源（check=cli / probe=probe）；只用于复盘时的来源分布。 */
	source: JevSampleSource,
): Promise<number> {
	const decision = await gate.evaluate({ state, questions: questionsFor(ids), apiKey, useCache, source });
	if (asJson) console.log(JSON.stringify(decision, null, 2));
	else printDecision(decision);
	if (decision.error) return 3;
	return OUTCOME_EXIT[decision.outcome] ?? 3;
}

/** 从配置里取密钥正文；缺失一律以退出码 3 结束（配置问题也算出错，不静默降级）。 */
function requireApiKey(
	agentDir: string,
	config: { credentialRef: { providerId: string; keyName: string } | null },
): string | null {
	const cred = config.credentialRef;
	if (!cred) {
		console.error(`门禁未绑定密钥：先运行 config --key-name <name>（providerId=${CREDENTIAL_PROVIDER}）`);
		return null;
	}
	const apiKey = resolveApiKey(agentDir, cred.providerId, cred.keyName);
	if (!apiKey) {
		console.error(`无法解析密钥 ${cred.providerId}/${cred.keyName}（provider-keys.json 中没有该名字）`);
		return null;
	}
	return apiKey;
}

/** 用法错误（互斥 flag、缺参数）：由调用方统一报错退出，不猜意图。 */
class FlagError extends Error {}

/**
 * 解析 `--since`：`7d` / `24h` / `30m`（也接受 `90s`）或 ISO 时间戳。
 * @CONTRACT 解析失败返回 null，调用方报错退出 3：**绝不把「看不懂」当成「不过滤」**——
 *   那会把全部样本导出去，而用户以为只导了最近 24 小时。
 */
function parseSince(raw: string, now: number): number | null {
	const text = raw.trim();
	const relative = /^(\d+)([dhms])$/i.exec(text);
	if (relative) {
		const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[
			relative[2]!.toLowerCase() as "d" | "h" | "m" | "s"
		];
		return now - Number(relative[1]) * unit;
	}
	const stamp = Date.parse(text);
	return Number.isFinite(stamp) ? stamp : null;
}

/** `samples` / `samples clear`：样本是本项目唯一落盘被审内容的地方，概览与删除都只认这一条路径。 */
function runSamples(agentDir: string, sub: string, asJson: boolean): number {
	const path = jevSamplesPath(agentDir);
	if (sub === "" || sub === "stats") {
		const stats = jevSamplesStats(path);
		if (asJson) console.log(JSON.stringify(stats, null, 2));
		else {
			const previousPath = jevSamplesPreviousPath(path);
			printSamplesStats(stats, { previousPath, previousExists: existsSync(previousPath) });
		}
		return 0;
	}
	if (sub === "clear") {
		const cleared = clearJevSamples(path);
		if (asJson) console.log(JSON.stringify({ path, ...cleared }, null, 2));
		else printSamplesClear(path, cleared);
		return 0;
	}
	console.error(`未知子命令: samples ${sub}（可用: samples / samples clear）`);
	return 3;
}

/**
 * `review [export|ack]`：到期判定 / 导出 tune 语料草稿 / 确认已复盘。
 * @CONTRACT 退出码：**到期 0 / 未到期 1**（便于放进定时任务或技能里判断该不该提醒），
 *   参数与 IO 问题一律 3。`export` 的语料只走 stdout（或 --out 文件），
 *   统计与提醒一律 stderr：只有这样才能安全重定向（`> corpus.jsonl`）。
 */
function runReview(gate: JevGate, agentDir: string, flags: Flags, sub: string, asJson: boolean): number {
	const samplesPath = jevSamplesPath(agentDir);
	const ackPath = jevReviewAckPath(agentDir);
	const now = Date.now();

	if (sub === "" || sub === "status") {
		const status = gate.reviewStatus(now);
		if (asJson) console.log(JSON.stringify(status, null, 2));
		else printReviewStatus(status, { samplesPath, ackPath });
		// 到期 0 / 未到期 1：提醒逻辑可以直接跟退出码挂钩。
		return status.due ? 0 : 1;
	}

	if (sub === "export") {
		const sinceRaw = flags.get("since");
		let since: number | null = null;
		if (sinceRaw !== undefined) {
			if (typeof sinceRaw !== "string") {
				console.error("--since 需要一个值（例如 7d / 24h / 30m / 2026-09-20T00:00:00Z）");
				return 3;
			}
			since = parseSince(sinceRaw, now);
			if (since === null) {
				console.error(`无法解析 --since ${sinceRaw}：用 7d / 24h / 30m / 90s 或 ISO 时间戳（如 2026-09-20T00:00:00Z）`);
				return 3;
			}
		}
		const outRaw = flags.get("out");
		const outText = typeof outRaw === "string" ? outRaw.trim() : "";
		// `--out -` 与不给 --out 同义：语料走 stdout。
		const out = outText && outText !== "-" ? resolve(outText) : null;
		const { entries } = loadJevSamples(samplesPath);
		const { items, skipped } = samplesToCorpus(entries, { since });
		const jsonl = corpusToJsonl(items);
		if (out) {
			try {
				writeFileSync(out, jsonl, { mode: 0o600 });
			} catch (err) {
				console.error(`写入语料失败 ${out}：${(err as Error).message}`);
				return 3;
			}
		} else {
			process.stdout.write(jsonl);
		}
		const summary = { out, since, items: items.length, skipped };
		// stdout 已经装了语料时，摘要只能走 stderr；写了文件（stdout 空闲）才允许 --json 走 stdout。
		if (asJson && out) console.log(JSON.stringify(summary, null, 2));
		else if (asJson) console.error(JSON.stringify(summary, null, 2));
		else printReviewExportSummary({ out, items: items.length, since, skipped });
		return 0;
	}

	if (sub === "ack") {
		const atRaw = flags.get("at");
		let at = now;
		if (atRaw !== undefined) {
			if (typeof atRaw !== "string") {
				console.error("--at 需要一个值（ISO 时间戳，如 2026-09-20T00:00:00Z）");
				return 3;
			}
			const stamp = Date.parse(atRaw.trim());
			if (!Number.isFinite(stamp)) {
				console.error(`无法解析 --at ${atRaw}：用 ISO 时间戳（如 2026-09-20T00:00:00Z）`);
				return 3;
			}
			at = stamp;
		}
		const previousAckAt = loadJevReviewAck(ackPath)?.lastAckAt ?? null;
		// 先算「确认掉几条」再写：回执里那个数字才有意义（ack 本身不删样本）。
		const { entries } = loadJevSamples(samplesPath);
		const acknowledged = computeReviewStatus(entries, { lastAckAt: previousAckAt, now: at }).pending;
		if (!saveJevReviewAck(ackPath, at)) {
			console.error(`写入确认文件失败：${ackPath}`);
			return 3;
		}
		if (asJson) console.log(JSON.stringify({ ackPath, lastAckAt: at, acknowledged, previousAckAt }, null, 2));
		else printReviewAck({ ackPath, lastAckAt: at, acknowledged, previousAckAt });
		return 0;
	}

	console.error(`未知子命令: review ${sub}（可用: review / review export / review ack）`);
	return 3;
}

function applyConfigPatch(
	flags: Flags,
	config: {
		thresholds: {
			approveAt: number;
			blockAt: number;
			perProposition?: Record<string, { approveAt?: number; blockAt?: number }>;
		};
	},
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (flags.get("enable") === true) patch.enabled = true;
	if (flags.get("disable") === true) patch.enabled = false;
	const endpoint = flags.get("endpoint");
	if (typeof endpoint === "string") patch.endpoint = endpoint;
	const model = flags.get("model");
	if (typeof model === "string") patch.model = model;
	const proposition = flags.get("proposition");
	if (typeof proposition === "string" && flags.get("unset-proposition") !== undefined) {
		// 两个都给了是矛盾指令：不猜，直接报错。
		throw new FlagError("--proposition 与 --unset-proposition 不能同时使用");
	}
	let thresholds:
		| { approveAt: number; blockAt: number; perProposition?: Record<string, { approveAt?: number; blockAt?: number }> }
		| undefined;
	const approveAt = numFlag(flags, "approve");
	const blockAt = numFlag(flags, "block");
	if (typeof proposition === "string" && proposition.trim()) {
		const id = proposition.trim();
		const current = config.thresholds.perProposition?.[id] ?? {};
		const next: { approveAt?: number; blockAt?: number } = { ...current };
		if (approveAt !== undefined) next.approveAt = approveAt;
		if (blockAt !== undefined) next.blockAt = blockAt;
		if (next.approveAt === undefined && next.blockAt === undefined) {
			throw new FlagError(`--proposition ${id} 需要同时给出 --approve 或 --block`);
		}
		const perProposition: Record<string, { approveAt?: number; blockAt?: number } | null> = {};
		for (const [key, value] of Object.entries(config.thresholds.perProposition ?? {})) {
			if (key !== id) perProposition[key] = value;
		}
		perProposition[id] = next;
		patch.thresholds = { perProposition };
		return patch;
	}
	const unset = flags.get("unset-proposition");
	if (typeof unset === "string" && unset.trim()) {
		// 显式 null = 删这一项（见 jev-settings.mergeThresholds）；其余项原样回写。
		patch.thresholds = { perProposition: { [unset.trim()]: null } };
		return patch;
	}
	if (flags.get("clear-propositions") === true) {
		patch.thresholds = { perProposition: null };
		return patch;
	}
	if (approveAt !== undefined) thresholds = { ...config.thresholds, approveAt };
	if (blockAt !== undefined) thresholds = { ...(thresholds ?? config.thresholds), blockAt };
	if (thresholds) patch.thresholds = thresholds;
	const timeoutMs = numFlag(flags, "timeout");
	if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
	const cacheTtlMs = numFlag(flags, "cache-ttl");
	if (cacheTtlMs !== undefined) patch.cacheTtlMs = cacheTtlMs;
	const minIntervalMs = numFlag(flags, "min-interval");
	if (minIntervalMs !== undefined) patch.minIntervalMs = minIntervalMs;
	const record = flags.get("record-samples") === true;
	const noRecord = flags.get("no-record-samples") === true;
	if (record && noRecord) throw new FlagError("--record-samples 与 --no-record-samples 不能同时使用");
	if (record) patch.recordSamples = true;
	if (noRecord) patch.recordSamples = false;
	if (flags.get("clear-credential") === true) patch.credentialRef = null;
	const keyName = flags.get("key-name");
	if (typeof keyName === "string") {
		const provider = flags.get("key-provider");
		patch.credentialRef = { providerId: typeof provider === "string" ? provider : CREDENTIAL_PROVIDER, keyName };
	}
	return patch;
}

async function runBalance(
	agentDir: string,
	config: Parameters<typeof requireApiKey>[1],
	asJson: boolean,
): Promise<number> {
	const apiKey = requireApiKey(agentDir, config);
	if (!apiKey) return 3;
	const cred = config.credentialRef!;
	const channel = {
		id: "cli",
		displayName: "CLI",
		providerId: cred.providerId,
		endpointId: null,
		credentialRef: null,
		accountRef: null,
		models: [],
		enabled: true,
		extra: { account: { kind: "openrouter" } },
	} as unknown as ChannelRecord;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
	try {
		const res = await openRouterAdapter.query({ channel, apiKey, signal: controller.signal });
		if (asJson) {
			console.log(JSON.stringify(res, null, 2));
		} else if (res.status === "ok") {
			console.log(`状态: ${res.status}  单位: ${res.unit ?? "-"}`);
			if (res.balance !== undefined) console.log(`余额: ${res.balance}`);
			if (res.quota) console.log(`已用: ${res.quota.used ?? "-"} / 额度: ${res.quota.limit ?? "-"}`);
		} else {
			console.error(`查询失败(${res.status}): ${res.error ?? "未知错误"}`);
		}
		return res.status === "ok" ? 0 : 3;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 解析语料路径。
 * @GOTCHA 根工程的 `npm run jev` 是 `npm --prefix vendor/pi-web-ui run jev`，npm 会把 cwd 切到
 *   包目录，于是「仓库相对路径」会找不到文件（实测）。先按 cwd 找，再退回真实调用者目录
 *   （npm 会把它放在 INIT_CWD）—— 两个都不存在时原样返回，让报错里保留用户写的路径。
 */
function resolveCorpusPath(raw: string): string {
	const candidates = [raw];
	const initCwd = process.env.INIT_CWD;
	if (initCwd && !isAbsolute(raw)) candidates.push(resolve(initCwd, raw));
	for (const candidate of candidates) if (existsSync(candidate)) return resolve(candidate);
	return raw;
}

/**
 * `tune`：用**真实分数**评测阈值是否合理（语料是人标的，分数是模型给的）。
 * @CONTRACT 分数只有两个来源，两个都不编造：
 *   ① 默认逐条调 `JevGate.evaluate`（与 check/probe 是同一个 gate、同一份密钥解析：
 *      密钥经 ModelAdminService 取出，只活在本次请求头里，**不打印、不落盘、不进报告**）；
 *   ② `--from-cache` 只读 jev-decisions-cache.jsonl 里已记录的分数（按 cacheKey 匹配，
 *      并做 model/命题集合同构校验）；查不到就如实报「缓存无此条」。
 *   拿不到分数的条目进 failures：不参与统计、绝不补 0（补 0 = 伪造一次拦截）。
 * @GOTCHA `--repeat` > 1 必须关缓存：读缓存会拿到同一个分数，抖动会被抹平成假的 0。
 * @GOTCHA 调用之间按配置的 minIntervalMs 主动让路：不限频的话 gate 会直接回 rate-limited
 *   （转人工），评测就退化成一堆假的失败。
 */
async function runTune(
	gate: JevGate,
	agentDir: string,
	config: JevGateConfig,
	flags: Flags,
	asJson: boolean,
): Promise<number> {
	const corpusArg = flags.get("corpus");
	if (typeof corpusArg !== "string" || !corpusArg.trim()) {
		console.error("缺少 --corpus <path.jsonl>（JSONL：每行 {id,label,state,propositions}）");
		return 2;
	}
	const corpus = resolveCorpusPath(corpusArg);
	let text: string;
	try {
		text = readFileSync(corpus, "utf8");
	} catch (err) {
		console.error(`无法读取语料 ${corpus}：${(err as Error).message}`);
		return 2;
	}
	const { items, errors } = parseJevCorpus(text);
	if (errors.length > 0) {
		// 语料是测量工具：坏行先修，不带着坏行花钱（否则阈值会看起来比实际更好）。
		if (asJson) console.log(JSON.stringify({ corpus, items: items.length, errors }, null, 2));
		else printCorpusErrors(corpus, errors, items.length);
		return 2;
	}
	if (items.length === 0) {
		console.error(`语料没有任何条目：${corpus}（没有语料就没有评测，不编造分数）`);
		return 2;
	}

	const fromCache = flags.get("from-cache") === true;
	const repeatFlag = flags.get("repeat");
	const repeatNum = numFlag(flags, "repeat");
	if (
		repeatFlag !== undefined &&
		(repeatNum === undefined || !Number.isInteger(repeatNum) || repeatNum < 1 || repeatNum > JEV_TUNE_REPEAT_MAX)
	) {
		console.error(`--repeat 必须是 1..${JEV_TUNE_REPEAT_MAX} 的整数（当前：${String(repeatFlag)}）`);
		return 2;
	}
	const repeats = repeatNum ?? JEV_TUNE_REPEAT_DEFAULT;
	if (fromCache && repeats > 1) {
		console.error("--from-cache 与 --repeat 互斥：缓存里每条只有一次分数，量抖动必须实时调用");
		return 2;
	}
	// 只有「单次采样」才允许用缓存：重复采样必须每次都新鲜（见函数头 @GOTCHA）。
	const useCache = repeats === 1 && flags.get("no-cache") !== true;

	let apiKey: string | null = null;
	if (!fromCache) {
		apiKey = requireApiKey(agentDir, config);
		if (!apiKey) return 3;
		// 看门狗预算：每次调用一条限频间隔 + 一个超时，再留一份默认余量。
		extendHardTimeout((config.minIntervalMs + config.timeoutMs) * items.length * repeats + HARD_TIMEOUT_MS);
	}

	const disk = fromCache ? loadJevCache(jevCachePath(agentDir)) : null;
	const scoredItems: JevTuneScoredItem[] = [];
	const perItemScores: { id: string; proposition: string; scores: number[] }[] = [];
	const failures: JevTuneFailure[] = [];
	const calls = {
		total: 0,
		errors: 0,
		cached: 0,
		fresh: 0,
		cost: 0,
		inputTokens: 0,
		outputTokens: 0,
		replayedCost: 0,
		replayedInputTokens: 0,
		replayedOutputTokens: 0,
	};
	let lastCallAt = 0;
	/**
	 * @MAGIC 50ms 余量：gate 的间隔判定是「本次发起时刻 - 上次发起时刻 < minIntervalMs」，
	 *   而 `Date.now()` 按毫秒**截断**（实测：正好睡到边界时仍会被判 rate-limited，
	 *   评测评均会凭空多出一条「失败」）。所以让路要比最小间隔多走一点。
	 */
	const paceMarginMs = 50;
	const pace = async (): Promise<void> => {
		const wait = config.minIntervalMs + paceMarginMs - (Date.now() - lastCallAt);
		if (lastCallAt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		lastCallAt = Date.now();
	};

	for (const item of items) {
		const propositions: string[] = item.propositions;
		// 命题 id 已在 parseJevCorpus 校验过来自注册表；组装也只走官方函数（同一份事实源）。
		const questions = buildJevQuestions(propositions);
		const scores: Record<string, number[]> = {};
		let failure: string | null = null;

		if (fromCache) {
			const key = cacheKey({ model: config.model, questions, state: item.state });
			const entry = disk!.get(key);
			if (!entry) {
				failure = "缓存无此条（磁盘缓存里没有该 state+命题的分数；不要用别的分数替代）";
			} else if (!cacheEntryMatches(entry, config.model, propositions)) {
				failure = "缓存条目与当前模型/命题集合不一致（按 miss 处理，不能当答案）";
			} else {
				for (const name of propositions) {
					const score = entry.checks[name];
					if (typeof score !== "number" || !Number.isFinite(score)) {
						calls.errors += 1;
						failure = `缓存条目缺少命题 ${name} 的分数`;
						break;
					}
					scores[name] = [score];
				}
			}
		} else {
			for (let round = 0; round < repeats; round++) {
				await pace();
				const decision = await gate.evaluate({
					state: item.state,
					questions,
					apiKey: apiKey!,
					useCache,
					// tune 跑的是**语料**（几十上百条合成/历史样本），不是真实使用：
					// 把它们写进样本会把「一周真实使用」的口径整个淹掉（见 JevEvaluateInput.recordSample）。
					source: "cli",
					recordSample: false,
				});
				calls.total += 1;
				// @GOTCHA 缓存命中（hit/disk）带出的是**当初那次**的 token/cost：分开记，
				//   否则一次全命中的跑分会被读成「刚刚花了这些钱」（见 jev-tune-format 的同名注）。
				const replayed = decision.audit.cache === "hit" || decision.audit.cache === "disk";
				if (replayed) {
					calls.cached += 1;
					calls.replayedCost += decision.audit.cost ?? 0;
					calls.replayedInputTokens += decision.audit.inputTokens ?? 0;
					calls.replayedOutputTokens += decision.audit.outputTokens ?? 0;
				} else {
					calls.fresh += 1;
					calls.cost += decision.audit.cost ?? 0;
					calls.inputTokens += decision.audit.inputTokens ?? 0;
					calls.outputTokens += decision.audit.outputTokens ?? 0;
				}
				if (decision.error) {
					calls.errors += 1;
					failure = `第 ${round + 1} 次调用未拿到有效决策：${decision.error}`;
					break;
				}
				for (const name of propositions) {
					const score = decision.checks[name];
					if (typeof score !== "number" || !Number.isFinite(score)) {
						calls.errors += 1;
						failure = `第 ${round + 1} 次调用缺少命题 ${name} 的分数`;
						break;
					}
					(scores[name] ??= []).push(score);
				}
				if (failure) break;
			}
		}

		if (failure) {
			failures.push({ id: item.id, label: item.label, proposition: propositions.join(", "), reason: failure });
			continue;
		}
		scoredItems.push({ id: item.id, label: item.label, scores });
		for (const name of propositions) perItemScores.push({ id: item.id, proposition: name, scores: scores[name]! });
	}

	const summaries = summarizeScores(perItemScores, config.thresholds);
	const current = confusionAt(scoredItems, config.thresholds);
	const { suggestions, evaluated, skipped } = suggestThresholds(scoredItems);
	// 逐命题窗口（加宽网格）：只增不改 —— 全局建议（suggestions/recommended）仍用窄网格。
	const perProposition = analyzePropositionWindows(scoredItems);
	const top = suggestions[0];
	// 落地的建议形态：全局基档（窄网格 top）+ 逐项覆盖，并给出它自己的四类统计。
	// @WHY 全局档位单独看永远看不出逐项阈值的价值；退出码也看这一组（见文件尾）。
	const propositionRecommendation = recommendPropositionThresholds(
		scoredItems,
		top ?? config.thresholds,
		perProposition,
	);
	const report: JevTuneReport = {
		corpus,
		model: config.model,
		repeats,
		fromCache,
		items: items.length,
		scored: scoredItems.length,
		calls,
		failures,
		summaries,
		current: { thresholds: config.thresholds, confusion: current },
		perProposition,
		propositionRecommendation,
		recommended: top ? { approveAt: top.approveAt, blockAt: top.blockAt } : null,
		suggestions,
		evaluated,
		skipped,
	};
	if (asJson) console.log(JSON.stringify(report, null, 2));
	else printTuneReport(report);

	if (scoredItems.length === 0) {
		console.error("没有任何条目拿到分数：不出建议（不编造结论）。");
		return 3;
	}
	if (failures.length > 0) {
		console.error(`${failures.length} 条未拿到分数：本次评测不完整，不能拿它当「阈值已验证」。`);
		return 3;
	}
	if (!top) {
		console.error("没有任何合法候选档位（blockAt 必须小于 approveAt）：检查网格。");
		return 3;
	}
	// 退出码 1 = 要落地的建议（全局基档 + 逐项覆盖，按**逐项阈值生效**）仍存在误放行：需要人看，不能当「阈值没问题」。
	// @WHY 只看全局档位会把「逐项阈值已经把误放行降到 0」的情况误报成有问题（反之亦然）。
	return propositionRecommendation.confusion.falsePass > 0 ? 1 : 0;
}

async function main(): Promise<number> {
	const { command, flags, positional } = parseArgs(process.argv.slice(2));
	const asJson = flags.get("json") === true;
	const agentDir = agentDirOf(flags);
	const loaded = loadJevSettings(agentDir);
	let config = loaded.config;

	if (command === "help" || flags.get("help")) {
		printUsage(CREDENTIAL_PROVIDER);
		printTuneUsage();
		return 0;
	}
	if (loaded.parseError && !asJson) {
		console.error(`警告: ${jevSettingsPath(agentDir)} 无法解析，已回退默认值（不会静默清空磁盘文件）`);
	}

	if (command === "config") {
		const patch = (() => {
			try {
				return applyConfigPatch(flags, config);
			} catch (e) {
				console.error(`参数错误: ${e instanceof Error ? e.message : String(e)}`);
				return null;
			}
		})();
		if (patch === null) return 3;
		if (Object.keys(patch).length > 0) {
			const saved = saveJevSettings(agentDir, patch);
			if (!saved.ok) {
				console.error(`保存失败: ${saved.error}`);
				if (!asJson) console.error(`         ${saved.errorEn}`);
				return 3;
			}
			config = saved.config;
			if (!asJson) console.log("已保存。");
		}
		if (asJson) console.log(JSON.stringify(redactJevGateConfigForEcho(config), null, 2));
		else printConfig(config, agentDir);
		return 0;
	}

	const gate = new JevGate({
		config,
		timeoutMs: config.timeoutMs,
		cacheTtlMs: config.cacheTtlMs,
		minIntervalMs: config.minIntervalMs,
		// 磁盘持久缓存：CLI 与在线实例共用同一份（同一 agentDir），CI 回放靠它保证同结论。
		cachePath: jevCachePath(agentDir),
		// 样本：在线实例写同一个文件，`review` 的到期判定读的也是它（与 ack 同目录，见 JevGate 注释）。
		samplesPath: jevSamplesPath(agentDir),
	});

	if (command === "status") {
		if (asJson) console.log(JSON.stringify(gate.snapshotStatus(), null, 2));
		else printStatus(gate);
		return 0;
	}

	if (command === "samples") return runSamples(agentDir, positional[0] ?? "stats", asJson);

	if (command === "review") return runReview(gate, agentDir, flags, positional[0] ?? "status", asJson);

	if (command === "cache") {
		const sub = positional[0] ?? "stats";
		const path = jevCachePath(agentDir);
		if (sub === "stats") {
			const stats = jevCacheStats(path);
			if (asJson) console.log(JSON.stringify(stats, null, 2));
			else printCacheStats(stats);
			return 0;
		}
		if (sub === "clear") {
			const cleared = clearJevCache(path);
			if (asJson) console.log(JSON.stringify({ path, ...cleared }, null, 2));
			else printCacheClear(path, cleared);
			return 0;
		}
		console.error(`未知子命令: cache ${sub}（可用: cache stats / cache clear）`);
		return 3;
	}

	if (command === "propositions") {
		if (asJson) console.log(JSON.stringify(JEV_PROPOSITIONS, null, 2));
		else printPropositions();
		return 0;
	}

	if (command === "check" || command === "probe") {
		const apiKey = requireApiKey(agentDir, config);
		if (!apiKey) return 3;
		const rawIds = flags.get("proposition");
		const single = typeof rawIds === "string" ? [rawIds] : null;
		const isProbe = command === "probe";
		const ids = isProbe ? (single ?? [JEV_PROPOSITIONS[0]!.id]) : (single ?? JEV_PROPOSITIONS.map((p) => p.id));
		const state = isProbe ? PROBE_STATE : await readState(flags);
		return await runDecision(
			gate,
			state,
			ids,
			apiKey,
			asJson,
			flags.get("no-cache") !== true,
			isProbe ? "probe" : "cli",
		);
	}

	if (command === "ask") {
		// 通用临时命题：harness 里所有「顺手问一句」的判断都走这里（见 docs/JEV-HARNESS-PLAN.md §6）。
		// 与 check/probe 共用同一个 gate、同一份密钥解析、同一套缓存与审计；不注册任何命题。
		// 先校验参数形状，再要密钥：参数用错时不该因为「没配密钥」而报出误导性错误（也便于离线测试）。
		const questions = readAskQuestions(flags);
		const apiKey = requireApiKey(agentDir, config);
		if (!apiKey) return 3;
		const state = flags.get("state-file") !== undefined || flags.get("state") !== undefined ? await readState(flags) : "";
		const decision = await gate.evaluate({
			state,
			questions,
			apiKey,
			useCache: flags.get("no-cache") !== true,
			source: "ask",
		});
		const raw = flags.get("raw") === true;
		if (asJson) console.log(JSON.stringify(decision, null, 2));
		else printDecision(decision);
		return askExitCode(decision, raw);
	}

	if (command === "tune") return await runTune(gate, agentDir, config, flags, asJson);

	if (command === "balance") return await runBalance(agentDir, config, asJson);

	console.error(`未知命令: ${command}\n`);
	printUsage(CREDENTIAL_PROVIDER);
	printTuneUsage();
	return 3;
}

/** CLI 整体看门狗：前台长命令被中止不等于失败，但 CLI 自己绝不能挂住。 */
let hardExitTimer: NodeJS.Timeout | null = setTimeout(() => {
	console.error("FAIL: CLI 超时未退出");
	process.exit(3);
}, HARD_TIMEOUT_MS);
hardExitTimer.unref?.();

/**
 * 重新给看门狗上闸（`tune` 要跑几十次真实调用，30s 的默认闸门必然误杀）。
 * @CONTRACT 只延长、不缩短：其余命令的行为与之前完全一致。
 */
function extendHardTimeout(ms: number): void {
	if (hardExitTimer) clearTimeout(hardExitTimer);
	hardExitTimer = setTimeout(() => {
		console.error("FAIL: CLI 超时未退出");
		process.exit(3);
	}, ms);
	hardExitTimer.unref?.();
}

main()
	.then((code) => {
		if (hardExitTimer) clearTimeout(hardExitTimer);
		process.exit(code);
	})
	.catch((err: unknown) => {
		if (hardExitTimer) clearTimeout(hardExitTimer);
		console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(3);
	});
