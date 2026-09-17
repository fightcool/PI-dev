/**
 * compaction-policy.ts — 自动压缩触发阈值：**整上下文窗口的 86%**。
 *
 * 为什么需要单独一层：SDK 的判据是
 *   `contextTokens > contextWindow - reserveTokens`
 * （node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:163），
 * 而 `settings.json` 里只有一个**全局** `reserveTokens`（默认 16384）。本项目一个
 * 进程里跨多个渠道/模型，窗口从 20 万（claude-*）到 105 万（gpt-6-astra / deepseek-flash）
 * 不等：一个全局值要么让 100 万窗口的会话涨到 98.4 万 token 才压缩（实测真实请求
 * 中位 30 万、峰值 106 万），要么把 20 万窗口的会话压得过早。所以按「当前活跃模型」
 * 的窗口**实时**换算：
 *
 *   触发点 = floor(窗口 × 86%)   ⇔   reserveTokens = 窗口 - 触发点
 *
 * 用整数百分比（`窗口 × 86 / 100`）而不是 `窗口 × 0.14`：后者在二进制浮点下会给出
 * `200000 × 0.14 = 28000.000000000004`，`ceil` 后变成 28001，触发点比 86% 早一个 token
 * 且数字难看。整数乘除在安全整数范围内是精确的。
 *
 * 换算结果只影响两处（其余行为不变）：
 *   1. `shouldCompact` 的触发阈值；
 *   2. 摘要输出上限 `maxTokens = min(0.8 × reserveTokens, model.maxTokens)`
 *      （compact.js:489 / :651）——放宽上限，摘要长度仍由提示词与模型决定。
 * `keepRecentTokens`（保留最近内容的量）与压缩流程本身不受影响。
 *
 * 模型未知或窗口非法（<=0 / NaN / Infinity）时返回 undefined，调用方回退到
 * settings.json 里的值。
 */

/** 触发点占整窗口的百分比（其余作为 reserve）。 */
export const COMPACTION_TRIGGER_PERCENT = 86;

/** reserveTokens 下限：窗口很小/未知时不要把保留量压到 0。 */
export const COMPACTION_MIN_RESERVE_TOKENS = 16384;

function usableWindow(contextWindow: number | null | undefined): contextWindow is number {
	return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0;
}

/** 由上下文窗口换算 reserveTokens；窗口非法时返回 undefined（= 不接管）。 */
export function reserveTokensForContextWindow(contextWindow: number | null | undefined): number | undefined {
	if (!usableWindow(contextWindow)) return undefined;
	const trigger = Math.floor((contextWindow * COMPACTION_TRIGGER_PERCENT) / 100);
	return Math.max(COMPACTION_MIN_RESERVE_TOKENS, contextWindow - trigger);
}

/** 该窗口下的实际触发点（token 数）；窗口非法时返回 undefined。 */
export function compactionTriggerTokens(contextWindow: number | null | undefined): number | undefined {
	const reserve = reserveTokensForContextWindow(contextWindow);
	if (reserve === undefined || !usableWindow(contextWindow)) return undefined;
	return contextWindow - reserve;
}

/** 人读的触发点描述（日志/诊断用）。 */
export function describeCompactionPolicy(contextWindow: number | null | undefined): string {
	const trigger = compactionTriggerTokens(contextWindow);
	const reserve = reserveTokensForContextWindow(contextWindow);
	if (trigger === undefined || reserve === undefined || !usableWindow(contextWindow))
		return "compaction: window unknown → settings.json reserveTokens";
	return `compaction: window=${contextWindow}，触发于 ${trigger}（${COMPACTION_TRIGGER_PERCENT}%），reserve=${reserve}`;
}
