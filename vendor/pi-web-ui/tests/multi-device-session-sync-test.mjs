// 多端会话同步回归（两个 clientId 模拟「手机端 / PC 端」连同一台服务器）：
//
//   层面 1 — 会话列表实时同步：A 端新建并落盘的会话，B 端列表要收到推送。
//   层面 2 — 单会话节点级接力：A 端完成一轮后，B 端（开着同一会话、未发指令）
//            要从磁盘重载，看到 A 端刚完成的那一轮内容。
//
// Usage: npm run build && node tests/multi-device-session-sync-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8961);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-multi-device-sync-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

/** 极简 OpenAI 兼容 mock：把用户提示回显成 "reply:<prompt>"，用于跑真实的一轮。 */
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const last = payload.messages?.at(-1);
	const prompt =
		typeof last?.content === "string"
			? last.content
			: (last?.content
					?.filter?.((part) => part.type === "text")
					.map((part) => part.text)
					.join(" ") ?? "");
	const reply = `reply:${prompt}`;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(
		`data: ${JSON.stringify({
			id: "multi-device-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
		})}\n\n`,
	);
	res.write(
		`data: ${JSON.stringify({
			id: "multi-device-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "multi-device-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "multi-device-test",
				models: [
					{
						id: "multi-device-mock",
						name: "Multi Device Mock",
						input: ["text"],
						contextWindow: 32000,
						maxTokens: 4096,
					},
				],
			},
		},
	}),
);

const repoRoot = realpathSync(new URL("../", import.meta.url));
// 关键：不设 PI_CODING_AGENT_SESSION_DIR（生产配置修复后的状态）——否则历史
// 列表会因为 SDK 只扫根目录顶层而恒为空，两层同步都无从谈起。
const serverEnv = {
	...process.env,
	PI_WEB_PORT: String(PORT),
	PI_WEB_DATA_DIR: dataDir,
	PI_WEB_CWD: workdir,
	PI_CODING_AGENT_DIR: agentDir,
};
delete serverEnv.PI_CODING_AGENT_SESSION_DIR;
// 隔离实例不需要访问口令（继承的 PI_WEB_TOKEN 会让 WS 升级要求鉴权）。
delete serverEnv.PI_WEB_TOKEN;
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: serverEnv,
	stdio: ["ignore", "ignore", "inherit"],
	windowsHide: true,
});

const waitForPort = async (port, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.sessions = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				this.messages = message.state.messages ?? [];
			} else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.messages = [...this.messages, ...message.appended];
			} else if (message.type === "sessions") {
				this.sessions = message.sessions;
			} else if (message.type === "notice") {
				console.log(`  [notice] ${message.text}`);
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const message = this.received[i];
				if (message.type !== type || !predicate(message)) continue;
				this.received.splice(i, 1);
				return message;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	async waitForMessage(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const message = this.messages.find(predicate);
			if (message) return message;
			await sleep(50);
		}
		throw new Error(
			`timeout waiting for message; conv=${this.state?.conversationId} roles=${this.messages.map((m) => m.role).join(",")}`,
		);
	}
	/** 等待收到一条满足条件的 sessions 推送（列表同步）。 */
	async waitForSessions(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.sessions.length > 0 && predicate(this.sessions)) return this.sessions;
			await sleep(50);
		}
		throw new Error("timeout waiting for sessions push");
	}
}

async function connect(clientId) {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const client = new Client(ws);
	client.send({ type: "hello", clientId });
	await client.waitForType("ready");
	await client.waitForState((state) => Boolean(state.conversationId));
	return client;
}

let a;
let b;
try {
	await waitForPort(PORT);

	// ---- PC 端：先落一场会话 ----
	a = await connect("device-pc-aaaa");
	a.send({ type: "set_model", modelId: "main/multi-device-mock" });
	await a.waitForState((state) => state.model?.id === "multi-device-mock");
	a.send({ type: "prompt", text: "seed" });
	await a.waitForMessage((message) => message.role === "assistant");
	const file = a.state.sessionFile;
	if (!file) throw new Error("seed session was not persisted");
	console.log("✓ PC 端完成第一轮并落盘:", file.split("/").pop());

	// ---- 手机端：接入，应自动 resume 到同一场会话 ----
	b = await connect("device-phone-bbbb");
	b.send({ type: "list_sessions" });
	await b.waitForSessions((sessions) => sessions.some((session) => session.path === file));
	if (b.state.sessionFile !== file) {
		throw new Error(`phone did not resume the same session: ${b.state.sessionFile}`);
	}
	console.log("✓ 手机端接入即 resume 到同一场会话，历史列表可见");

	// ---- 层面 2：PC 端完成一轮 → 手机端（未发指令）自动接力刷新 ----
	a.send({ type: "prompt", text: "second" });
	await a.waitForMessage(
		(message) => message.role === "assistant" && JSON.stringify(message.content).includes("reply:second"),
	);
	const phoneReloaded = await b.waitForMessage(
		(message) => message.role === "assistant" && JSON.stringify(message.content).includes("reply:second"),
	);
	if (!phoneReloaded) throw new Error("phone did not reload");
	console.log("✓ 层面 2：PC 端节点完成后，手机端未发指令即从磁盘接力到最新");

	// ---- 重连追平：离开期间另一端完成工作，回到页面（clientId 未变）也要追上 ----
	b.ws.close();
	await sleep(400);
	a.send({ type: "prompt", text: "third" });
	await a.waitForMessage(
		(message) => message.role === "assistant" && JSON.stringify(message.content).includes("reply:third"),
	);
	b = await connect("device-phone-bbbb"); // 同一 clientId 重连（页面刷新/切后台回来）
	await b.waitForMessage(
		(message) => message.role === "assistant" && JSON.stringify(message.content).includes("reply:third"),
	);
	console.log("✓ 重连追平：离开期间 PC 完成的一轮，手机端回到页面即追上");

	// ---- 层面 1：PC 端新建会话 → 手机端列表收到推送 ----
	a.send({ type: "new_chat" });
	const prevConversation = a.state.conversationId;
	await a.waitForState((state) => state.conversationId !== prevConversation);
	a.send({ type: "prompt", text: "fourth" });
	await a.waitForMessage(
		(message) => message.role === "assistant" && JSON.stringify(message.content).includes("reply:fourth"),
	);
	const newFile = a.state.sessionFile;
	if (!newFile || newFile === file) throw new Error("new session was not persisted");
	await b.waitForSessions((sessions) => sessions.some((session) => session.path === newFile));
	console.log("✓ 层面 1：PC 端新建的会话，手机端列表收到推送（无需刷新页面）");
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	a?.ws.close();
	b?.ws.close();
	server.kill();
	mock.close();
}
