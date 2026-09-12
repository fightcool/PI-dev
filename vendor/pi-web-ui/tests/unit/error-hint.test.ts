/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/error-hint.ts（报错卡的渠道归属与「人话」化）
 * 📖 docs/DEV-CON-PROPOSAL.md §7（失败状态如实展示：查不到就说查不到，不猜测、不编造）
 * @CONTRACT 这里钉死两件事：
 *   1) 认识的上游失败（new-api / one-api / OpenAI 的额度不足）能被识别并取出网关自报的剩余额度；
 *   2) **认不出的报错一律 kind=null**（调用方原样显示），渠道归属在「多义」时必须返回 null，不能猜。
 *   ⚠️ 报错原文里的 request id 是噪音：解析必须能容忍 JSON 后面追加的尾巴，否则真实报错会退化成原文。
 */
import { describe, expect, it } from "vitest";
import { channelErrorView, channelOfError, upstreamErrorFacts } from "../../web/src/error-hint.js";
import type { UiChannelInfo } from "../../web/src/types.js";

/** 真实报错原文（实测自 www.cctq.ai 的 new-api 网关，request id 已替换为占位）。 */
const CCTQ_QUOTA_ERROR =
	'OpenAI API error (403): {"message":"用户额度不足, 剩余额度: ¥-0.013362 (request id: 202609121538353343706438268d9d6vAofL5Y9)","type":"new_api_error","param":"","code":"insufficient_user_quota"}';

function channel(over: Partial<UiChannelInfo> & { id: string }): UiChannelInfo {
	return {
		displayName: over.id,
		providerId: "cctq",
		endpointId: "default",
		credentialRef: null,
		accountRef: null,
		enabled: true,
		models: [],
		keys: [],
		keyMissing: false,
		providerMissing: false,
		...over,
	};
}

const CHANNELS: UiChannelInfo[] = [
	channel({ id: "ch-cctq", displayName: "CCTQ 网关", providerId: "cctq" }),
	channel({
		id: "ch-1",
		displayName: "CCCQclaude",
		providerId: "CCQTCC",
		models: ["claude-opus-5"],
		account: { kind: "openai-gateway", topupUrl: "https://www.cctq.ai/console/topup" },
	}),
];

describe("上游报错识别", () => {
	it("认出网关的用户额度不足，并取出网关自报的剩余额度", () => {
		const facts = upstreamErrorFacts(CCTQ_QUOTA_ERROR);
		expect(facts.kind).toBe("quota");
		expect(facts.status).toBe(403);
		expect(facts.code).toBe("insufficient_user_quota");
		expect(facts.remaining).toBe("¥-0.013362");
	});

	it("认得 OpenAI 风格的嵌套结构与 insufficient_quota", () => {
		const facts = upstreamErrorFacts('OpenAI API error (429): {"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}');
		expect(facts.kind).toBe("quota");
		expect(facts.status).toBe(429);
		expect(facts.code).toBe("insufficient_quota");
		expect(facts.remaining).toBeNull();
	});

	it("只有文字、没有 code 时也认得（欠费/余额不足）", () => {
		expect(upstreamErrorFacts("Anthropic API error (402): 账户余额不足，请充值").kind).toBe("quota");
	});

	it("认不出的报错：kind=null，绝不改写（调用方按原文显示）", () => {
		const raw = 'OpenAI API error (503): {"error":{"message":"No available channel for model gpt-5.3-codex-spark under group CodeX专用"}}';
		const facts = upstreamErrorFacts(raw);
		expect(facts.kind).toBeNull();
		expect(facts.status).toBe(503);
	});

	it("不是 JSON 的报错不会抛异常", () => {
		expect(upstreamErrorFacts("fetch failed").kind).toBeNull();
		expect(upstreamErrorFacts("").kind).toBeNull();
	});
});

describe("报错属于哪个渠道", () => {
	it("服务商唯一匹配时给出渠道", () => {
		expect(channelOfError({ provider: "cctq", channels: CHANNELS })?.displayName).toBe("CCTQ 网关");
	});

	it("绑定优先：同服务商有多个渠道时按当前对话绑定取", () => {
		const both = [channel({ id: "ch-a", displayName: "A" }), channel({ id: "ch-b", displayName: "B" })];
		expect(channelOfError({ provider: "cctq", channels: both, boundChannelId: "ch-b" })?.displayName).toBe("B");
		// 没有绑定 → 多义不猜（宁可退回 providerId，也不显示错的渠道名）
		expect(channelOfError({ provider: "cctq", channels: both })).toBeNull();
	});

	it("同服务商多渠道时用模型白名单消歧", () => {
		const a = channel({ id: "ch-a", displayName: "A", models: ["gpt-6-astra"] });
		const b = channel({ id: "ch-b", displayName: "B", models: ["gpt-5.6-sol"] });
		expect(channelOfError({ provider: "cctq", modelId: "gpt-5.6-sol", channels: [a, b] })?.displayName).toBe("B");
	});

	it("没有服务商信息（非模型调用报错）时不指派渠道", () => {
		expect(channelOfError({ provider: null, channels: CHANNELS })).toBeNull();
	});
});

describe("报错卡视图", () => {
	it("CCTQ 实测那条：渠道名 + 模型 + 剩余额度 + 充值页一站齐", () => {
		const view = channelErrorView({
			errorMessage: CCTQ_QUOTA_ERROR,
			provider: "cctq",
			modelId: "gpt-6-astra",
			channels: CHANNELS,
			boundChannelId: "ch-cctq",
		});
		expect(view).toMatchObject({
			kind: "quota",
			channelName: "CCTQ 网关",
			providerId: "cctq",
			modelId: "gpt-6-astra",
			remaining: "¥-0.013362",
		});
	});

	it("换到 CCCQclaude 的模型不会串到另一个渠道（本次误判的根因）", () => {
		const view = channelErrorView({
			errorMessage: CCTQ_QUOTA_ERROR,
			provider: "CCQTCC",
			modelId: "claude-opus-5",
			channels: CHANNELS,
		});
		expect(view.channelName).toBe("CCCQclaude");
		expect(view.topupUrl).toBe("https://www.cctq.ai/console/topup");
	});
});
