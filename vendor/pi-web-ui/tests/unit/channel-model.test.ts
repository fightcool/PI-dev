/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/channel-model.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §4/§5（配置所有权、切换时点、版本复核）
 * 纯逻辑单测：覆盖规格里可判定的部分（优先级、时点、版本、脱敏、无损失去、绑定是否覆盖当下模型）。
 */
import { describe, expect, it } from "vitest";
import {
	bindingCoversModel,
	checkBindingRevision,
	checkConfigRevision,
	defaultCatalog,
	detachChannel,
	findSecretMaterial,
	isValidChannelId,
	isValidProviderId,
	makeBinding,
	nextChannelId,
	normalizeChannelRecord,
	providerIdFromName,
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
	models: [],
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
			bindings: {
				c1: makeBinding({
					conversationId: "c1",
					selection: selection("ch-1"),
					configRevision: 3,
					bindingRevision: 7,
					now: 1,
				}),
			},
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
		expect(validateChannelRecord(channel("ch-1", { credentialRef: { providerId: "other", keyName: "k" } }))).toContain(
			"凭据引用的服务商与渠道不一致",
		);
	});
	it("rejects a model that does not belong to the channel provider", () => {
		const errors = validateSelection(selection("ch-1", "other/m1"), channel("ch-1"));
		expect(errors).toContain("所选模型不属于该渠道的服务商");
		expect(validateSelection(selection("ch-1"), channel("ch-1"))).toEqual([]);
	});
	it("enforces the channel model whitelist only when it is non-empty", () => {
		const limited = channel("ch-1", { models: ["m1"] });
		expect(validateSelection(selection("ch-1", "main/m1"), limited)).toEqual([]);
		expect(validateSelection(selection("ch-1", "main/m2"), limited)).toContain("模型不在该渠道的可用列表内：main/m2");
		// 空白名单 = 不限制（向后兼容：老渠道没有这个字段也不能被锁死）。
		expect(validateSelection(selection("ch-1", "main/m2"), channel("ch-1"))).toEqual([]);
		expect(normalizeChannelRecord({ id: "ch-2", providerId: "main", models: ["a", "", 3, "b"] })?.models).toEqual([
			"a",
			"b",
		]);
		expect(normalizeChannelRecord({ id: "ch-3", providerId: "main" })?.models).toEqual([]);
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

	it("allows only the account template's declarative request headers (placeholders, no literal keys)", () => {
		// 账户模板的 request.headers 是声明式请求头：值必须是占位符/短常量 → 放行。
		const template = {
			kind: "template",
			request: { url: "{baseUrl}/v1/usage", headers: { authorization: "Bearer {apiKey}", accept: "application/json" } },
			map: { remaining: "balance" },
		};
		expect(findSecretMaterial({ channels: [{ id: "ch-1", extra: { account: template } }] })).toEqual([]);
		// 同一位置写明文密钥 → 照旧拒绝（窄豁免只看值的形状，不是无条件放过路径）。
		const leaky = {
			kind: "template",
			request: { url: "https://x", headers: { authorization: "Bearer sk-0123456789abcdef" } },
			map: { remaining: "balance" },
		};
		expect(findSecretMaterial({ channels: [{ id: "ch-1", extra: { account: leaky } }] })).toEqual([
			"channels[0].extra.account.request.headers",
			"channels[0].extra.account.request.headers.authorization",
		]);
		// 别处的 headers 不在豁免范围内。
		expect(findSecretMaterial({ channels: [{ extra: { headers: { authorization: "Bearer {apiKey}" } } }] })).toEqual([
			"channels[0].extra.headers",
			"channels[0].extra.headers.authorization",
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
				c1: makeBinding({
					conversationId: "c1",
					selection: selection("ch-1"),
					configRevision: 1,
					bindingRevision: 1,
					now: 1,
				}),
				c2: makeBinding({
					conversationId: "c2",
					selection: selection("ch-2"),
					configRevision: 1,
					bindingRevision: 2,
					now: 2,
				}),
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
				makeBinding({
					conversationId: `c${i}`,
					selection: selection("ch-1"),
					configRevision: 1,
					bindingRevision: i,
					now: i,
				}),
			]),
		);
		const pruned = pruneBindings(bindings, 2);
		expect(Object.keys(pruned).sort()).toEqual(["c3", "c4"]);
	});
});

describe("充值链接校验（会作为 href 渲染）", () => {
	const base = (extra: Record<string, unknown>) => ({
		id: "ch-1",
		displayName: "渠道",
		providerId: "main",
		endpointId: "default",
		credentialRef: null,
		accountRef: null,
		models: [],
		enabled: true,
		extra,
	});
	it("accepts http(s) and rejects anything else", () => {
		expect(validateChannelRecord(base({ account: { kind: "template", topupUrl: "https://x.example/topup" } }))).toEqual(
			[],
		);
		const bad = validateChannelRecord(base({ account: { kind: "template", topupUrl: "javascript:alert(1)" } }));
		expect(bad.join()).toContain("充值链接必须是 http(s) 地址");
		expect(
			validateChannelRecord(base({ account: { kind: "template", topupUrl: "data:text/html,x" } })).join(),
		).toContain("充值链接必须是 http(s)");
	});
	it("treats an empty value as not configured", () => {
		expect(validateChannelRecord(base({ account: { kind: "template", topupUrl: "" } }))).toEqual([]);
		expect(validateChannelRecord(base({ account: { kind: "template" } }))).toEqual([]);
	});
});

describe("provider id generation (channel form → models.json)", () => {
	it("slugifies a display name into a provider id", () => {
		expect(providerIdFromName("CCTQ Claude")).toBe("cctq-claude");
		expect(providerIdFromName("  My   Gateway / v2  ")).toBe("my-gateway-v2");
	});
	it("avoids collisions with existing ids", () => {
		expect(providerIdFromName("CCTQ Claude", ["cctq-claude"])).toBe("cctq-claude-2");
		expect(providerIdFromName("CCTQ Claude", ["cctq-claude", "cctq-claude-2"])).toBe("cctq-claude-3");
	});
	it("falls back when the name has no usable ascii (中文/emoji) or is empty", () => {
		expect(providerIdFromName("米醋claude")).toBe("claude");
		expect(providerIdFromName("")).toBe("provider-1");
		expect(providerIdFromName("", ["provider-1"])).toBe("provider-2");
		expect(providerIdFromName("测试")).toBe("provider-1");
	});
	it("only accepts safe provider ids", () => {
		expect(isValidProviderId("cctq-claude_1.x")).toBe(true);
		expect(isValidProviderId("bad id")).toBe(false);
		expect(isValidProviderId("")).toBe(false);
	});
});

describe("bindingCoversModel（绑定是否仍描述当下的请求）", () => {
	it("服务商不符即不成立（模型被渠道以外的路径换掉后的常态）", () => {
		// 真实事故：绑定 ch-3(uu-api)，模型却被 set_model 换成了 deepseek/deepseek-flash。
		const ch = channel("ch-3", { providerId: "uu-api", models: ["claude-opus-5"] });
		expect(
			bindingCoversModel({ channelId: "ch-3", modelId: "uu-api/claude-opus-5" }, ch, "deepseek/deepseek-flash"),
		).toBe(false);
	});
	it("同一渠道白名单内换模型仍然成立（不该把绑定清掉）", () => {
		const ch = channel("ch-2", { providerId: "rightcode", models: ["gpt-5.6-sol", "gpt-6-astra"] });
		expect(
			bindingCoversModel({ channelId: "ch-2", modelId: "rightcode/gpt-5.6-sol" }, ch, "rightcode/gpt-6-astra"),
		).toBe(true);
	});
	it("空白名单 = 不限模型，只按服务商判定", () => {
		const ch = channel("ch-1", { providerId: "main", models: [] });
		expect(bindingCoversModel({ channelId: "ch-1", modelId: "main/m1" }, ch, "main/m2")).toBe(true);
		expect(bindingCoversModel({ channelId: "ch-1", modelId: "main/m1" }, ch, "other/x")).toBe(false);
	});
	it("白名单挡住的同服务商模型也不成立（渠道白名单是配置，不是摆设）", () => {
		const ch = channel("ch-1", { providerId: "main", models: ["m1"] });
		expect(bindingCoversModel({ channelId: "ch-1", modelId: "main/m1" }, ch, "main/m2")).toBe(false);
	});
	it("模型未知时不判负（缺信息宁可保留绑定，也不替用户清）", () => {
		const ch = channel("ch-1", { providerId: "main" });
		expect(bindingCoversModel({ channelId: "ch-1", modelId: "main/m1" }, ch, null)).toBe(true);
		expect(bindingCoversModel({ channelId: "ch-1", modelId: "main/m1" }, ch, undefined)).toBe(true);
		expect(bindingCoversModel({ channelId: "ch-1", modelId: "main/m1" }, ch, "")).toBe(true);
	});
	it("渠道不存在 / 无 channelId 时不成立", () => {
		expect(bindingCoversModel({ channelId: "ch-x", modelId: "main/m1" }, undefined, "main/m1")).toBe(false);
		expect(bindingCoversModel({ channelId: "", modelId: "main/m1" }, channel("ch-1"), "main/m1")).toBe(false);
	});
	it("模型 ref 没有 provider 前缀时按裸模型 id 判定（与用量归属同一口径）", () => {
		const ch = channel("ch-1", { providerId: "main", models: ["m1"] });
		expect(bindingCoversModel({ channelId: "ch-1", modelId: "main/m1" }, ch, "m1")).toBe(true);
		expect(bindingCoversModel({ channelId: "ch-1", modelId: "main/m1" }, ch, "m2")).toBe(false);
	});
});
