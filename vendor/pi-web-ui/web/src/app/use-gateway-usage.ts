/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED web/src/App.tsx（唯一挂载点）, use-chat.ts（opsApi.queryGatewayUsage / state.gatewayUsage）,
 *            components/FooterBar.tsx（显示这份读数）, components/GatewaySettings.tsx（同一份读数 + 手动刷新）,
 *            server/dev-con/gateway-usage.ts（服务端 60s 缓存与账单本身 3–6s 的滞后）
 *   📖 docs/NEWAPI-GATEWAY.md §4（刷新节奏：为什么不是「越勤越好」）
 *   @WHY 这个 hook 的存在理由是「没人点也要有数字」：状态栏的网关项是常驻监视器，
 *        如果只在用户点开用量面板时才查，它就永远显示打开页面那一刻的旧数字。
 *   @CONTRACT 自动查询一律**不带 force**（服务端 60s 缓存直接复用）；手动刷新才 force。
 *       这样多标签页/多客户端同时开着也只会把网关请求打成一个，而不是每个客户端一份。
 *   @GOTCHA 该服务商没有账单接口（unsupported）时**停止重试**：这是永久事实（直连上游没有
 *       /dashboard/billing），每 5 分钟问一次不可能变的事实只是白打请求。
 *   @GOTCHA 依赖必须稳定：opsApi 是 use-chat 里建一次的稳定对象；activeProvider 取字符串，
 *       不要把整个 state 对象放进依赖（每次快照都是新对象 → 请求风暴，旧实现踩过）。
 * ──────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef } from "react";
import type { OpsApi } from "../use-chat";

/** @MAGIC 自动刷新间隔：账单本身滞后 3–6 秒、服务端缓存 60 秒，再密也只是重复同一个数字。 */
export const GATEWAY_USAGE_POLL_MS = 5 * 60_000;

export function useGatewayUsageAutoRefresh({
	opsApi,
	ready,
	activeProvider,
	unsupported,
}: {
	opsApi: OpsApi;
	/** WS 握手完成、会话就绪后才查（未就绪时服务端没有生效模型可判定）。 */
	ready: boolean;
	/** 当前生效模型所属服务商（变化 = 换网关，必须重查，否则显示的是上一个网关的数字）。 */
	activeProvider: string | null;
	/** 该服务商已确认没有账单接口 → 不再自动查询。 */
	unsupported?: boolean;
}): void {
	// 定期查询用 ref 读最新值，避免把 interval 反复拆建（每次重建都会立刻多发一次请求）。
	const disabledRef = useRef(false);
	disabledRef.current = unsupported === true;
	const readyRef = useRef(false);
	readyRef.current = ready;

	// ① 就绪后查一次；② 当前模型换了服务商后重查（非 force：同一网关的重复查询走服务端缓存）。
	// @GOTCHA 这里**不传** providerId：服务端默认查的就是**网关**（单网关实例唯一入口）。
	//   早期版本传的是「当前模型的服务商」，于是在模型还没切到网关时（例如会话从旧模型恢复）
	//   会去查 openrouter 的账单接口，界面显示「该服务商没有账单接口」——查的根本不是我们要的
	//   那台网关（2026-09-21 实测踩到）。
	useEffect(() => {
		if (!ready) return;
		opsApi.queryGatewayUsage();
	}, [opsApi, ready, activeProvider]);

	// ③ 页面开着就按固定间隔刷新；页面不可见时不打请求（切回来时下一次 tick 自然补上）。
	useEffect(() => {
		if (!ready) return;
		const timer = setInterval(() => {
			if (!readyRef.current || disabledRef.current) return;
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			opsApi.queryGatewayUsage();
		}, GATEWAY_USAGE_POLL_MS);
		return () => clearInterval(timer);
	}, [opsApi, ready]);
}
