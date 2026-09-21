/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../../web/src/gateway-usage.ts（被测件：金额格式与读数归属）,
 *            ../../web/src/components/GatewayUsageBlock.tsx（唯一展示方）,
 *            ../../server/dev-con/gateway-usage.ts（数字的来源与口径）
 *   📖 docs/NEWAPI-GATEWAY.md §4（网关自报 vs 本地估算：为什么不能相加；累计 vs 窗口）
 *   @CONTRACT 钉住两条会直接误导用户的规则：
 *     ① 小额金额不得被四舍五入成 $0.00（看起来像「没花钱」——那是错的信息）；
 *     ② windowDays 缺省时必须说「累计」，不得默认成「近 N 天」。
 * ──────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";
import {
	GATEWAY_USAGE_STALE_MS,
	formatUsd,
	gatewayUsageBelongsTo,
	gatewayUsageFacts,
	isGatewayUsageStale,
} from "../../web/src/gateway-usage.js";
import type { UiGatewayUsage } from "../../web/src/types.js";

const base: UiGatewayUsage = {
	providerId: "newapi",
	providerName: "NewAPI 网关",
	baseUrl: "https://api.ftai.cc",
	usedUsd: 0.0011296,
	limitUsd: null,
	remainingUsd: null,
	unlimited: true,
	checkedAt: Date.UTC(2026, 8, 21, 12, 0, 0),
};

describe("formatUsd（金额精度）", () => {
	it("小额给足精度：$0.0011 不能显示成 $0.00", () => {
		expect(formatUsd(0.0011296)).toBe("$0.0011");
		expect(formatUsd(0.421)).toBe("$0.421");
		expect(formatUsd(12.3456)).toBe("$12.35");
	});

	it("0 与缺失分开：0 是「真的没花钱」，缺失是「没报告」（返回 null）", () => {
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(null)).toBeNull();
		expect(formatUsd(undefined)).toBeNull();
		expect(formatUsd(Number.NaN)).toBeNull();
	});
});

describe("gatewayUsageFacts（口径措辞）", () => {
	it("windowDays 缺省 = 累计（该部署忽略日期窗口，写成「近 30 天」就是替网关说谎）", () => {
		expect(gatewayUsageFacts(base)?.scope).toBe("cumulative");
		expect(gatewayUsageFacts(base)?.windowDays).toBeNull();
	});

	it("只有网关真的按窗口统计时才说窗口", () => {
		expect(gatewayUsageFacts({ ...base, windowDays: 30 })?.scope).toBe("window");
		expect(gatewayUsageFacts({ ...base, windowDays: 0 })?.scope).toBe("cumulative");
	});

	it("不限额度时总额度/剩余都是 null（界面据此只说已用，不编余额）", () => {
		const facts = gatewayUsageFacts(base);
		expect(facts?.unlimited).toBe(true);
		expect(facts?.limitText).toBeNull();
		expect(facts?.remainingText).toBeNull();
		expect(facts?.usedText).toBe("$0.0011");
	});

	it("没有读数时返回 null（界面写「还没读过」，不显示 0）", () => {
		expect(gatewayUsageFacts(null)).toBeNull();
		expect(gatewayUsageFacts(undefined)).toBeNull();
	});
});

describe("gatewayUsageBelongsTo（读数归属）", () => {
	it("换服务商后旧读数不再算当前网关的（否则会把上一个网关的余额当现在这个）", () => {
		expect(gatewayUsageBelongsTo(base, "newapi")).toBe(true);
		expect(gatewayUsageBelongsTo(base, "openrouter")).toBe(false);
		expect(gatewayUsageBelongsTo(base, null)).toBe(false);
		expect(gatewayUsageBelongsTo(null, "newapi")).toBe(false);
	});
});

describe("isGatewayUsageStale（滞后提示）", () => {
	it("超过阈值算旧；没有 checkedAt 一律算旧", () => {
		expect(isGatewayUsageStale(base, base.checkedAt + 1000)).toBe(false);
		expect(isGatewayUsageStale(base, base.checkedAt + GATEWAY_USAGE_STALE_MS + 1)).toBe(true);
		expect(isGatewayUsageStale({ ...base, checkedAt: undefined as unknown as number })).toBe(true);
		expect(isGatewayUsageStale(null)).toBe(true);
	});
});
