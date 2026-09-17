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
 *   脚本停掉 pi-dev-pm2.service → 切换进程跟着死 → 半途中断（symlink 还没换、PM2 已经停），
 *   站点靠 systemd 的 Restart=on-failure 拉回**旧版本**。实测翻过两次车。
 *
 * @GOTCHA 关键教训：`detached:true` / setsid **解决不了**这个问题。
 *   pi-dev-pm2.service 是 `KillMode=control-group`，它杀的是**整个 cgroup**，
 *   而 Agent 的 bash（以及它派生的一切，无论怎么 setsid）都在
 *   /user.slice/…/app.slice/pi-dev-pm2.service 这个 cgroup 里 —— 换进程组/会话没用，
 *   得换 **cgroup**。所以这里用 `systemd-run --user --unit=… --collect` 把切换放进
 *   它**自己的 transient unit**，彻底脱离被停的那个 cgroup。
 *
 * @CONTRACT 本脚本只负责「派发」：退出码 0 仅表示 transient unit 已启动，
 *   不代表切换成功 —— 结果去 switch-status.json 看（deployed = 成功，
 *   failed/rolled_back = 失败已回滚），或直接跑 deploy-wait.mjs。
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
// systemd-run：把切换放进独立 transient unit（独立 cgroup），不受 pi-dev-pm2.service
// 的 KillMode=control-group 波及。--collect = 退出后自动清理单元，不留 failed 残骸。
const unit = `pi-dev-switch-${releaseId}-${Date.now()}`;
const args = [
	"--user",
	`--unit=${unit}`,
	"--description=PI-dev release switch (detached)",
	"--collect",
	// 环境要显式带进去：transient unit 不继承调用方的环境。
	`--setenv=SWITCH_DRAIN_TOLERATE=${env.SWITCH_DRAIN_TOLERATE}`,
	...(process.env.PI_DEV_DEPLOY_ROOT ? [`--setenv=PI_DEV_DEPLOY_ROOT=${process.env.PI_DEV_DEPLOY_ROOT}`] : []),
	...(process.env.PI_DEV_CONFIG_DIR ? [`--setenv=PI_DEV_CONFIG_DIR=${process.env.PI_DEV_CONFIG_DIR}`] : []),
	process.execPath,
	join(HERE, "switch-production-release.mjs"),
	releaseId,
];
const child = spawn("systemd-run", args, {
	detached: true,
	stdio: ["ignore", logFd, logFd],
	env,
});
child.unref();

writeFileSync(
	join(LOG_DIR, "last-dispatch.json"),
	JSON.stringify(
		{ releaseId, unit, log: logPath, dispatchedAt: new Date().toISOString(), previousPhase: before?.phase ?? null },
		null,
		2,
	) + "\n",
	{ mode: 0o600 },
);

console.log(`dispatched: release=${releaseId} unit=${unit}`);
console.log(`log: ${logPath}（systemd-run 自身输出）`);
console.log(`journal: journalctl --user -u ${unit} --no-pager（切换脚本的输出）`);
console.log(`status: ${STATUS_FILE}（等 phase=deployed；failed/rolled_back = 失败）`);
process.exit(0);
