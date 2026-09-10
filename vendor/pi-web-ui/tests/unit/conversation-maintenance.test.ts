/* 🍞 AI Breadcrumb — @COUPLED ../../server/conversation-maintenance.ts, ../../server/subagent-archive.ts
 * @CONTRACT Temporary records only; extension wake scans are mocked, never operator state.
 * 📖 ../../docs/conversation-lifecycle.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "../../server/agent-service.js";
import { ConversationMaintenance } from "../../server/conversation-maintenance.js";
import { SubagentArchive } from "../../server/subagent-archive.js";
import { toSubagentSnapshot } from "../../server/subagent-state.js";
import { hasActiveSubagentRun, hasPendingWaitSubscription } from "../../server/wait-subscription-scan.js";

vi.mock("../../server/wait-subscription-scan.js", () => ({
	hasActiveSubagentRun: vi.fn(() => false),
	hasPendingWaitSubscription: vi.fn(() => false),
}));
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-retirement-"));
	vi.clearAllMocks();
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function conversation(id: string, parentId?: string): Conversation {
	const sessionManager = SessionManager.inMemory("/fixture");
	sessionManager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
	return {
		id,
		parentId,
		cwd: "/fixture",
		title: "Completed task",
		isSubagent: true,
		createdAt: 1,
		lastActiveAt: 1,
		subagentType: "review",
		goal: { reviewing: false },
		wizardRunning: false,
		queueSteering: [],
		queueFollowUp: [],
		toolStartTimes: new Map(),
		terminals: { countLive: () => 0, killAll: vi.fn() },
		session: {
			isIdle: true,
			isStreaming: false,
			sessionManager,
			model: { provider: "fixture", id: "model" },
			agent: { state: { messages: [] } },
			getSessionStats: () => ({ totalMessages: 1 }),
			getLastAssistantText: () => "preserved result",
		},
		runtime: { dispose: vi.fn(async () => {}) },
	} as unknown as Conversation;
}

function fixture(records: Conversation[]) {
	const conversations = new Map(records.map((c) => [c.id, c]));
	const archive = new SubagentArchive(directory, "client");
	const drop = vi.fn((id: string) => {
		const c = conversations.get(id)!;
		c.terminals.killAll();
		void c.runtime.dispose();
		conversations.delete(id);
	});
	const changed = vi.fn(),
		warn = vi.fn();
	const restore = vi.fn(async (record) => conversation(record.id, record.parentId));
	const service = new ConversationMaintenance(archive, {
		conversations: () => conversations,
		activeId: () => "active",
		drop,
		changed,
		warn,
		restore,
	});
	return { conversations, archive, drop, changed, warn, restore, service };
}

describe("completed subagent retirement", () => {
	it("archives the full session before releasing the runtime and keeps results across store reconstruction", () => {
		const c = conversation("sa-00000001");
		const f = fixture([c]);
		f.service.reap();
		expect(f.conversations.size).toBe(0);
		expect(c.runtime.dispose).toHaveBeenCalledOnce();
		const saved = new SubagentArchive(directory, "client").read(c.id)!;
		expect(saved.snapshot).toMatchObject({ output: "preserved result", archived: true, streaming: false });
		expect(saved.entries).toEqual(c.session.sessionManager.getEntries());
		expect(saved.leafId).toBe(c.session.sessionManager.getLeafId());
		expect(statSync(join(f.archive.directory, `${c.id}.json`)).mode & 0o777).toBe(0o600);
		expect(new SubagentArchive(directory, "other-client").read(c.id)).toBeUndefined();
		expect(f.archive.read("../../elsewhere")).toBeUndefined();
	});

	it.each([
		"streaming",
		"retry",
		"compaction",
		"pending",
		"starting",
		"tool",
		"queue",
		"terminal",
		"review",
		"wizard",
		"reload",
	])("preserves a subagent with %s work", (state) => {
		const c = conversation("sa-00000001");
		if (state === "streaming") Object.assign(c.session, { isStreaming: true });
		if (state === "retry") c.retryState = { attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "retry" };
		if (state === "compaction") c.compactionState = { reason: "manual", startedAt: 1 };
		if (state === "pending") c.subagentPending = 1;
		if (state === "starting") c.subagentStarting = true;
		if (state === "tool") c.toolStartTimes.set("call", 1);
		if (state === "queue") c.queueFollowUp.push("queued");
		if (state === "terminal") c.terminals.countLive = () => 1;
		if (state === "review") c.goal.reviewing = true;
		if (state === "wizard") c.wizardRunning = true;
		if (state === "reload") c.reloadInFlight = true;
		const f = fixture([c]);
		f.service.reap();
		expect(f.drop).not.toHaveBeenCalled();
	});

	it("preserves parents for extension runs/wakes and retries cleanup after they clear", () => {
		const c = conversation("sa-00000001");
		const f = fixture([c]);
		vi.mocked(hasActiveSubagentRun).mockReturnValueOnce(true);
		f.service.reap();
		expect(f.drop).not.toHaveBeenCalled();
		vi.mocked(hasPendingWaitSubscription).mockReturnValueOnce(true);
		f.service.reap();
		expect(f.drop).not.toHaveBeenCalled();
		f.service.reap();
		expect(f.drop).toHaveBeenCalledOnce();
	});

	it("keeps both child and parent when child archival fails, then retires leaf first", () => {
		const parent = conversation("sa-00000001"),
			child = conversation("sa-00000002", parent.id);
		const f = fixture([parent, child]);
		const write = vi.spyOn(f.archive, "write").mockImplementation(() => {
			throw new Error("disk full");
		});
		f.service.reap();
		f.service.reap();
		expect(f.conversations.size).toBe(2);
		expect(f.warn).toHaveBeenCalledOnce();
		write.mockRestore();
		f.service.reap();
		expect(f.drop.mock.calls.map(([id]) => id)).toEqual([child.id, parent.id]);
	});

	it("keeps a selected earlier branch leaf in the archive", () => {
		const c = conversation("sa-00000001");
		const leaf = c.session.sessionManager.getLeafId()!;
		c.session.sessionManager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
		c.session.sessionManager.branch(leaf);
		const f = fixture([c]);
		f.service.reap();
		const saved = f.archive.read(c.id)!;
		expect(saved.entries).toHaveLength(2);
		expect(saved.leafId).toBe(leaf);
	});

	it("restores one archived conversation for concurrent requests and retains its original id", async () => {
		const c = conversation("sa-00000001");
		const f = fixture([c]);
		f.service.reap();
		const [a, b] = await Promise.all([f.service.restore(c.id), f.service.restore(c.id)]);
		expect(a).toBe(b);
		expect(a?.id).toBe(c.id);
		expect(f.restore).toHaveBeenCalledOnce();
	});

	it("handles corrupt archives without exposing transcript contents", () => {
		const c = conversation("sa-00000001");
		const f = fixture([c]);
		f.service.reap();
		writeFileSync(join(f.archive.directory, `${c.id}.json`), "private-transcript-fragment");
		expect(() => f.archive.read(c.id)).toThrow("Cannot read archived subagent");
	});

	it("cleans promptly after scheduling and disables timers on shutdown", () => {
		vi.useFakeTimers();
		const f = fixture([conversation("sa-00000001")]);
		f.service.start();
		f.service.schedule();
		vi.advanceTimersByTime(1);
		expect(f.drop).toHaveBeenCalledOnce();
		f.service.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not let a temporarily unreadable runtime crash the cleanup timer", () => {
		const c = conversation("sa-00000001");
		c.session.getSessionStats = () => {
			throw new Error("replacing");
		};
		const f = fixture([c]);
		expect(() => f.service.reap()).not.toThrow();
		expect(f.drop).not.toHaveBeenCalled();
		expect(f.warn).toHaveBeenCalledOnce();
	});

	it("startup and retry gaps are not exposed as completed results", () => {
		const c = conversation("sa-00000001");
		c.subagentStarting = true;
		expect(toSubagentSnapshot(c).streaming).toBe(true);
		c.subagentStarting = false;
		Object.assign(c.session, { isIdle: false });
		expect(toSubagentSnapshot(c).streaming).toBe(true);
	});
});
