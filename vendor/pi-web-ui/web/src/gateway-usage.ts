/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/FooterBar.tsx（状态栏网关项）, components/UsageDetail.tsx（用量面板网关区）,
 *            components/GatewaySettings.tsx（设置 → 网关）, components/JevRuntimeView.tsx（Jev 余额行）,
 *            use-chat.ts（state.gatewayUsage）, server/dev-con/gateway-usage.ts（数字的来源与口径）
 *   📖 docs/NEWAPI-GATEWAY.md（接口事实、单位换算、实测证据）
 *   @CONTRACT 纯函数：只把 UiGatewayUsage 翻译成**可显示的文本事实**，不发请求、不持有状态。
 *             调用方（状态栏/面板/设置）共用同一份口径，避免三处各写一套数字格式与措辞。
 *   @GOTCHA 金额精度：网关自报的量级可以很小（实测 api.ftai.cc 首次接入时是 $0.0011）。
 *             一律 toFixed(2) 会显示成 $0.00 —— 看起来像「没花钱」，是**错的信息**，不是小瑕疵。
 *   @GOTCHA 「累计」还是「近 N 天」：windowDays 缺省时必须说累计。该部署忽略日期窗口
 *             （实测 2020 年的窗口与不带窗口同值），写成「近 30 天」就是替网关说谎。
 *   @GOTCHA 这是**网关自报**，与 stats.cost（本地按 token × 价目表估算）不是一回事：
 *             同一批请求两边数字可以差好几倍（网关实价与模型目录价目表可以不同）。
 *             界面必须分开显示、且**绝不相加**（见 docs/NEWAPI-GATEWAY.md §4）。
 * ──────────────────────────────────────────────────
 */
import type { UiGatewayUsage } from "./types";

/** @MAGIC 超过这个时长没更新，界面就把数字标成「可能滞后」（网关账单本身也滞后 3–6s）。 */
export const GATEWAY_USAGE_STALE_MS = 15 * 60_000;

/**
 * USD 金额文本；无法表示时返回 null（调用方说「未报告」，不写 $0.00）。
 * @WHY 按量级选精度：<0.01 给 4 位（$0.0011）、<1 给 3 位（$0.123）、其余 2 位（$12.34）。
 */
export function formatUsd(value: number | null | undefined): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const abs = Math.abs(value);
	const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
	return `$${value.toFixed(digits)}`;
}

/** 网关自报用量的可显示事实（字段为 null = 网关没报这一项，界面不得补零）。 */
export interface GatewayUsageFacts {
	/** 已用（网关自报，USD）。 */
	usedText: string | null;
	/** 总额度；网关只给「不限额度」占位值时是 null。 */
	limitText: string | null;
	/** 剩余额度；没有真实额度时是 null。 */
	remainingText: string | null;
	/** true = 网关返回的是占位额度（NewAPI 的 1e8），只能看已用。 */
	unlimited: boolean;
	/** 数字口径：window = 网关按窗口统计；cumulative = 累计（该部署不细分）。 */
	scope: "window" | "cumulative";
	windowDays: number | null;
	/** 网关报告时间（本地时间文本）；没有就是 null。 */
	checkedAtText: string | null;
}

/** 把一次查询结果翻译成显示事实；没有结果时 null。 */
export function gatewayUsageFacts(usage: UiGatewayUsage | null | undefined): GatewayUsageFacts | null {
	if (!usage) return null;
	const windowDays = typeof usage.windowDays === "number" && usage.windowDays > 0 ? usage.windowDays : null;
	return {
		usedText: formatUsd(usage.usedUsd),
		limitText: formatUsd(usage.limitUsd),
		remainingText: formatUsd(usage.remainingUsd),
		unlimited: usage.unlimited === true,
		scope: windowDays === null ? "cumulative" : "window",
		windowDays,
		checkedAtText: typeof usage.checkedAt === "number" ? new Date(usage.checkedAt).toLocaleString() : null,
	};
}

/**
 * 这份读数是不是**当前生效服务商**的。
 * @WHY 用户换了模型/服务商后，上一次读数是另一个网关的；继续显示就等于把它当成现在这个的余额
 *   （旧渠道时代的同类错误见 docs/P0-VERIFICATION.md §绑定与实际模型不符）。
 */
export function gatewayUsageBelongsTo(usage: UiGatewayUsage | null | undefined, providerId: string | null): boolean {
	if (!usage) return false;
	const want = (providerId ?? "").trim();
	if (!want) return false;
	return usage.providerId === want;
}

/** 读数是否已经旧到该提示重新查询。 */
export function isGatewayUsageStale(usage: UiGatewayUsage | null | undefined, now = Date.now()): boolean {
	if (!usage || typeof usage.checkedAt !== "number") return true;
	return now - usage.checkedAt > GATEWAY_USAGE_STALE_MS;
}

/**
 * Jev 审计/运行态里的费用口径（网关表格之外的旧调用点）。
 * @CONTRACT 与 formatUsd 同源：没有数字写「—」，绝不写 0（0 会被读成「免费」）。
 */
export function formatCostOrDash(value: number | null | undefined): string {
	return formatUsd(value) ?? "—";
}
