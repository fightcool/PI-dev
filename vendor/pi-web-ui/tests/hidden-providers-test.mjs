// hidden_providers — built-in provider deletion (hide) round-trip (zero token).
//
// 「管理模型」里删除内置服务商 = 把它记进 settings.hiddenBuiltinProviders（纯 UI 偏好：
// 内置服务商来自 pi 运行时注册表，删不掉，只是不再展示），并清掉已保存的密钥。
// 本测试只覆盖协议/持久化这一半（UI 那一半由浏览器用例覆盖）。断言：
//   1. settings_state 默认下发空的 hiddenBuiltinProviders
//   2. set_settings 写入后立即回推新集合
//   3. 隐藏不影响运行时注册表（providers_status 里该服务商仍在）
//   4. 落盘到 <dataDir>/client-state.json（全局共享键 __settings__）
//   5. 存/应用预设不会把隐藏集合弹回来（预设只带提示词类字段）
//   6. 重连后仍在（跨会话持久化）；清空后归零
//
// Usage: npm run build && node tests/hidden-providers-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8978);
const base = mkdtempSync(join(tmpdir(), "pi-web-hiddenprov-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });
// 内置服务商列表要求 pi 运行时能起来：给一个最小的本地自定义服务商（不联网）。
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "k" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "k", models: [{ id: "m1" }] },
		},
	}),
);

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", "ignore"],
	windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** 等一条满足条件的消息（predicate 缺省 = 只按 type 匹配）。 */
	async waitFor(type, timeout = 20000, predicate = null) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type === type && (!predicate || predicate(m))) {
					this.received.splice(i, 1);
					return m;
				}
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	/** 最新一条 settings_state 的隐藏集合（没有则 null）。 */
	lastHidden() {
		let v = null;
		for (const m of this.received) {
			if (m.type === "settings_state") v = m.settings.hiddenBuiltinProviders;
		}
		return v;
	}
	async waitHidden(list, timeout = 20000) {
		const want = JSON.stringify([...list].sort());
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const cur = this.lastHidden();
			if (cur && JSON.stringify([...cur].sort()) === want) return cur;
			await sleep(50);
		}
		throw new Error(`timeout waiting for hiddenBuiltinProviders=${want}`);
	}
}

async function connect() {
	for (let i = 0; i < 80; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

const statePath = join(dataDir, "client-state.json");
const readState = () => {
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return {};
	}
};

let clean = false;
function cleanup() {
	if (clean) return;
	clean = true;
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {
		/* gone */
	}
}
process.on("exit", cleanup);

const HIDDEN = ["anthropic", "openai"];

try {
	const c = await connect();
	c.send({ type: "hello", clientId: "hidden-providers-test" });
	await c.waitFor("ready", 30000);
	const st0 = await c.waitFor("settings_state", 30000);
	check(
		"settings_state ships an empty hidden list by default",
		Array.isArray(st0.settings.hiddenBuiltinProviders) && st0.settings.hiddenBuiltinProviders.length === 0,
		JSON.stringify(st0.settings.hiddenBuiltinProviders),
	);

	// 隐藏两个内置服务商
	c.send({ type: "set_settings", hiddenBuiltinProviders: HIDDEN });
	const st1 = await c.waitFor(
		"settings_state",
		15000,
		(m) => Array.isArray(m.settings.hiddenBuiltinProviders) && m.settings.hiddenBuiltinProviders.includes("anthropic"),
	);
	check(
		"set_settings persists + pushes the hidden set",
		[...st1.settings.hiddenBuiltinProviders].sort().join(",") === [...HIDDEN].sort().join(","),
		JSON.stringify(st1.settings.hiddenBuiltinProviders),
	);

	// 隐藏只是 UI 展示偏好：运行时注册表不受影响
	c.send({ type: "list_providers" });
	const ps = await c.waitFor("providers_status", 30000);
	const ids = ps.providers.map((p) => p.id);
	check(
		"hidden provider still registered in the runtime",
		ids.includes("anthropic") && ids.includes("openai"),
		ids.length + " providers",
	);
	check("hidden set did not remove custom providers", ids.includes("main"));

	// 落盘（全局共享键 __settings__）
	const saved = readState().__settings__?.settings?.hiddenBuiltinProviders;
	check(
		"hidden set is persisted to client-state.json",
		Array.isArray(saved) && saved.includes("anthropic"),
		JSON.stringify(saved),
	);

	// 预设不含该字段：存/应用预设都不该把列表弹回来
	c.send({ type: "save_preset", name: "hidden-probe" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.presets.some((p) => p.name === "hidden-probe"));
	c.send({ type: "apply_preset", name: "hidden-probe" });
	await c.waitHidden(HIDDEN, 15000);
	check("applying a preset keeps the hidden set", true);
	const afterPreset = readState().__settings__?.settings?.hiddenBuiltinProviders;
	check(
		"preset round-trip re-persists the hidden set",
		Array.isArray(afterPreset) && afterPreset.includes("openai"),
		JSON.stringify(afterPreset),
	);

	// 重连后仍在（全局共享配置，不是会话态）
	c.ws.close();
	const c2 = await connect();
	c2.send({ type: "hello", clientId: "hidden-providers-test-2" });
	await c2.waitFor("ready", 30000);
	const st2 = await c2.waitFor("settings_state", 30000);
	check(
		"reconnect sees the same hidden set",
		[...(st2.settings.hiddenBuiltinProviders ?? [])].sort().join(",") === [...HIDDEN].sort().join(","),
		JSON.stringify(st2.settings.hiddenBuiltinProviders),
	);

	// 恢复（清空）
	c2.send({ type: "set_settings", hiddenBuiltinProviders: [] });
	const st3 = await c2.waitFor(
		"settings_state",
		15000,
		(m) => Array.isArray(m.settings.hiddenBuiltinProviders) && m.settings.hiddenBuiltinProviders.length === 0,
	);
	check("restore clears the hidden set", st3.settings.hiddenBuiltinProviders.length === 0);

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	cleanup();
	await sleep(500);
	process.exit(failed === 0 ? 0 : 1);
}
