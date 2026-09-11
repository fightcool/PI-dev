/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/account-template.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §7（余额/配额：带单位与状态）与 §8 P3（账户查询）
 * 覆盖：JSON 路径（含数组下标）、字符串/数字金额、单对象与多币种数组、缩放与单位、
 *       is_available 语义、缺字段必须失败（绝不把缺失当 0）、预设齐全且可渲染。
 */
import { describe, expect, it } from "vitest";
import {
	ACCOUNT_TEMPLATE_PRESETS,
	accountTemplateOf,
	applyAccountTemplate,
	readPath,
	renderTemplateText,
	toNumber,
} from "../../server/dev-con/account-template.js";
import type { ChannelRecord } from "../../server/dev-con/channel-model.js";

const channelWith = (account: unknown): ChannelRecord => ({
	id: "ch-1", displayName: "渠道", providerId: "p", endpointId: "default", credentialRef: null,
	accountRef: null, models: [], enabled: true, extra: { account },
});

describe("template path + value parsing", () => {
	it("reads dotted paths with array indexes and never invents values", () => {
		const body = { data: { list: [{ quota: "10.50" }, { quota: 2 }] }, is_available: false };
		expect(readPath(body, "data.list[0].quota")).toBe("10.50");
		expect(readPath(body, "data.list[1].quota")).toBe(2);
		expect(readPath(body, "data.missing.quota")).toBeUndefined();
		expect(readPath(body, "data.list[9].quota")).toBeUndefined();
		expect(readPath(body, undefined)).toBeUndefined();
		expect(toNumber("3.50")).toBe(3.5);
		expect(toNumber("")).toBeUndefined();
		expect(toNumber(null)).toBeUndefined();
		expect(toNumber("abc")).toBeUndefined();
	});

	it("renders {baseUrl}/{apiKey} placeholders", () => {
		expect(renderTemplateText("{baseUrl}/api/user/self?k={apiKey}", { baseUrl: "https://gw", apiKey: "secret" }))
			.toBe("https://gw/api/user/self?k=secret");
	});
});

describe("applyAccountTemplate", () => {
	it("maps a DeepSeek-shaped payload (multi-currency array, string amounts)", () => {
		const result = applyAccountTemplate(
			{ kind: "template", url: "x", items: { path: "balance_infos", currency: "currency", total: "total_balance", granted: "granted_balance", toppedUp: "topped_up_balance" }, mapping: { available: "is_available" } },
			{ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] },
		);
		expect(result).toMatchObject({ status: "ok", unit: "CNY", balance: 110, note: "接口标注：余额不足以继续调用" });
		expect(result.breakdown).toEqual([{ currency: "CNY", total: 110, granted: 10, toppedUp: 100 }]);
	});

	it("maps a gateway-shaped payload with scale and unit", () => {
		const result = applyAccountTemplate(
			{ kind: "template", url: "x", mapping: { limit: "data.quota", used: "data.used_quota", remaining: "data.quota", scope: "data.display_name" }, scale: 500000, unit: "USD" },
			{ data: { quota: 5_000_000, used_quota: 1_000_000, display_name: "acc" } },
		);
		expect(result).toMatchObject({ status: "ok", unit: "USD", balance: 10, scope: "acc" });
		expect(result.quota).toEqual({ used: 2, limit: 10, remaining: 10, unit: "USD" });
	});

	it("fails honestly when the mapping resolves nothing (missing != 0)", () => {
		expect(applyAccountTemplate({ kind: "template", url: "x", mapping: { balance: "nope" } }, {})).toMatchObject({ status: "failed" });
		expect(applyAccountTemplate({ kind: "template", url: "x", items: { path: "list", total: "total_balance" } }, { list: [{ currency: "CNY" }] })).toMatchObject({ status: "failed" });
		expect(applyAccountTemplate({ kind: "template", url: "x", items: { path: "list", total: "v" } }, { list: "not-an-array" })).toMatchObject({ status: "failed" });
	});

	it("prefers the configured unit among multiple currency entries", () => {
		const result = applyAccountTemplate(
			{ kind: "template", url: "x", unit: "CNY", items: { path: "infos", currency: "currency", total: "total" } },
			{ infos: [{ currency: "USD", total: 3 }, { currency: "CNY", total: 25 }] },
		);
		expect(result).toMatchObject({ unit: "CNY", balance: 25 });
		expect(result.breakdown?.map((entry) => entry.currency)).toEqual(["USD", "CNY"]);
	});

	it("recognizes only real templates (kind=template or a mapping/items) with a URL", () => {
		expect(accountTemplateOf(channelWith({ kind: "template", url: "https://x", mapping: { balance: "b" } }))).not.toBeNull();
		expect(accountTemplateOf(channelWith({ kind: "template", mapping: { balance: "b" } }))).toBeNull();
		expect(accountTemplateOf(channelWith({ kind: "deepseek" }))).toBeNull();
		expect(accountTemplateOf(channelWith(null))).toBeNull();
	});
});

describe("built-in presets", () => {
	it("ships DeepSeek / gateway / OpenRouter presets that actually parse a representative payload", () => {
		const ids = ACCOUNT_TEMPLATE_PRESETS.map((preset) => preset.id);
		expect(ids).toEqual(["deepseek", "openai-gateway", "openrouter"]);
		const deepseek = ACCOUNT_TEMPLATE_PRESETS[0].template;
		expect(applyAccountTemplate({ ...deepseek, kind: "template" } as never, { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "1.00" }] }))
			.toMatchObject({ status: "ok", unit: "CNY", balance: 1 });
		const gateway = ACCOUNT_TEMPLATE_PRESETS[1].template;
		expect(applyAccountTemplate({ ...gateway, kind: "template" } as never, { data: { quota: 1_000_000, used_quota: 0 } }))
			.toMatchObject({ status: "ok", unit: "USD", balance: 2 });
		const openrouter = ACCOUNT_TEMPLATE_PRESETS[2].template;
		expect(applyAccountTemplate({ ...openrouter, kind: "template" } as never, { data: { total_credits: 20, total_usage: 5 } }))
			.toMatchObject({ status: "ok", unit: "USD", balance: 20 });
	});
});
