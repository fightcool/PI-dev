#!/usr/bin/env node
/*
 * 🍞 AI Breadcrumb — @COUPLED ../server/dev-con/jev-model.ts, ../server/dev-con/jev-gate.ts,
 *   ../server/dev-con/jev-settings.ts, ../server/model-admin.ts,
 *   ../server/dev-con/channel-accounts.ts（openRouterAdapter）, ./jev-gate-format.ts
 * 📖 ../../../docs/JEV-DECISION-GATE.md §「CLI」
 *
 * Jev 决策门禁 CLI —— 编码过程中的二元判断入口。
 *
 * 设计约束（与 Web 端共用同一份内核，绝不重复实现判断逻辑）：
 *   - 配置读/写走 dev-con/jev-settings.ts（0600 原子写、读-合并-写）；
 *   - 判断执行走 dev-con/jev-gate.ts 的 JevGate（有界 HTTP、TTL 缓存、单飞去重）；
 *   - 三态判定与命题定义走 dev-con/jev-model.ts（阈值不可在 CLI 里另定一套）；
 *   - 密钥只按名字引用，经 model-admin 解析，**任何输出都不含密钥正文**；
 *   - 额度查询复用既有的 OpenRouter 账户查询适配器，不新增第二份余额事实源。
 *
 * Usage: node --import tsx scripts/jev-gate.ts <command> [options]
 * 退出码：0 通过 / 1 阻断 / 2 转人工 / 3 出错（仅 check、probe 使用）
 */
import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { JevGate } from "../server/dev-con/jev-gate.js";
import { JEV_PROPOSITIONS, buildJevQuestions, redactJevGateConfigForEcho } from "../server/dev-con/jev-model.js";
import { jevSettingsPath, loadJevSettings, saveJevSettings } from "../server/dev-con/jev-settings.js";
import { ModelAdminService, type ModelAdminHost } from "../server/model-admin.js";
import { openRouterAdapter } from "../server/dev-con/channel-accounts.js";
import type { ChannelRecord } from "../server/dev-con/channel-model.js";
import {
	PROBE_STATE,
	printConfig,
	printDecision,
	printPropositions,
	printStatus,
	printUsage,
} from "./jev-gate-format.js";

const OUTCOME_EXIT: Record<string, number> = { approve: 0, block: 1, review: 2 };
const HARD_TIMEOUT_MS = 30_000;
const CREDENTIAL_PROVIDER = "openrouter";

type Flags = Map<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; flags: Flags } {
	const [command = "help", ...rest] = argv;
	const flags: Flags = new Map();
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i]!;
		if (!token.startsWith("--")) continue;
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
	return { command, flags };
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
): Promise<number> {
	const decision = await gate.evaluate({ state, questions: questionsFor(ids), apiKey });
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

function applyConfigPatch(
	flags: Flags,
	config: { thresholds: { approveAt: number; blockAt: number } },
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (flags.get("enable") === true) patch.enabled = true;
	if (flags.get("disable") === true) patch.enabled = false;
	const endpoint = flags.get("endpoint");
	if (typeof endpoint === "string") patch.endpoint = endpoint;
	const model = flags.get("model");
	if (typeof model === "string") patch.model = model;
	let thresholds: { approveAt: number; blockAt: number } | undefined;
	const approveAt = numFlag(flags, "approve");
	if (approveAt !== undefined) thresholds = { ...config.thresholds, approveAt };
	const blockAt = numFlag(flags, "block");
	if (blockAt !== undefined) thresholds = { ...(thresholds ?? config.thresholds), blockAt };
	if (thresholds) patch.thresholds = thresholds;
	const timeoutMs = numFlag(flags, "timeout");
	if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
	const cacheTtlMs = numFlag(flags, "cache-ttl");
	if (cacheTtlMs !== undefined) patch.cacheTtlMs = cacheTtlMs;
	const minIntervalMs = numFlag(flags, "min-interval");
	if (minIntervalMs !== undefined) patch.minIntervalMs = minIntervalMs;
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

async function main(): Promise<number> {
	const { command, flags } = parseArgs(process.argv.slice(2));
	const asJson = flags.get("json") === true;
	const agentDir = agentDirOf(flags);
	const loaded = loadJevSettings(agentDir);
	let config = loaded.config;

	if (command === "help" || flags.get("help")) {
		printUsage(CREDENTIAL_PROVIDER);
		return 0;
	}
	if (loaded.parseError && !asJson) {
		console.error(`警告: ${jevSettingsPath(agentDir)} 无法解析，已回退默认值（不会静默清空磁盘文件）`);
	}

	if (command === "config") {
		const patch = applyConfigPatch(flags, config);
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
	});

	if (command === "status") {
		if (asJson) console.log(JSON.stringify(gate.snapshotStatus(), null, 2));
		else printStatus(gate);
		return 0;
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
		const ids =
			command === "probe" ? (single ?? [JEV_PROPOSITIONS[0]!.id]) : (single ?? JEV_PROPOSITIONS.map((p) => p.id));
		const state = command === "probe" ? PROBE_STATE : await readState(flags);
		return await runDecision(gate, state, ids, apiKey, asJson);
	}

	if (command === "balance") return await runBalance(agentDir, config, asJson);

	console.error(`未知命令: ${command}\n`);
	printUsage(CREDENTIAL_PROVIDER);
	return 3;
}

const HARD_EXIT = setTimeout(() => {
	console.error("FAIL: CLI 超时未退出");
	process.exit(3);
}, HARD_TIMEOUT_MS);
HARD_EXIT.unref?.();

main()
	.then((code) => {
		clearTimeout(HARD_EXIT);
		process.exit(code);
	})
	.catch((err: unknown) => {
		clearTimeout(HARD_EXIT);
		console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(3);
	});
