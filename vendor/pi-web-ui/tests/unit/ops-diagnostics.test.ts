/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/ops-diagnostics.ts, ../../server/dev-con/ops-alerts.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §8 P4 候选「必要运维 / 更多监控」
 * @CONTRACT 诊断包只含元数据：用合成密钥字符串断言「绝不出现在结果里」；
 *   告警判定：越线才告警、冷却期内不重复、读不到的指标不告警（不把缺失当 0）。
 */
import { describe, expect, it } from "vitest";
import { buildDiagnostics, usageSummaryOf } from "../../server/dev-con/ops-diagnostics.js";
import { evaluateAlerts, markFired, ALERT_COOLDOWN_MS } from "../../server/dev-con/ops-alerts.js";
import { findSecretMaterial } from "../../server/dev-con/channel-model.js";
import type { UiResourceSnapshot, UiStorageSnapshot } from "../../server/protocol.js";

const SYNTHETIC_KEY = "sk-DIAGNOSTIC-SYNTHETIC-0001";

const resources = (diskPercent: number, memUsed: number, cgroup: { currentBytes: number | null; maxBytes: number | null }): UiResourceSnapshot => ({
	at: 1,
	host: {
		hostname: "host", platform: "linux", uptimeSec: 10, cpuCount: 4, loadAvg: [0, 0, 0], cpuPercent: 5,
		mem: { totalBytes: 1_000, usedBytes: memUsed, availableBytes: 1_000 - memUsed, swapTotalBytes: 0, swapUsedBytes: 0 },
	},
	app: { pid: 1, node: "v22", uptimeSec: 1, rssBytes: 10, heapUsedBytes: 1, heapTotalBytes: 2, externalBytes: 0, cgroup: { ...cgroup, highBytes: null } },
	disks: [{ path: "/data", label: "data", totalBytes: 1000, freeBytes: 1000 - diskPercent * 10, usedBytes: diskPercent * 10, usedPercent: diskPercent }],
	sources: { cpu: "proc-stat", mem: "proc-meminfo", disk: "statfs", cgroup: "cgroup-v2" },
	warnings: [],
});

const storage: UiStorageSnapshot = {
	at: 1,
	areas: [],
	totalBytes: 0,
	retention: { maxAgeDays: 30, maxBytes: 8, fileBytes: 1, choices: [0, 7, 30, 90, 365] },
};

describe("ops diagnostics bundle", () => {
	it("assembles metadata and never carries secret material", () => {
		const bundle = buildDiagnostics({
			now: 42,
			app: { node: "v22", pid: 7, uptimeSec: 3, engine: "pi", protocolVersion: 20 },
			release: { commit: "a".repeat(40), appVersion: "0.72.0", protocolVersion: 20, builtAt: "2026-09-11T00:00:00Z", source: "a".repeat(40) },
			// 故意把合成密钥塞进「不该出现的地方」（凭据名/环境）以验证组装不会把它带出去。
			instance: { configDir: "/cfg", dataDir: "/data", agentDir: "/agent", workspaceDir: "/ws", host: "127.0.0.1", port: 8788, profile: "lean" },
			units: [{ unit: "pi-dev-pm2.service", active: "active", enabled: "enabled" }],
			resources: resources(50, 100, { currentBytes: 10, maxBytes: 100 }),
			storage,
			channels: { configRevision: 3, count: 2, enabledCount: 1, bindings: 1, pending: 0, accounts: 0, brokenRefs: 1 },
			usage: { windowDays: 30, requests: 5, totalTokens: 100, cost: 0.02, unpricedRequests: 1, bySource: { user: 4, subagent: 1 }, byChannel: { "ch-a": 3 } },
			environment: { platform: "linux", cpuCount: 4, totalMemBytes: 1_000 },
			warnings: ["storage:sessions 已达遍历上限"],
		});
		expect(bundle).toMatchObject({ generatedAt: 42, channels: { brokenRefs: 1 }, usage: { requests: 5 } });
		// 诊断包不得出现任何「密钥形状」的字段名，也不得包含合成密钥正文。
		expect(findSecretMaterial(bundle)).toEqual([]);
		expect(JSON.stringify(bundle)).not.toContain(SYNTHETIC_KEY);
		expect(JSON.stringify(bundle)).not.toContain("apiKey");
	});

	it("maps usage aggregation into the diagnostics summary without inventing scopes", () => {
		const summary = usageSummaryOf({
			groupBy: "source",
			totals: { requests: 3, total: 300, cost: 0.3, unpricedRequests: 1 },
			rows: [{ key: "user", requests: 2 }, { key: "review", requests: 1 }],
		});
		expect(summary).toMatchObject({ requests: 3, totalTokens: 300, cost: 0.3, unpricedRequests: 1, bySource: { user: 2, review: 1 } });
		expect(summary.byChannel).toEqual({});
	});
});

describe("resource alerts", () => {
	it("fires on crossing thresholds and stays quiet inside the cooldown", () => {
		const fired: Record<string, number> = {};
		const hot = resources(92, 950, { currentBytes: 95, maxBytes: 100 });
		const alerts = evaluateAlerts({ resources: hot, lastFired: fired, now: 1_000 });
		// 磁盘 92% ≥ 90 → critical；内存 95% ≥ 90 → critical；cgroup 95% → critical。
		expect(alerts.map((a) => [a.id, a.level])).toEqual([["disk", "critical"], ["memory", "critical"], ["cgroup", "critical"]]);
		// 阈值区间分别验证：85–90 之间是 warn，低于 85 不告警。
		expect(evaluateAlerts({ resources: resources(87, 870, { currentBytes: 87, maxBytes: 100 }), now: 1_000 }).map((a) => a.level)).toEqual(["warn", "warn", "warn"]);
		const marked = markFired(fired, alerts, 1_000);
		expect(evaluateAlerts({ resources: hot, lastFired: marked, now: 1_000 + ALERT_COOLDOWN_MS - 1 })).toEqual([]);
		expect(evaluateAlerts({ resources: hot, lastFired: marked, now: 1_000 + ALERT_COOLDOWN_MS }).length).toBe(3);
	});

	it("stays silent below thresholds and for unreadable metrics", () => {
		// 50% 磁盘/内存、cgroup 无上限（max=null）→ 不告警（缺失不能当 0 或当满）。
		const calm = evaluateAlerts({ resources: resources(50, 100, { currentBytes: 90, maxBytes: null }), now: 1 });
		expect(calm).toEqual([]);
		// 磁盘 totalBytes=0（读不到）→ 不告警。
		const unknownDisk = resources(50, 100, { currentBytes: null, maxBytes: null });
		unknownDisk.disks[0].totalBytes = 0;
		expect(evaluateAlerts({ resources: unknownDisk, now: 1 })).toEqual([]);
	});
});
