/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/channel-account.ts（channelBalanceBrief），
 *   ../../web/src/components/ModelChannelPicker.tsx（渠道分组头：当前渠道高亮 + 余额/已用）
 * 📖 docs/DEV-CON-PROPOSAL.md §6（选择器）, §7（余额与用量分开、不猜测、缺失不显示为 0）
 * @CONTRACT 这个文件钉住三条用户可见的口径：
 *   ① 没配账户查询的渠道 → configured:false，调用方一格都不显示（绝不拿 0 冒充余额）；
 *   ② 配了但还没查过 → queried:false，如实说「未查询」（不是 0、也不是空白）；
 *   ③ 金额走 formatAmount，与余额 chip / 设置页渠道行是同一个数字（不出现两套精度）；
 *   ④ 「哪个渠道在跑」的口径（channelAccountView）：绑定只在服务商与当下模型一致时才算数
 *      —— 否则界面会把旧渠道的余额挂在别的模型上（用户看到的「用 deepseek 却显示 UU apiClaude」）。
 */
import { describe, expect, it } from "vitest";
import type { UiAccountStatus, UiChannelInfo } from "../../web/src/types";
import { channelAccountView, channelBalanceBrief } from "../../web/src/channel-account.js";

const channel = (patch: Partial<UiChannelInfo> = {}): UiChannelInfo =>
	({
		id: "c1",
		displayName: "渠道一",
		providerId: "p1",
		endpointId: "",
		enabled: true,
		keys: [],
		models: [],
		...patch,
	}) as UiChannelInfo;

const status = (patch: Partial<UiAccountStatus>): UiAccountStatus => ({
	accountRef: "c1",
	kind: "template",
	status: "ok",
	...patch,
});

describe("channelBalanceBrief：模型选择器里的渠道余额摘要", () => {
	it("没配账户查询 → 不显示任何余额信息（不是 0）", () => {
		const brief = channelBalanceBrief(channel(), []);
		expect(brief.configured).toBe(false);
		expect(brief.balance).toBe("");
		expect(brief.used).toBe("");
	});

	it("配了查询但还没查过 → queried:false（调用方写「未查询」）", () => {
		const brief = channelBalanceBrief(channel({ account: { kind: "template" } } as Partial<UiChannelInfo>), []);
		expect(brief.configured).toBe(true);
		expect(brief.queried).toBe(false);
		expect(brief.balance).toBe("");
	});

	it("余额与已用各占一格，金额两位小数（与 chip/设置页同一个数）", () => {
		const brief = channelBalanceBrief(
			channel({ account: { kind: "template" } } as Partial<UiChannelInfo>),
			[status({ balance: 45.43301698, unit: "USD", quota: { used: 12.3456 } })],
		);
		expect(brief.queried).toBe(true);
		expect(brief.balance).toBe("45.43 USD");
		expect(brief.used).toBe("12.35 USD");
		expect(brief.tone).toBe("ok");
	});

	it("没有 balance 时回落到 quota.remaining（与 balanceTextOf 同一口径）", () => {
		const brief = channelBalanceBrief(
			channel({ account: { kind: "template" } } as Partial<UiChannelInfo>),
			[status({ quota: { remaining: 8, used: 2 }, unit: "CNY" })],
		);
		expect(brief.balance).toBe("8 CNY");
		expect(brief.used).toBe("2 CNY");
	});

	it("查询失败 → tone=bad，且不把缺失的余额写成 0", () => {
		const brief = channelBalanceBrief(
			channel({ account: { kind: "template" } } as Partial<UiChannelInfo>),
			[status({ status: "failed", error: "boom" })],
		);
		expect(brief.tone).toBe("bad");
		expect(brief.balance).toBe("");
	});

	it("按 accountRef 取快照（服务端键 = accountRef || channel.id）", () => {
		const brief = channelBalanceBrief(
			channel({ accountRef: "shared-acct", account: { kind: "template" } } as Partial<UiChannelInfo>),
			[status({ accountRef: "shared-acct", balance: 7 })],
		);
		expect(brief.balance).toBe("7");
	});
});

describe("channelAccountView：绑定与当下模型不一致时不冒充当前渠道", () => {
	const withAccount = (patch: Partial<UiChannelInfo> = {}): UiChannelInfo =>
		channel({ account: { kind: "template" } as never, ...patch });

	it("绑定服务商 == 当下模型服务商 → 用绑定渠道（正常路径）", () => {
		const view = channelAccountView({
			channels: [withAccount({ id: "ch-3", providerId: "uu-api" })],
			accounts: [],
			binding: { effective: { channelId: "ch-3" } } as never,
			modelProvider: "uu-api",
		});
		expect(view.channel?.id).toBe("ch-3");
		expect(view.derived).toBe(false);
	});

	it("绑定服务商 != 当下模型服务商 → 拒绝该绑定，反推到真正在跑的渠道", () => {
		// 真实事故：绑定还挂在 ch-3(uu-api)，模型已经换成 deepseek/deepseek-flash。
		const view = channelAccountView({
			channels: [
				withAccount({ id: "ch-3", providerId: "uu-api" }),
				withAccount({ id: "ch-deepseek", providerId: "deepseek" }),
			],
			accounts: [],
			binding: { effective: { channelId: "ch-3" } } as never,
			modelProvider: "deepseek",
		});
		expect(view.channel?.id).toBe("ch-deepseek");
		expect(view.derived).toBe(true);
	});

	it("拒绝绑定且该服务商没有唯一可查渠道 → 如实说没有渠道（不硬撑一个）", () => {
		const view = channelAccountView({
			channels: [
				withAccount({ id: "ch-3", providerId: "uu-api" }),
				withAccount({ id: "ch-d1", providerId: "deepseek" }),
				withAccount({ id: "ch-d2", providerId: "deepseek" }),
			],
			accounts: [],
			binding: { effective: { channelId: "ch-3" } } as never,
			modelProvider: "deepseek",
		});
		expect(view.channel).toBeNull();
		expect(view.derived).toBe(false);
	});

	it("拿不到当下模型时不判负：仍然按绑定显示（缺信息不藏东西）", () => {
		const view = channelAccountView({
			channels: [withAccount({ id: "ch-3", providerId: "uu-api" })],
			accounts: [],
			binding: { effective: { channelId: "ch-3" } } as never,
			modelProvider: null,
		});
		expect(view.channel?.id).toBe("ch-3");
	});
});
