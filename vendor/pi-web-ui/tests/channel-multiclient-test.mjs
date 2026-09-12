/*
 * 🍞 AI Breadcrumb — @COUPLED ../server/dev-con/channel-service.ts（refresh/冲突恢复、绑定合并）
 *   @COUPLED ../server/index.ts（channel_state 广播）
 * 📖 ../../docs/DEV-CON-PROPOSAL.md §10 A02/A05 + §4（外部修改不可静默覆盖、多端版本一致）
 *
 * DEV-CON 多端验收（真实 dist server + 两个独立 clientId，同一实例共享 agentDir）：
 *   1. A 端建渠道 → B 端收到同一份 channel_state（多端看到相同状态）；
 *   2. 文件被外部改写 → A 端基于旧版本的提交得到 conflict，且**不覆盖**外部编辑；
 *   3. conflict 后 A 端刷新即拿到新版本，用新版本重试成功（可恢复）；
 *   4. A/B 各自为自己对话绑定 → 两条绑定都保留在文件里（互不覆盖）；
 *   5. B 端删除渠道 → A 端看到渠道消失、引用它的绑定被清理。
 *
 * Usage: npm run build && node tests/channel-multiclient-test.mjs [port]
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// 默认端口按 PID 派生：冒烟与手工 e2e 并行时不会互撞（同一脚本两份的 PID 必不相同）。
const PORT = Number(process.argv[2] || 9300 + (process.pid % 100) * 2);
const base = mkdtempSync(join(tmpdir(), "pi-dev-channel-multiclient-"));
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

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "sk-mc" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				authHeader: true,
				apiKey: "sk-mc",
				models: [{ id: "mc-mock", name: "MC Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);
const channelsPath = join(agentDir, "dev-con", "channels.json");
const readChannels = () => JSON.parse(readFileSync(channelsPath, "utf8"));

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
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(name, ws) {
		this.name = name;
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.channelState = null;
		ws.on("message", (data) => {
			const msg = JSON.parse(data.toString());
			this.received.push(msg);
			if (msg.type === "snapshot") this.state = msg.state;
			else if (msg.type === "snapshot_delta" && this.state && this.state.rev === msg.baseRev) this.state = { ...this.state, ...msg.state };
			if (msg.type === "channel_state") this.channelState = msg;
		});
	}
	send(msg) {
		this.ws.send(JSON.stringify(msg));
	}
	async waitForType(type, predicate = () => true, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const msg = this.received[i];
				if (msg.type !== type || !predicate(msg)) continue;
				this.received.splice(i, 1);
				return msg;
			}
			await sleep(40);
		}
		throw new Error(`[${this.name}] timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(40);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	/** 等待 channel_state 满足条件（消费旧消息，直到出现匹配的一条）。 */
	async waitChannelState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.channelState && predicate(this.channelState)) return this.channelState;
			await sleep(40);
		}
		throw new Error(`[${this.name}] timeout waiting for channel_state`);
	}
}

const connect = async (clientId) => {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const client = new Client(clientId, ws);
	client.send({ type: "hello", clientId });
	await client.waitForState((s) => Boolean(s.conversationId));
	return client;
};

const runCommand = async (client, type, payload = {}, timeout = 20000) => {
	const commandId = randomUUID();
	client.send({ type, commandId, ...payload });
	return client.waitForType("channel_command_result", (m) => m.commandId === commandId, timeout);
};

const draft = (id, displayName, keyName = "密钥 1") => ({
	id,
	displayName,
	providerId: "mock",
	endpointId: "default",
	credentialRef: { providerId: "mock", keyName },
	accountRef: null,
	enabled: true,
});

try {
	await waitForPort(PORT);
	const a = await connect("mc-dev-a");
	const b = await connect("mc-dev-b");

	// 1) A 建渠道 → B 必须收到广播（多端一致）。
	const saved = await runCommand(a, "channel_save", { channel: draft("ch-a", "渠道 A") });
	check("A saves 渠道 A", saved.ok === true, saved.error ?? "");
	const seen = await b.waitChannelState((cs) => cs.channels.some((c) => c.id === "ch-a"), 15000);
	check("B receives the same channel list via broadcast", seen.configRevision === saved.configRevision);
	const convA = a.state.conversationId;
	const convB = b.state.conversationId;

	// 2) 外部改写文件 → A 基于旧版本提交必须 conflict 且不覆盖外部编辑。
	const onDisk = readChannels();
	onDisk.channels.push(draft("ch-ext", "外部渠道"));
	onDisk.configRevision = 9;
	writeFileSync(channelsPath, JSON.stringify(onDisk, null, 2) + "\n");
	const stale = await runCommand(a, "channel_save", {
		channel: draft("ch-stale", "陈旧渠道"),
		expectedConfigRevision: saved.configRevision,
	});
	check("stale submit against an external edit is a conflict", stale.ok === false && stale.phase === "conflict", stale.error ?? "");
	check("external edit was not overwritten", readChannels().channels.map((c) => c.id).sort().join() === "ch-a,ch-ext");

	// 3) conflict 后刷新拿到新版本，用新版本重试成功（可恢复）。
	a.send({ type: "list_channels" });
	const refreshed = await a.waitForType("channel_state", (m) => m.configRevision === 9, 10000);
	check("list_channels re-reads the file instead of stale memory", refreshed.configRevision === 9);
	const retry = await runCommand(a, "channel_save", {
		channel: draft("ch-b2", "渠道 B2"),
		expectedConfigRevision: refreshed.configRevision,
	});
	check("retry with the refreshed revision succeeds", retry.ok === true, retry.error ?? "");

	// 4) A/B 各自绑定自己的对话 → 两条绑定都保留。
	const bindA = await runCommand(a, "channel_select", { conversationId: convA, channelId: "ch-a", modelId: "mock/mc-mock" });
	const bindB = await runCommand(b, "channel_select", { conversationId: convB, channelId: "ch-a", modelId: "mock/mc-mock" });
	check("A binds its own conversation", bindA.ok === true && bindA.phase === "applied", bindA.error ?? "");
	check("B binds its own conversation", bindB.ok === true && bindB.phase === "applied", bindB.error ?? "");
	const bindings = readChannels().bindings;
	check(
		"both clients keep their own binding even with identical conversation ids",
		Boolean(bindings[`mc-dev-a::${convA}`]?.channelId) && Boolean(bindings[`mc-dev-b::${convB}`]?.channelId),
		Object.keys(bindings).join(),
	);
	// 多端语义（见 docs/P0-VERIFICATION.md）：渠道配置/默认值/账户是实例级共享并广播；
	// 对话绑定按客户端隔离（对话 id 本身就是客户端本地的 c1/c2…），因此 A 只发布自己的绑定，
	// 两端看到的 configRevision 必须一致（同一份渠道事实源）。
	const aView = a.channelState;
	const bView = b.channelState;
	check("each client publishes only its own conversation bindings", aView.bindings.every((x) => x.conversationId === convA) && bView.bindings.every((x) => x.conversationId === convB));
	check("both clients agree on the same channel config revision", aView.configRevision === bView.configRevision);

	// 5) B 删除渠道 → A 看到渠道消失且绑定被清理。
	const del = await runCommand(b, "channel_delete", { channelId: "ch-a" });
	check("B deletes 渠道 A", del.ok === true, del.error ?? "");
	const afterDelete = await a.waitChannelState((cs) => !cs.channels.some((c) => c.id === "ch-a"), 15000);
	check("A sees the deletion", afterDelete.channels.every((c) => c.id !== "ch-a"));
	check(
		"bindings referencing the deleted channel are gone",
		!readChannels().bindings[`mc-dev-a::${convA}`] && !readChannels().bindings[`mc-dev-b::${convB}`],
	);

	a.ws.close();
	b.ws.close();
} catch (err) {
	check("test run completed without exceptions", false, err?.message ?? String(err));
} finally {
	server.kill("SIGTERM");
	await sleep(200);
	console.log(failures === 0 ? "\n✓ channel multi-client: all checks passed" : `\n✗ channel multi-client: ${failures} check(s) failed`);
	process.exit(failures === 0 ? 0 : 1);
}
