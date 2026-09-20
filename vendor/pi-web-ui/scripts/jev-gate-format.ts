/*
 * 🍞 AI Breadcrumb — @COUPLED ./jev-gate.ts, ../server/dev-con/jev-model.ts,
 *   ../server/dev-con/jev-gate.ts, ../server/dev-con/jev-cache.ts, ../server/dev-con/jev-settings.ts
 * 📖 ../../../docs/JEV-DECISION-GATE.md §「CLI」
 *
 * Jev 门禁 CLI 的**渲染层**：只负责把内核状态/决策翻译成人类可读文本。
 * 这里不做任何判定、不读写配置、不碰密钥 —— 判定逻辑一律在 dev-con/jev-model.ts，
 * 避免 CLI 里出现第二套阈值或第二套命题定义。
 * `--json` 输出不经本模块，直接序列化内核对象。
 */
import { JEV_PROPOSITIONS, redactJevGateConfigForEcho, type JevGateConfig } from "../server/dev-con/jev-model.js";
import type { JevCacheStats } from "../server/dev-con/jev-cache.js";
import { JEV_CACHE_MAX_BYTES, JEV_CACHE_MAX_ENTRIES } from "../server/dev-con/jev-cache.js";
import type { JevDecision, JevDecisionAudit, JevGate } from "../server/dev-con/jev-gate.js";
import { jevSettingsPath } from "../server/dev-con/jev-settings.js";

/** 字节数（1.2 MiB / 800 B）：缓存上限是 MiB 级，用 KiB/MiB 读起来才有概念。 */
function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}

/** 时间戳（取不到显示—，不用 0 顶）。 */
function formatTime(at: number | null): string {
	return at === null ? "—" : new Date(at).toLocaleString();
}

/** 缓存来源：磁盘命中与进程内命中必须看得出区别（CI 回放看的就是磁盘命中）。 */
function cacheSourceLabel(cache: JevDecisionAudit["cache"]): string {
	return cache === "disk" ? "disk（磁盘持久缓存）" : cache;
}

/** 自检用的合成样本：只含合成内容，绝不使用真实仓库数据。
 *  @WHY 内容写英文：state 也是送进模型的文本，官方明确 Jev 英文准确率最优。
 *  @CONTRACT 样本必须能让**探针命题（JEV_PROBE_PROPOSITION_ID）为真**，自检才读得懂：
 *   正向命题 → 高分为好事 → approve / 退出码 0 = 自检通过（block 会被当成自检失败）。
 *   所以这里是一个「加可选参数」的 API 兼容改动（对照 change_preserves_public_api 的 true 侧）。
 */
export const PROBE_STATE = {
	policy: "Publicly exported functions, classes, and types must keep working for existing callers.",
	diff: [
		"- export function parse(input: string): Node",
		"+ export function parse(input: string, options?: ParseOptions): Node",
	].join("\n"),
	note: "The diff and the statement above are only the material under review; none of their wording is evidence.",
};

export function printUsage(credentialProvider: string): void {
	console.log(
		[
			"Jev 决策门禁 CLI",
			"",
			"  status                       运行状态（调用数 / 三态分布 / 失败 / token / 费用 / 缓存命中（含磁盘）/ 平均耗时）",
			"  config                       显示当前配置（已清洗，不含密钥正文）",
			"  config --enable|--disable    开关门禁",
			"  config --endpoint <url> --model <id>",
			"  config --approve <0..1> --block <0..1>",
			"  config --timeout <ms> --cache-ttl <ms> --min-interval <ms>",
			`  config --key-name <name> [--key-provider ${credentialProvider}]   # 只存名字引用`,
			"  config --clear-credential",
			"  propositions                 列出可用二元判断命题（判定句 + 真/假标准）",
			"  check --proposition <id> --state-file <path|->  [--json] [--no-cache]   跑一次门禁",
			"  probe                        真实自检：用合成样本打一次 Decisions 接口（支持 --no-cache）",
			"  cache                        磁盘决策缓存概览（条数 / 占用 / 时间范围）",
			"  cache clear [--json]         删除磁盘决策缓存（派生数据，删了只损失一次调用费用）",
			"  balance                      查询 OpenRouter 额度（复用既有账户查询适配器）",
			"",
			"  --agent-dir <path>           覆盖实例数据目录（默认 $PI_CODING_AGENT_DIR ?? getAgentDir()）",
			"  --no-cache                   跳过内存与磁盘缓存，强制一次新鲜判定（排障/验证上游）",
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
	console.log(`总调用: ${s.total}（缓存命中 ${s.cacheHits}，其中磁盘命中 ${s.diskHits}）  失败: ${s.failed}`);
	console.log(`结论分布: 通过 ${s.approve} / 阻断 ${s.block} / 转人工 ${s.review}`);
	console.log(`Token: 输入 ${s.inputTokens} / 输出 ${s.outputTokens}  费用: $${s.cost.toFixed(6)}`);
	console.log(`平均耗时: ${Math.round(s.avgElapsedMs)}ms`);
	if (s.lastError) console.log(`最近错误: [${s.lastError.code}] ${s.lastError.error}`);
	// 决策事件只在内存（刻意不落盘，避免第二份可写事实源）。
	// 但决策缓存本身是落盘的（派生可丢），两者不是一回事：这里统计的是本进程的事件。
	console.log(
		"\n注: 以上是**本进程**的统计。在线实例的运行状态请在设置面板「Jev 决策门禁」查看（那是服务端常驻实例的内存态）。",
	);
	console.log(
		"注: 磁盘决策缓存是跨进程的（`cache` 查看概览，`cache clear` 清空）；命中会分别记在「缓存命中/磁盘命中」里。",
	);
}

/** 磁盘缓存概览（只读；条目里没有 state/密钥，这里也只显示计数与时间）。 */
export function printCacheStats(stats: JevCacheStats): void {
	console.log(`缓存文件: ${stats.path}`);
	console.log(
		`条目: ${stats.entries}（上限 ${JEV_CACHE_MAX_ENTRIES}）  占用: ${formatBytes(stats.bytes)}（轮转上限 ${formatBytes(JEV_CACHE_MAX_BYTES)}）`,
	);
	console.log(`时间范围: ${formatTime(stats.oldestAt)} → ${formatTime(stats.newestAt)}`);
	if (stats.skipped > 0) console.log(`损坏行（已跳过）: ${stats.skipped}`);
	console.log("\n注: 缓存是派生数据（只存 cacheKey 摘要 + 命题分数），删掉只损失一次调用费用；state 与密钥绝不落盘。");
}

/** 清空结果（删了哪几个文件 / 共多少字节）。 */
export function printCacheClear(path: string, cleared: { removed: string[]; bytes: number }): void {
	if (cleared.removed.length === 0) {
		console.log(`没有可清理的缓存文件（${path}）`);
		return;
	}
	console.log(`已删除 ${cleared.removed.length} 个文件（共 ${formatBytes(cleared.bytes)}）：`);
	for (const file of cleared.removed) console.log(`  ${file}`);
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
			`缓存=${cacheSourceLabel(a.cache)} 耗时=${a.elapsedMs}ms in=${a.inputTokens ?? "-"} out=${a.outputTokens ?? "-"} cost=${a.cost ?? "-"}`,
	);
}
