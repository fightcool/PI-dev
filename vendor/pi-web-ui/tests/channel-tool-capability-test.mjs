/*
 * 🍞 AI Breadcrumb — @COUPLED ../server/dev-con/endpoint-capability.ts（探测请求/判读）,
 *   ../server/agent-service.ts（ClientSession.checkChannelToolCapability → warnChannelLacksTools）,
 *   ../server/dev-con/channel-service.ts（channelDisplayName）
 * 📖 ../../docs/DEV-CON-PROPOSAL.md §5（切换场景）、§9（P0 技术项）
 *
 * DEV-CON 端到端证据（渠道静默丢 tools）：网关接受带 tools 的请求、返回 200，却把 tools 丢掉，
 * 模型于是声称「没有工具」——UI 上看不出任何错误，开发任务退化成纯对话。
 *
 * 用真实 dist server + 真实 SDK 请求路径 + 本地替身模型端点（离线、合成凭据）验证：
 *   1) 会丢 tools 的渠道（anthropic-messages 替身：200 + 纯文本答复，无 tool call）
 *      → 探测请求确实带上了 tools，客户端收到 level=warning 且文案含「不支持工具调用」的 notice；
 *   2) 对照组（openai-responses 替身：响应含 function_call）
 *      → 探测同样发生（证明断言非空转），但**不**产生该告警。
 *
 * @GOTCHA 探测是 fire-and-forget（getApiKey 内触发）：必须带超时地等 notice，不能固定 sleep 就断言；
 *   对照组必须先确认替身端点真的收到了探测请求，否则「没有告警」可能只是探测没跑。
 * @GOTCHA 替身旁路的 probe 与真实模型请求共用同一条 URL（anthropic: /v1/messages，
 *   responses: /responses），靠请求体里的 pi_capability_probe 标记区分。
 *
 * Usage: npm run build && node tests/channel-tool-capability-test.mjs [port]
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// 默认端口按 PID 派生：冒烟与手工 e2e 并行时不会互撞（同一脚本两份的 PID 必不相同）。
const PORT = Number(process.argv[2] || 9500 + (process.pid % 100) * 2);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-dev-channel-toolcap-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

const WARNING_TEXT = "不支持工具调用";
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** 记录每一次到达替身端点的请求，供「我们带了 tools / 对方丢了 tools」举证。 */
const requests = [];
const record = (path, body) => {
	const entry = {
		path,
		body,
		// 探测请求的唯一指纹：探测提示词/工具名只出现在工具能力探测里。
		probe: JSON.stringify(body ?? {}).includes("pi_capability_probe"),
		status: 0,
		response: "",
		respondedAt: 0,
	};
	requests.push(entry);
	return entry;
};

/**
 * 替身模型端点：
 *   POST /drop/v1/messages（anthropic-messages）—— 网关「接受但要丢 tools」：200 + 纯文本，无 tool call；
 *   POST /ok/responses（openai-responses）—— 正常端点的对照组：响应含 function_call。
 * 两条路径都用一个 probe 标记区分探测请求与真实流式请求。
 */
const mock = createServer(async (req, res) => {
	let raw = "";
	for await (const chunk of req) raw += chunk;
	let body = {};
	try {
		body = JSON.parse(raw);
	} catch {
		/* keep empty */
	}
	const path = new URL(req.url ?? "/", "http://x").pathname;
	const entry = record(path, body);
	const sendJson = (code, payload) => {
		entry.status = code;
		entry.response = JSON.stringify(payload);
		res.writeHead(code, { "content-type": "application/json" });
		res.end(entry.response);
		entry.respondedAt = Date.now();
	};
	const sendSse = (events) => {
		entry.status = 200;
		entry.response = events.join("");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(entry.response);
		res.end();
		entry.respondedAt = Date.now();
	};

	if (path === "/drop/v1/messages") {
		if (entry.probe) {
			// 网关接受了请求、返回 200，但把 tools 丢了：模型只回一段纯文本。
			sendJson(200, {
				type: "message",
				id: "msg_drop",
				role: "assistant",
				model: body.model,
				content: [{ type: "text", text: "I do not have any tools available." }],
				stop_reason: "end_turn",
				usage: { input_tokens: 5, output_tokens: 8 },
			});
			return;
		}
		// 真实流式请求：同样只给纯文本（网关丢弃 tools 的表现）。
		sendSse([
			sse("message_start", { type: "message_start", message: { id: "msg_drop_run", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
			sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong-drop" } }),
			sse("content_block_stop", { type: "content_block_stop", index: 0 }),
			sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
			sse("message_stop", { type: "message_stop" }),
		]);
		return;
	}

	if (path === "/ok/responses") {
		if (entry.probe) {
			// 正常端点：确实产生了 function_call。
			sendJson(200, {
				id: "resp_probe",
				object: "response",
				status: "completed",
				output: [{ type: "function_call", id: "fc_probe", call_id: "call_probe", name: "pi_capability_probe", arguments: "{}" }],
				usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
			});
			return;
		}
		const message = { type: "message", id: "msg_ok", role: "assistant", status: "completed", content: [{ type: "output_text", text: "pong-ok", annotations: [] }] };
		sendSse([
			sse("response.created", { type: "response.created", response: { id: "resp_run" } }),
			sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...message, content: [], status: "in_progress" } }),
			sse("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: "pong-ok" }),
			sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message }),
			sse("response.completed", { type: "response.completed", response: { id: "resp_run", status: "completed", output: [message], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }),
		]);
		return;
	}

	sendJson(404, { error: { message: `no route: ${path}` } });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

// 两个服务商指向同一个替身端点（路径不同），各带一个模型；渠道白名单只放各自那一个。
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({}));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			dropprov: {
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}/drop`,
				apiKey: "sk-mock-drop",
				models: [{ id: "drop-model", name: "Drop Tools Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
			okprov: {
				api: "openai-responses",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}/ok`,
				apiKey: "sk-mock-ok",
				models: [{ id: "ok-model", name: "Tool-Capable Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);

const repoRoot = realpathSync(new URL("../", import.meta.url));
const serverEnv = {
	...process.env,
	PI_WEB_PORT: String(PORT),
	PI_WEB_DATA_DIR: dataDir,
	PI_WEB_CWD: workdir,
	PI_CODING_AGENT_DIR: agentDir,
};
// 隔离实例不得继承宿主鉴权/托管环境，否则匿名 WS 会被 401 挡掉。
delete serverEnv.PI_WEB_TOKEN;
delete serverEnv.PI_WEB_MANAGED;
delete serverEnv.PI_CODING_AGENT_SESSION_DIR;
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: serverEnv,
	stdio: ["ignore", "ignore", "inherit"],
	windowsHide: true,
});

const waitForPort = async (port, timeout = 20000) => {
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

const waitUntil = async (predicate, timeout, what) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const value = predicate();
		if (value) return value;
		await sleep(40);
	}
	throw new Error(`timeout waiting for ${what}`);
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.notices = [];
		this.state = null;
		this.resyncing = false;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				this.resyncing = false;
			} else if (message.type === "snapshot_delta") {
				if (this.state && this.state.rev === message.baseRev) {
					// messages 只随 appended 增量下发（见 protocol.ts 的 snapshot_delta 注释）。
					this.state = { ...this.state, ...message.state, messages: [...(this.state.messages ?? []), ...(message.appended ?? [])] };
				} else if (!this.resyncing) {
					// rev 链断了：请求整份快照重建，否则 messages 会永久停在被丢弃的那一版。
					this.resyncing = true;
					this.send({ type: "get_state" });
				}
			}
			if (message.type === "notice") {
				this.notices.push(message);
				console.log(`  [notice:${message.level}] ${message.text}`);
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 25000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const message = this.received[i];
				if (message.type !== type || !predicate(message)) continue;
				this.received.splice(i, 1);
				return message;
			}
			await sleep(40);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 25000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(40);
		}
		throw new Error("timeout waiting for state");
	}
	/** 工具能力告警（文案含「不支持工具调用」）——正反两个方向都用它判定。 */
	warnings() {
		return this.notices.filter((n) => n.level === "warning" && String(n.text ?? "").includes(WARNING_TEXT));
	}
	assistantCount() {
		return (this.state?.messages ?? []).filter((m) => m.role === "assistant").length;
	}
}

const runCommand = async (client, type, payload = {}) => {
	const commandId = randomUUID();
	client.send({ type, commandId, ...payload });
	return client.waitForType("channel_command_result", (m) => m.commandId === commandId);
};

/** 发一轮真实请求并等这一轮结束（assistant 消息落定且不再流式）。 */
const runTurn = async (client, text) => {
	const before = client.assistantCount();
	client.send({ type: "prompt", text });
	await client.waitForState((s) => s.isStreaming === false && (s.messages ?? []).filter((m) => m.role === "assistant").length > before, 30000);
};

const saveChannel = async (client, channel) => {
	const result = await runCommand(client, "channel_save", { channel });
	check(`渠道 ${channel.id} 保存成功`, result.ok === true, result.error ?? "");
	return result;
};

const selectChannel = async (client, conversationId, channelId, modelId) => {
	const result = await runCommand(client, "channel_select", { conversationId, channelId, modelId });
	check(`对话绑定 ${channelId}/${modelId}`, result.ok === true && result.phase === "applied", JSON.stringify({ phase: result.phase, error: result.error }));
	return result;
};

try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const client = new Client(ws);
	client.send({ type: "hello", clientId: "tool-capability-test" });
	const state = await client.waitForState((s) => Boolean(s.conversationId));
	const conv = state.conversationId;

	// 两个渠道：drop（anthropic-messages，网关丢 tools）与 ok（openai-responses，正常）。
	await saveChannel(client, { id: "ch-drop", displayName: "丢工具渠道", providerId: "dropprov", models: ["drop-model"] });
	await saveChannel(client, { id: "ch-ok", displayName: "正常工具渠道", providerId: "okprov", models: ["ok-model"] });

	// ── 1) 会丢 tools 的渠道：真实请求路径触发探测 → 必须告警 ─────────────────
	await selectChannel(client, conv, "ch-drop", "dropprov/drop-model");
	await runTurn(client, "ping-drop");

	const dropProbe = await waitUntil(
		() => requests.find((r) => r.path === "/drop/v1/messages" && r.probe),
		20000,
		"the drop-channel capability probe request",
	);
	check(
		"丢工具渠道的探测请求带上了 tools（是我们发了、对方丢了）",
		Array.isArray(dropProbe.body?.tools) && dropProbe.body.tools.length > 0 && dropProbe.body.tools[0]?.name === "pi_capability_probe",
		JSON.stringify({ tools: dropProbe.body?.tools?.map((t) => t.name ?? t?.function?.name ?? t?.type), stream: dropProbe.body?.stream }),
	);
	check(
		"替身网关返回 200 纯文本答复（无 tool_use），复现「静默丢 tools」",
		dropProbe.status === 200 && !dropProbe.response.includes("tool_use") && dropProbe.response.includes('"type":"message"'),
		`status=${dropProbe.status} body=${dropProbe.response.slice(0, 160)}`,
	);

	const warning = await client.waitForType("notice", (m) => m.level === "warning" && String(m.text ?? "").includes(WARNING_TEXT), 30000).catch((err) => {
		check("丢工具渠道触发明确告警", false, `${err?.message ?? err}；收到的 notice=${JSON.stringify(client.notices.map((n) => `${n.level}:${n.text}`))}`);
		return null;
	});
	if (warning) {
		check("丢工具渠道触发明确告警（level=warning）", warning.level === "warning", JSON.stringify({ level: warning.level, text: warning.text }));
		check("告警文案明确指出「不支持工具调用」", String(warning.text ?? "").includes(WARNING_TEXT), String(warning.text ?? "").slice(0, 200));
		check("告警点名了渠道显示名与模型（channelDisplayName 生效）", String(warning.text ?? "").includes("丢工具渠道") && String(warning.text ?? "").includes("drop-model"), String(warning.text ?? "").slice(0, 200));
	}

	// ── 2) 对照组：端点支持工具 → 探测发生但不得告警 ─────────────────────────
	const warningsBefore = client.warnings().length;
	await selectChannel(client, conv, "ch-ok", "okprov/ok-model");
	await runTurn(client, "ping-ok");

	const okProbe = await waitUntil(
		() => requests.find((r) => r.path === "/ok/responses" && r.probe),
		20000,
		"the control-channel capability probe request",
	);
	check(
		"对照组的探测请求同样带上了 tools",
		Array.isArray(okProbe.body?.tools) && okProbe.body.tools.length > 0,
		JSON.stringify({ tools: okProbe.body?.tools?.map((t) => t.name ?? t?.function?.name ?? t?.type) }),
	);
	check(
		"对照组替身端点返回了 function_call（探测必然判为 supported）",
		okProbe.status === 200 && okProbe.response.includes('"type":"function_call"'),
		`status=${okProbe.status} body=${okProbe.response.slice(0, 160)}`,
	);
	// 探测是异步的：给告警链路留出「如果会误报，早该到了」的窗口。
	await waitUntil(() => okProbe.respondedAt > 0, 10000, "the control probe response to settle");
	await sleep(2500);
	const newWarnings = client.warnings().slice(warningsBefore);
	check(
		"支持工具的渠道不产生「不支持工具调用」告警（无误报）",
		newWarnings.length === 0,
		JSON.stringify(newWarnings.map((n) => n.text)),
	);

	ws.close();
} catch (err) {
	check("test run completed without exceptions", false, err?.message ?? String(err));
} finally {
	server.kill("SIGTERM");
	await sleep(200);
	mock.close();
	rmSync(base, { recursive: true, force: true });
	console.log(failures === 0 ? "\n✓ channel tool capability: all checks passed" : `\n✗ channel tool capability: ${failures} check(s) failed`);
	process.exit(failures === 0 ? 0 : 1);
}
