/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/channel-account.ts（余额自动刷新的调度）
 * 📖 docs/DEV-CON-PROPOSAL.md §7（余额/用量：不阻塞编码路径；查询有界、限频、缓存）
 * @CONTRACT 用假时钟钉死「多久刷一次」：立即一次 → 每 5 分钟一次 → 后台不刷 → 回前台且数据
 *   超过一个周期时补一次。周期必须与服务端的账户缓存 TTL（5 分钟）对齐，不然只是重复打供应商接口。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BALANCE_MAX_RETRIES,
	BALANCE_REFRESH_MS,
	balanceFailuresOf,
	resetBalanceFailures,
	startBalanceRefresh,
} from "../../web/src/channel-account.js";

/** 每个用例用独立渠道 id：失败计数是模块级按渠道记的。 */
let seq = 0;
const nextChannel = () => `ch-test-${++seq}`;

describe("余额自动刷新调度", () => {
	afterEach(() => vi.useRealTimers());

	it("立即查一次，之后每 2 分钟一次", () => {
		vi.useFakeTimers();
		let calls = 0;
		const stop = startBalanceRefresh({ channelId: nextChannel(), query: () => (calls += 1), isHidden: () => false, lastCheckedAt: () => 0 });
		expect(calls).toBe(1);
		expect(BALANCE_REFRESH_MS).toBe(2 * 60_000);
		vi.advanceTimersByTime(BALANCE_REFRESH_MS - 1);
		expect(calls).toBe(1); // 不到一个周期不刷
		vi.advanceTimersByTime(1);
		expect(calls).toBe(2);
		vi.advanceTimersByTime(BALANCE_REFRESH_MS * 2);
		expect(calls).toBe(4);
		stop();
		vi.advanceTimersByTime(BALANCE_REFRESH_MS);
		expect(calls).toBe(4); // 停止后不再刷（组件卸载/切渠道时调用）
	});

	it("后台标签页不刷", () => {
		vi.useFakeTimers();
		let calls = 0;
		let hidden = true;
		const stop = startBalanceRefresh({
			channelId: nextChannel(),
			query: () => (calls += 1),
			isHidden: () => hidden,
			lastCheckedAt: () => 0,
		});
		expect(calls).toBe(1); // 进入时那一次照发
		hidden = true;
		vi.advanceTimersByTime(BALANCE_REFRESH_MS * 3);
		expect(calls).toBe(1);
		stop();
	});

	it("回到前台时，数据已过期才补一次", () => {
		vi.useFakeTimers();
		// 单测跑在 node 环境（没有 DOM）：给一个最小 document 替身，直接触发 visibilitychange 监听。
		const listeners = new Set<() => void>();
		vi.stubGlobal("document", {
			hidden: false,
			addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
			removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
		});
		const fire = () => listeners.forEach((fn) => fn());
		let calls = 0;
		let lastCheckedAt = 0;
		const stop = startBalanceRefresh({ channelId: nextChannel(), query: () => (calls += 1), lastCheckedAt: () => lastCheckedAt });
		expect(calls).toBe(1);
		// 数据新鲜：切回前台不该再查。
		lastCheckedAt = Date.now();
		fire();
		expect(calls).toBe(1);
		// 数据超过一个周期：切回前台补一次。
		lastCheckedAt = Date.now() - BALANCE_REFRESH_MS - 1;
		fire();
		expect(calls).toBe(2);
		// 停止后连监听也摘掉（组件卸载/切渠道）。
		stop();
		expect(listeners.size).toBe(0);
		fire();
		expect(calls).toBe(2);
		vi.unstubAllGlobals();
	});
	it("连续失败达到上限后停止获取，用户重试后恢复", () => {
		vi.useFakeTimers();
		const channelId = nextChannel();
		let calls = 0;
		let status: "ok" | "failed" | undefined;
		const stop = startBalanceRefresh({
			channelId,
			query: () => (calls += 1),
			statusOf: () => status,
			isHidden: () => false,
			lastCheckedAt: () => 0,
		});
		expect(calls).toBe(1); // 首次
		status = "failed";
		// 首次 + 最多 3 次重试：每过一个周期看上一次结果，失败就累加，超过上限后不再发请求。
		for (let i = 0; i < 6; i++) vi.advanceTimersByTime(BALANCE_REFRESH_MS);
		expect(calls).toBe(1 + BALANCE_MAX_RETRIES);
		expect(balanceFailuresOf(channelId)).toBeGreaterThan(BALANCE_MAX_RETRIES);
		// 停止后再过很多周期也不会再打接口
		vi.advanceTimersByTime(BALANCE_REFRESH_MS * 10);
		expect(calls).toBe(1 + BALANCE_MAX_RETRIES);
		// 用户点「重试」→ 计数清零 → 自动刷新恢复
		resetBalanceFailures(channelId);
		expect(balanceFailuresOf(channelId)).toBe(0);
		vi.advanceTimersByTime(BALANCE_REFRESH_MS);
		expect(calls).toBe(2 + BALANCE_MAX_RETRIES);
		// 恢复正常后计数清零（连续失败才算数）
		status = "ok";
		vi.advanceTimersByTime(BALANCE_REFRESH_MS);
		expect(balanceFailuresOf(channelId)).toBe(0);
		stop();
	});
});
