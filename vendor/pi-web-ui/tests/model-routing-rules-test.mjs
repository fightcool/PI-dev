/* 🍞 AI Breadcrumb — @COUPLED server/model-routing.ts（规则归一化/过滤）,
 * server/settings-service.ts（set/push + modelRoutingCustomized）, server/agent-service.ts（listModels 过滤）,
 * server/client-state.ts（三态持久化：缺省=出厂默认、[]=不隐藏、null=清除自定义）,
 * web/src/components/SettingsModal.tsx（「模型路由规则」面板入口）
 * @CONTRACT 密钥/模型定义不在这里：本用例只管「哪些路由不出现在选择器里」这条可配置规则。
 * 📖 docs/MODEL-ROUTING.md */
// 模型路由规则可配置（协议级，零 token）：
//   1. 未设置时 = 出厂默认（deepseek 三个退役路由），modelRoutingCustomized=false
//   2. 自定义后立即生效：list_models 不再返回被规则判为退役的模型（同一服务商其余模型不受影响）
//   3. 裸 id 匹配所有服务商；provider/id 只匹配该服务商
//   4. null = 清除自定义 → 回到出厂默认（不是「空规则」）
//   5. 落盘持久化 + 重连后仍在（全局共享配置）
//
// Usage: npm run build && node tests/model-routing-rules-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8981);
const base = mkdtempSync(join(tmpdir(), "pi-web-routing-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

// 两个自定义服务商，各带「保留」与「退役」两个模型（不需要任何真实网络）。
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ p1: { type: "api_key", key: "k1" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			p1: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "k1",
				models: [{ id: "m-keep" }, { id: "m-retired" }],
			},
			p2: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:2",
				apiKey: "k2",
				models: [{ id: "m-keep" }, { id: "m-retired" }],
			},
		},
	}),
);

const server = spawn(realpathSync(process.execPath), ["dist/server/index.js"], {
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
process.on("exit", () => {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
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
	async waitFor(type, timeout = 25000, predicate = null) {
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
	/** 最新一个 models 帧里的 "provider/id" 列表。 */
	lastModelIds() {
		let ids = null;
		for (const m of this.received) if (m.type === "models") ids = m.models.map((x) => x.id);
		return ids;
	}
	async waitModelIds(predicate, timeout = 25000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			this.send({ type: "list_models" });
			await sleep(400);
			const ids = this.lastModelIds();
			if (ids && predicate(ids)) return ids;
		}
		throw new Error("timeout waiting for the filtered model list");
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
const readStoredRouting = () => {
	try {
		const s = JSON.parse(readFileSync(statePath, "utf8")).__settings__?.settings ?? {};
		return { retired: s.retiredModelRoutes, aliases: s.modelRouteAliases };
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

try {
	const c = await connect();
	c.send({ type: "hello", clientId: "model-routing-rules-test" });
	await c.waitFor("ready", 30000);
	const st0 = await c.waitFor("settings_state", 30000);
	check(
		"未设置时生效的是出厂默认（deepseek 三个退役路由）",
		Array.isArray(st0.settings.retiredModelRoutes) &&
			st0.settings.retiredModelRoutes.length === 3 &&
			st0.settings.retiredModelRoutes.includes("deepseek/deepseek-v4-pro"),
		JSON.stringify(st0.settings.retiredModelRoutes),
	);
	check("出厂默认下标记为「未自定义」", st0.settings.modelRoutingCustomized === false);
	check(
		"同时下发出厂默认（面板「恢复默认」用）",
		(st0.settings.defaultModelRouting?.retired ?? []).length === 3,
		JSON.stringify(st0.settings.defaultModelRouting),
	);
	check("未设置时磁盘上没有自定义字段（三态：缺省 = 出厂默认）", readStoredRouting().retired === undefined);

	// 两个服务商的两个模型默认都在选择器里
	const idsBefore = await c.waitModelIds((ids) => ids.includes("p1/m-retired") && ids.includes("p2/m-retired"));
	check("默认规则不影响自定义服务商的模型", idsBefore.length >= 4, JSON.stringify(idsBefore));

	// 自定义：provider/id 只隐藏 p1 的那一个
	c.send({ type: "set_settings", retiredModelRoutes: ["p1/m-retired"] });
	const st1 = await c.waitFor("settings_state", 15000, (m) => m.settings.modelRoutingCustomized === true);
	check("自定义后标记为「已自定义」", st1.settings.modelRoutingCustomized === true);
	const idsP1 = await c.waitModelIds((ids) => !ids.includes("p1/m-retired"));
	check("被规则命中的模型从选择器消失", !idsP1.includes("p1/m-retired"), JSON.stringify(idsP1));
	check("同一服务商的其他模型不受影响", idsP1.includes("p1/m-keep"), JSON.stringify(idsP1));
	check("provider/id 规则不误伤别的服务商", idsP1.includes("p2/m-retired"), JSON.stringify(idsP1));

	// 裸 id：两个服务商的同名模型一起隐藏
	c.send({ type: "set_settings", retiredModelRoutes: ["m-retired"] });
	const idsBare = await c.waitModelIds((ids) => !ids.includes("p2/m-retired"));
	check(
		"裸 id 匹配所有服务商",
		!idsBare.includes("p1/m-retired") && !idsBare.includes("p2/m-retired"),
		JSON.stringify(idsBare),
	);

	// 归一化：去重 / trim / 空行
	c.send({ type: "set_settings", retiredModelRoutes: ["  m-retired  ", "", "m-retired"] });
	const st2 = await c.waitFor("settings_state", 15000, (m) => m.settings.retiredModelRoutes.length === 1);
	check(
		"规则归一化：去空行/去重/trim",
		st2.settings.retiredModelRoutes[0] === "m-retired",
		JSON.stringify(st2.settings.retiredModelRoutes),
	);

	// 落盘 + 重连后仍在
	const stored = readStoredRouting();
	check("自定义规则落盘", Array.isArray(stored.retired) && stored.retired[0] === "m-retired", JSON.stringify(stored));

	// null = 清除自定义 → 回到出厂默认
	c.send({ type: "set_settings", retiredModelRoutes: null, modelRouteAliases: null });
	const st3 = await c.waitFor("settings_state", 15000, (m) => m.settings.modelRoutingCustomized === false);
	check(
		"null 清除自定义 → 生效值回到出厂默认",
		st3.settings.retiredModelRoutes.includes("deepseek/deepseek-v4-pro") &&
			st3.settings.retiredModelRoutes.length === 3,
		JSON.stringify(st3.settings.retiredModelRoutes),
	);
	check(
		"清除后磁盘上不再保留自定义字段",
		readStoredRouting().retired === undefined,
		JSON.stringify(readStoredRouting()),
	);
	const idsBack = await c.waitModelIds((ids) => ids.includes("p2/m-retired"));
	check("清除后模型重新出现在选择器里", idsBack.includes("p1/m-retired"), JSON.stringify(idsBack));

	c.ws.close();
	const c2 = await connect();
	c2.send({ type: "hello", clientId: "model-routing-rules-test-2" });
	await c2.waitFor("ready", 30000);
	const st4 = await c2.waitFor("settings_state", 30000);
	check(
		"重连后拿到同一套生效规则（全局共享）",
		st4.settings.modelRoutingCustomized === false && st4.settings.retiredModelRoutes.length === 3,
	);

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	cleanup();
	await sleep(300);
	process.exit(failed === 0 ? 0 : 1);
}
