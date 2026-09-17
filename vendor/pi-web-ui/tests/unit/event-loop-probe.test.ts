/**
 * 事件循环探针（server/event-loop-probe.ts）单测。
 *
 * 契约：
 *  - 默认（未开 env）零成本：不起定时器、不打日志；
 *  - 打开后能把「block 了多久」量化成一行 [loop] 日志，超阈值带 `!`；
 *  - 停止函数幂等。
 */
import { describe, expect, it, vi } from "vitest";
import { describeLoopDelay, startEventLoopProbe, type LoopDelaySample } from "../../server/event-loop-probe.js";

const sample = (over: Partial<LoopDelaySample> = {}): LoopDelaySample => ({
	maxMs: 0,
	meanMs: 0,
	p99Ms: 0,
	over: 0,
	samples: 0,
	...over,
});

describe("describeLoopDelay", () => {
	it("低于阈值不打标记，超阈值打 `!`", () => {
		expect(describeLoopDelay(sample({ maxMs: 42.3 }), 100)).toContain("[loop] max=42.3ms");
		expect(describeLoopDelay(sample({ maxMs: 42.3 }), 100)).not.toContain("!");
		expect(describeLoopDelay(sample({ maxMs: 520.6 }), 100)).toContain("[loop]! max=520.6ms");
	});

	it("带上 p99/mean/次数与阈值说明", () => {
		const line = describeLoopDelay(sample({ maxMs: 500, p99Ms: 120.4, meanMs: 12.34, over: 3, samples: 96 }), 100);
		expect(line).toContain("p99=120.4ms");
		expect(line).toContain("mean=12.3ms");
		expect(line).toContain("over=3/96");
		expect(line).toContain("阈值 100ms");
	});
});

describe("startEventLoopProbe", () => {
	it("关闭时不建定时器也不打日志，且返回幂等停止函数", async () => {
		const log = vi.fn();
		const stop = startEventLoopProbe({ enabled: false, log });
		stop();
		stop();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(log).not.toHaveBeenCalled();
	});

	it("打开后在窗口末打一行 [loop]，停止后不再打", async () => {
		const log = vi.fn();
		const stop = startEventLoopProbe({ enabled: true, intervalMs: 40, thresholdMs: 100, log });
		await new Promise((resolve) => setTimeout(resolve, 120));
		stop();
		const after = log.mock.calls.length;
		expect(after).toBeGreaterThanOrEqual(1);
		expect(String(log.mock.calls[0][0])).toContain("[loop]");
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(log.mock.calls.length).toBe(after);
	});

	it("真的阻塞事件循环时能看出来（max 与 over 都要涨）", async () => {
		const lines: string[] = [];
		const stop = startEventLoopProbe({ enabled: true, intervalMs: 60, thresholdMs: 100, log: (l) => lines.push(l) });
		// 直方图要先自己 tick 一次才能看到阻塞（同一个同步 tick 里 enable + 忙等是看不到的，
		// 实测 max 只记到 resolution）——线上探针是常驻的，这里模拟这个前提。
		await new Promise((resolve) => setTimeout(resolve, 60));
		// 忙等 ~200ms：这就是「一段同步工作卡住所有客户端」的最小复现
		const until = Date.now() + 200;
		while (Date.now() < until) {
			/* busy wait */
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
		stop();
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const blocked = lines.find((l) => l.includes("[loop]!"));
		expect(blocked).toBeDefined();
		const max = Number(/max=([\d.]+)ms/.exec(blocked!)![1]);
		expect(max).toBeGreaterThanOrEqual(150);
		expect(blocked).toMatch(/over=[1-9]\d*\//);
	});
});
