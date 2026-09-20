/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/JevFooterItem.tsx（底栏 Jev 门禁项：三态结论 + 点开浮层）,
 *            use-chat.ts（ChatState.jev.status ← 服务端**主动推送**的 jev_status，reqId 0）,
 *            jev-decision.ts（三态 → i18n 键：outcomeLabelKey；本模块只做计数差，不写文案映射）,
 *            server/agent-service.ts（pushJevStatus：会话 ready 后一次 + 每次真实决策后一次）
 *   @CONTRACT 只从推送的运行态里读出「最近一次结论」：不新增服务端字段、不猜逐条分数
 *             （分数以设置面板为准，status.runtime 本来就不带分数）。
 *   @GOTCHA 推送只带**聚合计数**（total/approve/block/review/failed），没有「最近一次结论」字段。
 *             所以最近结论靠**前后两份推送的计数差**推断：只有「整批新增全是同一结果」才认；
 *             混合结论、计数回退（服务端重启清零）、首次收到（还没有基线）一律返回 null ——
 *             状态栏显示「—」，绝不把聚合数当成某一次结论编出来。
 *   @WHY 推断出的结论只在**本页面生命周期内**有效（刷新页面后要等下一次推送），这正是
 *        「状态栏反映刚刚发生了什么」的口径；历史三态分布请去设置面板看运行聚合。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import type { UiJevOutcome, UiJevRuntimeStatus } from "./types";

/** 结论 → 状态栏配色类（复用现有 ok/mid/warn 口径：放行=ok、转人工=mid、拦下=warn）。 */
export function verdictTone(outcome: UiJevOutcome | null): "ok" | "mid" | "warn" | "" {
	if (outcome === "approve") return "ok";
	if (outcome === "review") return "mid";
	if (outcome === "block") return "warn";
	return "";
}

/**
 * 两份运行态聚合之差 → 期间到达的那次（或那批）决策的三态。
 * @CONTRACT 只在能**唯一归因**时返回三态：整批新增全是同一结果才算（dApprove/dBlock/dReview
 *   恰好等于 dTotal）。混合结论（一批里既有放行又有拦下）、无新增、计数回退都返回 null。
 */
export function lastOutcomeFromDelta(prev: UiJevRuntimeStatus, next: UiJevRuntimeStatus): UiJevOutcome | null {
	const dTotal = next.total - prev.total;
	if (dTotal <= 0) return null;
	if (next.approve - prev.approve === dTotal) return "approve";
	if (next.block - prev.block === dTotal) return "block";
	if (next.review - prev.review === dTotal) return "review";
	return null;
}

/**
 * 跟踪服务端推送的运行态，返回最近一次可归因的结论（推断不出来 = null）。
 * @GOTCHA 依赖必须是**状态对象的引用**：use-chat 的 reducer 只在收到新的 jev_status 时换掉
 *   `state.jev.status` 这个引用，流式输出等其它 dispatch 不会换 —— 所以这里不会因无关渲染重跑，
 *   也不会把同一份快照重复当成一次新决策。
 */
export function useLastJevOutcome(runtime: UiJevRuntimeStatus | null | undefined): UiJevOutcome | null {
	const [outcome, setOutcome] = useState<UiJevOutcome | null>(null);
	const prevRef = useRef<UiJevRuntimeStatus | null>(null);
	useEffect(() => {
		const next = runtime ?? null;
		const prev = prevRef.current;
		if (!next) {
			prevRef.current = null;
			setOutcome(null);
			return;
		}
		// 计数回退（服务端重启清零 / 换了实例）→ 旧结论作废，等下一次推送重新推断。
		if (prev && next.total < prev.total) setOutcome(null);
		else if (prev && next.total > prev.total) {
			const derived = lastOutcomeFromDelta(prev, next);
			// 混合批次（一次推了多条不同结论）推断不出「最近一次」，保留上一次已知结论，不猜。
			if (derived) setOutcome(derived);
		}
		prevRef.current = next;
	}, [runtime]);
	return outcome;
}
