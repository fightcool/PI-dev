/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/failure-alert.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §8 P4 候选「更多监控」
 * 覆盖：双阈值（次数 + 失败率）、窗口裁剪、未归属样本、冷却、多主体排序。
 * 纯函数，无时钟/无 IO：now 由调用方注入。
 */
import { describe, expect, it } from "vitest";
import {
	FAILURE_COOLDOWN_MS,
	FAILURE_MIN_FAILURES,
	FAILURE_WINDOW_MS,
	evaluateFailureAlerts,
	type FailureSample,
} from "../../server/dev-con/failure-alert.js";

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);

const sample = (extra: Partial<FailureSample> = {}): FailureSample => ({
	at: T0,
	subjectKey: "provider:p3",
	failed: false,
	input: 100_000,
	...extra,
});

/** n 个失败样本（默认集中在 T0；extra 优先，便于把样本推到窗口外/换渠道）。 */
const failures = (n: number, extra: Partial<FailureSample> = {}): FailureSample[] =>
	Array.from({ length: n }, (_, i) => sample({ at: T0 + i, failed: true, ...extra }));

describe("failure alerts", () => {
	it("fires once a subject crosses both the failure count and the rate threshold", () => {
		// 5 失败 / 20 请求 = 25%：次数与失败率都过线。
		const samples = [...failures(FAILURE_MIN_FAILURES), ...Array.from({ length: 15 }, (_, i) => sample({ at: T0 + i }))];
		const alerts = evaluateFailureAlerts({ samples, now: T0 + 1000 });
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ subjectKey: "provider:p3", failed: 5, requests: 20, rate: 0.25 });
		expect(alerts[0].wastedInput).toBe(5 * 100_000);
		expect(alerts[0].key).toBe("failure:provider:p3");
	});

	it("stays quiet below the failure-count floor even at a 100% rate", () => {
		// 2 次里 2 次失败 = 100%，但样本太少，不足以说明这个服务商有问题。
		expect(evaluateFailureAlerts({ samples: failures(2), now: T0 + 1000 })).toEqual([]);
	});

	it("stays quiet below the rate floor even with many failures", () => {
		// 5 失败但分母 1000：0.5% < 5%，属于正常噪声。
		const samples = [...failures(5), ...Array.from({ length: 995 }, (_, i) => sample({ at: T0 + i }))];
		expect(evaluateFailureAlerts({ samples, now: T0 + 1000 })).toEqual([]);
	});

	it("ignores samples outside the window and samples with no subject", () => {
		const stale = failures(9, { at: T0 - FAILURE_WINDOW_MS - 1 });
		const unattributed = failures(9, { subjectKey: null });
		expect(evaluateFailureAlerts({ samples: [...stale, ...unattributed], now: T0 })).toEqual([]);
		// 窗口边界（恰好等于窗口）算在内，避免边界样本被静默丢掉。
		expect(evaluateFailureAlerts({ samples: failures(5, { at: T0 - FAILURE_WINDOW_MS }), now: T0 })).toHaveLength(1);
	});

	it("respects the cooldown per subject via lastFired", () => {
		const samples = failures(FAILURE_MIN_FAILURES);
		const key = "failure:provider:p3";
		expect(evaluateFailureAlerts({ samples, now: T0, lastFired: { [key]: T0 - 1000 } })).toEqual([]);
		expect(evaluateFailureAlerts({ samples, now: T0, lastFired: { [key]: T0 - FAILURE_COOLDOWN_MS } })).toHaveLength(1);
		// 冷却按主体隔离：别的服务商已触发，不影响本主体。
		expect(evaluateFailureAlerts({ samples, now: T0, lastFired: { "failure:provider:other": T0 } })).toHaveLength(1);
	});

	it("reports every affected subject, worst first, and keeps labels", () => {
		const samples = [
			...failures(6, { subjectKey: "provider:a", subjectLabel: "UU apiClaude" }),
			...Array.from({ length: 4 }, (_, i) => sample({ subjectKey: "provider:a", subjectLabel: "UU apiClaude", at: T0 + i })),
			...failures(9, { subjectKey: "provider:b", subjectLabel: "CCCQclaude" }),
		];
		const alerts = evaluateFailureAlerts({ samples, now: T0 + 1000 });
		expect(alerts.map((a) => a.subjectKey)).toEqual(["provider:b", "provider:a"]);
		expect(alerts[0].subjectLabel).toBe("CCCQclaude");
		expect(alerts[1].subjectLabel).toBe("UU apiClaude");
	});

	it("keeps every subject independent (one provider's alert never silences another)", () => {
		const samples = [
			...failures(5, { subjectKey: "provider:uu-api" }),
			...Array.from({ length: 20 }, (_, i) => sample({ subjectKey: "provider:deepseek", at: T0 + i })),
		];
		const alerts = evaluateFailureAlerts({ samples, now: T0 + 1000 });
		expect(alerts).toHaveLength(1);
		expect(alerts[0].subjectKey).toBe("provider:uu-api");
	});

	it("counts wasted input only from failed samples", () => {
		const samples = [sample({ failed: true, input: 1_000 }), sample({ failed: false, input: 999_999 }), ...failures(4, { input: 1_000 })];
		const alerts = evaluateFailureAlerts({ samples, now: T0 + 1000 });
		expect(alerts[0].wastedInput).toBe(5_000);
	});

	it("stays silent when the failures never billed any input (quota, pre-request rejects)", () => {
		// 真实回测：零计费的失败（额度不足 403、请求前就被网关拒掉）在历史上一共有 7 次会越过
		// 次数+失败率双阈值，全部是噪声——它们不是「白烧」（没烧到钱），而且本身已有可见出口
		// （报错卡 + 余额面板）。告警只该盯「请求数与费用看上去完全正常」的那种损失。
		expect(evaluateFailureAlerts({ samples: failures(8, { input: 0 }), now: T0 + 1000 })).toEqual([]);
		// 只要其中一条真的计费了输入，它又该报了。
		const mixed = [...failures(4, { input: 0 }), ...failures(1, { input: 500 })];
		expect(evaluateFailureAlerts({ samples: mixed, now: T0 + 1000 })).toHaveLength(1);
	});
});
