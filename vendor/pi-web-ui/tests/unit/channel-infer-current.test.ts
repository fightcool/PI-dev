/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/channel-models.ts（inferChannelIdByModel / switcherChannels），
 *   ../../web/src/components/ModelChannelPicker.tsx（没有对话绑定时的当前渠道回退 + 切换器过滤），
 *   ../channel-picker-current-ui-test.mjs（同一行为的浏览器级验证）
 * 📖 docs/DEV-CON-PROPOSAL.md §6（选择器）
 * @CONTRACT 这个文件钉住两件事：
 *   ① 「没有对话绑定时怎么判断当前渠道」：命中唯一渠道 → 返回它（用户反馈的「有模型却一个高亮
 *      都没有」就是缺了这一步）；命中多个 → 返回 null，宁可不高亮，绝不把用户没选的渠道标成
 *      「正在使用」；白名单要参与过滤。
 *   ② 「切换器里列哪些渠道」：停用（enabled:false）的不列；服务商缺失/凭据缺失的**必须**列。
 */
import { describe, expect, it } from "vitest";
import type { ModelInfo, UiChannelInfo } from "../../web/src/types";
import { bindingCoversActiveModel, inferChannelIdByModel, switcherChannels } from "../../web/src/channel-models.js";

const chan = (id: string, providerId: string, models: string[] = []): UiChannelInfo => ({
	id,
	displayName: id,
	providerId,
	endpointId: "",
	enabled: true,
	keys: [],
	models,
	credentialRef: null,
	accountRef: "",
	keyMissing: false,
	providerMissing: false,
});

const model = (id: string, provider: string): ModelInfo => ({ id, name: id, provider }) as ModelInfo;

describe("inferChannelIdByModel", () => {
	it("命中唯一渠道时返回该渠道", () => {
		const channels = [chan("ch-a", "prov-a"), chan("ch-b", "prov-b")];
		const models = [model("opus-5", "prov-a"), model("astra-6", "prov-b")];
		expect(inferChannelIdByModel(channels, models, "opus-5")).toBe("ch-a");
		expect(inferChannelIdByModel(channels, models, "astra-6")).toBe("ch-b");
	});

	it("同一模型命中多个渠道时不猜（返回 null）", () => {
		// 两个渠道指向同一个服务商 —— 真实配置里很常见（同服务商配不同密钥/端点）。
		const channels = [chan("ch-a", "prov-a"), chan("ch-a2", "prov-a")];
		const models = [model("opus-5", "prov-a")];
		expect(inferChannelIdByModel(channels, models, "opus-5")).toBeNull();
	});

	it("白名单参与过滤：模型不在白名单里的渠道不算命中", () => {
		// ch-a2 限定只用 sonnet → opus-5 只应命中 ch-a，反推回到唯一。
		const channels = [chan("ch-a", "prov-a"), chan("ch-a2", "prov-a", ["sonnet-5"])];
		const models = [model("opus-5", "prov-a"), model("sonnet-5", "prov-a")];
		expect(inferChannelIdByModel(channels, models, "opus-5")).toBe("ch-a");
		// 反过来 sonnet-5 两个渠道都允许（ch-a 空白名单 = 不限）→ 有歧义，不猜。
		expect(inferChannelIdByModel(channels, models, "sonnet-5")).toBeNull();
	});

	it("没有生效模型时返回 null", () => {
		const channels = [chan("ch-a", "prov-a")];
		const models = [model("opus-5", "prov-a")];
		expect(inferChannelIdByModel(channels, models, null)).toBeNull();
		expect(inferChannelIdByModel(channels, models, undefined)).toBeNull();
		expect(inferChannelIdByModel(channels, models, "")).toBeNull();
	});

	it("模型不属于任何渠道时返回 null", () => {
		const channels = [chan("ch-a", "prov-a")];
		const models = [model("opus-5", "prov-a")];
		expect(inferChannelIdByModel(channels, models, "unknown-model")).toBeNull();
	});

	it("没有渠道时返回 null", () => {
		expect(inferChannelIdByModel([], [model("opus-5", "prov-a")], "opus-5")).toBeNull();
	});
});

describe("switcherChannels（切换器列出哪些渠道）", () => {
	it("停用的渠道不进切换器", () => {
		const off = { ...chan("ch-off", "prov-a"), enabled: false };
		expect(switcherChannels([chan("ch-a", "prov-a"), off]).map((c) => c.id)).toEqual(["ch-a"]);
	});

	it("服务商缺失 / 凭据缺失的渠道保留（那是要用户去修的问题，不能默默消失）", () => {
		const gone = { ...chan("ch-gone", "ghost"), providerMissing: true };
		const keyless = { ...chan("ch-key", "prov-a"), keyMissing: true };
		expect(switcherChannels([gone, keyless]).map((c) => c.id)).toEqual(["ch-gone", "ch-key"]);
	});

	it("enabled 缺失（老快照/夹具）按启用处理：缺字段绝不藏东西", () => {
		const legacy = { ...chan("ch-legacy", "prov-a") } as Partial<UiChannelInfo>;
		delete legacy.enabled;
		expect(switcherChannels([legacy as UiChannelInfo]).map((c) => c.id)).toEqual(["ch-legacy"]);
	});

	it("全停用 → 空列表（调用方自己决定空态文案）", () => {
		expect(switcherChannels([{ ...chan("ch-off", "prov-a"), enabled: false }])).toEqual([]);
	});
});

describe("bindingCoversActiveModel（绑定还算不算数）", () => {
	it("服务商不符即不算数（用户看到的「跑 deepseek 却显示 UU apiClaude」）", () => {
		const ch = chan("ch-3", "uu-api", ["claude-opus-5"]);
		expect(
			bindingCoversActiveModel(ch, { channelId: "ch-3", modelId: "uu-api/claude-opus-5" }, "deepseek/deepseek-flash"),
		).toBe(false);
	});

	it("同一渠道白名单内换模型仍然算数（不该把用户的渠道选择抹掉）", () => {
		const ch = chan("ch-2", "rightcode", ["gpt-5.6-sol", "gpt-6-astra"]);
		expect(
			bindingCoversActiveModel(ch, { channelId: "ch-2", modelId: "rightcode/gpt-5.6-sol" }, "rightcode/gpt-6-astra"),
		).toBe(true);
	});

	it("白名单挡住的同服务商模型不算数；空白名单 = 不限，只看服务商", () => {
		expect(
			bindingCoversActiveModel(
				chan("ch-a", "prov-a", ["m1"]),
				{ channelId: "ch-a", modelId: "prov-a/m1" },
				"prov-a/m2",
			),
		).toBe(false);
		expect(
			bindingCoversActiveModel(chan("ch-a", "prov-a"), { channelId: "ch-a", modelId: "prov-a/m1" }, "prov-a/m2"),
		).toBe(true);
	});

	it("实际模型未知时不判负（缺字段绝不藏东西）", () => {
		expect(bindingCoversActiveModel(chan("ch-a", "prov-a"), { channelId: "ch-a", modelId: "prov-a/m1" }, null)).toBe(
			true,
		);
		expect(
			bindingCoversActiveModel(chan("ch-a", "prov-a"), { channelId: "ch-a", modelId: "prov-a/m1" }, undefined),
		).toBe(true);
		expect(bindingCoversActiveModel(chan("ch-a", "prov-a"), { channelId: "ch-a", modelId: "prov-a/m1" }, "")).toBe(
			true,
		);
	});

	it("渠道不存在或没有 channelId 时不算数", () => {
		expect(bindingCoversActiveModel(undefined, { channelId: "ch-x", modelId: "prov-a/m1" }, "prov-a/m1")).toBe(false);
		expect(
			bindingCoversActiveModel(chan("ch-a", "prov-a"), { channelId: null, modelId: "prov-a/m1" }, "prov-a/m1"),
		).toBe(false);
		expect(bindingCoversActiveModel(chan("ch-a", "prov-a"), null, "prov-a/m1")).toBe(false);
	});

	it("模型 id 有多个斜杠时按第一个斜杠切服务商（同 bareModelId 口径）", () => {
		const ch = chan("ch-gw", "openrouter", ["vendor/model"]);
		expect(
			bindingCoversActiveModel(
				ch,
				{ channelId: "ch-gw", modelId: "openrouter/vendor/model" },
				"openrouter/vendor/model",
			),
		).toBe(true);
	});
});
