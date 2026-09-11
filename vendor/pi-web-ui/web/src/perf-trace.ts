/**
 * 🍞 AI Breadcrumb Navigation — @COUPLED=main.tsx（boot）, use-chat.ts（ws:open/ready/
 *    snapshot、switch:*）, app/chat-view.tsx（paint:*）, components/LeftPanel.tsx（点击入口）,
 *    server/timing.ts（服务端同名阶段，两端对照）.
 * @WHY 「页面加载 4~5 秒」与「切会话卡顿」都是端到端墙钟问题：只有把
 *      HTML → WS → 首份 snapshot → 首帧 的关键点打上时间戳，才能分清是网络、
 *      服务端还是渲染。纯观测，不改任何行为。
 * @GOTCHA 打点必须在 await/渲染之前同步执行；marks 只留在内存（上限 200 条），
 *      不发送、不落盘、不含消息正文——验收时由人显式读走。
 * @MAGIC MAX_MARKS=200 环形上限；SWITCH_WINDOW_MS=15000 是「点击→首帧」的配对
 *      窗口：超过它才到的 paint 不再当成本次切换的结果（否则一次切换会错配到很久
 *      之后的某次渲染）。
 * 📖 docs/PERF-SESSION-LOAD.md
 */

/** One recorded point on the client timeline. */
export interface PerfMark {
	name: string;
	/** performance.now() at record time (ms since page load). */
	at: number;
	detail?: string;
}

/** Bounded so a long-lived tab can never grow this without limit. */
const MAX_MARKS = 200;
const marks: PerfMark[] = [];

/** Opt-in console echo: `localStorage.setItem("pi-perf", "1")` then reload. */
const PERF_LOG = (() => {
	try {
		return typeof localStorage !== "undefined" && localStorage.getItem("pi-perf") === "1";
	} catch {
		return false;
	}
})();

/** Timestamp of the last switch click, so click → first paint can be paired. */
/** Clicks older than this are not paired: a switch that never painted must not
 *  absorb an unrelated later paint. */
const SWITCH_WINDOW_MS = 15_000;

let lastSwitchAt: number | null = null;

/** Record one timeline point. Safe to call before/without any UI. */
export function perfMark(name: string, detail?: string): void {
	const at = typeof performance === "undefined" ? Date.now() : performance.now();
	marks.push(detail === undefined ? { name, at } : { name, at, detail });
	if (marks.length > MAX_MARKS) marks.splice(0, marks.length - MAX_MARKS);
	if (typeof console !== "undefined" && PERF_LOG) {
		console.debug(`[perf] +${Math.round(at)}ms ${name}${detail ? ` (${detail})` : ""}`);
	}
}

/** Remember when the user asked for another conversation (paired with paint:*). */
export function perfMarkSwitch(kind: string): void {
	lastSwitchAt = typeof performance === "undefined" ? Date.now() : performance.now();
	perfMark(`switch:${kind}`);
}

/** First paint of a conversation after a switch: records the click→paint delta. */
export function perfMarkPaint(conversationId: string): void {
	const from = lastSwitchAt;
	lastSwitchAt = null;
	if (from === null) {
		perfMark("paint");
		return;
	}
	const at = typeof performance === "undefined" ? Date.now() : performance.now();
	const delta = at - from;
	if (delta > SWITCH_WINDOW_MS) {
		perfMark("paint", `${conversationId.slice(0, 8)}（无配对切换）`);
		return;
	}
	perfMark("paint", `${Math.round(delta)}ms after switch (${conversationId.slice(0, 8)})`);
}

/** Readable waterfall — call `__piPerf()` in the browser console. */
export function perfReport(): string {
	const lines = marks.map(
		(m) => `+${String(Math.round(m.at)).padStart(6)}ms  ${m.name}${m.detail ? `  ${m.detail}` : ""}`,
	);
	return [`pi perf marks (${marks.length}):`, ...lines].join("\n");
}

declare global {
	interface Window {
		/** Console entry point, installed by this module's side effect below. */
		__piPerf?: () => string;
	}
}

if (typeof window !== "undefined") window.__piPerf = perfReport;

perfMark("boot");
