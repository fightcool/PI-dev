/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/channel-account.ts（formatAmount = 全局唯一金额口径 +
 *   accountStatusBits = 设置页渠道行的整行文本）,
 *   ../../web/src/components/ChannelRow.tsx（AccountStatusLine 只负责把 bits 用 ` · ` 串起来）,
 *   ../../web/src/components/UsageDetail.tsx / ModelThinking.tsx（余额 chip 与详情走同一口径）
 * 📖 docs/DEV-CON-PROPOSAL.md §7（余额与用量分开、不猜测、缺失不显示为 0）
 * @BUGFIX 2026-09-17 用户投诉：同一行显示 `余额 45.43301698 USD · Used 45.43301698 USD`——
 *   ① 设置页行插原始数字（chip 却是 45.43）＝两套精度；② 标签写 Used 值取的却是
 *   `remaining ?? limit ?? used`，所以余额与「已用」显示成同一个数。这个文件把两点都钉住。
 */
import { describe, expect, it } from "vitest";
import type { UiAccountStatus } from "../../web/src/types";
import { accountStatusBits, balanceTextOf, formatAmount, usedTextOf } from "../../web/src/channel-account.js";

/** 测试用 t()：直接回显键名，断言看的是「哪个标签配了哪个数」而不是具体译文。 */
const t = (k: string) => k;

const status = (patch: Partial<UiAccountStatus>): UiAccountStatus => ({
	accountRef: "a",
	kind: "template",
	status: "ok",
	...patch,
});

describe("formatAmount：全局唯一金额口径", () => {
	it("小数保留 2 位（用户截图里的 45.43301698）", () => {
		expect(formatAmount(45.43301698)).toBe("45.43");
	});

	it("整数不加小数点（47 不写成 47.00）", () => {
		expect(formatAmount(47)).toBe("47");
		expect(formatAmount(0)).toBe("0");
	});

	it("极小正值不写成 0.00（会被读成「没钱了」）", () => {
		expect(formatAmount(0.001)).toBe("<0.01");
		expect(formatAmount(0.0049)).toBe("<0.01");
		// 0.005 起 toFixed(2) 不再是 0.00，按常规显示。
		expect(formatAmount(0.005)).toBe("0.01");
	});

	it("负数照常显示；极小负值给 >-0.01（不写成 -0.00）", () => {
		expect(formatAmount(-12.3456)).toBe("-12.35");
		expect(formatAmount(-0.001)).toBe(">-0.01");
	});

	it("取不到值返回空串——由调用方决定说「未知」还是不显示这一格", () => {
		expect(formatAmount(undefined)).toBe("");
		expect(formatAmount(Number.NaN)).toBe("");
		expect(formatAmount(Number.POSITIVE_INFINITY)).toBe("");
		// 值为空时单位也不该单独冒出来。
		expect(formatAmount(undefined, "USD")).toBe("");
	});

	it("带单位拼「值 单位」", () => {
		expect(formatAmount(45.43301698, "USD")).toBe("45.43 USD");
		expect(formatAmount(47, "CNY")).toBe("47 CNY");
		expect(formatAmount(0.001, "USD")).toBe("<0.01 USD");
	});
});

describe("balanceTextOf / usedTextOf 复用同一口径", () => {
	it("余额走 formatAmount；没有 balance 时退回 quota.remaining", () => {
		expect(balanceTextOf(status({ balance: 45.43301698, unit: "USD" }), t)).toBe("45.43 USD");
		expect(balanceTextOf(status({ quota: { remaining: 12.3456 }, unit: "USD" }), t)).toBe("12.35 USD");
	});

	it("拿不到余额说「未知」，绝不显示 0", () => {
		expect(balanceTextOf(undefined, t)).toBe("channelAccountUnknownBalance");
		expect(balanceTextOf(status({ status: "unsupported" }), t)).toBe("channelAccountUnknownBalance");
	});

	it("已用只认 quota.used，没有就是 null（不拿 remaining/limit 顶替）", () => {
		expect(usedTextOf(status({ quota: { used: 45.43301698 }, unit: "USD" }))).toBe("45.43 USD");
		expect(usedTextOf(status({ quota: { remaining: 10, limit: 100 }, unit: "USD" }))).toBeNull();
		expect(usedTextOf(undefined)).toBeNull();
		// 配额自带单位时优先用它（额度与余额可能不同币种）。
		expect(usedTextOf(status({ quota: { used: 7, unit: "CNY" }, unit: "USD" }))).toBe("7 CNY");
	});
});

describe("accountStatusBits：设置页渠道行的口径", () => {
	it("已用与剩余各占一格，数字与 chip 同精度", () => {
		const bits = accountStatusBits(
			status({ balance: 45.43301698, unit: "USD", quota: { used: 4.5, remaining: 45.43301698 } }),
			t,
		);
		expect(bits).toEqual([
			"channelAccountBalance 45.43 USD",
			"channelAccountKeyQuota 4.50 USD",
			"channelAccountRemaining 45.43 USD",
		]);
	});

	it("没有 quota.used 就不显示「已用」——绝不用 limit 或 remaining 顶替（原 bug）", () => {
		const bits = accountStatusBits(
			status({ balance: 45.43301698, unit: "USD", quota: { limit: 100, remaining: 45.43301698 } }),
			t,
		);
		expect(bits).toEqual(["channelAccountBalance 45.43 USD", "channelAccountRemaining 45.43 USD"]);
		expect(bits.some((b) => b.startsWith("channelAccountKeyQuota"))).toBe(false);
		// 100（limit）绝不出现在这一行里。
		expect(bits.join(" · ")).not.toContain("100");
	});

	it("没有 quota.remaining 就不显示「剩余」这一格", () => {
		expect(accountStatusBits(status({ quota: { used: 47 } }), t)).toEqual(["channelAccountKeyQuota 47"]);
	});

	it("查询时间与 stale 说明按顺序附在后面", () => {
		const at = Date.UTC(2026, 8, 17, 7, 16, 26);
		const bits = accountStatusBits(status({ status: "stale", staleReason: "ttl", balance: 1, checkedAt: at }), t);
		expect(bits[0]).toBe("channelAccountBalance 1");
		expect(bits[1]).toBe(`channelAccountCheckedAt ${new Date(at).toLocaleString()}`);
		expect(bits[2]).toBe("channelAccountStaleTtlTip");
	});

	it("空快照 = 空数组（行里只剩状态标签，不编造 0 或「—」）", () => {
		expect(accountStatusBits(undefined, t)).toEqual([]);
		expect(accountStatusBits(status({ status: "unsupported" }), t)).toEqual([]);
	});
});
