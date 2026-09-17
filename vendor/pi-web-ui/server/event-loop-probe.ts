/**
 * 🍞 AI Breadcrumb Navigation — @COUPLED=index.ts 启动与 shutdown,
 *    docs/EVENT-LOOP-SPLIT-PROPOSAL.md（结构性风险与验收指标 §4）.
 * @WHY 服务端**一个** Node 进程同时承担 WS/HTTP、agent 运行、工具执行、jsonl 读写与
 *   插件宿主，任何一处同步工作都会同时卡住所有客户端。提案里「扫描搬 worker」的
 *   首要验收指标就是事件循环阻塞时长——没有这个探针，改造前后都只有间接证据。
 * @GOTCHA 默认完全关闭：不建 histogram、不起定时器（与 timing.ts 同一约定）。
 * @GOTCHA `monitorEventLoopDelay` 返回的 IntervalHistogram 在 Node 22.19 **没有**
 *   `counts`/`resolution`（实测 undefined），所以「超阈值次数」不能从直方图桶里数；
 *   用第二个 100ms 定时器的漂移计数补（漂移 ≈ 该次阻塞时长）。
 * @GOTCHA 直方图对**单次长阻塞**不可靠：实测 400ms 阻塞记成 425ms，但 200ms 阻塞只记到
 *   20.2ms（= resolution）——而 20ms 定时器的漂移每次都抓得到。所以 max 取两者较大值，
 *   直方图只贡献 mean/p99。写测试时注意：阻塞要发生在探针自己 tick 过一次之后。
 * @MAGIC PI_WEB_LOOP_PROBE=1 打开；`PI_WEB_LOOP_PROBE_MS` 调窗口（默认 10s）、
 *   `PI_WEB_LOOP_PROBE_THRESHOLD_MS` 调告警/计数线（默认 100ms）。
 * 📖 docs/PERF-SESSION-LOAD.md §7.4（复测方式）
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** 一个观测窗口内的阻塞统计（毫秒）。 */
export interface LoopDelaySample {
	/** 窗口内最长的单次阻塞（直方图与漂移计数的较大值）。 */
	maxMs: number;
	meanMs: number;
	p99Ms: number;
	/** 窗口内超过阈值的阻塞次数。 */
	over: number;
	samples: number;
}

/** 阈值线与窗口由 env 决定；只有字面量 "1" 才算打开。 */
export const loopProbeEnabled = process.env.PI_WEB_LOOP_PROBE === "1";

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 一行摘要：人读 + 日志 grep 都靠它。 */
export function describeLoopDelay(sample: LoopDelaySample, thresholdMs: number): string {
	const flag = sample.maxMs >= thresholdMs ? "!" : "";
	const round = (value: number) => `${value.toFixed(1)}ms`;
	return (
		`[loop]${flag} max=${round(sample.maxMs)} p99=${round(sample.p99Ms)} mean=${round(sample.meanMs)}` +
		` over=${sample.over}/${sample.samples}（阈值 ${thresholdMs}ms）`
	);
}

export interface LoopProbeOptions {
	enabled?: boolean;
	/** 上报周期。 */
	intervalMs?: number;
	/** 超过它就打 `!`（并计入 over）。 */
	thresholdMs?: number;
	log?: (line: string) => void;
}

/**
 * 启动探针；返回停止函数（幂等）。关闭时不做任何分配，返回空操作。
 *
 * 直方图由内核侧记录（回调开销与阻塞时长无关），所以 100ms 级阻塞不会被采样
 * 分辨率吃掉；`mean/p99/max` 与「超阈值次数」一起回答「卡了多久、卡了几次」。
 */
export function startEventLoopProbe(options: LoopProbeOptions = {}): () => void {
	const enabled = options.enabled ?? loopProbeEnabled;
	if (!enabled) return () => {};
	const intervalMs = options.intervalMs ?? positiveInt(process.env.PI_WEB_LOOP_PROBE_MS, 10_000);
	const thresholdMs = options.thresholdMs ?? positiveInt(process.env.PI_WEB_LOOP_PROBE_THRESHOLD_MS, 100);
	const log = options.log ?? ((line: string) => console.log(line));

	const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();

	// 漂移计数：定时器被拖延多久，就约等于事件循环被阻塞多久。
	// 为什么不能只靠直方图：实测同一次阻塞可能被记成 resolution 值（200ms 阻塞只记到
	// 20.2ms），而漂移计数每次都抓得到；两者取较大值作为 max。
	const tickMs = 20;
	let lastTick = Date.now();
	let over = 0;
	let samples = 0;
	let maxDriftMs = 0;
	const driftTimer = setInterval(() => {
		const now = Date.now();
		const drift = now - lastTick - tickMs;
		lastTick = now;
		samples++;
		if (drift > maxDriftMs) maxDriftMs = drift;
		if (drift >= thresholdMs) over++;
	}, tickMs);
	driftTimer.unref?.();

	const reportTimer = setInterval(() => {
		const count = histogram.count;
		const histogramMax = count > 0 ? histogram.max / 1e6 : 0;
		const sample: LoopDelaySample = {
			maxMs: Math.max(histogramMax, maxDriftMs),
			meanMs: count > 0 ? histogram.mean / 1e6 : 0,
			p99Ms: count > 0 ? histogram.percentile(99) / 1e6 : 0,
			samples,
			over,
		};
		log(describeLoopDelay(sample, thresholdMs));
		histogram.reset();
		over = 0;
		samples = 0;
		maxDriftMs = 0;
	}, intervalMs);
	reportTimer.unref?.();

	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(reportTimer);
		clearInterval(driftTimer);
		histogram.disable();
	};
}
