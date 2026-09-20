/*
 * 🍞 AI Breadcrumb — @COUPLED ./jev-gate.ts, ../server/dev-con/jev-model.ts,
 *   ../server/dev-con/jev-gate.ts, ../server/dev-con/jev-settings.ts
 * 📖 ../../../docs/JEV-DECISION-GATE.md §「CLI」
 *
 * Jev 门禁 CLI 的**渲染层**：只负责把内核状态/决策翻译成人类可读文本。
 * 这里不做任何判定、不读写配置、不碰密钥 —— 判定逻辑一律在 dev-con/jev-model.ts，
 * 避免 CLI 里出现第二套阈值或第二套命题定义。
 * `--json` 输出不经本模块，直接序列化内核对象。
 */
import { JEV_PROPOSITIONS, redactJevGateConfigForEcho, type JevGateConfig } from "../server/dev-con/jev-model.js";
import type { JevDecision, JevGate } from "../server/dev-con/jev-gate.js";
import { jevSettingsPath } from "../server/dev-con/jev-settings.js";

/** 自检用的合成样本：只含合成内容，绝不使用真实仓库数据。
 *  @WHY 内容写英文：state 也是送进模型的文本，官方明确 Jev 英文准确率最优。 */
export const PROBE_STATE = {
	policy:
		"Publicly exported functions, classes, and types must not be removed or have their signatures changed without a major version bump.",
	diff: [
		"- export function parse(input: string): Node",
		"+ export function parse(input: string, options: ParseOptions): Node",
	].join("\n"),
	note: "The diff and the statement above are only the material under review; none of their wording is evidence.",
};

export function printUsage(credentialProvider: string): void {
	console.log(
		[
			"Jev 决策门禁 CLI",
			"",
			"  status                       运行状态（调用数 / 三态分布 / 失败 / token / 费用 / 缓存命中 / 平均耗时）",
			"  config                       显示当前配置（已清洗，不含密钥正文）",
			"  config --enable|--disable    开关门禁",
			"  config --endpoint <url> --model <id>",
			"  config --approve <0..1> --block <0..1>",
			"  config --timeout <ms> --cache-ttl <ms> --min-interval <ms>",
			`  config --key-name <name> [--key-provider ${credentialProvider}]   # 只存名字引用`,
			"  config --clear-credential",
			"  propositions                 列出可用二元判断命题（判定句 + 真/假标准）",
			"  check --proposition <id> --state-file <path|->  [--json]   跑一次门禁",
			"  probe                        真实自检：用合成样本打一次 Decisions 接口",
			"  balance                      查询 OpenRouter 额度（复用既有账户查询适配器）",
			"",
			"  --agent-dir <path>           覆盖实例数据目录（默认 $PI_CODING_AGENT_DIR ?? getAgentDir()）",
			"  --json                       机器可读输出",
			"",
			"退出码（check / probe）：0 通过 / 1 阻断 / 2 转人工 / 3 出错",
		].join("\n"),
	);
}

export function printConfig(config: JevGateConfig, agentDir: string): void {
	const echo = redactJevGateConfigForEcho(config);
	const cred = echo.credentialRef;
	console.log(`配置来源: ${jevSettingsPath(agentDir)}`);
	console.log(`开关: ${echo.enabled ? "启用" : "停用"}`);
	console.log(`端点: ${echo.endpoint}`);
	console.log(`模型: ${echo.model}`);
	console.log(`密钥: ${cred ? `${cred.providerId} / ${cred.keyName}（仅引用，不显示正文）` : "未绑定（门禁不可用）"}`);
	console.log(`阈值: 通过 >= ${echo.thresholds.approveAt}  阻断 <= ${echo.thresholds.blockAt}  其余转人工`);
	console.log(`超时: ${echo.timeoutMs}ms  缓存: ${echo.cacheTtlMs}ms  最小间隔: ${echo.minIntervalMs}ms`);
	console.log("提示: 阈值之间是「模型不确定」的空白带。Jev 同一输入的概率抖动可达 ~0.08，不要收窄到 0.5 附近。");
}

export function printStatus(gate: JevGate): void {
	const s = gate.snapshotStatus();
	console.log(`总调用: ${s.total}（缓存命中 ${s.cacheHits}）  失败: ${s.failed}`);
	console.log(`结论分布: 通过 ${s.approve} / 阻断 ${s.block} / 转人工 ${s.review}`);
	console.log(`Token: 输入 ${s.inputTokens} / 输出 ${s.outputTokens}  费用: $${s.cost.toFixed(6)}`);
	console.log(`平均耗时: ${Math.round(s.avgElapsedMs)}ms`);
	if (s.lastError) console.log(`最近错误: [${s.lastError.code}] ${s.lastError.error}`);
	// 决策事件只在内存（刻意不落盘，避免第二份可写事实源）。
	console.log(
		"\n注: 以上是**本进程**的统计。在线实例的运行状态请在设置面板「Jev 决策门禁」查看（那是服务端常驻实例的内存态）。",
	);
}

export function printPropositions(): void {
	for (const p of JEV_PROPOSITIONS) {
		console.log(`\n[${p.id}]`);
		console.log(`  判定: ${p.instructions}`);
		console.log(`  为真: ${p.criteria.true}`);
		console.log(`  为假: ${p.criteria.false}`);
	}
	console.log(
		"\n提示: 一次请求可同时问多条命题（并行隔离求值，几乎不增加耗时）；任何一条为假即应阻断。" +
			"\n      能由代码精确计算的判断（计数、算术、日期先后、正则匹配）不要交给 Jev —— 官方明示这几类会不可靠。",
	);
}

export function printDecision(decision: JevDecision): void {
	console.log(`结论: ${decision.outcome}`);
	console.log(`理由: ${decision.reason}`);
	for (const [name, value] of Object.entries(decision.checks)) {
		console.log(`  概率 ${name} = ${value.toFixed(3)}`);
	}
	if (decision.error) console.log(`错误: ${decision.error}`);
	const a = decision.audit;
	console.log(
		`审计: requestId=${a.requestId ?? "-"} model=${a.model ?? "-"} provider=${a.provider ?? "-"} ` +
			`缓存=${a.cache} 耗时=${a.elapsedMs}ms in=${a.inputTokens ?? "-"} out=${a.outputTokens ?? "-"} cost=${a.cost ?? "-"}`,
	);
}
