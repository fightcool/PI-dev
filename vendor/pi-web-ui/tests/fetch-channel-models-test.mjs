/* 🍞 AI Breadcrumb — @COUPLED server/model-admin.ts（fetchChannelModels：服务端解析 baseUrl/密钥后探测）,
 * server/protocol.ts（fetch_channel_models / channel_models_result）, web/src/components/ChannelForm.tsx
 * @CONTRACT 密钥只在服务端解析：请求帧里只有 providerId + keyName，回执里没有密钥正文。
 * 📖 docs/DEV-CON-PROPOSAL.md §4（凭据按名称引用） */
// fetch_channel_models — 渠道表单「获取接口清单」的协议测试（零 token）。
//
// 渠道白名单此前只能用「模型目录里已有的 id」；用户想按渠道 baseUrl 拉一份真实清单时，
// 浏览器既拿不到密钥（设计如此）也过不了 CORS，所以这一步必须走服务端。本用例验证：
//   1. 用服务商的 baseUrl 探测 /models，回执带 id/名称 + 实际探测的 baseUrl
//   2. 凭据在服务端解析：命名凭据 → 其密钥值作为 Authorization 头发给端点
//   3. 未指定凭据 = 「跟随服务商当前密钥」：命中 active 命名密钥
//   4. 指定了不存在的凭据名 → 明确报错，且不发任何网络请求
//   5. 没有 baseUrl 的服务商 → 明确报错（不是空列表）
//   6. 回执带 providerId，前端可丢弃「换服务商后才回来的」过期结果
//
// Usage: npm run build && node tests/fetch-channel-models-test.mjs [port]
import WebSocket from "ws";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8979);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-chanmodels-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

/** /models 的请求记录 + 固定返回（含一个重复 id 用于去重口径）。 */
const seen = [];
const mock = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	const send = (code, body) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(typeof body === "string" ? body : JSON.stringify(body));
	};
	if (url.pathname === "/models") {
		seen.push({ path: url.pathname, auth: req.headers.authorization ?? null });
		return send(200, {
			data: [
				{ id: "cc1q/gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
				{ id: "cc1q/gpt-6-astra" },
				{ id: "cc1q/gpt-5.6-sol" },
			],
		});
	}
	// 无 baseUrl 的服务商走不到这里；其它路径一律 404（触发 /v1 回退后仍失败）。
	send(404, { error: "no route" });
});
await new Promise((res) => mock.listen(MOCK_PORT, "127.0.0.1", res));
console.log(`mock /models on :${MOCK_PORT}`);

// 一个带 baseUrl 的自定义服务商（cc1q）+ 一把命名密钥；另一个故意不给 baseUrl。
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ cc1q: { type: "api_key", key: "inline-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			cc1q: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "inline-key",
				models: [{ id: "cc1q/gpt-5.6-sol" }],
			},
			nobase: { api: "openai-completions", models: [{ id: "x" }] },
		},
	}),
);
writeFileSync(
	join(agentDir, "provider-keys.json"),
	JSON.stringify({ cc1q: { activeKeyName: "主密钥", keys: [{ name: "主密钥", apiKey: "named-key-A" }] } }),
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

let clean = false;
function cleanup() {
	if (clean) return;
	clean = true;
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {
		/* gone */
	}
	try {
		mock.close();
	} catch {
		/* gone */
	}
}
process.on("exit", cleanup);

try {
	const c = await connect();
	c.send({ type: "hello", clientId: "fetch-channel-models-test" });
	await c.waitFor("ready", 30000);

	// 1) 跟随当前密钥（= active 命名密钥）
	seen.length = 0;
	c.send({ type: "fetch_channel_models", reqId: 1, providerId: "cc1q" });
	const r1 = await c.waitFor("channel_models_result", 30000, (m) => m.reqId === 1);
	check("probe succeeds against the provider baseUrl", r1.ok === true, r1.error ?? "");
	check(
		"returns the endpoint's models (deduped by id)",
		Array.isArray(r1.models) && r1.models.length === 2 && r1.models.every((m) => m.id.startsWith("cc1q/")),
		JSON.stringify(r1.models?.map((m) => m.id)),
	);
	check("echoes the probed baseUrl", r1.baseUrl === `http://127.0.0.1:${MOCK_PORT}`, r1.baseUrl);
	check("echoes providerId (stale results can be dropped)", r1.providerId === "cc1q", r1.providerId);
	check(
		"no key material in the reply",
		!JSON.stringify(r1).includes("named-key-A") && !JSON.stringify(r1).includes("inline-key"),
	);
	check(
		"the ACTIVE named key authenticates the probe",
		seen.length === 1 && seen[0].auth === "Bearer named-key-A",
		JSON.stringify(seen),
	);

	// 2) 指定命名凭据（不存在）→ 明确报错且不发请求
	seen.length = 0;
	c.send({ type: "fetch_channel_models", reqId: 2, providerId: "cc1q", keyName: "没有这把" });
	const r2 = await c.waitFor("channel_models_result", 30000, (m) => m.reqId === 2);
	check(
		"unknown named credential fails loudly",
		r2.ok === false && /不存在|no longer exists/.test(r2.error ?? ""),
		r2.error,
	);
	check("a failed key lookup sends no request", seen.length === 0, JSON.stringify(seen));

	// 3) 没有 baseUrl 的服务商 → 明确报错（而不是空列表）
	c.send({ type: "fetch_channel_models", reqId: 3, providerId: "nobase" });
	const r3 = await c.waitFor("channel_models_result", 30000, (m) => m.reqId === 3);
	check(
		"a provider without baseUrl reports a clear error",
		r3.ok === false && /baseUrl/.test(r3.error ?? "") && (r3.models ?? []).length === 0,
		r3.error,
	);

	// 4) 空 providerId → 明确报错
	c.send({ type: "fetch_channel_models", reqId: 4, providerId: "   " });
	const r4 = await c.waitFor("channel_models_result", 30000, (m) => m.reqId === 4);
	check("an empty providerId is rejected", r4.ok === false, r4.error);

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	cleanup();
	await sleep(300);
	process.exit(failed === 0 ? 0 : 1);
}
