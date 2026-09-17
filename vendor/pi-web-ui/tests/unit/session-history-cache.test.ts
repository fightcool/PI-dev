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

describe("SessionHistoryCache signature gate", () => {
	const stamps = (entries: Record<string, string>) => new Map(Object.entries(entries));

	it("磁盘签名未变时不受 TTL 限制：一次解析后只付 stat 的钱", async () => {
		const load = vi.fn().mockResolvedValue(infos("a"));
		const signature = vi.fn().mockResolvedValue(stamps({ "/s/a.jsonl": "1:10" }));
		// TTL = 0：没有签名 gate 时每次 get 都会重扫
		const cache = new SessionHistoryCache(load, 0, Date.now, 8, { signature });
		expect(await cache.get("/a")).toEqual(infos("a"));
		await cache.get("/a");
		await cache.get("/a");
		expect(load).toHaveBeenCalledTimes(1);
		expect(signature.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it("非本端文件的签名变化会重扫", async () => {
		let current = stamps({ "/s/a.jsonl": "1:10" });
		const load = vi.fn().mockResolvedValue(infos("a"));
		const cache = new SessionHistoryCache(load, 0, Date.now, 8, { signature: async () => current });
		await cache.get("/a");
		current = stamps({ "/s/a.jsonl": "2:20" });
		await cache.get("/a");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("本端正在写的会话（adopted）签名变化不触发重扫", async () => {
		let current = stamps({ "/s/a.jsonl": "1:10", "/s/b.jsonl": "1:10" });
		const load = vi.fn().mockResolvedValue(infos("a"));
		const cache = new SessionHistoryCache(load, 0, Date.now, 8, {
			signature: async () => current,
			adopted: (path) => path === "/s/a.jsonl",
		});
		await cache.get("/a");
		// 流式对话追加字节：签名变了，但它是本端在写
		current = stamps({ "/s/a.jsonl": "2:999", "/s/b.jsonl": "1:10" });
		await cache.get("/a");
		await cache.get("/a");
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("本端文件之外的变化仍然重扫（adopted 不能屏蔽别人的改动）", async () => {
		let current = stamps({ "/s/a.jsonl": "1:10", "/s/b.jsonl": "1:10" });
		const load = vi.fn().mockResolvedValue(infos("a"));
		const cache = new SessionHistoryCache(load, 0, Date.now, 8, {
			signature: async () => current,
			adopted: (path) => path === "/s/a.jsonl",
		});
		await cache.get("/a");
		current = stamps({ "/s/a.jsonl": "2:999", "/s/b.jsonl": "5:50" });
		await cache.get("/a");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("新增或删除会话文件都触发重扫", async () => {
		let current = stamps({ "/s/a.jsonl": "1:10" });
		const load = vi.fn().mockResolvedValue(infos("a"));
		const cache = new SessionHistoryCache(load, 0, Date.now, 8, { signature: async () => current });
		await cache.get("/a");
		current = stamps({ "/s/a.jsonl": "1:10", "/s/new.jsonl": "1:1" });
		await cache.get("/a");
		current = stamps({});
		await cache.get("/a");
		expect(load).toHaveBeenCalledTimes(3);
	});

	it("签名抛错不能影响列表（回退到 TTL 新鲜度）", async () => {
		const load = vi.fn().mockResolvedValue(infos("a"));
		const cache = new SessionHistoryCache(load, 3000, Date.now, 8, {
			signature: async () => {
				throw new Error("readdir failed");
			},
		});
		expect(await cache.get("/a")).toEqual(infos("a"));
		expect(await cache.get("/a")).toEqual(infos("a"));
		expect(load).toHaveBeenCalledTimes(1);
	});
});
