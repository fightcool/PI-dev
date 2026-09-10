/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/channel-model.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §4/§5（配置所有权、切换时点、版本复核）
 * 纯逻辑单测：覆盖规格里可判定的部分（优先级、时点、版本、脱敏、无损失去）。
 */
import { describe, expect, it } from "vitest";
import {
	checkBindingRevision,
	checkConfigRevision,
	defaultCatalog,
	detachChannel,
	findSecretMaterial,
	isValidChannelId,
	makeBinding,
	nextChannelId,
	normalizeChannelRecord,
	parseModelRef,
	planSwitch,
	pruneBindings,
	resolveEffectiveSelection,
	sameSelection,
	validateChannelRecord,
	validateSelection,
	type ChannelCatalog,
	type ChannelRecord,
} from "../../server/dev-con/channel-model.js";

const channel = (id: string, extra: Partial<ChannelRecord> = {}): ChannelRecord => ({
	id,
	displayName: `渠道 ${id}`,
	providerId: "main",
	endpointId: "default",
	credentialRef: null,
	accountRef: null,
	enabled: true,
	extra: {},
	...extra,
});

const selection = (channelId: string, modelId = "main/m1") => ({
	channelId,
	endpointId: "default",
	credentialRef: null,
	modelId,
});

describe("model refs and ids", () => {
	it("splits provider/model only on the first slash and rejects malformed refs", () => {
		expect(parseModelRef("main/m1")).toEqual({ providerId: "main", modelId: "m1" });
		expect(parseModelRef("main/sub/m1")).toEqual({ providerId: "main", modelId: "sub/m1" });
		expect(parseModelRef("m1")).toBeNull();
		expect(parseModelRef("/m1")).toBeNull();
		expect(parseModelRef("main/")).toBeNull();
	});
	it("accepts only slug-like channel ids and generates unused ones", () => {
		expect(isValidChannelId("ch-1")).toBe(true);
		expect(isValidChannelId("Ch_1")).toBe(false);
		expect(isValidChannelId("a")).toBe(false);
		expect(nextChannelId([channel("ch-1"), channel("ch-2")])).toBe("ch-3");
	});
});

describe("effective selection precedence", () => {
	const catalog: ChannelCatalog = {
		...defaultCatalog(),
		channels: [channel("ch-1"), channel("ch-2")],
		instanceDefault: selection("ch-2"),
		projectDefaults: { "/proj": selection("ch-1") },
		bindings: {},
	};
	it("prefers the conversation binding over any default", () => {
		const withBinding: ChannelCatalog = {
			...catalog,
			bindings: { c1: makeBinding({ conversationId: "c1", selection: selection("ch-1"), configRevision: 3, bindingRevision: 7, now: 1 }) },
		};
		const resolved = resolveEffectiveSelection(withBinding, "c1", "/proj");
		expect(resolved.source).toBe("conversation");
		expect(resolved.binding?.bindingRevision).toBe(7);
	});
	it("falls back to project default, then instance default, then none", () => {
		expect(resolveEffectiveSelection(catalog, "c9", "/proj").source).toBe("project");
		expect(resolveEffectiveSelection(catalog, "c9", "/other").source).toBe("instance");
		expect(resolveEffectiveSelection({ ...catalog, instanceDefault: null }, "c9", "/other").source).toBe("none");
	});
	it("compares selections including the credential ref", () => {
		expect(sameSelection(selection("ch-1"), selection("ch-1"))).toBe(true);
		expect(
			sameSelection(selection("ch-1"), {
				...selection("ch-1"),
				credentialRef: { providerId: "main", keyName: "密钥 1" },
			}),
		).toBe(false);
	});
});

describe("switch timing (P0 conclusion)", () => {
	it("applies immediately when idle and defers when busy or queued", () => {
		expect(planSwitch({ busy: false, hasQueue: false })).toEqual({ mode: "apply" });
		expect(planSwitch({ busy: true, hasQueue: false })).toEqual({ mode: "pending", reason: "streaming" });
		expect(planSwitch({ busy: false, hasQueue: true })).toEqual({ mode: "pending", reason: "queue" });
	});
	it("rejects stale config and binding revisions but allows an unversioned submit", () => {
		expect(checkConfigRevision(5, 5).ok).toBe(true);
		expect(checkConfigRevision(5, undefined).ok).toBe(true);
		expect(checkConfigRevision(5, 4)).toEqual({ ok: false, kind: "conflict" });
		expect(checkConfigRevision(5, 1.5)).toEqual({ ok: false, kind: "missing" });
		expect(checkBindingRevision(2, 2).ok).toBe(true);
		expect(checkBindingRevision(2, 3)).toEqual({ ok: false, kind: "conflict" });
	});
});

describe("channel records", () => {
	it("validates required fields and duplicate ids", () => {
		expect(validateChannelRecord(channel("ch-1"))).toEqual([]);
		expect(validateChannelRecord({ ...channel("ch-1"), displayName: "  " })).toContain("渠道名称不能为空");
		expect(validateChannelRecord(channel("ch-1"), [channel("ch-1")]).join()).toContain("已存在");
		expect(
			validateChannelRecord(channel("ch-1", { credentialRef: { providerId: "other", keyName: "k" } })),
		).toContain("凭据引用的服务商与渠道不一致");
	});
	it("rejects a model that does not belong to the channel provider", () => {
		const errors = validateSelection(selection("ch-1", "other/m1"), channel("ch-1"));
		expect(errors).toContain("所选模型不属于该渠道的服务商");
		expect(validateSelection(selection("ch-1"), channel("ch-1"))).toEqual([]);
	});
	it("normalizes unknown fields into extra instead of dropping them", () => {
		const normalized = normalizeChannelRecord({
			id: "ch-9",
			providerId: "main",
			futureField: { nested: true },
			extra: { kept: 1 },
		});
		expect(normalized?.extra).toEqual({ kept: 1, futureField: { nested: true } });
		expect(normalized?.endpointId).toBe("default");
		expect(normalizeChannelRecord({ providerId: "main" })).toBeNull();
	});
});

describe("secret material guard", () => {
	it("flags every credential-shaped field so channels.json can never store a second key source", () => {
		expect(findSecretMaterial({ channels: [channel("ch-1")] })).toEqual([]);
		expect(findSecretMaterial({ channels: [{ apiKey: "sk-x" }] })).toEqual(["channels[0].apiKey"]);
		expect(findSecretMaterial({ extra: { nested: { token: "t" } } })).toEqual(["extra.nested.token"]);
		expect(findSecretMaterial({ a: [{ key: "k" }, { headers: { authorization: "b" } }] })).toEqual([
			"a[0].key",
			"a[1].headers",
			"a[1].headers.authorization",
		]);
	});
});

describe("maintenance", () => {
	it("detaches bindings and defaults when a channel is deleted", () => {
		const catalog: ChannelCatalog = {
			...defaultCatalog(),
			channels: [channel("ch-1"), channel("ch-2")],
			instanceDefault: selection("ch-1"),
			projectDefaults: { "/a": selection("ch-1"), "/b": selection("ch-2") },
			bindings: {
				c1: makeBinding({ conversationId: "c1", selection: selection("ch-1"), configRevision: 1, bindingRevision: 1, now: 1 }),
				c2: makeBinding({ conversationId: "c2", selection: selection("ch-2"), configRevision: 1, bindingRevision: 2, now: 2 }),
			},
		};
		const { catalog: next, detachedConversations } = detachChannel(catalog, "ch-1");
		expect(detachedConversations).toEqual(["c1"]);
		expect(next.channels.map((c) => c.id)).toEqual(["ch-2"]);
		expect(next.instanceDefault).toBeNull();
		expect(next.projectDefaults).toEqual({ "/a": null, "/b": selection("ch-2") });
		expect(Object.keys(next.bindings)).toEqual(["c2"]);
	});
	it("keeps only the most recently used bindings", () => {
		const bindings = Object.fromEntries(
			Array.from({ length: 5 }, (_, i) => [
				`c${i}`,
				makeBinding({ conversationId: `c${i}`, selection: selection("ch-1"), configRevision: 1, bindingRevision: i, now: i }),
			]),
		);
		const pruned = pruneBindings(bindings, 2);
		expect(Object.keys(pruned).sort()).toEqual(["c3", "c4"]);
	});
});
