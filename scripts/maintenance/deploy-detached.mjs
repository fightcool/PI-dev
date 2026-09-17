#!/usr/bin/env node
/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @WHY=design rationale
 *              @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED scripts/maintenance/switch-production-release.mjs（真正干活的切换脚本，本文件只是脱离壳）,
 *            scripts/maintenance/prepare-release.mjs（候选构建，先跑它）,
 *            docs/PM2-PRODUCTION.md（生产切换流程）
 *   📖 docs/PM2-PRODUCTION.md「持久目录与工具」「磁盘回收」
 *
 * @WHY 为什么需要这一层：pi-web-ui **自己就是被切换的那个服务**。Agent 的 bash 工具是
 *   服务进程（scripts/start.mjs）的子进程，直接在里面跑 switch-production-release.mjs 时，
 *   脚本停掉 pi-dev-pm2.service → 服务进程死 → 整棵子进程树（含正在跑切换的那个 node）
 *   一起被杀，切换半途中断，Agent 那边只看到「命令被中止」。实测就这么翻过车。
 *
 * @CONTRACT 本脚本把切换放进**新会话（setsid）+ 完全脱离的 stdio**，并把输出重定向到日志：
 *   父进程（Agent 的 bash）退出、服务被重启，都不影响它跑完。
 *   退出码只表示「已成功派发」，不代表切换成功 —— 切换结果去 switch-status.json 看
 *   （phase: deployed = 成功、failed/rolled_back = 失败已回滚）。
 * @GOTCHA 必须 detached + unref + stdio 全部重定向到文件：只要还持有父进程的管道，
 *   父进程被杀时子进程会跟着收到 SIGHUP/EPIPE。
 * @ASSUME 调用方（Agent）随后**轮询 switch-status.json 与 /api/health** 来确认结果，
 *   而不是等这个进程的退出码。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PI_DEV_DEPLOY_ROOT ?? join(homedir(), ".local/share/pi-dev/deploy");
const LOG_DIR = join(BASE, "shared/maintenance");
const STATUS_FILE = join(LOG_DIR, "switch-status.json");

const releaseId = process.argv[2];
if (!releaseId || !/^[0-9a-f]{12}$/.test(releaseId)) {
	console.error("用法: node scripts/maintenance/deploy-detached.mjs <releaseId(12位hex)>");
	process.exit(2);
}
if (!existsSync(join(BASE, "releases", releaseId))) {
	console.error(`release 不存在：${releaseId}（先跑 prepare-release.mjs <commit>）`);
	process.exit(2);
}

mkdirSync(LOG_DIR, { recursive: true });
const logPath = join(LOG_DIR, `switch-${releaseId}-${Date.now()}.log`);
const logFd = openSync(logPath, "a");

// 记下派发前的状态，方便调用方判断「状态文件是否被这次切换更新过」。
let before = null;
try {
	before = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
} catch {
	/* 首次切换时没有状态文件 */
}

// @CONTRACT 默认容忍 1 条活跃对话 = **发起这次部署的那一轮自己**。
//   不容忍就必然死锁：切换等对话排空，而那个对话要等切换返回才结束（实测卡在 quiesce）。
//   调用方可用 SWITCH_DRAIN_TOLERATE 覆盖（0 = 严格排空，适合人工在别处发起时用）。
const env = { ...process.env, SWITCH_DRAIN_TOLERATE: process.env.SWITCH_DRAIN_TOLERATE ?? "1" };
const child = spawn(process.execPath, [join(HERE, "switch-production-release.mjs"), releaseId], {
	// detached: 新进程组 + 新会话（等价 setsid）→ 父进程被杀不会波及它。
	detached: true,
	// stdio 全部指向日志文件：不留任何指向父进程的管道（否则父死时会 EPIPE/SIGHUP）。
	stdio: ["ignore", logFd, logFd],
	env,
});
child.unref();

writeFileSync(
	join(LOG_DIR, "last-dispatch.json"),
	JSON.stringify(
		{ releaseId, pid: child.pid, log: logPath, dispatchedAt: new Date().toISOString(), previousPhase: before?.phase ?? null },
		null,
		2,
	) + "\n",
	{ mode: 0o600 },
);

console.log(`dispatched: release=${releaseId} pid=${child.pid}`);
console.log(`log: ${logPath}`);
console.log(`status: ${STATUS_FILE}（等 phase=deployed；failed/rolled_back = 失败）`);
process.exit(0);
