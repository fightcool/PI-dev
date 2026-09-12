/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/channel-service.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §4/§5/§9/§10（A01 凭据隔离、A02 冲突可见、A03 切换时点、A04 组合命令、A05 版本）
 * 用假宿主覆盖服务语义：两个对话/两把 key 的隔离、待生效、被取代、冲突、默认值继承。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "../../server/protocol.js";
import { ChannelService, type ChannelServiceHost } from "../../server/dev-con/channel-service.js";
import { loadCatalog, channelStorePath } from "../../server/dev-con/channel-store.js";
import { readFileSync, writeFileSync } from "node:fs";

type Receipt = Extract<ServerMessage, { type: "channel_command_result" }>;
type State = Extract<ServerMessage, { type: "channel_state" }>;

/** 假宿主：两个对话 + 一个 provider + 两把命名密钥。 */
function makeHost(dir: string, clientId = "test-client") {
	const emitted: ServerMessage[] = [];
	const busy = new Set<string>();
	const queued = new Set<string>();
	const messages = new Map<string, number>();
	const conversations = new Set(["c1", "c2"]);
	const models: Record<string, string> = { "main/m1": "Model 1", "main/m2": "Model 2", "other/x": "X" };
	const applied: { conversationId: string; modelId: string }[] = [];
	/** 渠道表单写入服务商的调用记录（验证顺序与 payload）。 */
	const providerWrites: { providerId: string; api?: string; baseUrl?: string; apiKey?: string; models?: { id: string }[] }[] = [];
	/** 已注册服务商（upsertProvider 成功后会真的“注册”，供 hasProvider 用）。 */
	const providers = new Set(["main", "other"]);
	/** 测试钩子：在“写服务商”与“写渠道”之间做外部修改（验证部分失败可辨识）。 */
	const hooks: { onProviderWrite?: () => void } = {};
	const host: ChannelServiceHost = {
		agentDir: dir,
		clientId,
		emit: (msg) => emitted.push(msg),
		broadcast: (msg) => emitted.push(msg),
		flushSnapshot: () => undefined,
		hasProvider: (id) => providers.has(id),
		providerIds: () => [...providers],
		upsertProvider: async (input) => {
			providerWrites.push(input);
			if (input.baseUrl === "boom") return { ok: false, error: "服务商写入失败" };
			hooks.onProviderWrite?.();
			providers.add(input.providerId);
			return { ok: true };
		},
		resolveProviderKey: async (providerId) => (providerId === "main" ? "provider-own-key" : null),
		getModel: (providerId, modelId) => (models[`${providerId}/${modelId}`] ? { id: modelId, name: models[`${providerId}/${modelId}`] } : null),
		keyNames: (providerId) =>
			providerId === "main"
				? [
						{ keyName: "密钥 1", active: true },
						{ keyName: "密钥 2", active: false },
					]
				: [],
		resolveKeyValue: (providerId, keyName) => (providerId === "main" ? { "密钥 1": "sk-one", "密钥 2": "sk-two" }[keyName] ?? null : null),
		setConversationModel: async (conversationId, modelId) => {
			if (!conversations.has(conversationId)) throw new Error("对话不存在");
			if (!models[modelId]) throw new Error(`模型不存在：${modelId}`);
			applied.push({ conversationId, modelId });
		},
		activeConversationId: () => "c1",
		conversationExists: (id) => conversations.has(id),
		isBusy: (id) => busy.has(id),
		hasQueue: (id) => queued.has(id),
		conversationHasMessages: (id) => (messages.get(id) ?? 0) > 0,
		cwd: () => "/proj",
	};
	const receipts = () => emitted.filter((m): m is Receipt => m.type === "channel_command_result");
	const lastReceipt = (commandId: string) => receipts().filter((r) => r.commandId === commandId).at(-1);
	const lastState = () => emitted.filter((m): m is State => m.type === "channel_state").at(-1);
	return {
		host,
		applied,
		providerWrites,
		hooks,
		receipts,
		lastReceipt,
		lastState,
		setBusy: (id: string, value: boolean) => (value ? busy.add(id) : busy.delete(id)),
		setQueued: (id: string, value: boolean) => (value ? queued.add(id) : queued.delete(id)),
		setMessages: (id: string, count: number) => messages.set(id, count),
	};
}

const channelDraft = (id: string, keyName: string | null) => ({
	id,
	displayName: `渠道 ${id}`,
	providerId: "main",
	endpointId: "default",
	credentialRef: keyName ? { providerId: "main", keyName } : null,
	accountRef: null,
	enabled: true,
	extra: {},
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-dev-channelsvc-"));
});

describe("channel service — configuration", () => {
	it("saves a channel, persists it and rejects a stale config revision", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "cmd-1", channel: channelDraft("ch-1", "密钥 1") });
		expect(h.lastReceipt("cmd-1")?.ok).toBe(true);
		expect(h.lastReceipt("cmd-1")?.configRevision).toBe(1);
		expect(loadCatalog(dir).catalog.channels.map((c) => c.id)).toEqual(["ch-1"]);

		// 别人先改过（revision 已前进）→ 旧基准提交必须 conflict。
		await svc.saveChannel({ commandId: "cmd-2", channel: channelDraft("ch-2", null), expectedConfigRevision: 0 });
		expect(h.lastReceipt("cmd-2")).toMatchObject({ ok: false, phase: "conflict" });
		expect(loadCatalog(dir).catalog.channels.map((c) => c.id)).toEqual(["ch-1"]);
	});

	it("rejects unknown providers, unknown credentials and bad ids without touching disk", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "a", channel: { ...channelDraft("ch-1", null), providerId: "nope" } });
		expect(h.lastReceipt("a")?.error).toContain("未在模型中注册");
		await svc.saveChannel({ commandId: "b", channel: channelDraft("ch-1", "密钥 9") });
		expect(h.lastReceipt("b")?.error).toContain("命名凭据不存在");
		await svc.saveChannel({ commandId: "c", channel: { ...channelDraft("ch-1", null), id: "BAD_ID" } });
		expect(h.lastReceipt("c")?.ok).toBe(false);
		expect(loadCatalog(dir).exists).toBe(false);
	});

	it("deletes a channel and detaches the conversations bound to it", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "sel", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		expect(h.lastReceipt("sel")?.phase).toBe("applied");
		await svc.deleteChannel({ commandId: "d", channelId: "ch-1" });
		expect(h.lastReceipt("d")?.ok).toBe(true);
		const catalog = loadCatalog(dir).catalog;
		expect(catalog.channels).toEqual([]);
		expect(catalog.bindings).toEqual({});
	});
});

describe("channel service — provider + channel in one command", () => {
	const providerDraft = {
		api: "anthropic-messages",
		baseUrl: "https://www.cctq.ai",
		apiKey: "sk-new",
		models: [{ id: "claude-opus-5" }],
	};

	it("creates the provider (id slugged from the name) and the channel together", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({
			commandId: "new",
			channel: { ...channelDraft("ch-claude", null), displayName: "CCTQ Claude", providerId: "" },
			provider: providerDraft,
		});
		expect(h.lastReceipt("new")).toMatchObject({ ok: true, phase: "applied" });
		// 服务商 id 由显示名 slug 生成，渠道引用它（不再要求先去「管理模型」建一遍）。
		expect(h.providerWrites).toHaveLength(1);
		expect(h.providerWrites[0]).toMatchObject({ providerId: "cctq-claude", api: "anthropic-messages", baseUrl: "https://www.cctq.ai", apiKey: "sk-new" });
		const saved = loadCatalog(dir).catalog.channels;
		expect(saved.map((c) => c.providerId)).toEqual(["cctq-claude"]);
	});

	it("keeps the given provider id and whitelist, and does not touch the channel when the provider fails", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({
			commandId: "id-given",
			channel: { ...channelDraft("ch-a", null), providerId: "cc1q", models: ["claude-opus-5"] },
			provider: { ...providerDraft, providerId: "cc1q" },
		});
		expect(h.lastReceipt("id-given")?.ok).toBe(true);
		expect(h.providerWrites[0].providerId).toBe("cc1q");
		expect(loadCatalog(dir).catalog.channels[0]).toMatchObject({ providerId: "cc1q", models: ["claude-opus-5"] });

		// 服务商写失败 → 渠道不能落盘（先写 models.json，后写 channels.json）。
		const before = loadCatalog(dir).catalog.channels.length;
		await svc.saveChannel({
			commandId: "boom",
			channel: { ...channelDraft("ch-b", null), providerId: "broken" },
			provider: { ...providerDraft, baseUrl: "boom", providerId: "broken" },
		});
		expect(h.lastReceipt("boom")).toMatchObject({ ok: false, phase: "rejected" });
		expect(h.lastReceipt("boom")?.error).toContain("服务商未写入，渠道未保存");
		expect(loadCatalog(dir).catalog.channels).toHaveLength(before);
	});

	it("names the partial failure when the provider landed but a concurrent edit blocked the channel", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "seed", channel: channelDraft("ch-1", "密钥 1") });
		// 模拟「写服务商期间别的客户端改了 channels.json」→ commitConfig 检测到外部修改。
		h.hooks.onProviderWrite = () => {
			const catalog = loadCatalog(dir);
			writeFileSync(
				channelStorePath(dir),
				JSON.stringify({ ...catalog.catalog, configRevision: 99, channels: [...catalog.catalog.channels] }, null, 2),
			);
		};
		await svc.saveChannel({
			commandId: "partial",
			channel: { ...channelDraft("ch-2", null), providerId: "cc1q" },
			provider: { ...providerDraft, providerId: "cc1q" },
		});
		const receipt = h.lastReceipt("partial");
		expect(receipt).toMatchObject({ ok: false, phase: "conflict" });
		expect(receipt?.error).toContain("服务商已保存");
	});
});

describe("channel service — combined selection", () => {
	it("applies immediately when idle and confirms the effective binding", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "sel", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		const receipt = h.lastReceipt("sel");
		expect(receipt).toMatchObject({ ok: true, phase: "applied", conversationId: "c1", channelId: "ch-1" });
		expect(receipt?.binding).toMatchObject({ modelId: "main/m1", credentialRef: { providerId: "main", keyName: "密钥 1" }, bindingRevision: 1 });
		expect(h.applied).toEqual([{ conversationId: "c1", modelId: "main/m1" }]);
		expect(svc.bindingViewMessage("c1").effective?.channelName).toBe("渠道 ch-1");
	});

	it("keeps two conversations on two different keys without touching the other one", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s1", channel: channelDraft("ch-a", "密钥 1") });
		await svc.saveChannel({ commandId: "s2", channel: channelDraft("ch-b", "密钥 2") });
		await svc.select({ commandId: "p", conversationId: "c1", selection: { channelId: "ch-a", modelId: "main/m1" } });
		await svc.select({ commandId: "q", conversationId: "c2", selection: { channelId: "ch-b", modelId: "main/m2" } });
		// A01：并行对话各自绑定自己的渠道/密钥，互不影响。
		expect(svc.credentialFor("c1", "main")).toBe("sk-one");
		expect(svc.credentialFor("c2", "main")).toBe("sk-two");
		expect(svc.credentialFor("c1", "main")).not.toBe(svc.credentialFor("c2", "main"));
		expect(svc.bindingViewMessage("c1").effective?.modelId).toBe("main/m1");
		expect(svc.bindingViewMessage("c2").effective?.modelId).toBe("main/m2");
		// 未绑定的对话不使用任何命名凭据（回落到全局解析）。
		expect(svc.credentialFor("c3", "main")).toBeUndefined();
	});

	it("defers the switch while streaming and applies it after the run settles", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "first", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		h.setBusy("c1", true);
		await svc.select({ commandId: "second", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m2" } });
		const pendingReceipt = h.lastReceipt("second");
		expect(pendingReceipt).toMatchObject({ ok: true, phase: "pending" });
		// A03：在途请求/工具仍按原绑定；有效值不变，待生效值可见。
		expect(h.applied).toHaveLength(1);
		expect(svc.bindingViewMessage("c1").effective?.modelId).toBe("main/m1");
		expect(svc.bindingViewMessage("c1").pending?.modelId).toBe("main/m2");
		expect(svc.credentialFor("c1", "main")).toBe("sk-one");
		expect(h.lastState()?.pending?.[0]).toMatchObject({ conversationId: "c1", modelId: "main/m2" });

		h.setBusy("c1", false);
		await svc.onConversationSettled("c1");
		expect(h.applied).toEqual([
			{ conversationId: "c1", modelId: "main/m1" },
			{ conversationId: "c1", modelId: "main/m2" },
		]);
		expect(h.lastReceipt("second")).toMatchObject({ ok: true, phase: "applied" });
		expect(svc.bindingViewMessage("c1").effective?.modelId).toBe("main/m2");
		expect(svc.bindingViewMessage("c1").pending).toBeNull();
	});

	it("marks a superseded pending selection instead of pretending both succeeded", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		h.setBusy("c1", true);
		await svc.select({ commandId: "p1", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		await svc.select({ commandId: "p2", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m2" } });
		expect(h.lastReceipt("p1")).toMatchObject({ ok: false, phase: "superseded" });
		expect(h.lastReceipt("p2")).toMatchObject({ ok: true, phase: "pending" });
		h.setBusy("c1", false);
		await svc.onConversationSettled("c1");
		expect(h.applied).toEqual([{ conversationId: "c1", modelId: "main/m2" }]);
	});

	it("keeps the previous binding when the switch fails", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "ok", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		h.setMessages("c1", 3);
		await svc.select({ commandId: "bad", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/missing" } });
		expect(h.lastReceipt("bad")).toMatchObject({ ok: false, phase: "rejected", conversationId: "c1" });
		expect(h.lastReceipt("bad")?.error).toContain("模型不存在");
		expect(svc.bindingViewMessage("c1").effective?.modelId).toBe("main/m1");
	});

	it("rejects a stale binding revision and a model outside the channel provider", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "a", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		await svc.select({ commandId: "b", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m2" }, expectedBindingRevision: 0 });
		expect(h.lastReceipt("b")).toMatchObject({ ok: false, phase: "conflict" });
		await svc.select({ commandId: "c", conversationId: "c1", selection: { channelId: "ch-1", modelId: "other/x" } });
		expect(h.lastReceipt("c")?.error).toContain("不属于该渠道的服务商");
	});

	it("clears a binding on request", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "a", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		await svc.clearBinding({ commandId: "clear", conversationId: "c1" });
		expect(h.lastReceipt("clear")).toMatchObject({ ok: true, phase: "applied" });
		expect(svc.bindingViewMessage("c1").effective).toBeNull();
		expect(svc.credentialFor("c1", "main")).toBeUndefined();
	});
});

describe("channel service — defaults, persistence and requests", () => {
	it("lets a fresh conversation inherit the project default but never rebinds a used one", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.setDefault({ commandId: "d", scope: "project", selection: { channelId: "ch-1", modelId: "main/m1" } });
		expect(h.lastReceipt("d")).toMatchObject({ ok: true, phase: "applied" });
		// 未发言的新对话继承默认（来源标 project）。
		expect(svc.effectiveSelectionFor("c1")).toMatchObject({ source: "project" });
		expect(svc.credentialFor("c1", "main")).toBe("sk-one");
		// 已经跑过的对话不被新默认悄悄重绑（§4/A03）。
		h.setMessages("c2", 2);
		expect(svc.effectiveSelectionFor("c2")).toMatchObject({ source: "none", selection: null });
		expect(svc.credentialFor("c2", "main")).toBeUndefined();
	});

	it("survives a restart: a new service instance sees the persisted channels and bindings", async () => {
		const h = makeHost(dir);
		const first = new ChannelService(h.host);
		await first.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 2") });
		await first.select({ commandId: "a", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m2" } });

		const restarted = new ChannelService(h.host);
		expect(restarted.credentialFor("c1", "main")).toBe("sk-two");
		expect(restarted.bindingViewMessage("c1").effective?.modelId).toBe("main/m2");
	});

	it("carries the channel binding to a new chat and can be detected as explicit", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "a", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		expect(svc.hasConversationBinding("c1")).toBe(true);
		expect(svc.hasConversationBinding("c2")).toBe(false);
		svc.inheritBinding("c1", "c2");
		// 新对话拿到同一个渠道/凭据/模型，但是独立的一条绑定。
		expect(svc.hasConversationBinding("c2")).toBe(true);
		expect(svc.bindingViewMessage("c2").effective).toMatchObject({ channelId: "ch-1", modelId: "main/m1" });
		expect(svc.credentialFor("c2", "main")).toBe("sk-one");
		expect(svc.bindingViewMessage("c2").effective?.bindingRevision).not.toBe(svc.bindingViewMessage("c1").effective?.bindingRevision);
		// 没有来源绑定时不会凭空生成绑定。
		svc.inheritBinding("c3", "c4");
		expect(svc.hasConversationBinding("c4")).toBe(false);
	});

	it("records the request-time binding snapshot for usage attribution", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "a", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		expect(svc.bindingSnapshotFor("c1")).toMatchObject({
			channelId: "ch-1",
			credentialKeyName: "密钥 1",
			modelId: "main/m1",
			providerId: "main",
			bindingRevision: 1,
		});
		expect(svc.bindingSnapshotFor("c2")).toBeNull();
	});

	it("never writes key material into channels.json", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		await svc.select({ commandId: "a", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		const text = readFileSync(channelStorePath(dir), "utf8");
		expect(text).not.toContain("sk-one");
		expect(text).not.toContain("apiKey");
	});

	it("surfaces an external file change as a conflict and recovers after refresh (A02)", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		expect(h.lastReceipt("s")?.configRevision).toBe(1);

		// 外部工具直接改了 channels.json（另一个进程/人手编辑）。
		const onDisk = JSON.parse(readFileSync(channelStorePath(dir), "utf8"));
		onDisk.channels.push(channelDraft("ch-ext", null));
		onDisk.configRevision = 7;
		writeFileSync(channelStorePath(dir), JSON.stringify(onDisk, null, 2) + "\n");

		// 本端用旧版本提交 → 必须 conflict，且不得静默覆盖外部编辑。
		await svc.saveChannel({ commandId: "stale", channel: channelDraft("ch-2", null), expectedConfigRevision: 1 });
		expect(h.lastReceipt("stale")).toMatchObject({ ok: false, phase: "conflict" });
		expect(loadCatalog(dir).catalog.channels.map((c) => c.id).sort()).toEqual(["ch-1", "ch-ext"]);

		// 收到 conflict 后服务已经对齐磁盘，再用新版本重试就能成功（可恢复）。
		const fresh = h.lastState();
		expect(fresh?.configRevision).toBe(7);
		await svc.saveChannel({
			commandId: "retry",
			channel: channelDraft("ch-2", null),
			expectedConfigRevision: h.lastReceipt("stale")?.configRevision,
		});
		expect(h.lastReceipt("retry")?.ok).toBe(true);
		expect(loadCatalog(dir).catalog.channels.map((c) => c.id).sort()).toEqual(["ch-1", "ch-2", "ch-ext"]);
	});

	it("keeps bindings of two clients apart even when both use conversation id c1", async () => {
		const a = makeHost(dir, "client-a");
		const svcA = new ChannelService(a.host);
		await svcA.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		const b = makeHost(dir, "client-b");
		const svcB = new ChannelService(b.host);
		// 两个客户端都会把自己的第一个对话叫 c1 —— 存储键必须按 clientId 分开。
		await svcA.select({ commandId: "a1", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m1" } });
		await svcB.select({ commandId: "b1", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m2" } });
		const catalog = loadCatalog(dir).catalog;
		expect(catalog.bindings["client-a::c1"]?.modelId).toBe("main/m1");
		expect(catalog.bindings["client-b::c1"]?.modelId).toBe("main/m2");
		// 每端只看到自己的对话绑定，且 conversationId 已剥掉前缀。
		expect(svcA.bindingViewMessage("c1").effective?.modelId).toBe("main/m1");
		expect(svcB.bindingViewMessage("c1").effective?.modelId).toBe("main/m2");
		expect(a.lastState()?.bindings.map((x) => x.conversationId)).toEqual(["c1"]);
		expect(a.lastState()?.bindings.map((x) => x.modelId)).toEqual(["main/m1"]);
	});

	it("merges bindings written by another client instead of clobbering them", async () => {
		const h = makeHost(dir);
		const svc = new ChannelService(h.host);
		await svc.saveChannel({ commandId: "s", channel: channelDraft("ch-1", "密钥 1") });
		// 另一端（独立实例，共享同一个 agentDir）先写了自己的绑定。
		const other = new ChannelService(makeHost(dir, "other-client").host);
		await other.select({ commandId: "other", conversationId: "c2", selection: { channelId: "ch-1", modelId: "main/m1" } });
		// 本端随后写自己的绑定 → 两边的绑定都要在文件里。
		await svc.select({ commandId: "mine", conversationId: "c1", selection: { channelId: "ch-1", modelId: "main/m2" } });
		const catalog = loadCatalog(dir).catalog;
		expect(catalog.bindings["other-client::c2"]?.modelId).toBe("main/m1");
		expect(catalog.bindings["test-client::c1"]?.modelId).toBe("main/m2");
	});
});
