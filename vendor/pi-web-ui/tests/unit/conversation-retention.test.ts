/* 🍞 AI Breadcrumb — @COUPLED ../../server/conversation-retention.ts
 * 📖 ../../docs/conversation-lifecycle.md
 */
import { describe, expect, it } from "vitest";
import { retirementCandidates, type ConversationCandidate } from "../../server/conversation-retention.js";

const candidate = (id: string, extra: Partial<ConversationCandidate> = {}): ConversationCandidate => ({
	id,
	cwd: "/project",
	isSubagent: false,
	busy: false,
	lastActiveAt: 0,
	recoverable: true,
	...extra,
});

describe("idle conversation cache", () => {
	it("retires oldest recoverable histories without counting completed subagents as user slots", () => {
		const ordinary = Array.from({ length: 12 }, (_, i) => candidate(`c${i}`, { lastActiveAt: i }));
		const children = Array.from({ length: 20 }, (_, i) => candidate(`sa${i}`, { isSubagent: true }));
		const ids = retirementCandidates([...ordinary, ...children], "c11");
		expect(ids.filter((id) => id.startsWith("c"))).toEqual(["c0", "c1", "c2", "c3"]);
		expect(ids.filter((id) => id.startsWith("sa"))).toHaveLength(20);
	});
	it("does not evict live work or reject a ninth busy conversation", () => {
		const records = Array.from({ length: 9 }, (_, i) => candidate(`c${i}`, { busy: true }));
		expect(retirementCandidates(records, "c8")).toEqual([]);
	});
	it("keeps project budgets independent and never drops an unpersisted transcript", () => {
		const records = Array.from({ length: 10 }, (_, i) => candidate(`a${i}`, { lastActiveAt: i, recoverable: i > 0 }));
		records.push(...Array.from({ length: 8 }, (_, i) => candidate(`b${i}`, { cwd: "/other" })));
		expect(retirementCandidates(records, "a9")).toEqual(["a1", "a2"]);
	});
	it("protects every ancestor of a running or currently viewed child", () => {
		const records = [
			candidate("parent", { isSubagent: true }),
			candidate("child", { isSubagent: true, parentId: "parent" }),
			candidate("grandchild", { isSubagent: true, parentId: "child", busy: true }),
		];
		expect(retirementCandidates(records, "other")).toEqual([]);
		records[2].busy = false;
		expect(retirementCandidates(records, "grandchild")).toEqual([]);
		expect(retirementCandidates(records, "other")).toEqual(["grandchild", "child", "parent"]);
	});
	it("does not loop on corrupt cyclic parent references", () => {
		const records = [
			candidate("a", { isSubagent: true, parentId: "b" }),
			candidate("b", { isSubagent: true, parentId: "a", busy: true }),
		];
		expect(retirementCandidates(records, "other")).toEqual([]);
	});
});
