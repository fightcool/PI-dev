/*
 * 🍞 @COUPLED server/dev-con/model-capability.ts, server/model-admin.ts
 * @CONTRACT 回归：渠道 /models 只返回 {id, object} 时（RightCode 实测），
 *   写入模型目录的条目必须带上 reasoning，否则 SDK 的
 *   getSupportedThinkingLevels() 只返回 ["off"]，UI 把思考强度三档全禁用。
 */
import { describe, expect, it } from "vitest";
import { KNOWN_MODEL_CAPABILITIES, backfillModelCapability, knownCapabilityOf } from "../../server/dev-con/model-capability.js";

describe("knownCapabilityOf", () => {
	it("认得 gpt-6-astra 并给出 reasoning 与 thinkingLevelMap", () => {
		const cap = knownCapabilityOf("gpt-6-astra");
		expect(cap?.reasoning).toBe(true);
		expect(cap?.thinkingLevelMap?.low).toBe("low");
		expect(cap?.thinkingLevelMap?.medium).toBe("medium");
		expect(cap?.thinkingLevelMap?.high).toBe("high");
	});

	it("off/minimal 显式置空 = 不提供这两档", () => {
		const map = knownCapabilityOf("gpt-6-astra")?.thinkingLevelMap;
		expect(map?.off).toBeNull();
		expect(map?.minimal).toBeNull();
	});

	it("空 id 与未知模型都返回 undefined（不猜）", () => {
		expect(knownCapabilityOf("")).toBeUndefined();
		expect(knownCapabilityOf("   ")).toBeUndefined();
		expect(knownCapabilityOf("some-unregistered-model")).toBeUndefined();
	});

	it("表里每个条目的 reasoning 都必须是布尔值", () => {
		for (const [id, cap] of Object.entries(KNOWN_MODEL_CAPABILITIES)) {
			expect(typeof cap.reasoning, id).toBe("boolean");
		}
	});
});

describe("backfillModelCapability", () => {
	it("把只有 id 的条目补成可推理模型（这就是 RightCode 的修法）", () => {
		const out = backfillModelCapability({ id: "gpt-6-astra" });
		expect(out.reasoning).toBe(true);
		expect(out.contextWindow).toBe(1050000);
		expect(out.input).toEqual(["text", "image"]);
		expect((out.thinkingLevelMap as Record<string, unknown>)?.low).toBe("low");
	});

	it("不覆盖用户已填的字段（显式配置优先）", () => {
		const out = backfillModelCapability({ id: "gpt-6-astra", contextWindow: 32000, reasoning: true });
		expect(out.contextWindow).toBe(32000);
	});

	it("显式的 reasoning:false 必须保留，不能被回填成 true", () => {
		const out = backfillModelCapability({ id: "gpt-6-astra", reasoning: false });
		expect(out.reasoning).toBe(false);
	});

	it("未登记的模型原样返回（未知 ≠ 不支持）", () => {
		const entry = { id: "brand-new-model" };
		const out = backfillModelCapability(entry);
		expect(out).toEqual(entry);
		expect("reasoning" in out).toBe(false);
	});

	it("不修改入参（返回新对象）", () => {
		const entry: Record<string, unknown> = { id: "gpt-6-astra" };
		const out = backfillModelCapability({ ...entry, id: "gpt-6-astra" });
		expect(out).not.toBe(entry);
		expect(entry.reasoning).toBeUndefined();
	});

	it("不回填 cost：价格随渠道浮动，猜错会显示假花费", () => {
		const out = backfillModelCapability({ id: "gpt-6-astra" });
		expect("cost" in out).toBe(false);
	});

	it("补出来的 thinkingLevelMap 是副本，改它不会污染表", () => {
		const a = backfillModelCapability({ id: "gpt-6-astra" });
		(a.thinkingLevelMap as Record<string, unknown>).low = "tampered";
		const b = backfillModelCapability({ id: "gpt-6-astra" });
		expect((b.thinkingLevelMap as Record<string, unknown>).low).toBe("low");
	});
});
