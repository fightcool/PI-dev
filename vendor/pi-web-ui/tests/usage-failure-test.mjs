/*
 * 🍞 AI Breadcrumb — @COUPLED ../server/dev-con/usage-history.ts,
 *   ../lib/usage/token-usage.mjs, ../server/dev-con/channel-failure-alert.ts,
 *   ../server/agent-service.ts（failureSamples / checkChannelFailureAlerts）
 * 📖 ../../docs/P0-VERIFICATION.md §14「失败请求与白烧可见」
 *
 * 端到端证明「网关掐流 → 白烧可见 → 越线告警」这条链在真实服务里成立。替身
 * anthropic-messages 端点按 pi-ai 的判据（`iterateAnthropicEvents` 的
 * `sawMessageStart && !sawMessageEnd`）在 `message_start` 之后直接收流，逐字复现
 * 线上那句 `Anthropic stream ended before message_stop`。
 *
 * 断言（每一条都对着一个线上真实后果）：
 *   1) 被掐掉的那一次仍会被自动重试救回 —— 线上 136/136 救回，是「只漏钱不丢活」的前提；
 *   2) 掐流那一次的输入 token 进得了用量历史（failedRequests / wastedInput）——
 *      这类请求在「请求数 / 费用」上看起来完全正常，不单独记账就永远不可见；
 *   3) 磁盘记录带 stopReason=error 与截断到 120 字的 failureReason；
 *   4) 用户主动中止（aborted）不算失败 —— 口径只认 error，否则告警变噪声；
 *   5) 失败越线时真的发出告警，且**点名渠道**（不是 provider，也不是沉默）。
 *
 * 阈值/窗口是分钟级常量，检查周期由 PI_WEB_OPS_ALERT_MS 压到 1 秒，用例才不用等一个
 * 60 秒 tick；窗口与冷却本身仍按生产值走（这里只验证「判定到了会发」）。
 *
 * Usage: node tests/usage-failure-test.mjs [port]   # 未构建过会自动构建
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ensureBuild } from "./lib/build.mjs";

// 默认端口按 PID 派生：冒烟与手工 e2e 并行时不会互撞（同一脚本两份的 PID 必不相同）。
// 9700 段与既有的 8900/9100/9300/9500 段互不重叠。
const PORT = Number(process.argv[2] || 9700 + (process.pid % 100) * 2);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-dev-usage-failure-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(agentDir, "dev-con"), { recursive: true });

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * 掐流那一次的 token 记账：故意与正常回复取不同数字，断言才能精确到个位
 * （线上掐流请求就是「input 照收、output≈0」这个形状，见 §14）。
 */
const TRUNCATED_USAGE = {
	input_tokens: 5000,
	cache_read_input_tokens: 2000,
	cache_creation_input_tokens: 1000,
	output_tokens: 0,
};
const OK_USAGE = {
	input_tokens: 100,
	cache_read_input_tokens: 400,
	cache_creation_input_tokens: 50,
	output_tokens: 20,
};
/** 掐掉一次的白烧输入 = miss + 读缓存 + 写缓存 = 5000 + 2000 + 1000。 */
const TRUNCATED_WASTE = 8000;
/** 两条请求混在一组时的加权命中率分母：input 5100 + cacheRead 2400 + cacheWrite 1050。 */
const EXPECTED_HIT_RATE = 2400 / (5100 + 2400 + 1050);
const FAILURE_REASON_NEEDLE = "stream ended before message_stop";

/** 每条路径还剩几次「掐流」（p1 只掐第一次以验证重试救回；p2 全掐用于压告警阈值）。 */
const truncationsLeft = new Map([
	["/p1/v1/messages", 1],
	["/p2/v1/messages", Number.POSITIVE_INFINITY],
]);
/** 到达替身端点的请求路径（只用来给响应 id 编个唯一序号，不参与断言）。 */
const seen = [];

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
	seen.push(path);

	// 工具能力探测必须**正常答复**：否则渠道会被标成「不支持工具调用」，
	// 那条告警会混进本用例的通知流，噪声掩盖我们要断言的那条。
	if (JSON.stringify(body).includes("pi_capability_probe")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				type: "message",
				id: `msg_probe_${randomUUID().slice(0, 8)}`,
				role: "assistant",
				model: body.model,
				content: [{ type: "tool_use", id: "tu_probe", name: "pi_capability_probe", input: {} }],
				stop_reason: "tool_use",
				usage: { input_tokens: 5, output_tokens: 4 },
			}),
		);
		return;
	}

	if (path === "/p3/v1/messages") {
		// 慢流：给用户中止留出窗口。中止后 SDK 写 stopReason=aborted（有意为之，不算失败）。
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(
			sse("message_start", {
				type: "message_start",
				message: {
					id: "msg_abort",
					type: "message",
					role: "assistant",
					model: body.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: OK_USAGE,
				},
			}),
		);
		res.write(
			sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		);
		res.write(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "slow" },
			}),
		);
		await sleep(8000);
		res.end();
		return;
	}

	const left = truncationsLeft.get(path) ?? 0;
	if (left > 0) {
		if (left !== Number.POSITIVE_INFINITY) truncationsLeft.set(path, left - 1);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(
			sse("message_start", {
				type: "message_start",
				message: {
					id: `msg_trunc_${seen.length}`,
					type: "message",
					role: "assistant",
					model: body.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: TRUNCATED_USAGE,
				},
			}),
		);
		res.write(
			sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		);
		res.write(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "half" },
			}),
		);
		// 关键：到此收流，**没有** message_stop —— 与网关掐流逐字同形。
		res.end();
		return;
	}

	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(
		sse("message_start", {
			type: "message_start",
			message: {
				id: `msg_ok_${seen.length}`,
				type: "message",
				role: "assistant",
				model: body.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: OK_USAGE,
			},
		}),
	);
	res.write(
		sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	);
	res.write(
		sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }),
	);
	res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
	res.write(
		sse("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: OK_USAGE.output_tokens },
		}),
	);
	res.write(sse("message_stop", { type: "message_stop" }));
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({}));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			p1: {
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}/p1`,
				apiKey: "sk-mock-p1",
				models: [{ id: "p1-model", name: "Flaky Once Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
			p2: {
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}/p2`,
				apiKey: "sk-mock-p2",
				models: [
					{ id: "p2-model", name: "Always Truncating Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 },
				],
			},
			p3: {
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}/p3`,
				apiKey: "sk-mock-p3",
				models: [{ id: "p3-model", name: "Slow Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);
// 重试退避压到 100ms（默认 2000ms×2^n）：用例要验证的是「会不会救回」，不是睡得久。
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } }),
);

const repoRoot = realpathSync(new URL("../", import.meta.url));
// 单独跑时自建（跑批时 run-smoke 已构建一次并置 PI_SMOKE_DIST_READY=1，见 tests/lib/build.mjs）。
ensureBuild({ cwd: repoRoot, label: "usage-failure-test" });
const serverEnv = {
	...process.env,
	PI_WEB_PORT: String(PORT),
	PI_WEB_DATA_DIR: dataDir,
	PI_WEB_CWD: workdir,
	PI_CODING_AGENT_DIR: agentDir,
	// 告警检查周期 1 秒：链路照跑，只是不必等生产的 60 秒 tick。
	PI_WEB_OPS_ALERT_MS: "1000",
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
					this.state = {
						...this.state,
						...message.state,
						messages: [...(this.state.messages ?? []), ...(message.appended ?? [])],
					};
				} else if (!this.resyncing) {
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
	async waitForType(type, predicate = () => true, timeout = 30000) {
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
	async waitForState(predicate, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(40);
		}
		throw new Error("timeout waiting for state");
	}
	assistantCount() {
		return (this.state?.messages ?? []).filter((m) => m.role === "assistant").length;
	}
	/** 渠道失败告警：文案形如「<渠道名> 近 30 分钟 N 次请求中 M 次失败…白烧约 T 输入 token」。 */
	failureNotices() {
		return this.notices.filter((n) => String(n.text ?? "").includes("白烧"));
	}
}

const runCommand = async (client, type, payload = {}) => {
	const commandId = randomUUID();
	client.send({ type, commandId, ...payload });
	return client.waitForType("channel_command_result", (m) => m.commandId === commandId);
};
const queryHistory = async (client, groupBy) => {
	const reqId = Math.floor(Math.random() * 1e6);
	client.send({ type: "usage_history_query", reqId, groupBy });
	return client.waitForType("usage_history", (m) => m.reqId === reqId, 20000);
};
const readHistoryRecords = () =>
	readFileSync(join(agentDir, "dev-con", "usage-history.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const client = new Client(ws);
	client.send({ type: "hello", clientId: "usage-failure-test" });
	const state = await client.waitForState((s) => Boolean(s.conversationId));
	const conv = state.conversationId;

	for (const channel of [
		{ id: "ch-p1", displayName: "偶发掐流渠道", providerId: "p1", models: ["p1-model"] },
		{ id: "ch-p2", displayName: "持续掐流渠道", providerId: "p2", models: ["p2-model"] },
		{ id: "ch-p3", displayName: "慢流渠道", providerId: "p3", models: ["p3-model"] },
	]) {
		const saved = await runCommand(client, "channel_save", { channel });
		check(`渠道 ${channel.id} 保存成功`, saved.ok === true, saved.error ?? "");
	}
	const select = async (channelId, modelId) => {
		const result = await runCommand(client, "channel_select", { conversationId: conv, channelId, modelId });
		check(
			`对话绑定 ${channelId}/${modelId}`,
			result.ok === true && result.phase === "applied",
			JSON.stringify({ phase: result.phase, error: result.error }),
		);
	};
	const runTurn = async (text) => {
		const before = client.assistantCount();
		client.send({ type: "prompt", text });
		await client.waitForState(
			(s) => s.isStreaming === false && (s.messages ?? []).filter((m) => m.role === "assistant").length > before,
			40000,
		);
	};

	// ── 1) 掐流一次 → 重试救回（线上 136/136 都是这么活的） ─────────────────────
	await select("ch-p1", "p1/p1-model");
	await runTurn("ping-flaky");
	const lastAssistant = (client.state?.messages ?? []).filter((m) => m.role === "assistant").at(-1);
	const replyText = JSON.stringify(lastAssistant?.content ?? []).includes("pong");
	check(
		"掐流后本轮仍产出正常回复（自动重试救回）",
		replyText,
		JSON.stringify(lastAssistant?.content ?? []).slice(0, 120),
	);

	// ── 2) 白烧进得了用量历史（这是本次改动的核心） ─────────────────────────────
	const byChannel = await queryHistory(client, "channel");
	const rowP1 = byChannel.rows.find((r) => r.key === "ch-p1");
	check("用量历史按渠道分组里能看到 ch-p1", Boolean(rowP1));
	check("失败请求数 = 1", rowP1?.failedRequests === 1, `failedRequests=${rowP1?.failedRequests}`);
	check(
		"白烧输入 = 8000（miss+读缓存+写缓存）",
		rowP1?.wastedInput === TRUNCATED_WASTE,
		`wastedInput=${rowP1?.wastedInput}`,
	);
	check(
		"缓存命中率是 token 加权口径（cacheRead ÷ 全部输入）",
		Math.abs((rowP1?.cacheHitRate ?? -1) - EXPECTED_HIT_RATE) < 1e-9,
		`cacheHitRate=${rowP1?.cacheHitRate} 期望 ${EXPECTED_HIT_RATE}`,
	);
	check(
		"totals 同样带上失败与白烧字段",
		byChannel.totals?.failedRequests === 1 && byChannel.totals?.wastedInput === TRUNCATED_WASTE,
		`totals.failedRequests=${byChannel.totals?.failedRequests} wastedInput=${byChannel.totals?.wastedInput}`,
	);
	check(
		"未失败渠道的 failedRequests 是 0（不是缺失）",
		byChannel.rows.filter((r) => r.key !== "ch-p1").every((r) => r.failedRequests === 0),
	);

	// ── 3) 磁盘记录带 stopReason / 有界 failureReason ───────────────────────────
	const errored = readHistoryRecords().filter((r) => r.stopReason === "error");
	check("JSONL 里出现 stopReason=error 的记录", errored.length >= 1, `count=${errored.length}`);
	check(
		"失败记录带 failureReason 且与线上错误同源",
		errored.some((r) => String(r.failureReason ?? "").includes(FAILURE_REASON_NEEDLE)),
		JSON.stringify(errored[0]?.failureReason ?? ""),
	);
	check(
		"failureReason 截断到 120 字（append-only JSONL 不能无界膨胀）",
		errored.every((r) => String(r.failureReason ?? "").length <= 120),
		`max=${Math.max(0, ...errored.map((r) => String(r.failureReason ?? "").length))}`,
	);
	check(
		"失败记录只挂在 ch-p1 上（不串渠道）",
		errored.every((r) => r.channelId === "ch-p1"),
		JSON.stringify([...new Set(errored.map((r) => r.channelId))]),
	);

	// ── 4) 用户主动中止不算失败 ────────────────────────────────────────────────
	await select("ch-p3", "p3/p3-model");
	client.send({ type: "prompt", text: "ping-slow" });
	await sleep(800);
	client.send({ type: "abort" });
	await client.waitForState((s) => s.isStreaming === false, 20000);
	await sleep(500);
	const byChannel2 = await queryHistory(client, "channel");
	const rowP3 = byChannel2.rows.find((r) => r.key === "ch-p3");
	check(
		"中止的请求不算失败（failedRequests 保持 0）",
		rowP3?.failedRequests === 0,
		`failedRequests=${rowP3?.failedRequests}`,
	);
	const aborted = readHistoryRecords().filter((r) => r.stopReason === "aborted");
	check("但中止事实照记在盘上（stopReason=aborted，留证据）", aborted.length >= 1, `count=${aborted.length}`);

	// ── 5) 失败越线 → 告警点名渠道（不是 provider，也不是沉默） ─────────────────
	await select("ch-p2", "p2/p2-model");
	// 每次 prompt 都会在重试里反复失败；跑到 ≥5 次失败样本即可（阈值：≥5 次且失败率 ≥5%）。
	let failedSamples = 0;
	for (let round = 0; round < 3 && failedSamples < 6; round++) {
		client.send({ type: "prompt", text: `ping-dead-${round}` });
		await client.waitForState((s) => s.isStreaming === false, 40000);
		await sleep(300);
		failedSamples = readHistoryRecords().filter((r) => r.stopReason === "error").length;
	}
	check("持续掐流渠道积累了 ≥5 次失败样本", failedSamples >= 5, `failedSamples=${failedSamples}`);

	const alert = await (async () => {
		const started = Date.now();
		while (Date.now() - started < 15000) {
			const found = client.failureNotices();
			if (found.length > 0) return found[0];
			await sleep(200);
		}
		return null;
	})();
	check("失败越线后真的发出白烧告警", Boolean(alert), alert?.text ?? "(15 秒内没有告警)");
	check("告警点名的是渠道显示名", String(alert?.text ?? "").includes("持续掐流渠道"), alert?.text ?? "");
	check(
		"告警给出失败率与白烧 token 量",
		/近 30 分钟 \d+ 次请求中 \d+ 次失败（\d+%）/.test(String(alert?.text ?? "")) &&
			/白烧约 \d+ 输入 token/.test(String(alert?.text ?? "")),
		alert?.text ?? "",
	);
	check(
		"只有 1 次失败的渠道不触发告警（次数下限挡住偶发）",
		!client.failureNotices().some((n) => String(n.text ?? "").includes("偶发掐流渠道")),
	);
	check("告警文案有英文版（UI 双语）", Boolean(alert?.textEn), alert?.textEn ?? "");
} catch (error) {
	check("用例未抛异常", false, error instanceof Error ? error.message : String(error));
} finally {
	server.kill();
	mock.close();
}

console.log(failures === 0 ? "\n✓ usage failure: all checks passed" : `\n✗ usage failure: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
