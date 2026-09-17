/**
 * 上下文压缩频率的稳态估算（用于给 context-policy 的 autoCompactTokenLimit 定值）。
 *
 * 为什么需要它：历史 prompt 分布是「旧策略从不压缩」造成的（上下文会一路涨到峰值），
 * 直接数「多少轮超过触发点」会得出严重偏高的比例。正确做法是看**每轮上下文增长量**，
 * 再算从压缩残留涨回触发点需要多少轮。
 *
 * 用法：
 *   node scripts/maintenance/analyze-context-steady-state.mjs [usage-history.jsonl]
 *   默认读 <agentDir>/dev-con/usage-history.jsonl（PI_DEV_AGENT_DIR 可覆盖 agentDir）。
 * 只读；不写任何文件；输出不含凭据（仅 token 计数、模型/会话标识）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_DEV_AGENT_DIR ?? join(homedir(), ".local/share/pi-dev/agent");
const historyPath = process.argv[2] ?? join(agentDir, "dev-con/usage-history.jsonl");
/** 压缩后的残留量估：摘要 + keepRecentTokens（settings.json，默认 20000）。 */
const residue = Number(process.env.PI_DEV_RESIDUE_TOKENS ?? 60_000);

const recs = readFileSync(historyPath, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter(Boolean)
	.map((r) => ({ ...r, prompt: (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0) }))
	.filter((r) => r.conversationId && r.prompt > 0)
	.sort((a, b) => a.at - b.at);

// 同一会话内相邻请求的 prompt 增量 = 该轮新增的上下文
const growth = [];
const lastByConv = new Map();
for (const r of recs) {
	const prev = lastByConv.get(r.conversationId);
	if (prev !== undefined && r.prompt > prev) growth.push(r.prompt - prev);
	lastByConv.set(r.conversationId, r.prompt);
}
const sorted = [...growth].sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const spanDays = (recs.at(-1).at - recs[0].at) / 86400_000;
const perDay = spanDays > 0 ? recs.length / spanDays : recs.length;
const k = (n) => `${Math.round(n / 1000)}k`;

console.log(`来源: ${historyPath}`);
console.log(`样本: ${recs.length} 次请求 / ${lastByConv.size} 个会话 / 跨 ${spanDays.toFixed(1)} 天 → 日均 ${perDay.toFixed(0)} 轮`);
console.log(`每轮上下文增长: 中位 ${k(q(0.5))} / p75 ${k(q(0.75))} / p90 ${k(q(0.9))} / 峰值 ${k(sorted.at(-1) ?? 0)}`);
console.log(`压缩残留按 ${k(residue)} 估（摘要 + keepRecentTokens）\n`);
console.log("触发点 T      每多少轮压缩一次      折算每天        峰值 prompt 上限");
for (const T of [258_400, 300_000, 400_000, 500_000, 600_000, 700_000, 1_000_000]) {
	const turns = Math.max(1, (T - residue) / Math.max(1, q(0.5)));
	console.log(`${String(T).padStart(9)}      每 ${turns.toFixed(0).padStart(5)} 轮          ${(perDay / turns).toFixed(1).padStart(5)} 次/天      ~${k(T)}`);
}
console.log("\n口径限定：增长不均匀（极端单轮可达数百 k，如一次读进大文件），实际频率只会比表中偏高。");
