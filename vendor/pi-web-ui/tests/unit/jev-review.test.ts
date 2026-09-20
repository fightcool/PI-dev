/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-review.ts
 * 📖 docs/JEV-DECISION-GATE.md §4.4（真实样本复盘回路）
 * @WHY 到期判定与导出语料都是**纯逻辑**，所以这里注入固定的 now：不依赖时钟、不碰磁盘。
 *   重点钉两条契约：① review 结论**不导出**（没有真值，硬填 label 就是自欺）；
 *   ② 一条样本带多命题时按命题各出一条（tune 的统计按命题分组）。
 */
import { describe, expect, it } from "vitest";
import type { JevSampleEntry, JevSampleSource } from "../../server/dev-con/jev-samples.js";
import {
	JEV_REVIEW_MAX_AGE_MS,
	JEV_REVIEW_MIN_ENTRIES,
	corpusToJsonl,
	reviewStatus,
	samplesToCorpus,
} from "../../server/dev-con/jev-review.js";

const DAY = 24 * 60 * 60_000;
const NOW = 1_700_000_000_000;

function sample(overrides: Partial<JevSampleEntry> = {}): JevSampleEntry {
	return {
		v: 1,
		at: NOW,
		propositions: ["change_within_task_scope"],
		checks: { change_within_task_scope: 0.56 },
		outcome: "approve",
		reason: "r",
		reasonEn: "r",
		source: "tool" as JevSampleSource,
		model: "typesafe/jev-1.13",
		state: '{"objective":"o","diff":"-a\\n+b"}',
		stateChars: 32,
		stateHash: "hash-a",
		...overrides,
	};
}

describe("reviewStatus", () => {
	it("从未确认时从最早的样本算起（第一次跑一周后要能提醒）", () => {
		const status = reviewStatus([sample({ at: NOW - 8 * DAY })], { lastAckAt: null, now: NOW });
		expect(status.pending).toBe(1);
		expect(status.due).toBe(true);
		expect(status.reason).toBe("age");
		expect(status.oldestPendingAt).toBe(NOW - 8 * DAY);
	});

	it("攒够条数即到期（先到先触发）", () => {
		const entries = Array.from({ length: JEV_REVIEW_MIN_ENTRIES }, (_, i) =>
			sample({ at: NOW - i, stateHash: `h${i}` }),
		);
		const status = reviewStatus(entries, { lastAckAt: null, now: NOW });
		expect(status.pending).toBe(JEV_REVIEW_MIN_ENTRIES);
		expect(status.due).toBe(true);
		expect(status.reason).toBe("entries");
		expect(status.thresholds.minEntries).toBe(JEV_REVIEW_MIN_ENTRIES);
	});

	it("条数与时间都不够时不到期", () => {
		const status = reviewStatus([sample({ at: NOW - DAY })], { lastAckAt: null, now: NOW });
		expect(status.due).toBe(false);
		expect(status.reason).toBeNull();
	});

	it("ack 之后只算新增（已复盘的不再计入）", () => {
		const entries = [sample({ at: NOW - 10 * DAY, stateHash: "old" }), sample({ at: NOW - 1000, stateHash: "new" })];
		const status = reviewStatus(entries, { lastAckAt: NOW - 2 * DAY, now: NOW });
		expect(status.pending).toBe(1);
		expect(status.due).toBe(false);
		expect(status.lastAckAt).toBe(NOW - 2 * DAY);
		expect(status.oldestPendingAt).toBe(NOW - 1000);
	});

	it("统计需要人判的转人工条数（这些没有真值）", () => {
		const entries = [sample({ outcome: "review", stateHash: "a" }), sample({ outcome: "block", stateHash: "b" })];
		expect(reviewStatus(entries, { lastAckAt: null, now: NOW }).needsHumanLabel).toBe(1);
	});

	it("空样本：pending 0、不到期、不抛", () => {
		const status = reviewStatus([], { lastAckAt: null, now: NOW });
		expect(status.pending).toBe(0);
		expect(status.due).toBe(false);
		expect(status.oldestPendingAt).toBeNull();
	});

	it("阈值可覆盖（便于测试与将来调参）", () => {
		const status = reviewStatus([sample({ at: NOW - 2 * DAY })], {
			lastAckAt: null,
			now: NOW,
			minEntries: 1,
			maxAgeMs: JEV_REVIEW_MAX_AGE_MS,
		});
		expect(status.reason).toBe("entries");
	});
});

describe("samplesToCorpus", () => {
	it("approve → should-pass、block → should-block，并标记 label 是机器预填", () => {
		const { items } = samplesToCorpus([sample({ outcome: "approve" }), sample({ outcome: "block", stateHash: "b" })]);
		expect(items.map((i) => i.label)).toEqual(["should-pass", "should-block"]);
		expect(items.every((i) => i.labelFromOutcome)).toBe(true);
	});

	it("review 结论不导出，只计数（没有真值）", () => {
		const { items, skipped } = samplesToCorpus([sample({ outcome: "review" })]);
		expect(items).toEqual([]);
		expect(skipped.unlabeledOutcome).toBe(1);
	});

	it("没有被审内容的样本不导出（没有内容可复盘）", () => {
		const { items, skipped } = samplesToCorpus([sample({ state: "" })]);
		expect(items).toEqual([]);
		expect(skipped.noState).toBe(1);
	});

	it("一条样本带两命题 → 出两条（各自的 id 不同）", () => {
		const { items } = samplesToCorpus([sample({ propositions: ["a_prop", "b_prop"] })]);
		expect(items.length).toBe(2);
		expect(new Set(items.map((i) => i.id)).size).toBe(2);
		expect(items.map((i) => i.propositions)).toEqual([["a_prop"], ["b_prop"]]);
	});

	it("同 (stateHash, 命题) 只保留最新一条，并计入 duplicate", () => {
		const entries = [
			sample({ at: NOW - DAY, outcome: "block", stateHash: "same" }),
			sample({ at: NOW, outcome: "approve", stateHash: "same" }),
		];
		const { items, skipped } = samplesToCorpus(entries);
		expect(items.length).toBe(1);
		expect(items[0]!.label).toBe("should-pass");
		expect(skipped.duplicate).toBe(1);
	});

	it("state 是 JSON 文本时还原成对象（tune 的 state 形状不限，但对象更好读）", () => {
		const { items } = samplesToCorpus([sample({ state: '{"objective":"o","diff":"d"}' })]);
		expect(items[0]!.state).toEqual({ objective: "o", diff: "d" });
	});

	it("state 不是 JSON 时原样保留字符串", () => {
		const { items } = samplesToCorpus([sample({ state: "plain diff text" })]);
		expect(items[0]!.state).toBe("plain diff text");
	});

	it("--since 只导出更新的样本（ack 之后的增量复盘）", () => {
		const entries = [sample({ at: NOW - 10 * DAY, stateHash: "old" }), sample({ at: NOW, stateHash: "new" })];
		const { items } = samplesToCorpus(entries, { since: NOW - DAY });
		expect(items.length).toBe(1);
		expect(items[0]!.id.startsWith("new")).toBe(true);
	});

	it("corpusToJsonl 每行都是合法 JSON 且末尾有换行", () => {
		const { items } = samplesToCorpus([sample({ propositions: ["a_prop", "b_prop"] })]);
		const text = corpusToJsonl(items);
		expect(text.endsWith("\n")).toBe(true);
		const lines = text.trim().split("\n");
		expect(lines.length).toBe(2);
		for (const line of lines) {
			const parsed = JSON.parse(line) as { label: string; propositions: string[] };
			expect(["should-pass", "should-block"]).toContain(parsed.label);
			expect(parsed.propositions.length).toBe(1);
		}
	});
});
