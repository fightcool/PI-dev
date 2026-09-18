/**
 * 排空门禁的判定（纯函数，见 tests/drain-policy.test.mjs）。
 *
 * @WHY 原先两处排空循环（maintenance/switch-production-release.mjs、lifecycle/cutover.mjs）
 *   都只写 `active === 0 && pending === 0`，然后一直等到总超时。问题在于 pending 混了两类东西：
 *     1. **有运行在消费**的排队消息（steer / follow-up）：运行结束时会自己消化，值得等；
 *     2. **没有运行消费**的排队消息（孤儿队列）：quiesce 期间新工作一律被拒（prompt 直接
 *        返回、新客户端 4403），运行不会自己出现 —— 等多久都不会变。
 *   2026-09-18 那次生产切换就因此白等 45 分钟（active=0、pending=2、无运行在消费），
 *   且既不报「谁卡住了」也不早退：人只能干等或反复重试（用户为此累计浪费了数小时）。
 *
 * @CONTRACT 门禁只看 drainable（在飞工作 + 有运行消费的队列）。孤儿队列不阻塞，但必须
 *   报出来（重启会丢弃它们，界面上的待发气泡要重发）。
 * @CONTRACT 停在同一个数值上超过 stallLimitMs 就早退并点名持有者，而不是等满总超时。
 *   阈值不是 0：一条正常的长回合会持续几十秒不改变计数，那些是「在飞的工作」，要等。
 * @COUPLED vendor/pi-web-ui/server/agent-service.ts（drainableMessages / orphanedMessages /
 *   drainHolders 的产出方）、server/control-socket.ts（status 字段）、scripts/maintenance/
 *   switch-production-release.mjs、scripts/lifecycle/cutover.mjs（两处调用方）
 *   📖 docs/PM2-PRODUCTION.md「排空」、docs/P0-VERIFICATION.md
 */

/** 默认停滞阈值：5 分钟没有进度就早退（总超时另有 SWITCH_WAIT_MINUTES）。 */
export const DEFAULT_STALL_MS = 5 * 60_000;

/** 把秒数说成人话：90 → 「1.5 分钟」。 */
function humanMinutes(ms) {
	const minutes = ms / 60_000;
	return minutes >= 10 ? `${Math.round(minutes)} 分钟` : `${minutes.toFixed(1)} 分钟`;
}

/** 点出谁持有排空门禁挡着的工作（用于早退时的诊断，而不是只说「没排空」）。 */
function describeHolders(status) {
	const holders = Array.isArray(status?.drainHolders) ? status.drainHolders : [];
	const parts = [];
	for (const holder of holders) {
		const streaming = Boolean(holder?.streaming);
		const queued = Number(holder?.queued ?? 0);
		if (!streaming && queued <= 0) continue;
		const bits = [];
		if (streaming) {
			const idle = Number(holder?.idleSeconds ?? 0);
			bits.push(idle >= 60 ? `流式中，已 ${humanMinutes(idle * 1000)} 无输出` : "流式中");
		}
		if (queued > 0) bits.push(`排队 ${queued} 条`);
		parts.push(`对话 ${holder?.id ?? "?"}（${bits.join("，")}）`);
	}
	return parts.join("、");
}

/**
 * 判定一轮排空：完成 / 继续等 / 早退。
 *
 * @param {{activeConversations?: number, drainableMessages?: number, orphanedMessages?: number,
 *   pendingMessages?: number, drainHolders?: Array<{id?: string, streaming?: boolean, queued?: number, idleSeconds?: number}>}} status
 *   控制套接字 status 的回包。旧进程没有 drainableMessages（新脚本跑在升级前的旧服务上），
 *   此时回退到 pendingMessages —— 与修复前行为一致，不会因为字段缺失就误判成「已排空」。
 * @param {{tolerate?: number, stalledMs?: number, stallLimitMs?: number}} [options]
 *   tolerate：允许多少活跃对话 / 可排空队列（切换派发方默认 1，见 deploy-detached.mjs）。
 *   stalledMs：距离上一次数值变化过去了多久（调用方跟踪）；stallLimitMs：超过就早退。
 * @returns {{done: boolean, abort: string|null, note: string|null, detail: string}}
 *   done=true 可继续切换；abort 非空则抛这个理由；note 非空是需要照实报出来的情况（孤儿队列）。
 */
export function evaluateDrain(status, options = {}) {
	const tolerate = Number(options.tolerate ?? 0);
	const stalledMs = Number(options.stalledMs ?? 0);
	const stallLimitMs = Number(options.stallLimitMs ?? DEFAULT_STALL_MS);
	const active = Number(status?.activeConversations ?? 0);
	const drainable = Number(status?.drainableMessages ?? status?.pendingMessages ?? 0);
	const total = Number(status?.pendingMessages ?? drainable);
	const orphaned = Number(status?.orphanedMessages ?? Math.max(0, total - drainable));
	const detail = `active=${active} drainable=${drainable} orphaned=${orphaned}`;

	if (active <= tolerate && drainable <= tolerate) {
		return {
			done: true,
			abort: null,
			note:
				orphaned > 0
					? `${orphaned} 条排队消息没有任何运行在消费（孤儿队列），不计入排空等待；重启会丢弃它们，界面上的待发气泡需要重发`
					: null,
			detail,
		};
	}
	if (stalledMs >= stallLimitMs) {
		const who = describeHolders(status);
		return {
			done: false,
			abort:
				`排空停滞 ${humanMinutes(stalledMs)}：${detail}${who ? `；持有者：${who}` : ""}。` +
				"可选项：在界面上中止那条对话，或用 SWITCH_DRAIN_TOLERATE=<n> 放宽门禁（会中断它）。",
			note: null,
			detail,
		};
	}
	return { done: false, abort: null, note: null, detail };
}
