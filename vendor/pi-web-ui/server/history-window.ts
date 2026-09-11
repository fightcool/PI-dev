/**
 * 🍞 AI Breadcrumb Navigation — @COUPLED=agent-service.ts（emitSnapshotNow / loadHistory）、
 *    index.ts（load_history 分发）、protocol.ts（messagesOmitted / message_page）、
 *    web/src/components/MessageList.tsx（向上加载）、docs/PERF-SESSION-LOAD.md §P1-8.
 * @WHY 大会话每次切换都要在 wire 上传数百 KB（实测 1460 条高熵会话 1.60MB → deflate 385KB），
 *      而且用户通常是接着最近的内容继续。尾部优先：先只发最近若干条 + 一个「还有更早」的计数，
 *      向上滚动/搜索时再补。纯函数放在这里，便于单测与服务端/客户端共用一个口径。
 * @GOTCHA `omitted` 是「更早的条数」，不是总条数；`complete` 表示这一页之前已经没有任何消息。
 * @MAGIC SNAPSHOT_TAIL_MESSAGES=40：一屏左右；HISTORY_PAGE_MESSAGES=200：一次补一页，
 *      `all:true`（搜索）忽略页大小一次补全。
 */
import type { UiMessage } from "./protocol.js";

/** Most recent messages carried by a full snapshot. */
export const SNAPSHOT_TAIL_MESSAGES = 40;
/** How many earlier messages one `load_history` page returns by default. */
export const HISTORY_PAGE_MESSAGES = 200;

export interface SnapshotWindow {
	messages: UiMessage[];
	/** How many EARLIER messages this window leaves out (0 = the whole transcript). */
	omitted: number;
}

/**
 * The slice a full snapshot carries. `expanded` is the per-conversation latch set
 * once the client has loaded the whole transcript: after that, snapshots stay
 * complete (otherwise a later full snapshot — compaction/edit-fork/resync — would
 * silently throw away the history the user just scrolled back through).
 */
export function snapshotWindow(
	messages: readonly UiMessage[],
	expanded: boolean,
	tail = SNAPSHOT_TAIL_MESSAGES,
): SnapshotWindow {
	if (expanded || messages.length <= tail) return { messages: [...messages], omitted: 0 };
	return { messages: messages.slice(messages.length - tail), omitted: messages.length - tail };
}

export interface HistoryPage {
	messages: UiMessage[];
	/** How many earlier messages remain BEFORE this page (the client's new count). */
	omittedBefore: number;
	/** True when nothing older than this page exists. */
	complete: boolean;
}

/**
 * One page of earlier messages, ending just before `before`.
 *
 * An unknown `before` (the client's oldest row is gone — e.g. compaction replaced
 * the ids) yields an EMPTY page marked complete rather than a guess: the client
 * stops asking, and its next full snapshot reconciles the view. Guessing here
 * would prepend unrelated messages above the ones the user is reading.
 */
export function historyPage(
	messages: readonly UiMessage[],
	opts: { before?: string; limit?: number; all?: boolean } = {},
	pageSize = HISTORY_PAGE_MESSAGES,
): HistoryPage {
	const end = opts.before === undefined ? messages.length : messages.findIndex((m) => m.id === opts.before);
	if (end < 0) return { messages: [], omittedBefore: 0, complete: true };
	const cap = opts.all === true ? end : Math.max(1, opts.limit ?? pageSize);
	const start = Math.max(0, end - cap);
	return { messages: messages.slice(start, end), omittedBefore: start, complete: start === 0 };
}
