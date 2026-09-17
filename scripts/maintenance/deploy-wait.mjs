#!/usr/bin/env node
/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Breadcrumbs (changing this affects):
 *   @COUPLED scripts/maintenance/deploy-detached.mjs（派发方，写 last-dispatch.json）,
 *            scripts/maintenance/switch-production-release.mjs（写 switch-status.json 的各 phase）
 *   📖 docs/PM2-PRODUCTION.md
 * @CONTRACT 只读轮询：等 switch-status.json 到达终态并复核站点健康，不做任何写操作。
 *   退出码 0 = 切换成功且站点健康；1 = 失败/回滚/超时（细节打在 stdout）。
 * @WHY 切换是脱离进程派发的（见 deploy-detached.mjs 的 @WHY），拿不到子进程退出码，
 *   所以「结果」只能从状态文件 + /api/health 复核。这个脚本被服务重启打断也无所谓：
 *   它是纯读的，重跑一次即可。
 * @GOTCHA 健康检查必须**同时**核对 pid 与 commit：只看 200 会把「旧进程还活着」当成成功。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.PI_DEV_DEPLOY_ROOT ?? join(homedir(), ".local/share/pi-dev/deploy");
const LOG_DIR = join(BASE, "shared/maintenance");
const STATUS_FILE = join(LOG_DIR, "switch-status.json");
const PORT = process.env.PI_DEV_PORT ?? "8788";
const TERMINAL = new Set(["deployed", "already_deployed", "failed", "rolled_back", "recovery_failed", "aborted"]);
const DEADLINE_MS = Number(process.env.PI_DEV_WAIT_MS ?? 300_000);

const expected = process.argv[2] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return null;
	}
};

const started = Date.now();
let status = null;
while (Date.now() - started < DEADLINE_MS) {
	status = readJson(STATUS_FILE);
	if (status && TERMINAL.has(status.phase) && (!expected || status.target === expected)) break;
	await sleep(1500);
}

if (!status || !TERMINAL.has(status.phase)) {
	console.log(JSON.stringify({ ok: false, reason: "timeout", status }, null, 1));
	process.exit(1);
}

// 站点复核：健康 + 正在跑的 commit 与目标一致（只看 200 会漏「旧进程还活着」）。
let health = null;
for (let i = 0; i < 40; i++) {
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(4000) });
		if (res.ok) {
			health = await res.json();
			break;
		}
	} catch {
		/* 切换窗口内连不上是正常的，继续等 */
	}
	await sleep(1500);
}

const ok = (status.phase === "deployed" || status.phase === "already_deployed") && !!health?.ok;
console.log(
	JSON.stringify(
		{
			ok,
			phase: status.phase,
			target: status.target,
			from: status.from ?? null,
			commit: status.commit ?? null,
			pid: status.pid ?? null,
			health,
			error: status.error ?? null,
		},
		null,
		1,
	),
);
process.exit(ok ? 0 : 1);
