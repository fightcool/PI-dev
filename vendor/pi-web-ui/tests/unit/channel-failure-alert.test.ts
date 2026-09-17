/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/channel-failure-alert.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §8 P4 候选「更多监控」
 * 覆盖：双阈值（次数 + 失败率）、窗口裁剪、未归属样本、冷却、多渠道路由顺序。
 * 纯函数，无时钟/无 IO：now 由调用方注入。
 */
import { describe, expect, it } from "vitest";
import {
	CHANNEL_FAILURE_COOLDOWN_MS,
	CHANNEL_FAILURE_MIN_FAILURES,
	CHANNEL_FAILURE_WINDOW_MS,
	evaluateChannelFailureAlerts,
	type FailureSample,
} from "../../server/dev-con/channel-failure-alert.js";

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);

const sample = (extra: Partial<FailureSample> = {}): FailureSample => ({
	at: T0,
	subjectKey: "channel:ch-3",
	failed: false,
	input: 100_000,
	...extra,
});

/** n 个失败样本（默认集中在 T0；extra 优先，便于把样本推到窗口外/换渠道）。 */
const failures = (n: number, extra: Partial<FailureSample> = {}): FailureSample[] =>
	Array.from({ length: n }, (_, i) => sample({ at: T0 + i, failed: true, ...extra }));

describe("channel failure alerts", () => {
	it("fires once a channel crosses both the failure count and the rate threshold", () => {
		// 5 失败 / 20 请求 = 25%：次数与失败率都过线。
		const samples = [...failures(CHANNEL_FAILURE_MIN_FAILURES), ...Array.from({ length: 15 }, (_, i) => sample({ at: T0 + i }))];
		const alerts = evaluateChannelFailureAlerts({ samples, now: T0 + 1000 });
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ subjectKey: "channel:ch-3", failed: 5, requests: 20, rate: 0.25 });
		expect(alerts[0].wastedInput).toBe(5 * 100_000);
		expect(alerts[0].key).toBe("channel-failure:channel:ch-3");
	});

	it("stays quiet below the failure-count floor even at a 100% rate", () => {
		// 2 次里 2 次失败 = 100%，但样本太少，不足以说明渠道有问题。
		expect(evaluateChannelFailureAlerts({ samples: failures(2), now: T0 + 1000 })).toEqual([]);
	});

	it("stays quiet below the rate floor even with many failures", () => {
		// 5 失败但分母 1000：0.5% < 5%，属于正常噪声。
		const samples = [...failures(5), ...Array.from({ length: 995 }, (_, i) => sample({ at: T0 + i }))];
		expect(evaluateChannelFailureAlerts({ samples, now: T0 + 1000 })).toEqual([]);
	});

	it("ignores samples outside the window and samples with no subject", () => {
		const stale = failures(9, { at: T0 - CHANNEL_FAILURE_WINDOW_MS - 1 });
		const unattributed = failures(9, { subjectKey: null });
		expect(evaluateChannelFailureAlerts({ samples: [...stale, ...unattributed], now: T0 })).toEqual([]);
		// 窗口边界（恰好等于窗口）算在内，避免边界样本被静默丢掉。
		expect(evaluateChannelFailureAlerts({ samples: failures(5, { at: T0 - CHANNEL_FAILURE_WINDOW_MS }), now: T0 })).toHaveLength(1);
	});

	it("respects the cooldown per subject via lastFired", () => {
		const samples = failures(CHANNEL_FAILURE_MIN_FAILURES);
		const key = "channel-failure:channel:ch-3";
		expect(evaluateChannelFailureAlerts({ samples, now: T0, lastFired: { [key]: T0 - 1000 } })).toEqual([]);
		expect(evaluateChannelFailureAlerts({ samples, now: T0, lastFired: { [key]: T0 - CHANNEL_FAILURE_COOLDOWN_MS } })).toHaveLength(1);
		// 冷却按渠道隔离：别的渠道已触发，不影响本渠道。
		expect(evaluateChannelFailureAlerts({ samples, now: T0, lastFired: { "channel-failure:channel:other": T0 } })).toHaveLength(1);
	});

	it("reports every affected subject, worst first, and keeps labels", () => {
		const samples = [
			...failures(6, { subjectKey: "channel:ch-a", subjectLabel: "UU apiClaude" }),
			...Array.from({ length: 4 }, (_, i) => sample({ subjectKey: "channel:ch-a", subjectLabel: "UU apiClaude", at: T0 + i })),
			...failures(9, { subjectKey: "channel:ch-b", subjectLabel: "CCCQclaude" }),
		];
		const alerts = evaluateChannelFailureAlerts({ samples, now: T0 + 1000 });
		expect(alerts.map((a) => a.subjectKey)).toEqual(["channel:ch-b", "channel:ch-a"]);
		expect(alerts[0].subjectLabel).toBe("CCCQclaude");
		expect(alerts[1].subjectLabel).toBe("UU apiClaude");
	});

	it("treats a provider-level subject as its own alert target", () => {
		// 无渠道绑定的请求回落到 provider：最严重的白烧实测都落在这一类，
		// 只认渠道会让告警完全沉默。
		const alerts = evaluateChannelFailureAlerts({ samples: failures(5, { subjectKey: "provider:uu-api" }), now: T0 + 1000 });
		expect(alerts).toHaveLength(1);
		expect(alerts[0].subjectKey).toBe("provider:uu-api");
	});

	it("counts wasted input only from failed samples", () => {
		const samples = [sample({ failed: true, input: 1_000 }), sample({ failed: false, input: 999_999 }), ...failures(4, { input: 1_000 })];
		const alerts = evaluateChannelFailureAlerts({ samples, now: T0 + 1000 });
		expect(alerts[0].wastedInput).toBe(5_000);
	});
});
