#!/usr/bin/env node
/* 🍞 AI Breadcrumb — @COUPLED conversation-lifecycle-test.mjs, channel-isolation-test.mjs
 * 📖 ../docs/conversation-lifecycle.md, ../../docs/P0-VERIFICATION.md
 */
/**
 * run-smoke.mjs — 零 token 协议冒烟测试聚合跑器（本地与 CI 共用）。
 *
 * 顺序执行一组自起 server 的 *-test.mjs 脚本（各自独立端口 + 临时 data-dir，
 * 结束时自行清理）。任何一个失败不中断后续，最后汇总并以非零码退出。
 *
 * 不收录的脚本及原因：
 *   - 浏览器 E2E（playwright/chromium，路径写死本机）：*-browser*、scm-test、
 *     freeze、goal-pill/ui/rounds、panel/left/sound/settings-ui 等 → 本地手动跑；
 *   - 真模型 live：goal-review-loop、live-test（需已运行 server）、update-test。
 *
 * 用法：node tests/run-smoke.mjs [name1 name2 …]   # 无参 = 全量
 */
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Windows 本机已知失败（非逻辑问题，ubuntu CI 正常）：
//   - terminal-smoke-test：node-pty 在 ConPTY 下 shell 退出事件/控制台列表 agent
//     （AttachConsole failed）行为差异，导致退出检测类检查超时；
//   - restart-handoff-test：所有断言通过后 libuv 在命名管道关闭时触发
//     win\\async.c 断言崩溃（退出码 127），属 libuv 关闭时序问题。
const WIN32_KNOWN_ENV_FAIL = new Set(["terminal-smoke-test", "restart-handoff-test"]);

/** 子进程环境：清掉会改变隔离实例行为的鉴权/托管变量（不影响其它环境值）。 */
function smokeEnv() {
	const env = { ...process.env };
	for (const key of ["PI_WEB_TOKEN", "PI_WEB_MANAGED"]) delete env[key];
	return env;
}

const ALL = [
	"clear-provider-key-test",
	"channel-isolation-test",
	"channel-multiclient-test",
	"conv-cross-project-test",
	"conv-cwd-test",
	"conversation-lifecycle-test",
	"project-model-key-test",
	"provider-keys-test",
	"db-client-test",
	"dsh-smoke-test",
	"fetch-channel-models-test",
	"fetch-models-test",
	"global-search-test",
	"goal-prefs-test",
	"goal-test",
	"hidden-providers-test",
	"left-panel-delete-test",
	"list-files-missing-dir-test",
	"plugin-bgtask-test",
	"plugin-command-test",
	"plugin-cwd-test",
	"plugin-http-test",
	"mcp-bridge-test",
	"plugin-settings-test",
	"plugin-test",
	"plugin-update-test",
	"preview-test",
	"quiesce-test",
	"recursive-watch-test",
	"refresh-models-test",
	"restart-handoff-test",
	"scm-features-test",
	"settings-test",
	"slash-commands-test",
	"snapshot-delta-test",
	"ssh-plugin-test",
	"steer-queue-smoke",
	"subagent-template-test",
	"switch-session-background-test",
	"terminal-smoke-test",
	"token-auth-test",
	"vision-bridge-test",
	"vscode-editor-plugin-test",
];

// 不在默认清单里的脚本：
//   - 需外部已运行 server（attach 型，默认 8787）：ws-session-test /
//     file-upload-test / image-paste-test / commands-test(8791) /
//     edit-reask-test / projects-test —— 本地先起 server 再单独跑；
//   - 需真模型（本地可跑，CI 无凭据必败）：goal-abort-test /
//     goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test /
//     tool-status-test（需真模型执行 bash 工具，从仓库根或任意目录均可跑）；
//   - 平台相关：spawn-helper-test（macOS spawn-helper 二进制）；win32 下
//     terminal-smoke / restart-handoff 自动跳过（见 WIN32_KNOWN_ENV_FAIL）；
//   - title-jsonl-test：已修复（原 lsof/URL.pathname 的 Windows 兼容问题），本地可跑；
//   - 浏览器 E2E 见文件头注释（headless Chrome 路径写死本机）。

// 并发度：默认 3（4 vCPU 机器上实测最省时且不互相干扰）；SMOKE_JOBS / --jobs=N 可覆盖，
// 调试单个失败用例时用 --jobs=1 拿到干净的交错输出。
const args = process.argv.slice(2);
const jobsArg = args.find((a) => a.startsWith("--jobs="));
const JOBS = Math.max(1, Number(jobsArg ? jobsArg.slice(7) : process.env.SMOKE_JOBS ?? 3) || 3);
const targets = args.filter((a) => !a.startsWith("--jobs="));
const selected = targets.length > 0 ? targets : ALL;

// 必须独占运行的用例（其余按 JOBS 并发）：
//   - 刻意制造高负载/时序敏感的：会话生命周期（10 并发 run）、终端与重启交接（node-pty/libuv 时序）。
// 它们各自仍用自己的端口，串行只是为了不让负载影响判定。
const SERIAL = new Set(["conversation-lifecycle-test", "terminal-smoke-test", "restart-handoff-test"]);
const results = [];

/** 跑一个用例（返回 ok 与耗时）。 */
async function runOne(name) {
	if (process.platform === "win32" && WIN32_KNOWN_ENV_FAIL.has(name) && targets.length === 0) {
		console.log(`⏭ ${name} — Windows 环境已知噪音（node-pty/libuv），跳过；ubuntu CI 正常跑`);
		return { name, ok: true, skipped: true, ms: 0 };
	}
	const file = join(here, `${name}.mjs`);
	const started = Date.now();
	const logFile = join(here, "..", `.smoke-${name}.${process.pid}.log`);
	const stream = createWriteStream(logFile, { flags: "w" });
	const ok = await new Promise((resolveRun) => {
		const child = spawn(process.execPath, [file], {
			// 测试脚本内相对路径（如 dist/server/index.js）以仓库根为基准
			cwd: dirname(here),
			stdio: ["ignore", "pipe", "pipe"],
			// 鉴权环境必须隔离：若在线上实例的进程内跑测试（agent 自身继承了
			// PI_WEB_TOKEN/PI_WEB_MANAGED），子测试起的隔离服务会要求口令，匿名 WS 直接 401，
			// 表现为「与产品无关的假失败」。多数测试自己会清理，这里统一兜底。
			env: smokeEnv(),
		});
		// 并发运行时交错输出无法阅读：写入每个用例自己的日志，失败时再打印尾部。
		child.stdout.on("data", (d) => stream.write(d));
		child.stderr.on("data", (d) => stream.write(d));
		child.on("exit", (code) => resolveRun(code === 0));
		child.on("error", () => resolveRun(false));
	});
	await new Promise((r) => stream.end(r));
	const ms = Date.now() - started;
	console.log(`${ok ? "✓" : "✗"} ${name} ${(ms / 1000).toFixed(1)}s`);
	if (!ok) {
		console.log(`  --- ${name} 输出尾部 ---`);
		try {
			const tail = readFileSync(logFile, "utf8").trim().split("\n").slice(-15).join("\n");
			console.log(tail.split("\n").map((l) => `  ${l}`).join("\n"));
		} catch { /* 日志不可读就算了 */ }
	} else {
		try { rmSync(logFile, { force: true }); } catch { /* 尽力 */ }
	}
	return { name, ok, ms, logFile };
}

const startedAll = Date.now();
const parallel = selected.filter((n) => !SERIAL.has(n));
const serial = selected.filter((n) => SERIAL.has(n));
if (JOBS > 1 && parallel.length > 1) console.log(`并发 ${JOBS}（独占运行：${serial.join(", ") || "无"}）`);
let next = 0;
await Promise.all(
	Array.from({ length: Math.min(JOBS, parallel.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= parallel.length) return;
			results.push(await runOne(parallel[index]));
		}
	}),
);
for (const name of serial) results.push(await runOne(name));
const totalMs = Date.now() - startedAll;

console.log("\n===== 冒烟汇总 =====");
let failures = 0;
for (const r of results) {
	console.log(`${r.skipped ? "⏭" : r.ok ? "✓" : "✗"} ${r.name}${r.skipped ? "（跳过）" : ""}`);
	if (!r.ok) failures++;
}
const slowest = [...results].filter((r) => !r.skipped).sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(`\n总耗时 ${(totalMs / 1000).toFixed(1)}s（并发 ${JOBS}）；最慢 5 项：${slowest.map((r) => `${r.name} ${(r.ms / 1000).toFixed(1)}s`).join(" | ")}`);
console.log(`\n${results.length - failures}/${results.length} 通过`);
process.exit(failures ? 1 : 0);
