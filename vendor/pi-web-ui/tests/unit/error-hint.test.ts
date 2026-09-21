/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/error-hint.ts（报错卡的渠道归属与「人话」化）
 * 📖 docs/DEV-CON-PROPOSAL.md §7（失败状态如实展示：查不到就说查不到，不猜测、不编造）
 * @CONTRACT 这里钉死两件事：
 *   1) 认识的上游失败（new-api / one-api / OpenAI 的额度不足）能被识别并取出网关自报的剩余额度；
 *   2) **认不出的报错一律 kind=null**（调用方原样显示），渠道归属在「多义」时必须返回 null，不能猜。
 *   ⚠️ 报错原文里的 request id 是噪音：解析必须能容忍 JSON 后面追加的尾巴，否则真实报错会退化成原文。
 */
import { describe, expect, it } from "vitest";
import { upstreamErrorFacts, upstreamErrorView } from "../../web/src/error-hint.js";

/** 真实报错原文（实测自 www.cctq.ai 的 new-api 网关，request id 已替换为占位）。 */
const CCTQ_QUOTA_ERROR =
	'OpenAI API error (403): {"message":"用户额度不足, 剩余额度: ¥-0.013362 (request id: 202609121538353343706438268d9d6vAofL5Y9)","type":"new_api_error","param":"","code":"insufficient_user_quota"}';



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

describe("报错卡视图（服务商 + 模型 + 人话原因）", () => {
	it("CCTQ 实测那条：认得类别、带上剩余额度与服务商/模型", () => {
		const view = upstreamErrorView({
			errorMessage: CCTQ_QUOTA_ERROR,
			provider: "cctq",
			modelId: "gpt-6-astra",
		});
		expect(view).toMatchObject({
			kind: "quota",
			providerId: "cctq",
			modelId: "gpt-6-astra",
			remaining: "¥-0.013362",
		});
	});

	it("认不出的报错：kind=null，调用方按原文显示（不编造原因）", () => {
		const view = upstreamErrorView({ errorMessage: "fetch failed", provider: "newapi", modelId: "deepseek-flash" });
		expect(view.kind).toBeNull();
		expect(view.providerId).toBe("newapi");
		expect(view.modelId).toBe("deepseek-flash");
	});

	it("没有服务商/模型信息时两个字段都是 null（不指派、不猜）", () => {
		const view = upstreamErrorView({ errorMessage: CCTQ_QUOTA_ERROR });
		expect(view.providerId).toBeNull();
		expect(view.modelId).toBeNull();
	});
});
