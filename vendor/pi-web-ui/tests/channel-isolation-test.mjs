/*
 * 🍞 AI Breadcrumb — @COUPLED ../server/dev-con/channel-service.ts, ../server/agent-service.ts（makeConversation 的 Agent.getApiKey）
 * 📖 ../../docs/DEV-CON-PROPOSAL.md §9「凭据隔离」+ §10 A01/A05
 *
 * DEV-CON P0 证据（凭据隔离）：两个 Pi 对话各自绑定同一服务商的不同命名密钥，
 * 请求必须带各自那把 key —— 即使那把 key 不是全局 active key；且渠道切换不得
 * 隐式改写 agentDir/auth.json。用真实 dist server + 真实 SDK 请求路径 + 本地
 * 替身模型端点验证（合成凭据，不接触任何真实模型）。
 *
 * Usage: npm run build && node tests/channel-isolation-test.mjs [port]
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// 默认端口按 PID 派生：冒烟与手工 e2e 并行时不会互撞（同一脚本两份的 PID 必不相同）。
const PORT = Number(process.argv[2] || 9100 + (process.pid % 100) * 2);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-dev-channel-isolation-"));
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

/** 记录每次模型请求携带的凭据；回显式 SSE 让一轮真实跑完。 */
const seenAuth = [];
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	if (req.method === "GET" && new URL(req.url ?? "/", "http://x").pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: "chan-mock", object: "model" }] }));
		return;
	}
	let payload = {};
	try {
		payload = JSON.parse(body);
	} catch {
		/* keep empty */
	}
	seenAuth.push({ authorization: String(req.headers.authorization ?? ""), model: payload.model });
	const last = payload.messages?.at(-1);
	const prompt = typeof last?.content === "string" ? last.content : "";
	const reply = `reply:${prompt}`;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(
		`data: ${JSON.stringify({ id: "chan", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`,
	);
	res.write(
		`data: ${JSON.stringify({ id: "chan", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
	);
	// 真实 provider 语义：开启 include_usage 后，最后一个 chunk 带 usage（含缓存明细）。
	// 没有它就无法在端到端里验证「token 落进用量历史」这条链路。
	res.write(
		`data: ${JSON.stringify({
			id: "chan",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [],
			usage: { prompt_tokens: 120, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 4 } },
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

// 全局 active key 最终是 sk-active-two；渠道 ch-a 用的是「非 active」的 sk-active-one。
// auth.json 初始为空，避免 provider-keys 的 legacy 播种改变密钥命名。
const ORIGINAL_ACTIVE = "sk-active-two";
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({}));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				authHeader: true,
				apiKey: ORIGINAL_ACTIVE,
				models: [{ id: "chan-mock", name: "Channel Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
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
delete serverEnv.PI_CODING_AGENT_SESSION_DIR;
delete serverEnv.PI_WEB_TOKEN;
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

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.channelState = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta" && this.state && this.state.rev === message.baseRev) {
				this.state = { ...this.state, ...message.state };
			}
			if (message.type === "channel_state") this.channelState = message;
			if (message.type === "notice") console.log(`  [notice:${message.level}] ${message.text}`);
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
}

const runCommand = async (client, type, payload = {}) => {
	const commandId = randomUUID();
	client.send({ type, commandId, ...payload });
	return client.waitForType("channel_command_result", (m) => m.commandId === commandId);
};

const readAuth = () => JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));

/** 用量历史查询（P4 首个切片）：发出请求并按 reqId 匹配结果。 */
const queryHistory = async (client, groupBy, reqId = Math.floor(Math.random() * 1e6)) => {
	client.send({ type: "usage_history_query", reqId, groupBy });
	return client.waitForType("usage_history", (m) => m.reqId === reqId, 20000);
};

try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const client = new Client(ws);
	client.send({ type: "hello", clientId: "isolation-test" });
	await client.waitForState((s) => Boolean(s.conversationId));
	const convA = client.state.conversationId;

	// 1) 两把命名密钥：密钥 1 = sk-active-one，密钥 2 = sk-active-two（激活）。
	client.send({ type: "set_provider_api_key", provider: "mock", apiKey: "sk-active-one" });
	await client.waitForType("provider_keys", (m) => (m.keys.mock ?? []).some((k) => k.name === "密钥 1"));
	client.send({ type: "add_provider_key", provider: "mock", apiKey: "sk-active-two", name: "密钥 2" });
	await client.waitForType("provider_keys", (m) => (m.keys.mock ?? []).some((k) => k.name === "密钥 2"));
	client.send({ type: "activate_provider_key", provider: "mock", keyName: "密钥 2" });
	await client.waitForType("provider_keys", (m) => (m.keys.mock ?? []).some((k) => k.name === "密钥 2" && k.active));
	check("global active key is 密钥 2", readAuth().mock?.key === ORIGINAL_ACTIVE);
	// 2) 两个渠道分别引用两把密钥。
	const savedA = await runCommand(client, "channel_save", {
		channel: { id: "ch-a", displayName: "渠道 A", providerId: "mock", credentialRef: { providerId: "mock", keyName: "密钥 1" } },
	});
	check("channel ch-a saved", savedA.ok === true, savedA.error ?? "");
	const savedB = await runCommand(client, "channel_save", {
		channel: { id: "ch-b", displayName: "渠道 B", providerId: "mock", credentialRef: { providerId: "mock", keyName: "密钥 2" } },
	});
	check("channel ch-b saved", savedB.ok === true, savedB.error ?? "");

	// 3) 会话 A 绑定 ch-a（非 active 的密钥 1），先真实跑一轮。
	const selectA = await runCommand(client, "channel_select", { conversationId: convA, channelId: "ch-a", modelId: "mock/chan-mock" });
	check("conversation A selects 渠道 A", selectA.ok === true && selectA.phase === "applied", selectA.error ?? "");
	check("receipt carries the binding revision", selectA.binding?.channelId === "ch-a" && selectA.binding?.bindingRevision >= 1);
	check("selecting a channel does not rewrite the global active key", readAuth().mock?.key === ORIGINAL_ACTIVE);

	seenAuth.length = 0;
	client.send({ type: "prompt", text: "ping-a" });
	const deadlineA = Date.now() + 25000;
	while (seenAuth.length === 0 && Date.now() < deadlineA) await sleep(50);
	await client.waitForState((s) => s.conversationId === convA && s.isStreaming === false && (s.messages?.length ?? 0) > 0, 25000).catch(() => undefined);
	check("conversation A used its channel credential", seenAuth[0]?.authorization === "Bearer sk-active-one", seenAuth[0]?.authorization ?? "no request seen");

	// 4) 新对话 B（A 已有内容 → new_chat 真的新建），绑定 ch-b。
	client.send({ type: "new_chat" });
	const stateB = await client.waitForState((s) => s.conversationId !== convA);
	const convB = stateB.conversationId;
	const selectB = await runCommand(client, "channel_select", { conversationId: convB, channelId: "ch-b", modelId: "mock/chan-mock" });
	check("conversation B selects 渠道 B", selectB.ok === true && selectB.phase === "applied", selectB.error ?? "");

	// 5) B 端真实跑一轮 → 用 sk-active-two，且不影响 A 的绑定。
	seenAuth.length = 0;
	client.send({ type: "prompt", text: "ping-b" });
	const deadlineB = Date.now() + 25000;
	while (seenAuth.length === 0 && Date.now() < deadlineB) await sleep(50);
	await client.waitForState((s) => s.conversationId === convB && s.isStreaming === false && (s.messages?.length ?? 0) > 0, 25000).catch(() => undefined);
	check("conversation B used its channel credential", seenAuth[0]?.authorization === "Bearer sk-active-two", seenAuth[0]?.authorization ?? "no request seen");

	// 6) A 的绑定在 B 跑动期间未被改写（回归“另一对话不受影响”）。
	const bindingA = (client.channelState?.bindings ?? []).find((b) => b.conversationId === convA);
	check("conversation A binding survives conversation B's run", bindingA?.channelId === "ch-a" && bindingA?.modelId === "mock/chan-mock");

	// 7) 多端/快照可见：两个绑定都在同一份 channel_state 里，且当前对话的快照带自己的绑定。
	const stateMsg = client.channelState;
	const bindings = stateMsg?.bindings ?? [];
	check("both conversation bindings are published", bindings.some((b) => b.conversationId === convA && b.channelId === "ch-a") && bindings.some((b) => b.conversationId === convB && b.channelId === "ch-b"));
	check("snapshot exposes the active conversation binding", client.state?.channelBinding?.effective?.channelId === "ch-b", JSON.stringify(client.state?.channelBinding ?? null));
	check("global auth.json untouched after all switches", readAuth().mock?.key === ORIGINAL_ACTIVE);

	// 7b) P4 首个切片：两次真实运行都已落盘到用量历史，且按渠道/项目分组可查。
	const byChannel = await queryHistory(client, "channel");
	const channelRows = byChannel.rows.map((r) => [r.key, r.requests]);
	check(
		"usage history groups the two real runs by their own channel",
		byChannel.ok === true && channelRows.some(([k, n]) => k === "ch-a" && n >= 1) && channelRows.some(([k, n]) => k === "ch-b" && n >= 1),
		JSON.stringify(channelRows),
	);
	const perRequest = {
		input: byChannel.totals.input / byChannel.totals.requests,
		output: byChannel.totals.output / byChannel.totals.requests,
		cacheRead: byChannel.totals.cacheRead / byChannel.totals.requests,
		cacheWrite: byChannel.totals.cacheWrite / byChannel.totals.requests,
	};
	check(
		"usage history totals match the mock's reported usage (tokens + cache survive persistence)",
		byChannel.totals.requests === 2 &&
			byChannel.totals.total === byChannel.totals.input + byChannel.totals.output + byChannel.totals.cacheRead + byChannel.totals.cacheWrite &&
			perRequest.input === 96 && perRequest.output === 12 && perRequest.cacheRead === 20 && perRequest.cacheWrite === 4,
		`${JSON.stringify(byChannel.totals)} perRequest=${JSON.stringify(perRequest)}`,
	);
	check(
		"usage history marks unpriced requests instead of claiming a zero cost (mock model has no price table)",
		byChannel.scanned >= 2 && byChannel.totals.unpricedRequests === 2 && byChannel.totals.cost === 0,
		JSON.stringify({ unpriced: byChannel.totals.unpricedRequests, cost: byChannel.totals.cost }),
	);
	const byProject = await queryHistory(client, "project");
	check("usage history can group by project (cwd)", byProject.rows.some((r) => r.key === workdir), JSON.stringify(byProject.rows.map((r) => r.key)));
	const windowed = await queryHistory(client, "day");
	check("usage history groups by UTC day", windowed.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.key)), JSON.stringify(windowed.rows.map((r) => r.key)));

	// 8) 组合命令的失败路径：模型不属于该渠道服务商 → 明确拒绝，绑定保持。
	const bad = await runCommand(client, "channel_select", { conversationId: convB, channelId: "ch-b", modelId: "mock/missing-model" });
	check("unknown model is rejected with the previous binding kept", bad.ok === false && bad.phase === "rejected", bad.error ?? "");
	// 9) 明确的状态请求：list_channels 直接回 channel_state（不是命令回执）。
	client.send({ type: "list_channels" });
	const listed = await client.waitForType("channel_state", (m) => m.channels.some((c) => c.id === "ch-b"), 10000);
	check(
		"list_channels returns server-side channels and the published credential names",
		listed.channels.map((c) => c.id).join() === "ch-a,ch-b" && listed.channels[0].keys.some((k) => k.keyName === "密钥 1"),
	);

	// 10) 未认证的错误帧不会杀死服务（P0 入口安全）。
	ws.send("null");
	await sleep(300);
	const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok).catch(() => false);
	check("a malformed websocket frame does not kill the process", health === true);

	ws.close();
} catch (err) {
	check("test run completed without exceptions", false, err?.message ?? String(err));
} finally {
	server.kill("SIGTERM");
	mock.close();
	await sleep(200);
	console.log(failures === 0 ? "\n✓ channel isolation: all checks passed" : `\n✗ channel isolation: ${failures} check(s) failed`);
	process.exit(failures === 0 ? 0 : 1);
}
