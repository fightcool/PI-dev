/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/channel-account.ts（余额自动刷新的调度）
 * 📖 docs/DEV-CON-PROPOSAL.md §7（余额/用量：不阻塞编码路径；查询有界、限频、缓存）
 * @CONTRACT 用假时钟钉死「多久刷一次」：立即一次 → 每 5 分钟一次 → 后台不刷 → 回前台且数据
 *   超过一个周期时补一次。周期必须与服务端的账户缓存 TTL（5 分钟）对齐，不然只是重复打供应商接口。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	accountStateView,
	BALANCE_DEGRADED_MS,
	BALANCE_MAX_RETRIES,
	BALANCE_REFRESH_MS,
	balanceFailuresOf,
	isAccountQueryFailed,
	resetBalanceFailures,
	startBalanceRefresh,
} from "../../web/src/channel-account.js";

/** 每个用例用独立渠道 id：失败计数是模块级按渠道记的。 */
let seq = 0;
const nextChannel = () => `ch-test-${++seq}`;

describe("账户状态呈现（chip / 详情 / 设置页行共用）", () => {
	it("stale 分两种：ttl = 待刷新（中性），failed = 已过期（警示 + 说明）", () => {
		// 数据只是旧了：渠道没有报错，不该用报警口径吓人。
		expect(accountStateView({ accountRef: "a", kind: "template", status: "stale", staleReason: "ttl" })).toEqual({
			labelKey: "channelAccountStaleTtl",
			tone: "aging",
			tipKey: "channelAccountStaleTtlTip",
		});
		expect(accountStateView({ accountRef: "a", kind: "template", status: "stale", staleReason: "failed" })).toEqual({
			labelKey: "channelAccountStale",
			tone: "bad",
			tipKey: "channelAccountStaleTip",
		});
		// 旧服务端/旧夹具没有 staleReason：按「上次查询失败」处理（保持原有文案）。
		expect(accountStateView({ accountRef: "a", kind: "template", status: "stale" })).toMatchObject({
			labelKey: "channelAccountStale",
			tone: "bad",
		});
	});

	it("ok / failed / unsupported / 未查询 的档位", () => {
		expect(accountStateView({ accountRef: "a", kind: "k", status: "ok" })).toMatchObject({ labelKey: "channelAccountOk", tone: "ok" });
		expect(accountStateView({ accountRef: "a", kind: "k", status: "failed" })).toMatchObject({ tone: "bad" });
		expect(accountStateView({ accountRef: "a", kind: "k", status: "unsupported" })).toMatchObject({ tone: "bad" });
		expect(accountStateView(undefined)).toMatchObject({ labelKey: "channelQuerying", tone: "unknown" });
	});

	it("isAccountQueryFailed：stale 里只有非 ttl 的那种算失败", () => {
		expect(isAccountQueryFailed(undefined)).toBe(false);
		expect(isAccountQueryFailed({ accountRef: "a", kind: "k", status: "ok" })).toBe(false);
		expect(isAccountQueryFailed({ accountRef: "a", kind: "k", status: "stale", staleReason: "ttl" })).toBe(false);
		expect(isAccountQueryFailed({ accountRef: "a", kind: "k", status: "stale", staleReason: "failed" })).toBe(true);
		// 旧服务端没有 staleReason 的 stale：以前就一直当失败处理，行为不变。
		expect(isAccountQueryFailed({ accountRef: "a", kind: "k", status: "stale" })).toBe(true);
		expect(isAccountQueryFailed({ accountRef: "a", kind: "k", status: "unsupported" })).toBe(false);
	});
});

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
	it("连续失败达到上限后降级为慢速探测，用户重试后恢复；成功后计数清零", () => {
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
		// 首次 + 最多 3 次重试：每过一个周期看上一次结果，失败就累加。
		for (let i = 0; i < 6; i++) vi.advanceTimersByTime(BALANCE_REFRESH_MS);
		expect(calls).toBe(1 + BALANCE_MAX_RETRIES);
		expect(balanceFailuresOf(channelId)).toBeGreaterThan(BALANCE_MAX_RETRIES);
		// 超限后不再按周期打接口（从每 2 分钟一次降级成每 10 分钟一次）：
		// 再推进 10 分钟，期间只补一次探测。
		vi.advanceTimersByTime(BALANCE_DEGRADED_MS);
		// @WHY 降级有界重试（而不是永久停止）：供应商恢复后不用等用户点重试也能自己恢复，
		//   否则一个查询已经正常的渠道会永远停留在「已过期」。
		expect(calls).toBe(2 + BALANCE_MAX_RETRIES);
		// 用户点「重试」→ 计数清零 → 常规周期立即恢复。
		resetBalanceFailures(channelId);
		expect(balanceFailuresOf(channelId)).toBe(0);
		status = "ok";
		vi.advanceTimersByTime(BALANCE_REFRESH_MS);
		expect(calls).toBe(3 + BALANCE_MAX_RETRIES);
		expect(balanceFailuresOf(channelId)).toBe(0);
		stop();
	});

	it("stale + 上次查询失败也算失败（带余额的渠道否则永远碰不到上限）", () => {
		vi.useFakeTimers();
		const channelId = nextChannel();
		let calls = 0;
		// 服务端把「查询失败但保留了上次余额」记成 stale：只看 status 会把它当成正常而清零计数。
		let failed = false;
		const stop = startBalanceRefresh({
			channelId,
			query: () => (calls += 1),
			statusOf: () => "stale" as const,
			queryFailedOf: () => failed,
			isHidden: () => false,
			lastCheckedAt: () => 0,
		});
		expect(calls).toBe(1); // 首次
		failed = true; // 此后服务端快照一直是「stale + 上次查询失败」
		for (let i = 0; i < 6; i++) vi.advanceTimersByTime(BALANCE_REFRESH_MS);
		expect(balanceFailuresOf(channelId)).toBeGreaterThan(BALANCE_MAX_RETRIES);
		expect(calls).toBe(1 + BALANCE_MAX_RETRIES);
		// 失败变成「只是数据旧了」→ 计数清零，恢复常规周期。
		failed = false;
		vi.advanceTimersByTime(BALANCE_DEGRADED_MS);
		expect(balanceFailuresOf(channelId)).toBe(0);
		stop();
	});
});
