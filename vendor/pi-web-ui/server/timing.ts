/**
 * 🍞 AI Breadcrumb Navigation — @COUPLED=index.ts hello/attach, agent-service.ts
 *    attach / ClientSession.create / switchSession / switchConversation / emitSnapshotNow,
 *    web/src/perf-trace.ts（同一套阶段名，两端对得上）.
 * @WHY 会话加载与切换慢是「多段串行叠加」，不分段计时就无法定责——本模块只加观测，不改行为。
 * @GOTCHA 关闭时必须是零成本：调用点统一用 `trace?.mark(...)`，不启用就不分配、不取时钟。
 * @MAGIC PI_WEB_TIMING=1 启用；SLOW_PHASE_MS 只用于给单段打 `!` 标记，不做丢弃/超时。
 * 📖 docs/PERF-SESSION-LOAD.md
 */

/** Opt-in via env so production stays silent unless someone is measuring. */
export const timingEnabled = process.env.PI_WEB_TIMING === "1";

/** A phase at or above this is flagged with `!` in the log line. */
const SLOW_PHASE_MS = 300;

export interface TimingMark {
	name: string;
	ms: number;
}

/**
 * One request's ordered phase measurements. Cheap enough to always construct
 * when enabled; `startTrace` returns undefined when disabled so hot paths pay
 * nothing but a null check.
 */
export class TimingTrace {
	private readonly marks: TimingMark[] = [];
	private at = now();
	private readonly startedAt = this.at;

	constructor(
		private readonly label: string,
		/** Extra key=value pairs appended to the log line (no credentials/secrets). */
		private readonly facts: Record<string, string | number | boolean> = {},
	) {}

	/** Record the time since the previous mark (or since the trace started). */
	mark(name: string): void {
		const current = now();
		this.marks.push({ name, ms: Math.round(current - this.at) });
		this.at = current;
	}

	/** One structured line; harmless in production logs but only emitted when enabled. */
	end(extra: Record<string, string | number | boolean> = {}): void {
		const total = Math.round(now() - this.startedAt);
		const phases = this.marks.map((m) => `${m.name}=${m.ms}${m.ms >= SLOW_PHASE_MS ? "!" : ""}`).join(" ");
		const facts = Object.entries({ ...this.facts, ...extra, total })
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		console.log(`[timing] ${this.label} ${phases} | ${facts}`.replace(/\s+/g, " ").trim());
	}
}

/** undefined when timing is off — callers use optional chaining and never branch. */
export function startTrace(label: string, facts?: Record<string, string | number | boolean>): TimingTrace | undefined {
	return timingEnabled ? new TimingTrace(label, facts) : undefined;
}

/**
 * Await `run()` and mark it on the trace. Keeps call sites a single expression
 * when the trace may be undefined (the disabled path adds no allocation).
 */
export async function traceStep<T>(trace: TimingTrace | undefined, name: string, run: () => Promise<T>): Promise<T> {
	if (!trace) return run();
	try {
		return await run();
	} finally {
		trace.mark(name);
	}
}

/** Monotonic-enough wall clock; `performance` is available on Node >= 16. */
function now(): number {
	return performance.now();
}
