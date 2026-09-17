/// <reference lib="dom" />
/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED app/use-chrome-collapse.tsx（React 层：状态与上下文，调用本文件的纯函数）,
 *            components/ChatInput.tsx（收起输入工具条/快捷短语）,
 *            components/FooterBar.tsx（收起状态栏）, components/GoalBar.tsx（收起空闲目标条）,
 *            components/MessageList.tsx（报告「是否停在最底部」）
 *   📖 docs/architecture-core.md
 *   @WHY 移动端与窄屏的底部控件（目标条 / 输入工具条 / 状态栏）能吃掉 130px 以上，输出流式
 *        刷屏时留给正文的可见区域很小。规则：**输出中**或**用户在翻历史**时自动收起，
 *        用户把会话滑到最底部（或聚焦输入框、点一下展开）才恢复。
 *   @CONTRACT 只做纯判定，不做 IO/定时：输入是四个信号，输出一个布尔，便于用事件序列单测。
 * ────────────────────────────────────────────────────────────────────────── */

/** 用户手动指定的展开/收起（一次性的；滚动或新一轮输出后清空，规则重新生效）。 */
export type ChromeForce = "expanded" | "collapsed" | null;

/** 判定底部控件是否收起的四个信号。 */
export interface ChromeSignals {
	/** 本轮输出进行中（流式）。 */
	streaming: boolean;
	/** 会话是否停在最底部（MessageList 的 stickBottom：贴底自动跟随 / 用户滑到底）。 */
	atBottom: boolean;
	/** 输入框是否聚焦（或正在输入）。 */
	focused: boolean;
	/** 用户手动指定的值。 */
	force: ChromeForce;
}

/**
 * 底部控件是否收起。
 * @CONTRACT 优先级：输入框聚焦 → 永不收起（正在打字时控件必须完整可见，否则等于把输入框抢走）；
 *   其次用户手动指定；否则「输出中」或「不在最底部（在翻历史）」→ 收起。
 */
export function chromeCollapsed(input: ChromeSignals): boolean {
	if (input.focused) return false;
	if (input.force === "expanded") return false;
	if (input.force === "collapsed") return true;
	return input.streaming || !input.atBottom;
}

/**
 * 点击「展开/收起」后应该记住的手动值。
 * @WHY 用当前是否收起来决定下一个值，而不是简单取反：规则随时可能因为流式结束/pin 到底而变化，
 *   按「结果」翻转才符合直觉（点一下 = 切换你看到的这个状态）。
 */
export function toggledForce(currentlyCollapsed: boolean): ChromeForce {
	return currentlyCollapsed ? "expanded" : "collapsed";
}
