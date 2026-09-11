/**
 * Server-side session-loading probe: cold attach and session switch.
 *
 * Starts an ISOLATED instance from TS source (no build, no live config):
 *   - own agent dir (synthetic sessions only), own data dir, own workspace, free port
 *   - PI_WEB_TIMING=1 so `server/timing.ts` prints one `[timing] …` line per path
 *
 * Then, as a browser would: hello → first snapshot, list_sessions → switch_session
 * to the large fixture → snapshot. Reports wall-clock deltas and the server's own
 * phase breakdown side by side.
 *
 * Usage:
 *   node tests/performance/server-timing.mjs
 *   SMALL=200 BIG=1460 BENCH_ITERATIONS=3 node tests/performance/server-timing.mjs
 *
 * 🍞 @COUPLED tests/performance/README.md, session-fixture.mjs, server/timing.ts
 * @WHY 客户端 harness 用模拟 WS，量不到服务端；这条探针补上 attach/切换的服务端分段。
 * @GOTCHA 全程使用临时目录，绝不读取或写入真实 agent 目录与线上实例。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import { portUp } from "../../vendor/pi-web-ui/tests/lib/port-utils.mjs";
import { writeSyntheticSession } from "./session-fixture.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_ROOT = join(REPO_ROOT, "vendor", "pi-web-ui");
const require = createRequire(join(APP_ROOT, "package.json"));

const SMALL_MESSAGES = Number(process.env.SMALL ?? 200);
const BIG_MESSAGES = Number(process.env.BIG ?? 1460);
const PORT = Number(process.env.PORT ?? 8899);
const HARD_TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000);

const guard = setTimeout(() => {
	console.error(`FAIL: 整体超时 ${HARD_TIMEOUT_MS}ms`);
	process.exit(1);
}, HARD_TIMEOUT_MS);
guard.unref();

const root = mkdtempSync(join(tmpdir(), "pi-perf-server-"));
const agentDir = join(root, "agent");
const dataDir = join(root, "data");
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
// Write the BIG fixture first: attach() resumes the most recently modified
// session, so the small one stays in memory and switching to big is a real
// disk switch (the path this probe exists to measure).
const big = writeSyntheticSession({ agentDir, cwd: workspace, messages: BIG_MESSAGES, id: "big" });
const small = writeSyntheticSession({ agentDir, cwd: workspace, messages: SMALL_MESSAGES, id: "small" });

/** A full snapshot carries the whole array; a delta carries only the appended tail. */
function messageCountOf(msg) {
	if (Array.isArray(msg.state?.messages)) return msg.state.messages.length;
	if (Array.isArray(msg.appended)) return `+${msg.appended.length}`;
	return "?";
}

const timingLines = [];
const server = spawn(process.execPath, ["--import", require.resolve("tsx"), "server/index.ts"], {
	cwd: APP_ROOT,
	env: {
		...process.env,
		NODE_ENV: "development",
		PI_WEB_TIMING: "1",
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workspace,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		// No token: the probe is loopback-only and refuses nothing.
		PI_WEB_TOKEN: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
for (const stream of [server.stdout, server.stderr]) {
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		serverOutput += chunk;
		for (const line of chunk.split("\n")) if (line.includes("[timing]")) timingLines.push(line.trim());
	});
}

const clientId = `perf-server-${Date.now().toString(36)}`;
let ws;
const waiters = new Map();

function send(msg) {
	ws.send(JSON.stringify(msg));
}
function waitFor(type, timeoutMs = 60_000) {
	return waitForAny([type], timeoutMs);
}

/** Resolve on the first message of any listed type; one waiter, removed on settle. */
function waitForAny(types, timeoutMs = 60_000) {
	return new Promise((resolve, reject) => {
		const consume = (msg) => {
			clearTimeout(timer);
			for (const t of types) {
				const list = waiters.get(t);
				if (list) waiters.set(
					t,
					list.filter((fn) => fn !== consume),
				);
			}
			resolve(msg);
		};
		const timer = setTimeout(() => {
			for (const t of types) {
				const list = waiters.get(t);
				if (list) waiters.set(
					t,
					list.filter((fn) => fn !== consume),
				);
			}
			reject(new Error(`等待 ${types.join("/")} 超时`));
		}, timeoutMs);
		for (const t of types) waiters.set(t, [...(waiters.get(t) ?? []), consume]);
	});
}
/** A switch/tick answer may be a full snapshot or an incremental checkpoint. */
function waitForSnapshot() {
	return waitForAny(["snapshot", "snapshot_delta"]);
}
function nextTiming() {
	// The probe can outrun the child's stdout flush; poll briefly.
	const deadline = Date.now() + 5000;
	return (async () => {
		while (Date.now() < deadline) {
			if (timingLines.length > 0) return timingLines.shift();
			await sleep(50);
		}
		return "(no [timing] line)";
	})();
}

const rows = [];
function record(name, ms, serverLine) {
	rows.push({ name, ms, serverLine });
	console.log(`\n▸ ${name}: ${Math.round(ms)}ms`);
	console.log(`  server: ${serverLine}`);
}

const cleanup = () => {
	try {
		ws?.close();
	} catch {
		/* already closed */
	}
	server.kill("SIGTERM");
	rmSync(root, { recursive: true, force: true });
};

try {
	for (let i = 0; i < 80 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error(`服务未在 ${PORT} 起监听\n${serverOutput.slice(-2000)}`);

	// ---- 1) cold attach: hello → first snapshot ----
	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		// Startup notices/errors explain an attach that never reaches a snapshot.
		if (msg.type === "notice" || msg.type === "error") console.log(`  [server ${msg.type}] ${msg.text ?? ""}`);
		for (const fn of waiters.get(msg.type) ?? []) fn(msg);
	});
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});

	const tAttach = performance.now();
	send({ type: "hello", clientId });
	await waitFor("snapshot");
	record("cold attach → 首份 snapshot", performance.now() - tAttach, await nextTiming());

	// ---- 2) switch to the large persisted session ----
	send({ type: "list_sessions" });
	const sessions = await waitFor("sessions");
	const target = sessions.sessions.find((s) => s.path === big) ?? sessions.sessions[0];
	if (!target) throw new Error("会话列表为空，fixture 未被识别");

	const tSwitch = performance.now();
	send({ type: "switch_session", path: target.path });
	const switched = await waitForSnapshot();
	record(
		`switch_session → snapshot（${switched.state.messages.length} 条消息）`,
		performance.now() - tSwitch,
		await nextTiming(),
	);

	// ---- 3) switch back to the small session (runtime reuse path) ----
	const smallTarget = sessions.sessions.find((s) => s.path === small);
	if (smallTarget) {
		const tBack = performance.now();
		send({ type: "switch_session", path: smallTarget.path });
		await waitForSnapshot();
		record("switch_session 回小会话", performance.now() - tBack, await nextTiming());
	}

	// ---- 4) no-op switch (already active) must still answer with a snapshot ----
	const tNoop = performance.now();
	send({ type: "switch_session", path: smallTarget?.path ?? big });
	await waitForSnapshot();
	record("switch_session 重复目标（no-op）", performance.now() - tNoop, await nextTiming());

	// ---- 5) project list scan is cached (the first call is what EVERY call used to cost) ----
	const firstProjects = performance.now();
	send({ type: "list_projects" });
	await waitFor("projects");
	const firstMs = performance.now() - firstProjects;
	const secondProjects = performance.now();
	send({ type: "list_projects" });
	await waitFor("projects");
	record(
		"list_projects 首次（改前每次都是这个成本）",
		firstMs,
		`同一会话内二次 = ${Math.round(performance.now() - secondProjects)}ms`,
	);

	console.log("\n── 汇总 ──");
	for (const row of rows) console.log(`${String(Math.round(row.ms)).padStart(7)}ms  ${row.name}`);
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	console.error(serverOutput.slice(-2000));
	cleanup();
	process.exit(1);
}
cleanup();
process.exit(0);
