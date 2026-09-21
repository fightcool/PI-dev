/* 🍞 AI Breadcrumb — @COUPLED ../scripts/jev-gate.ts（ask 子命令的**同一个** gate/缓存/审计路径）
 * 📖 docs/JEV-TRIM.md §延迟 —— 这个文件存在的唯一理由就是**快**。
 * @WHY 为什么另开一个入口而不是直接用 `jev-gate.ts ask`：实测 `node --import tsx scripts/jev-gate.ts`
 *   冷启动 **2.37-2.47s**，其中 **~2.5s 全在 `import "@earendil-works/pi-coding-agent"`**
 *   （那一个包拉进整棵 SDK 树），而 CLI 只用了它的 `getAgentDir()`。工具结果过滤在 `tool_result`
 *   钩子里跑，每次多等 2.5s 是不能接受的 —— 瘦入口实测把冷启动压到 **~0.6s**。
 * @CONTRACT 只做 `ask`：参数形状、退出码语义（0/1/2/3）、缓存/采样/审计**必须与 `jev-gate.ts ask` 完全一致**
 *   （两边都调用 `parseAskQuestions` / `askExitCode` / 同一个 `JevGate`）。密钥解析仍走
 *   `ModelAdminService`（门禁密钥的唯一拥有者），不在这里重写一份读文件逻辑。
 * @GOTCHA `agentDir()` 是对 SDK `getAgentDir()` 的**等价复制**：语义变了必须能发现 ——
 *   `tests/unit/jev-ask-cli.test.ts` 有一条断言直接对比两者，漂移会红。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { JevAskError, askExitCode, parseAskQuestions } from "../server/dev-con/jev-ask.js";
import { JevGate } from "../server/dev-con/jev-gate.js";
import { jevCachePath } from "../server/dev-con/jev-cache.js";
import { jevSamplesPath } from "../server/dev-con/jev-samples.js";
import { loadJevSettings } from "../server/dev-con/jev-settings.js";
import { ModelAdminService, type ModelAdminHost } from "../server/model-admin.js";

const HARD_TIMEOUT_MS = 60_000;
const CREDENTIAL_PROVIDER = "openrouter";
const USAGE =
	"用法：jev-ask --questions-file <path|-> [--state-file <path|->] [--raw] [--json] [--no-cache] [--agent-dir <dir>]\n" +
	"      jev-ask --print-agent-dir   （诊断：打印它实际使用的 agentDir）\n" +
	'（临时命题：{ "<id>": { "type": "noul", "instructions": …, "criteria": … } }；--raw = 只取概率，成功即退出 0）';

/**
 * 等价于 SDK 的 `getAgentDir()`：`PI_CODING_AGENT_DIR`（展开 `~`）→ `~/.pi/agent`。
 * @CONTRACT 任何语义变化都会让 `tests/unit/jev-ask-cli.test.ts` 的对比断言失败（刻意的）。
 */
function agentDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.PI_CODING_AGENT_DIR;
	if (fromEnv) return normalize(fromEnv.startsWith("~") ? resolve(homedir(), `.${fromEnv.slice(1)}`) : fromEnv);
	return join(homedir(), ".pi", "agent");
}

class Flags {
	readonly values = new Map<string, string | true>();
	constructor(argv: string[]) {
		for (let i = 0; i < argv.length; i += 1) {
			const token = argv[i];
			if (!token.startsWith("--")) continue;
			const name = token.slice(2);
			const next = argv[i + 1];
			if (name === "json" || name === "raw" || name === "no-cache" || name === "print-agent-dir") {
				this.values.set(name, true);
				continue;
			}
			if (next === undefined || next.startsWith("--")) throw new JevAskError(`flag --${name} 缺少取值`);
			this.values.set(name, next);
			i += 1;
		}
	}
	get(name: string): string | true | undefined {
		return this.values.get(name);
	}
	str(name: string): string | undefined {
		const value = this.values.get(name);
		return typeof value === "string" ? value : undefined;
	}
}

/** 密钥解析：只走 model-admin（与 jev-gate.ts 同一实现，不另写一份）。 */
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

function readStdin(): string {
	return readFileSync(0, "utf8");
}

async function main(argv: string[]): Promise<number> {
	const flags = new Flags(argv);
	const agentDir = flags.str("agent-dir") ?? agentDirFromEnv();
	// 诊断用：确认「它到底在看哪个 agentDir」——路径配错时症状是「找不到密钥」或「静默不生效」，
	// 没有这条命令就只能靠猜（tests/unit/jev-ask-cli.test.ts 也用它钉住与 SDK 的等价性）。
	if (flags.get("print-agent-dir") === true) {
		console.log(agentDir);
		return 0;
	}
	const settings = loadJevSettings(agentDir);
	const config = settings.config;

	const questionsFile = flags.str("questions-file");
	if (!questionsFile) {
		throw new JevAskError(
			'缺少 --questions-file: 提供命题 JSON（{ "<id>": { "type": "noul", "instructions": …, "criteria": … } }），或用 - 从 stdin 读',
		);
	}
	if (questionsFile === "-" && flags.str("state-file") === "-") {
		throw new JevAskError("--questions-file 与 --state-file 不能同时用 - （stdin 只有一份）");
	}
	const parsedQuestions = (() => {
		try {
			return parseAskQuestions(JSON.parse(questionsFile === "-" ? readStdin() : readFileSync(questionsFile, "utf8")));
		} catch (err) {
			if (err instanceof JevAskError) throw err;
			throw new JevAskError("--questions-file 不是合法 JSON");
		}
	})();

	const credential = settings.config.credentialRef;
	if (!credential)
		throw new JevAskError(
			`门禁未绑定密钥：先运行 jev-gate config --key-name <name>（providerId=${CREDENTIAL_PROVIDER}）`,
		);
	const apiKey = resolveApiKey(agentDir, credential.providerId, credential.keyName);
	if (!apiKey)
		throw new JevAskError(
			`无法解析密钥 ${credential.providerId}/${credential.keyName}（provider-keys.json 中没有该名字）`,
		);

	let state: unknown = "";
	const stateFile = flags.str("state-file");
	if (stateFile !== undefined) {
		const raw = stateFile === "-" ? readStdin() : readFileSync(stateFile, "utf8");
		const looksJson = stateFile.endsWith(".json") || raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[");
		try {
			state = looksJson ? JSON.parse(raw) : raw;
		} catch {
			state = raw;
		}
	}

	const gate = new JevGate({
		config,
		timeoutMs: config.timeoutMs,
		cacheTtlMs: config.cacheTtlMs,
		minIntervalMs: config.minIntervalMs,
		cachePath: jevCachePath(agentDir),
		samplesPath: jevSamplesPath(agentDir),
	});
	const decision = await gate.evaluate({
		state,
		questions: parsedQuestions,
		apiKey,
		useCache: flags.get("no-cache") !== true,
		source: "ask",
	});
	const asJson = flags.get("json") === true;
	if (asJson) console.log(JSON.stringify(decision, null, 2));
	else {
		const entries = Object.entries(decision.checks ?? {});
		console.log(`结论: ${decision.outcome}`);
		console.log(`理由: ${decision.reason}`);
		for (const [id, score] of entries) console.log(`  概率 ${id} = ${score.toFixed(3)}`);
		if (decision.audit) {
			console.log(
				`审计: requestId=${decision.audit.requestId ?? "-"} model=${decision.audit.model ?? "-"} ` +
					`缓存=${decision.audit.cache} 耗时=${decision.audit.elapsedMs}ms in=${decision.audit.inputTokens ?? "-"} ` +
					`out=${decision.audit.outputTokens ?? "-"} cost=${decision.audit.cost ?? "-"}`,
			);
		}
	}
	return askExitCode(decision, flags.get("raw") === true);
}

const watchdog = setTimeout(() => {
	console.error("FAIL: CLI 超时未退出");
	process.exit(3);
}, HARD_TIMEOUT_MS);
watchdog.unref?.();

if (process.argv.length <= 2) {
	console.error(USAGE);
	process.exit(3);
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((err: unknown) => {
		clearTimeout(watchdog);
		console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(3);
	});
