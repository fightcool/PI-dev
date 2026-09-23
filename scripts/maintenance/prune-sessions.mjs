/*
 * 🍞 AI Breadcrumb Navigation
 *   @COUPLED docs/OPERATIONS.md「会话留存」, scripts/lib.mjs（loadConfig→agentDir / isMain）,
 *            ~/.config/systemd/user/pi-dev-session-prune.{service,timer}（--install-units 生成）
 *   @WHY 会话与机器生成归档没有任何留存机制（实测 13 天 43 会话/151MB、subagent 归档
 *        507 文件/127MB，均无界增长；pi-dev-prune.timer 只回收 release 目录）。
 *        本脚本给它们一个保守的、归档优先于删除的留存策略。
 *   @CONTRACT 默认 dry-run：只打印计划，不动盘；--apply 才执行。
 *   @CONTRACT 安全栏：24 小时内修改过的文件一律不动（活跃会话天然满足）；
 *        单轮影响总量 > capBytes（2 GiB）时拒绝执行，需显式 --force。
 *   @GOTCHA 恢复 = gunzip 回原位：sessions-archive/<相对路径>.gz 解压到 sessions/ 下同名位置。
 *   @GOTCHA 不触碰 usage-history.jsonl 正本（用量分析的依据），只清多余的 .bak 副本。
 * 用法：node scripts/maintenance/prune-sessions.mjs [--apply] [--force] [--install-units]
 *        [--session-days=90] [--archive-days=180] [--subagent-days=30] [--agent-dir=DIR]
 */
import { execFileSync } from "node:child_process";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { isMain, loadConfig, ROOT } from "../lib.mjs";

export const DEFAULTS = {
	sessionDays: 90,
	archiveDays: 180,
	subagentDays: 30,
	usageBakKeep: 1,
	recencyMs: 24 * 60 * 60 * 1000,
	capBytes: 2 * 1024 ** 3,
};

/** 一轮留存计划（纯函数：输入文件元数据与当前时间，输出动作分组与总量）。
 *  archive = gzip 后删原文件；delete* = 直接删除；一切以 mtime 判定。 */
export function collectPlan(input) {
	const { sessionFiles = [], archiveFiles = [], subagentFiles = [], usageBakFiles = [], nowMs, opts = {} } = input;
	const o = { ...DEFAULTS, ...opts };
	const old = (f, days) => nowMs - f.mtimeMs >= days * 86_400_000;
	const recent = (f) => nowMs - f.mtimeMs < o.recencyMs;

	const archive = sessionFiles.filter((f) => !recent(f) && old(f, o.sessionDays));
	const deleteArchives = archiveFiles.filter((f) => !recent(f) && old(f, o.archiveDays));
	const deleteSubagent = subagentFiles.filter((f) => !recent(f) && old(f, o.subagentDays));

	// .bak 副本按新→旧保留前 usageBakKeep 份，其余删除（不看天数：副本就是冗余）。
	const sortedBaks = [...usageBakFiles].sort((a, b) => b.mtimeMs - a.mtimeMs);
	const deleteBaks = sortedBaks.slice(o.usageBakKeep);

	const touched = [...archive, ...deleteArchives, ...deleteSubagent, ...deleteBaks];
	const totalBytes = touched.reduce((n, f) => n + f.sizeBytes, 0);
	return {
		archive,
		deleteArchives,
		deleteSubagent,
		deleteBaks,
		totalBytes,
		overCap: totalBytes > o.capBytes,
	};
}

const mb = (n) => `${(n / 1024 ** 2).toFixed(1)}MB`;
const sum = (list) => list.reduce((n, f) => n + f.sizeBytes, 0);

export function formatReport(plan, agentDir, days = DEFAULTS) {
	const lines = [
		`会话留存计划（agentDir=${agentDir}）：`,
		`  归档会话（gzip → sessions-archive/，>${days.sessionDays} 天未动）：${plan.archive.length} 个 / ${mb(sum(plan.archive))}`,
		`  删除过期归档（>${days.archiveDays} 天）：${plan.deleteArchives.length} 个 / ${mb(sum(plan.deleteArchives))}`,
		`  删除 subagent 归档（>${days.subagentDays} 天）：${plan.deleteSubagent.length} 个 / ${mb(sum(plan.deleteSubagent))}`,
		`  删除多余 usage-history .bak（保留 ${days.usageBakKeep} 份）：${plan.deleteBaks.length} 个 / ${mb(sum(plan.deleteBaks))}`,
		`  本轮影响总量：${mb(plan.totalBytes)}${plan.overCap ? "（超出 2GiB 安全上限，需 --force）" : ""}`,
	];
	for (const f of [...plan.archive, ...plan.deleteSubagent].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 5)) {
		lines.push(`    · ${f.path}（${mb(f.sizeBytes)}，${new Date(f.mtimeMs).toISOString().slice(0, 10)} 最后修改）`);
	}
	return lines.join("\n");
}

/** 递归列出目录下所有常规文件（path 为相对 dir 的正斜杠路径 + mtime/size）。 */
export function listFiles(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) out.push({ path: relative(dir, p).split(sep).join("/"), mtimeMs: st.mtimeMs, sizeBytes: st.size });
		}
	};
	walk(dir);
	return out;
}

/** gzip 单文件到目标路径（已存在则返回 false，保证幂等重跑）。 */
async function gzipTo(source, target) {
	if (existsSync(target)) return false;
	mkdirSync(dirname(target), { recursive: true });
	await pipeline(createReadStream(source), createGzip(), createWriteStream(target));
	return true;
}

/** 执行计划（path 均相对各自根目录）。返回 {archived, deleted, skipped}。 */
export async function applyPlan(agentDir, plan, { log = () => {} } = {}) {
	let archived = 0;
	let deleted = 0;
	let skipped = 0;
	for (const f of plan.archive) {
		const source = join(agentDir, "sessions", f.path);
		const target = join(agentDir, "sessions-archive", `${f.path}.gz`);
		if (!existsSync(source)) {
			skipped += 1;
			continue;
		}
		if (await gzipTo(source, target)) {
			rmSync(source);
			archived += 1;
			log(`archived ${f.path} → ${relative(agentDir, target)}`);
		} else {
			skipped += 1;
			log(`skip（归档已存在）${f.path}`);
		}
	}
	const deletes = [
		...plan.deleteArchives.map((f) => ({ root: "sessions-archive", f })),
		...plan.deleteSubagent.map((f) => ({ root: join("web", "subagent-archive"), f })),
		...plan.deleteBaks.map((f) => ({ root: "dev-con", f })),
	];
	for (const { root, f } of deletes) {
		const target = join(agentDir, root, f.path);
		if (!existsSync(target)) {
			skipped += 1;
			continue;
		}
		rmSync(target);
		deleted += 1;
		log(`deleted ${join(root, f.path)}`);
	}
	return { archived, deleted, skipped };
}

const UNIT_SERVICE = (node, script) => `[Unit]
Description=pi-dev 会话留存（prune-sessions --apply）
Documentation=file:${script}

[Service]
Type=oneshot
ExecStart=${node} ${script} --apply
Nice=10
IOSchedulingClass=idle`;

const UNIT_TIMER = `[Unit]
Description=每天执行 pi-dev 会话留存（归档旧会话、清理机器生成归档）

[Timer]
OnCalendar=*-*-* 04:47:00
# 错过的那次开机后补跑（与 pi-dev-prune.timer 的取舍一致）
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target`;

function installUnits(script) {
	const deployNode = join(homedir(), ".local/share/pi-dev/deploy/tools/node/bin/node");
	const node = existsSync(deployNode) ? deployNode : process.execPath;
	const unitDir = join(homedir(), ".config/systemd/user");
	mkdirSync(unitDir, { recursive: true });
	writeFileSync(join(unitDir, "pi-dev-session-prune.service"), UNIT_SERVICE(node, script) + "\n");
	writeFileSync(join(unitDir, "pi-dev-session-prune.timer"), UNIT_TIMER + "\n");
	execFileSync("systemctl", ["--user", "daemon-reload"]);
	execFileSync("systemctl", ["--user", "enable", "--now", "pi-dev-session-prune.timer"]);
	console.log(`已安装并启用 pi-dev-session-prune.timer（每天 04:47 ±5min，--apply）`);
}

function parseArgs(argv) {
	const flags = { apply: false, force: false, installUnits: false, days: {}, agentDir: undefined };
	for (const arg of argv) {
		if (arg === "--apply") flags.apply = true;
		else if (arg === "--force") flags.force = true;
		else if (arg === "--install-units") flags.installUnits = true;
		else {
			const m = /^--(session-days|archive-days|subagent-days)=(\d+)$/.exec(arg) ?? /^--(agent-dir)=(.+)$/.exec(arg);
			if (!m) throw new Error(`未知参数：${arg}`);
			if (m[1] === "agent-dir") flags.agentDir = m[2];
			else flags.days[m[1]] = Number(m[2]);
		}
	}
	return flags;
}

async function main() {
	const flags = parseArgs(process.argv.slice(2));
	if (flags.installUnits) {
		installUnits(join(ROOT, "scripts/maintenance/prune-sessions.mjs"));
		return;
	}
	const dayKeys = { "session-days": "sessionDays", "archive-days": "archiveDays", "subagent-days": "subagentDays" };
	const opts = Object.fromEntries(Object.entries(flags.days).map(([raw, n]) => [dayKeys[raw], n]));
	const agentDir =
		flags.agentDir ??
		(() => {
			try {
				return loadConfig().agentDir;
			} catch {
				return join(homedir(), ".local/share/pi-dev/agent");
			}
		})();
	const nowMs = Date.now();
	const plan = collectPlan({
		sessionFiles: listFiles(join(agentDir, "sessions")).filter((f) => f.path.endsWith(".jsonl")),
		archiveFiles: listFiles(join(agentDir, "sessions-archive")),
		subagentFiles: listFiles(join(agentDir, "web", "subagent-archive")),
		// 实际命名是 usage-history.jsonl.bak-<ISO时间戳>（后缀跟时间戳，不以 .bak 结尾）。
		usageBakFiles: listFiles(join(agentDir, "dev-con")).filter((f) => /^usage-history.*\.bak/.test(f.path)),
		nowMs,
		opts,
	});
	const days = { ...DEFAULTS, ...opts };
	console.log(formatReport(plan, agentDir, days));
	if (plan.overCap && !flags.force) {
		console.error("拒绝执行：本轮影响总量超出 2GiB 安全上限。确认无误后加 --force。");
		process.exitCode = 2;
		return;
	}
	if (!flags.apply) {
		console.log("dry-run：未动任何文件（--apply 执行）。");
		return;
	}
	const { archived, deleted, skipped } = await applyPlan(agentDir, plan, { log: (l) => console.log(`  ${l}`) });
	console.log(`已执行：归档 ${archived}，删除 ${deleted}，跳过 ${skipped}。`);
}

if (isMain(import.meta.url)) await main();
