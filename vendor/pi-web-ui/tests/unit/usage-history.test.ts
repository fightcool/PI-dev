/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/usage-history.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §7（逐请求记录字段）+ §8 P4 首个切片（跨服务商/项目/时间历史）
 * 覆盖：五种分组、时间窗、无归属诚实标记、未知价格计数、轮转、损坏行、扫描上限。
 */
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	aggregateUsage,
	groupKeyOf,
	UsageHistoryStore,
	type UsageHistoryRecord,
} from "../../server/dev-con/usage-history.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 10, 12, 0, 0); // 2026-09-10T12:00:00Z

const record = (extra: Partial<UsageHistoryRecord> = {}): UsageHistoryRecord => ({
	id: "r:1",
	at: T0,
	runId: "run-1",
	conversationId: "c1",
	cwd: "/proj-a",
	source: "user",
	providerId: "main",
	modelId: "m1",
	input: 100,
	output: 20,
	cacheRead: 5,
	cacheWrite: 1,
	total: 126,
	cost: 0.02,
	costBasis: "sdk-model-pricing",
	currency: "USD",
	...extra,
});

describe("usage history aggregation", () => {
	it("groups by provider, project, model, source and UTC day without inventing attribution", () => {
		const records = [
			record({ id: "a", providerId: "gw", cwd: "/p1", total: 100, cost: 0.01 }),
			record({ id: "b", providerId: "gw", cwd: "/p2", total: 50, cost: 0.02, modelId: "m2" }),
			record({ id: "c", providerId: "", cwd: null, total: 10, cost: 0, costBasis: "unknown", source: "subagent", at: T0 + DAY }),
		];
		const byProvider = aggregateUsage(records, { groupBy: "provider" });
		expect(byProvider.rows.map((r) => [r.key, r.requests, r.total])).toEqual([["gw", 2, 150], ["unattributed", 1, 10]]);
		expect(byProvider.totals).toMatchObject({ requests: 3, total: 160, cost: 0.03, unpricedRequests: 1 });
		expect(aggregateUsage(records, { groupBy: "project" }).rows.map((r) => r.key).sort()).toEqual(["/p1", "/p2", "unattributed"]);
		expect(aggregateUsage(records, { groupBy: "model" }).rows.map((r) => r.key).sort()).toEqual(["/m1", "gw/m1", "gw/m2"]);
		expect(aggregateUsage(records, { groupBy: "source" }).rows.map((r) => r.key).sort()).toEqual(["subagent", "user"]);
		const byDay = aggregateUsage(records, { groupBy: "day" });
		expect(byDay.rows.map((r) => r.key)).toEqual(["2026-09-10", "2026-09-11"]);
		expect(byDay.rows[0].firstAt).toBe(T0);
		expect(byDay.rows[1].lastAt).toBe(T0 + DAY);
	});

	it("filters by the time window inclusively and reports scanned/skipped/truncated", () => {
		const records = [record({ id: "old", at: T0 - 10 * DAY }), record({ id: "in", at: T0 }), record({ id: "new", at: T0 + 10 * DAY })];
		const window = aggregateUsage(records, { groupBy: "provider", from: T0, to: T0 + DAY });
		expect(window.totals.requests).toBe(1);
		expect(window.from).toBe(T0);
		expect(aggregateUsage(records, { groupBy: "day" }, { scanned: 3, skipped: 2, truncated: true })).toMatchObject({ scanned: 3, skipped: 2, truncated: true });
	});

	it("keeps unknown prices visible instead of merging them into zero", () => {
		const rows = aggregateUsage(
			[record({ id: "priced", cost: 0.5 }), record({ id: "unpriced", cost: 0, costBasis: "unknown", currency: null })],
			{ groupBy: "provider" },
		).rows[0];
		expect(rows.cost).toBe(0.5);
		expect(rows.unpricedRequests).toBe(1);
		expect(rows.requests).toBe(2);
	});

	it("counts requests whose provider reported no usage (0 tokens != no spend)", () => {
		const rows = aggregateUsage(
			[record({ id: "reported", total: 100 }), record({ id: "silent", total: 0, cost: 0, costBasis: "unknown", usageKnown: false })],
			{ groupBy: "provider" },
		).rows[0];
		expect(rows.unreportedRequests).toBe(1);
		expect(rows.requests).toBe(2);
		// 旧记录没有 usageKnown 字段：按「已上报」处理，不能误判成未上报。
		expect(aggregateUsage([record({ id: "legacy" })], { groupBy: "provider" }).rows[0].unreportedRequests).toBe(0);
	});

	it("keys are derived from the record only", () => {
		expect(groupKeyOf(record({ providerId: "" }), "provider")).toBe("unattributed");
		expect(groupKeyOf(record({ cwd: null }), "project")).toBe("unattributed");
		expect(groupKeyOf(record(), "model")).toBe("main/m1");
		expect(groupKeyOf(record(), "day")).toBe("2026-09-10");
	});

	it("reports a token-weighted cache hit rate, not a per-request average", () => {
		// 小请求 100% 命中、大请求全未命中：逐请求平均会得 50%，
		// token 加权则应该被大请求压到接近 0——后者才是真实成本口径。
		const rows = aggregateUsage(
			[
				record({ id: "small", input: 0, cacheRead: 100, cacheWrite: 0, total: 100 }),
				record({ id: "big", input: 100_000, cacheRead: 0, cacheWrite: 0, total: 100_000 }),
			],
			{ groupBy: "provider" },
		).rows[0];
		expect(rows.cacheHitRate).toBeCloseTo(100 / 100_100, 10);
		expect(rows.cacheHitRate).not.toBeCloseTo(0.5, 2);
	});

	it("counts cache writes in the hit-rate denominator", () => {
		// 首次请求：只写缓存（无命中）→ 0%；下一个请求把同一段读回来 → 命中率上升。
		const cold = aggregateUsage([record({ id: "cold", input: 900, cacheRead: 0, cacheWrite: 100 })], { groupBy: "provider" });
		expect(cold.rows[0].cacheHitRate).toBe(0);
		expect(cold.totals.cacheHitRate).toBe(0);
		const warm = aggregateUsage(
			[record({ id: "cold", input: 900, cacheRead: 0, cacheWrite: 100 }), record({ id: "warm", input: 0, cacheRead: 1_000, cacheWrite: 0 })],
			{ groupBy: "provider" },
		);
		expect(warm.rows[0].cacheHitRate).toBeCloseTo(1_000 / 2_000, 10);
		expect(warm.totals.cacheHitRate).toBeCloseTo(1_000 / 2_000, 10);
	});

	it("returns null when there are no tokens to compute over (never 0%)", () => {
		// 全部未上报：0 token 不等于「命中率 0%」，界面要显示「—」。
		const silent = aggregateUsage(
			[record({ id: "silent", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, costBasis: "unknown", usageKnown: false })],
			{ groupBy: "provider" },
		);
		expect(silent.rows[0].cacheHitRate).toBeNull();
		expect(silent.totals.cacheHitRate).toBeNull();
		// 空窗口同样是 null，不是 0。
		expect(aggregateUsage([], { groupBy: "provider" }).totals.cacheHitRate).toBeNull();
	});

	it("keeps per-group rates independent", () => {
		const result = aggregateUsage(
			[
				record({ id: "a", providerId: "gw-hit", input: 10, cacheRead: 990, cacheWrite: 0 }),
				record({ id: "b", providerId: "gw-miss", input: 1_000, cacheRead: 0, cacheWrite: 0 }),
			],
			{ groupBy: "provider" },
		);
		const byKey = new Map(result.rows.map((r) => [r.key, r.cacheHitRate]));
		expect(byKey.get("gw-hit")).toBeCloseTo(0.99, 10);
		expect(byKey.get("gw-miss")).toBe(0);
	});

	it("counts failed requests and the input they wasted (gateway dropped the stream)", () => {
		// 网关搞流：输入照计费、输出为空（stopReason=error，errorMessage 记原因）。
		const rows = aggregateUsage(
			[
				record({ id: "truncated", stopReason: "error", failureReason: "Anthropic stream ended before message_stop", input: 1_147, cacheRead: 73_414, cacheWrite: 351, output: 1 }),
				record({ id: "ok", stopReason: "stop", output: 120 }),
			],
			{ groupBy: "provider" },
		).rows[0];
		expect(rows.failedRequests).toBe(1);
		expect(rows.wastedInput).toBe(1_147 + 73_414 + 351);
		expect(rows.requests).toBe(2);
	});

	it("does not count user-cancelled requests as failures", () => {
		// 用户主动中止（aborted）是有意为之：算成故障会让告警变成噪声、也误导渠道判断。
		const totals = aggregateUsage([record({ id: "stopped", stopReason: "aborted", input: 5_000 })], { groupBy: "provider" }).totals;
		expect(totals.failedRequests).toBe(0);
		expect(totals.wastedInput).toBe(0);
	});

	it("treats legacy records without stopReason as not failed", () => {
		// 旧记录没有 stopReason 字段：不能因此被当成失败。
		const totals = aggregateUsage([record({ id: "legacy" })], { groupBy: "provider" }).totals;
		expect(totals.failedRequests).toBe(0);
		expect(totals.wastedInput).toBe(0);
	});
});

describe("usage history store", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-dev-usage-history-"));
	});

	it("appends JSONL, reads it back and survives malformed lines", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"));
		store.append(record({ id: "one" }));
		store.append(record({ id: "two", total: 10 }));
		writeFileSync(store.filePath(), `${readFileSync(store.filePath(), "utf8")}{ not json }\n{"id":"bad"}\n`, { mode: 0o600 });
		const result = store.query({ groupBy: "provider" });
		expect(result.rows.map((r) => [r.key, r.requests, r.total])).toEqual([["main", 2, 136]]);
		expect(result.scanned).toBe(2);
		expect(result.skipped).toBe(2);
		expect(result.truncated).toBe(false);
	});

	it("rotates to a single previous generation and still reads both", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"), { maxBytes: 200 });
		for (let i = 0; i < 6; i += 1) store.append(record({ id: `r${i}`, total: 10 }));
		expect(statSync(`${store.filePath()}.1`).size).toBeGreaterThan(0);
		const result = store.query({ groupBy: "provider" });
		expect(result.scanned).toBeGreaterThan(1);
		expect(result.totals.requests).toBe(result.scanned);
	});

	it("stops at the scan cap and marks the result truncated", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"), { maxRecords: 2 });
		for (let i = 0; i < 5; i += 1) store.append(record({ id: `r${i}` }));
		const result = store.query({ groupBy: "provider" });
		expect(result.scanned).toBe(2);
		expect(result.truncated).toBe(true);
		expect(result.totals.requests).toBe(2);
	});

	it("prunes records older than the configured retention and keeps newer ones", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"));
		expect(store.readSettings().maxAgeDays).toBe(0);
		store.append(record({ id: "old", at: T0 - 40 * DAY }));
		store.append(record({ id: "fresh", at: T0 }));
		// 写入非法值被归一化为 0（只按大小轮转）。
		expect(store.writeSettings(3).maxAgeDays).toBe(0);
		expect(store.writeSettings(30).maxAgeDays).toBe(30);
		const pruned = store.pruneByAge(T0);
		expect(pruned).toMatchObject({ removed: 1, kept: 1, maxAgeDays: 30 });
		const after = store.query({ groupBy: "provider" });
		expect(after.scanned).toBe(1);
		expect(after.rows[0].requests).toBe(1);
		// 保留 0 天（关闭）时不做时间清理。
		store.writeSettings(0);
		expect(store.pruneByAge(T0)).toMatchObject({ removed: 0, maxAgeDays: 0 });
	});

	it("keeps damaged lines when pruning (evidence is never dropped silently)", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"));
		store.writeSettings(7);
		store.append(record({ id: "kept", at: T0 }));
		writeFileSync(store.filePath(), `{ damaged\n${readFileSync(store.filePath(), "utf8")}`, { mode: 0o600 });
		const pruned = store.pruneByAge(T0 + 30 * DAY);
		expect(pruned.removed).toBe(1);
		expect(readFileSync(store.filePath(), "utf8")).toContain("{ damaged");
	});

	it("writes owner-only permissions", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"));
		store.append(record());
		if (process.platform !== "win32") expect(statSync(store.filePath()).mode & 0o777).toBe(0o600);
	});
});
