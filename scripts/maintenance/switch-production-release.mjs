/*
 * 🍞 AI Breadcrumb Navigation
 * @COUPLED docs/PM2-PRODUCTION.md「后续生产版本更新与回退」, scripts/lifecycle/pm2-manager.mjs,
 *          scripts/lifecycle/health.mjs, vendor/pi-web-ui/dist/server/control-socket.js
 * @CONTRACT 生产版本切换（PM2 → PM2，含「旧 systemd 入口退役」）：
 *   排空 → 停用旧 UI/wachdog → 原子替换 current → manager start → 验收 → unquiesce；
 *   失败则原子恢复旧 current 并重启 PM2；PM2 起不来时回退旧 unit 保证站点可用。
 * @GOTCHA 必须由**服务进程之外**的独立 cgroup 执行（例如 systemd-run --user --unit=…）：
 *         两个 unit 都是 KillMode=control-group，本脚本所在 cgroup 会连带被杀。
 * @GOTCHA 旧 unit 是 enabled + WantedBy=default.target：只要它还是 enabled，任何
 *         daemon-reload 都会把它拉起来抢 8788（本次事故的直接原因），必须 disable。
 * @SECURITY 只读 runtime.json 的路径/端口；不读取、不复制任何凭据。
 * @CONTRACT 路径来自 PI_DEV_DEPLOY_ROOT / PI_DEV_CONFIG_DIR / PI_DEV_DEV_ROOT，缺省值与历史行为一致。
 * 用法：node scripts/maintenance/switch-production-release.mjs <newReleaseId(12hex)>
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HOME = process.env.HOME;
const DEV_ROOT = process.env.PI_DEV_DEV_ROOT ?? "/home/dev/PI-dev";
// deploy 根目录可迁移；写死会让切换静默作用在旧路径上（current 更新了但服务仍跑旧目录）。
const BASE = process.env.PI_DEV_DEPLOY_ROOT ?? join(HOME, ".local/share/pi-dev/deploy");
const CONFIG_FILE = process.env.PI_DEV_CONFIG_DIR
	? join(process.env.PI_DEV_CONFIG_DIR, "runtime.json")
	: join(HOME, ".config/pi-dev/runtime.json");
const STATUS_FILE = join(BASE, "shared/maintenance/switch-status.json");
const ORIGIN = "https://dev.ftai.cc";
const LEGACY = "pi-web-ui-dev.service";
const WATCHDOGS = ["pi-web-ui-dev-watchdog.timer", "pi-web-ui-dev-watchdog.service"];
const PM2_UNIT = "pi-dev-pm2.service";

const NEW_ID = process.argv[2];
if (!NEW_ID || !/^[a-f0-9]{12}$/.test(NEW_ID)) throw new Error("Usage: switch-production-release.mjs <releaseId(12hex)>");
const WAIT_MIN = Number(process.env.SWITCH_WAIT_MINUTES ?? 45);

const log = (...a) => console.log(new Date().toISOString(), "switch:", ...a);
const phase = (name, extra = {}) => {
	try {
		mkdirSync(join(BASE, "shared/maintenance"), { recursive: true });
		writeFileSync(STATUS_FILE, JSON.stringify({ phase: name, at: new Date().toISOString(), target: NEW_ID, ...extra }, null, 2) + "\n", { mode: 0o600 });
	} catch { /* 状态文件尽力而为 */ }
};
const systemctl = (args, allowFail = false) => {
	try {
		return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		if (allowFail) return "failed";
		throw new Error(`systemctl ${args[0]} ${args[1] ?? ""} failed`);
	}
};
const isActive = (unit) => systemctl(["is-active", unit], true) === "active";
const manager = (action) =>
	execFileSync(process.execPath, [join(DEV_ROOT, "scripts/pm2.mjs"), action], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

const { validateConfig } = await import(join(DEV_ROOT, "scripts/lib.mjs"));
const { waitForHealth } = await import(join(DEV_ROOT, "scripts/lifecycle/health.mjs"));
const config = validateConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
const { sendControlCommand } = await import(join(DEV_ROOT, "vendor/pi-web-ui/dist/server/control-socket.js"));
const control = (cmd) => sendControlCommand(config.dataDir, config.port, cmd);
/** 控制套接字属于「当前正在服务的进程」，切换前后都是同一个路径。 */
/** 控制套接字查询（带重试）：刚启动/刚重启的进程可能还没监听，不能一次失败就判定「无人在服务」。 */
const status = async (attempts = 10) => {
	for (let i = 0; i < attempts; i += 1) {
		const s = await control("status").catch(() => null);
		if (s?.ok) return s;
		await delay(500);
	}
	return null;
};

const currentLink = join(BASE, "current");
const OLD_ID = basename(execFileSync("readlink", ["-f", currentLink], { encoding: "utf8" }).trim());
const newPath = join(BASE, "releases", NEW_ID);
if (!existsSync(join(newPath, "release-source.json"))) throw new Error(`release ${NEW_ID} is missing release-source.json`);

async function activate(id) {
	const tmp = join(BASE, `.current-${randomBytes(8).toString("hex")}`);
	try {
		symlinkSync(join(BASE, "releases", id), tmp);
		renameSync(tmp, currentLink);
	} finally {
		if (existsSync(tmp)) unlinkSync(tmp);
	}
}

async function waitForNewProcess(oldPid, deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const s = await status();
		if (s?.ok && Number.isInteger(s.pid) && s.pid !== oldPid) return s;
		await delay(500);
	}
	throw new Error("the new process did not open its control socket");
}

async function verifyStrict(vendorRoot) {
	const [health, page] = await Promise.all([
		fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(10_000), redirect: "error" }),
		fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(10_000), redirect: "error" }),
	]);
	if (!health.ok || health.headers.has("set-cookie") || !page.ok) throw new Error("public ingress health failed");
	const html = await page.text();
	const entry = readFileSync(join(vendorRoot, "web/dist/index.html"), "utf8").match(/src="([^"]+\.js)"/)?.[1];
	if (!entry || !html.includes(entry)) throw new Error("public ingress is not serving this release's frontend");
	const { createRequire } = await import("node:module");
	const { WebSocket } = createRequire(join(vendorRoot, "package.json"))("ws");
	await new Promise((resolve, reject) => {
		const socket = new WebSocket(`${ORIGIN.replace(/^http/, "ws")}/ws`);
		const timer = setTimeout(() => { socket.terminate(); reject(new Error("WS probe timed out")); }, 8_000);
		socket.once("unexpected-response", (req, res) => { clearTimeout(timer); req.destroy(); res.statusCode === 401 ? resolve() : reject(new Error(`unexpected WS status ${res.statusCode}`)); });
		socket.once("open", () => { clearTimeout(timer); socket.close(); reject(new Error("anonymous WebSocket accepted")); });
		socket.once("error", () => { clearTimeout(timer); reject(new Error("WS probe failed")); });
	});
	return entry;
}

let quiesced = false;
let touchedManagers = false;
try {
	const initial = await status();
	// 控制套接字不可用时的显式逃生阀：只有在操作人明确接受「不排空、直接重启」时才继续。
	// 典型场景：旧进程持有的套接字文件被别的实例覆盖（ECONNREFUSED），需要一次重启来自愈。
	const allowNoSocket = process.env.SWITCH_ALLOW_NO_SOCKET === "1";
	if (!initial?.ok) {
		if (!allowNoSocket) {
			throw new Error(
				"no control socket: nothing is serving the instance. " +
					"若确认这是「套接字陈旧（文件在但连接被拒），服务本身健康」，可用 SWITCH_ALLOW_NO_SOCKET=1 重跑：跳过排空、直接重启（会中断运行中的对话）。",
			);
		}
		log("WARNING: control socket unavailable and SWITCH_ALLOW_NO_SOCKET=1 → skipping the drain step (running conversations will be interrupted)");
		phase("drain_skipped", { reason: "control socket unavailable" });
	}
	// 幂等：如果 current 已经指向目标版本、进程健康且 build-info 与 release-source 一致，
	// 说明这次升级已经完成过（例如维护任务被重复提交），直接成功返回 —— 不要再去停服务，
	// 更不要把已经成功的状态覆盖成 failed（2026-09-11 实际踩到过）。
	if (OLD_ID === NEW_ID) {
		const info = JSON.parse(readFileSync(join(newPath, "vendor/pi-web-ui/dist/build-info.json"), "utf8"));
		const source = JSON.parse(readFileSync(join(newPath, "release-source.json"), "utf8"));
		if (info.commit === source.commit) {
			log(`already deployed: current=${NEW_ID} pid=${initial.pid} commit=${info.commit.slice(0, 12)} (no action taken)`);
			phase("already_deployed", { pid: initial.pid, commit: info.commit });
			process.exitCode = 0;
		} else {
			log(`current already points at ${NEW_ID} but provenance differs; continuing with a normal switch`);
		}
	}
	log(initial?.ok ? `serving pid=${initial.pid} quiesced=${initial.quiesced} active=${initial.activeConversations} pending=${initial.pendingMessages}` : "serving instance did not answer the control socket");
	log(`current=${OLD_ID} → target=${NEW_ID}`);
	phase("quiesce");
	if (initial?.ok && !(await control("quiesce"))?.ok) throw new Error("quiesce failed");
	quiesced = Boolean(initial?.ok);
	const deadline = Date.now() + WAIT_MIN * 60_000;
	for (; quiesced; ) {
		const s = await status();
		if (!s?.ok) throw new Error("instance became unavailable while draining");
		if (s.activeConversations === 0 && s.pendingMessages === 0) break;
		// （循环条件见上：quiesced=false 时直接跳过排空）
		if (Date.now() > deadline) throw new Error(`active work did not drain within ${WAIT_MIN} minutes`);
		await delay(2_000);
	}
	log("drained (active=0 pending=0)");
	phase("drained", { from: OLD_ID });

	// 退役旧入口：先停，再 disable（否则任何 daemon-reload 都会把它拉回来）。
	log(`retiring legacy manager: ${LEGACY} + watchdog`);
	systemctl(["stop", ...WATCHDOGS], true);
	for (const unit of WATCHDOGS) if (systemctl(["is-enabled", unit], true) === "enabled") systemctl(["disable", unit], true);
	if (isActive(LEGACY)) systemctl(["stop", LEGACY]);
	if (systemctl(["is-enabled", LEGACY], true) === "enabled") systemctl(["disable", LEGACY]);
	touchedManagers = true;
	if (isActive(LEGACY)) throw new Error("legacy unit is still active");

	// PM2 → PM2 升级必须先停止当前单元再换链接：单元已 active 时 `manager start` 是空操作，
	// 旧进程会继续用旧代码服务，切换看似成功实则没生效（2026-09-10 实际踩到）。
	log(`stopping ${PM2_UNIT} before the release swap`);
	if (isActive(PM2_UNIT)) systemctl(["stop", PM2_UNIT]);
	if (isActive(PM2_UNIT)) throw new Error(`${PM2_UNIT} did not stop before the release swap`);

	log(`switching current → ${NEW_ID}`);
	phase("switching", { from: OLD_ID });
	await activate(NEW_ID);
	log("starting PM2 manager");
	manager("start");
	if (!isActive(PM2_UNIT)) throw new Error("PM2 unit did not become active");

	const s2 = await waitForNewProcess(initial?.pid ?? 0, 60_000);
	await waitForHealth({ ...config, workspaceDir: config.workspaceDir ?? config.root }, { pid: s2.pid, timeout: 30_000 });
	const info = JSON.parse(readFileSync(join(newPath, "vendor/pi-web-ui/dist/build-info.json"), "utf8"));
	if (info.commit !== JSON.parse(readFileSync(join(newPath, "release-source.json"), "utf8")).commit) throw new Error("release provenance mismatch");
	const entry = await verifyStrict(join(newPath, "vendor/pi-web-ui"));
	await control("unquiesce");
	quiesced = false;
	log(`DEPLOYED ${OLD_ID} → ${NEW_ID} pid=${s2.pid} commit=${info.commit.slice(0, 12)} protocol=${info.protocolVersion} entry=${entry}`);
	phase("deployed", { pid: s2.pid, commit: info.commit, protocolVersion: info.protocolVersion, from: OLD_ID });
} catch (error) {
	log(`FAILED: ${error.message}`);
	phase("failed", { error: String(error.message).slice(0, 300) });
	if (touchedManagers) {
		log(`rolling back to ${OLD_ID}`);
		try {
			if (isActive(PM2_UNIT)) systemctl(["stop", PM2_UNIT], true);
			await activate(OLD_ID);
			try {
				manager("start");
				const back = await waitForNewProcess(0, 60_000);
				await waitForHealth({ ...config, workspaceDir: config.workspaceDir ?? config.root }, { pid: back.pid, timeout: 30_000 });
				log(`ROLLED BACK to ${OLD_ID} pid=${back.pid} (PM2)`);
				phase("rolled_back", { to: OLD_ID, pid: back.pid, manager: "pm2" });
			} catch (pm2Error) {
				// PM2 起不来时用旧 unit 兜底，保证站点可用（并保持 enabled 以免再次丢失）。
				log(`PM2 start failed (${pm2Error.message}); falling back to the legacy unit`);
				systemctl(["enable", LEGACY], true);
				systemctl(["start", LEGACY]);
				log(`ROLLED BACK to ${OLD_ID} via legacy unit`);
				phase("rolled_back", { to: OLD_ID, manager: "legacy", error: String(pm2Error.message).slice(0, 200) });
			}
			if (quiesced) { await control("unquiesce").catch(() => {}); quiesced = false; }
		} catch (recovery) {
			log(`RECOVERY FAILED (manual intervention required): ${recovery.message}`);
			phase("recovery_failed", { error: String(recovery.message).slice(0, 300) });
		}
	} else if (quiesced) {
		await control("unquiesce").catch(() => {});
		log("aborted before touching managers; instance resumed");
		phase("aborted");
	}
	process.exitCode = 1;
} finally {
	log(`current → ${execFileSync("readlink", ["-f", currentLink], { encoding: "utf8" }).trim()}`);
	log(`units: ${PM2_UNIT}=${systemctl(["is-active", PM2_UNIT], true)} ${LEGACY}=${systemctl(["is-active", LEGACY], true)} (legacy enabled=${systemctl(["is-enabled", LEGACY], true)})`);
}
