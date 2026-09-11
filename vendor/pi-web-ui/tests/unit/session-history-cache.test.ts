import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SessionHistoryCache } from "../../server/session-history-cache.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const infos = (path: string): SessionInfo[] => [{ path } as SessionInfo];

describe("SessionHistoryCache", () => {
	it("shares a scan and retains its result for the full TTL after completion", async () => {
		let now = 0;
		const scan = deferred<SessionInfo[]>();
		const load = vi.fn(() => scan.promise);
		const cache = new SessionHistoryCache(load, 3000, () => now);
		const a = cache.get("/a");
		expect(cache.get("/a")).toBe(a);
		await Promise.resolve();
		expect(load).toHaveBeenCalledTimes(1);
		now = 5000;
		scan.resolve(infos("first"));
		const result = await a;
		now = 7999;
		expect(await cache.get("/a")).toBe(result);
		expect(load).toHaveBeenCalledTimes(1);
		now = 8000;
		await cache.get("/a");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("invalidates a completed cached list", async () => {
		const load = vi.fn().mockResolvedValueOnce(infos("deleted")).mockResolvedValueOnce([]);
		const cache = new SessionHistoryCache(load);
		expect(await cache.get("/a")).toEqual(infos("deleted"));
		cache.invalidate("/a");
		expect(await cache.get("/a")).toEqual([]);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not return or cache a superseded scan, even when it finishes last", async () => {
		const old = deferred<SessionInfo[]>();
		const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(infos("renamed"));
		const cache = new SessionHistoryCache(load);
		const beforeMutation = cache.get("/a");
		await Promise.resolve();
		cache.invalidate("/a");
		const afterMutation = await cache.get("/a");
		old.resolve(infos("old-name"));
		expect(await beforeMutation).toBe(afterMutation);
		expect(await cache.get("/a")).toBe(afterMutation);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("retries invalidated waiters without needing another list request", async () => {
		const old = deferred<SessionInfo[]>();
		const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(infos("new"));
		const cache = new SessionHistoryCache(load);
		const pending = cache.get("/a");
		await Promise.resolve();
		cache.invalidate("/a");
		old.resolve(infos("old"));
		expect(await pending).toEqual(infos("new"));
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("a superseded failure cannot clear a replacement flight", async () => {
		const old = deferred<SessionInfo[]>();
		const fresh = deferred<SessionInfo[]>();
		const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
		const cache = new SessionHistoryCache(load);
		const first = cache.get("/a");
		await Promise.resolve();
		cache.invalidate("/a");
		const second = cache.get("/a");
		old.reject(new Error("superseded failure"));
		fresh.resolve(infos("fresh"));
		expect(await first).toEqual(await second);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("allows retry after an ordinary failure", async () => {
		const load = vi.fn().mockRejectedValueOnce(new Error("scan failed")).mockResolvedValueOnce([]);
		const cache = new SessionHistoryCache(load);
		await expect(cache.get("/a")).rejects.toThrow("scan failed");
		expect(await cache.get("/a")).toEqual([]);
	});

	it("captures cwd before await and never shares a scan across projects", async () => {
		const a = deferred<SessionInfo[]>();
		const load = vi.fn((cwd: string) => (cwd === "/a" ? a.promise : Promise.resolve(infos("b"))));
		const cache = new SessionHistoryCache(load);
		const pendingA = cache.get("/a");
		expect(await cache.get("/b")).toEqual(infos("b"));
		a.resolve(infos("a"));
		expect(await pendingA).toEqual(infos("a"));
		expect(await cache.get("/b")).toEqual(infos("b"));
	});

	it("retains several projects so switching back does not rescan", async () => {
		const load = vi.fn().mockImplementation((cwd: string) => Promise.resolve(infos(cwd)));
		const cache = new SessionHistoryCache(load);
		await cache.get("/a");
		await cache.get("/b");
		expect(await cache.get("/a")).toEqual(infos("/a"));
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("invalidating an unrelated project preserves the current cached result", async () => {
		const load = vi.fn().mockResolvedValue(infos("a"));
		const cache = new SessionHistoryCache(load);
		await cache.get("/a");
		cache.invalidate("/b");
		await cache.get("/a");
		expect(load).toHaveBeenCalledTimes(1);
	});
});
