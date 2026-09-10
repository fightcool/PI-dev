/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/usage-history.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §7（逐请求记录字段）+ §8 P4 首个切片（跨渠道/项目/时间历史）
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
	channelId: "ch-a",
	credentialKeyName: "密钥 1",
	providerId: "main",
	modelId: "m1",
	bindingRevision: 2,
	configRevision: 5,
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
	it("groups by channel, project, model, source and UTC day without inventing attribution", () => {
		const records = [
			record({ id: "a", channelId: "ch-a", cwd: "/p1", total: 100, cost: 0.01 }),
			record({ id: "b", channelId: "ch-a", cwd: "/p2", total: 50, cost: 0.02, modelId: "m2" }),
			record({ id: "c", channelId: null, cwd: null, total: 10, cost: 0, costBasis: "unknown", source: "subagent", at: T0 + DAY }),
		];
		const byChannel = aggregateUsage(records, { groupBy: "channel" });
		expect(byChannel.rows.map((r) => [r.key, r.requests, r.total])).toEqual([["ch-a", 2, 150], ["unattributed", 1, 10]]);
		expect(byChannel.totals).toMatchObject({ requests: 3, total: 160, cost: 0.03, unpricedRequests: 1 });
		expect(aggregateUsage(records, { groupBy: "project" }).rows.map((r) => r.key).sort()).toEqual(["/p1", "/p2", "unattributed"]);
		expect(aggregateUsage(records, { groupBy: "model" }).rows.map((r) => r.key).sort()).toEqual(["main/m1", "main/m2"]);
		expect(aggregateUsage(records, { groupBy: "source" }).rows.map((r) => r.key).sort()).toEqual(["subagent", "user"]);
		const byDay = aggregateUsage(records, { groupBy: "day" });
		expect(byDay.rows.map((r) => r.key)).toEqual(["2026-09-10", "2026-09-11"]);
		expect(byDay.rows[0].firstAt).toBe(T0);
		expect(byDay.rows[1].lastAt).toBe(T0 + DAY);
	});

	it("filters by the time window inclusively and reports scanned/skipped/truncated", () => {
		const records = [record({ id: "old", at: T0 - 10 * DAY }), record({ id: "in", at: T0 }), record({ id: "new", at: T0 + 10 * DAY })];
		const window = aggregateUsage(records, { groupBy: "channel", from: T0, to: T0 + DAY });
		expect(window.totals.requests).toBe(1);
		expect(window.from).toBe(T0);
		expect(aggregateUsage(records, { groupBy: "day" }, { scanned: 3, skipped: 2, truncated: true })).toMatchObject({ scanned: 3, skipped: 2, truncated: true });
	});

	it("keeps unknown prices visible instead of merging them into zero", () => {
		const rows = aggregateUsage(
			[record({ id: "priced", cost: 0.5 }), record({ id: "unpriced", cost: 0, costBasis: "unknown", currency: null })],
			{ groupBy: "channel" },
		).rows[0];
		expect(rows.cost).toBe(0.5);
		expect(rows.unpricedRequests).toBe(1);
		expect(rows.requests).toBe(2);
	});

	it("keys are derived from the record only", () => {
		expect(groupKeyOf(record({ channelId: null }), "channel")).toBe("unattributed");
		expect(groupKeyOf(record({ cwd: null }), "project")).toBe("unattributed");
		expect(groupKeyOf(record(), "model")).toBe("main/m1");
		expect(groupKeyOf(record(), "day")).toBe("2026-09-10");
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
		const result = store.query({ groupBy: "channel" });
		expect(result.rows.map((r) => [r.key, r.requests, r.total])).toEqual([["ch-a", 2, 136]]);
		expect(result.scanned).toBe(2);
		expect(result.skipped).toBe(2);
		expect(result.truncated).toBe(false);
	});

	it("rotates to a single previous generation and still reads both", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"), { maxBytes: 200 });
		for (let i = 0; i < 6; i += 1) store.append(record({ id: `r${i}`, total: 10 }));
		expect(statSync(`${store.filePath()}.1`).size).toBeGreaterThan(0);
		const result = store.query({ groupBy: "channel" });
		expect(result.scanned).toBeGreaterThan(1);
		expect(result.totals.requests).toBe(result.scanned);
	});

	it("stops at the scan cap and marks the result truncated", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"), { maxRecords: 2 });
		for (let i = 0; i < 5; i += 1) store.append(record({ id: `r${i}` }));
		const result = store.query({ groupBy: "channel" });
		expect(result.scanned).toBe(2);
		expect(result.truncated).toBe(true);
		expect(result.totals.requests).toBe(2);
	});

	it("writes owner-only permissions", () => {
		const store = new UsageHistoryStore(join(dir, "usage-history.jsonl"));
		store.append(record());
		if (process.platform !== "win32") expect(statSync(store.filePath()).mode & 0o777).toBe(0o600);
	});
});
