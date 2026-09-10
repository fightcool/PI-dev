/* 🍞 AI Breadcrumb — @COUPLED ../server/agent-service.ts, ../server/conversation-maintenance.ts
 * @CONTRACT Real SDK + local model only; no operator credentials, sessions or online service.
 * 📖 ../docs/conversation-lifecycle.md
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const base = mkdtempSync(join(tmpdir(), "pi-conversation-lifecycle-"));
const work = join(base, "workspace"),
	data = join(base, "web"),
	agent = join(base, "agent");
for (const dir of [work, data, agent]) mkdirSync(dir);
// Match the root protocol harness: never inherit provider variables or instance paths.
const allowed = ["PATH", "LANG", "LC_ALL", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP"];
for (const key of Object.keys(process.env)) if (!allowed.includes(key)) delete process.env[key];
Object.assign(process.env, {
	PI_CODING_AGENT_DIR: agent,
	PI_WEB_DATA_DIR: data,
	PI_SUBAGENTS_TEMP_ROOT: join(base, "extension-state"),
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
});
let cs,
	model,
	requestCount = 0;
const gates = new Set();
const hardStop = setTimeout(() => {
	console.error("Conversation lifecycle integration timed out");
	process.exit(1);
}, 90000);
async function until(predicate, label, timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
		await delay(20);
	}
}
try {
	model = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		const payload = JSON.parse(text);
		const last = payload.messages?.filter((m) => m.role === "user").at(-1)?.content;
		const prompt = typeof last === "string" ? last : JSON.stringify(last ?? "");
		requestCount++;
		if (prompt.includes("FAIL_FIXTURE")) {
			res.writeHead(400).end('{"error":{"message":"fixture failure"}}');
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (content, finish = null) =>
			res.write(
				`data: ${JSON.stringify({
					id: `fixture-${requestCount}`,
					object: "chat.completion.chunk",
					created: 0,
					model: payload.model,
					choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
				})}\n\n`,
			);
		send("fixture result ");
		if (prompt.includes("HOLD_FIXTURE"))
			await new Promise((resolve) => {
				const release = () => {
					gates.delete(release);
					resolve();
				};
				gates.add(release);
				res.once("close", release);
			});
		if (!res.destroyed) {
			send("complete");
			send("", "stop");
			res.end("data: [DONE]\n\n");
		}
	});
	await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
	writeFileSync(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${model.address().port}`,
					apiKey: "synthetic-local-only",
					models: [{ id: "model", name: "Fixture", contextWindow: 32000, maxTokens: 1024, input: ["text"] }],
				},
			},
		}),
	);
	writeFileSync(
		join(agent, "settings.json"),
		JSON.stringify({
			defaultProvider: "fixture",
			defaultModel: "model",
			defaultProjectTrust: "always",
			packages: [],
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	const { ClientSession } = await import("../dist/server/agent-service.js");
	const { ClientStateStore } = await import("../dist/server/client-state.js");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	cs = await ClientSession.create("lifecycle-fixture", work, new ClientStateStore(join(data, "client-state.json")));
	const notices = [];
	cs.attachSink((message) => {
		if (message.type === "notice") notices.push(message.text);
	});
	await cs.setModel("fixture/model");

	// Keep ten actual SDK runs in flight. Creating the next chat must not abort or reject any of them.
	const runs = [],
		ids = [];
	for (let i = 0; i < 10; i++) {
		const before = requestCount;
		const id = cs.activeId;
		runs.push(
			cs.prompt(`HOLD_FIXTURE ${i}`).catch((error) => {
				throw new Error(`Run ${i}: ${error.message}`);
			}),
		);
		await until(() => requestCount > before && cs.session.isStreaming, "real SDK streaming");
		ids.push(id);
		await cs.newChat();
		assert.notEqual(cs.activeId, id, `new chat must remain available after ${i + 1} open runs`);
	}
	assert.equal(ids.length, 10);
	assert.ok(ids.every((id) => cs.convs.get(id)?.session.isStreaming));
	for (const release of [...gates]) release();
	await Promise.all(runs);
	cs.maintenance.reap();
	assert.ok(cs.convs.size <= 8, "idle user runtimes should return to the cache budget");
	assert.ok((await SessionManager.list(work)).length >= 10, "eviction retains persistent history");
	const history = await SessionManager.list(work);
	await cs.switchSession(history[0].path);
	assert.ok(cs.session.getSessionStats().totalMessages > 0, "retired user history can be reopened");
	console.log("PASS ten concurrent user runs, new chat beyond eight, idle eviction, history retained and reopened");

	const childIds = [];
	for (let i = 0; i < 12; i++) {
		const id = await cs.subagentHost.spawnSubagent(`child ${i}`, "review", work);
		childIds.push(id);
		await until(() => cs.subagentHost.getSubagent(id)?.archived, "completed child archived");
		assert.equal(cs.convs.has(id), false);
		assert.match(cs.subagentHost.getSubagent(id).output, /fixture result/);
	}
	assert.ok(childIds.every((id) => cs.subagentHost.getSubagent(id)?.archived));
	const firstId = childIds[0];
	const beforeCount = cs.subagentHost.getSubagent(firstId).messageCount;
	await cs.subagentHost.steerSubagent(firstId, "continue this archived task");
	await until(() => cs.subagentHost.getSubagent(firstId)?.archived, "continued child re-archived");
	assert.ok(cs.subagentHost.getSubagent(firstId).messageCount > beforeCount);
	await cs.switchConversation(firstId);
	assert.equal(cs.activeId, firstId);
	assert.ok(cs.session.getSessionStats().totalMessages > beforeCount);
	await cs.newChat();
	await until(() => !cs.convs.has(firstId), "viewed child archived after leaving");
	console.log("PASS twelve completed subagents retired, results readable, same-id continuation and viewing restored");

	const parallel = [];
	for (let i = 0; i < 8; i++)
		parallel.push(await cs.subagentHost.spawnSubagent(`HOLD_FIXTURE child ${i}`, "review", work));
	await until(() => gates.size === 8, "eight child model requests in flight");
	await assert.rejects(cs.subagentHost.spawnSubagent("ninth child", "review", work), /8/);
	await cs.prompt("user work while eight children run");
	const userId = cs.activeId;
	await cs.newChat();
	assert.notEqual(cs.activeId, userId, "subagent concurrency does not block new user chats");
	for (const release of [...gates]) release();
	await until(() => parallel.every((id) => cs.subagentHost.getSubagent(id)?.archived), "parallel children retired");
	console.log("PASS independent subagent concurrency budget and user chat availability");

	const failedId = await cs.subagentHost.spawnSubagent("FAIL_FIXTURE", "review", work);
	await until(() => cs.subagentHost.getSubagent(failedId)?.archived, "failed child archived");
	assert.ok(cs.subagentHost.getSubagent(failedId).error);
	const stoppedId = await cs.subagentHost.spawnSubagent("HOLD_FIXTURE stop", "review", work);
	await until(() => cs.convs.get(stoppedId)?.session.isStreaming, "cancel candidate started");
	await cs.subagentHost.stopSubagent(stoppedId);
	await until(() => cs.subagentHost.getSubagent(stoppedId)?.archived, "cancelled child archived");
	assert.ok(cs.subagentHost.getSubagent(stoppedId).canceled || cs.subagentHost.getSubagent(stoppedId).error);
	assert.equal(
		notices.some((text) => text.includes("当前项目运行的对话已达上限")),
		false,
	);
	console.log("PASS failed and cancelled subagents retire with outcomes preserved; no obsolete quota notice");

	// DSH uses the same idle-cache policy; no DSH runtime/model is started in this fixture.
	const { DshClientSession } = await import("../dist/server/dsh/dsh-agent-service.js");
	const dsh = Object.create(DshClientSession.prototype);
	const make = (id) => ({
		id,
		fromDisk: true,
		cwd: work,
		messages: [{ id: "message" }],
		isStreaming: false,
		lastEventAt: Date.now(),
		listed: true,
		promptedSinceActive: true,
		dsGoal: null,
		goal: {},
		queue: { steering: [], followUp: [] },
		toolStartTimes: new Map(),
		terminals: { list: () => [], countLive: () => 0, killAll: () => {} },
	});
	Object.assign(dsh, {
		activeId: "d7",
		cwd: work,
		disposed: false,
		model: "fixture",
		convs: new Map(Array.from({ length: 8 }, (_, i) => [`d${i}`, make(`d${i}`)])),
		isQuiesced: () => false,
		emitConversations() {},
		emitGoalStatus() {},
		pushTerminals() {},
		flushSnapshot() {},
		addConversation(id) {
			const conv = make(id);
			this.convs.set(id, conv);
			return conv;
		},
	});
	await dsh.newChat();
	assert.notEqual(dsh.activeId, "d7");
	assert.equal(dsh.convs.size, 8);
	console.log("PASS DSH new-chat path reclaims idle history instead of rejecting the ninth conversation");
	for (const conv of dsh.convs.values()) conv.fromDisk = false;
	dsh.sessionRoot = join(base, "empty-dsh-history");
	await dsh.newChat();
	assert.equal(dsh.convs.size, 9, "unpersisted DSH messages are retained instead of silently evicted");
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	for (const release of [...gates]) release();
	await cs?.dispose();
	model?.closeAllConnections();
	if (model?.listening) await new Promise((resolve) => model.close(resolve));
	clearTimeout(hardStop);
	rmSync(base, { recursive: true, force: true });
}
