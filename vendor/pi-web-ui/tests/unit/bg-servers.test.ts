import { describe, expect, it } from "vitest";
import { shouldTrackBackgroundServer } from "../../server/bg-servers.js";

/** 构造一条 子→父 链的 parents 映射：args 为 [pid, parentPid] 数组。 */
function parentsOf(entries: Array<[number, number]>): Map<number, number> {
	return new Map(entries);
}

describe("shouldTrackBackgroundServer", () => {
	const SERVER = 1000;

	it("命中黑名单进程名直接跳过（微信，大小写不敏感）", () => {
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "WeChat.exe")).toBe(false);
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "wechatappex.exe")).toBe(false);
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "QQ.EXE")).toBe(false);
	});

	it("黑名单优先于保守路径：进程树查不到也不记录微信", () => {
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "WeChat.exe")).toBe(false);
	});

	it("进程树查不到且不在黑名单 → 保守记录", () => {
		expect(shouldTrackBackgroundServer(42, undefined, new Set([42]), SERVER, "node.exe")).toBe(true);
	});

	it("父链撞上服务器进程 → 记录（AI 直接 bash 拉起的服务）", () => {
		// node(vite) ← bash ← node(server=SERVER)
		const parents = parentsOf([
			[7001, 7002],
			[7002, SERVER],
		]);
		expect(shouldTrackBackgroundServer(7001, parents, new Set([7001]), SERVER)).toBe(true);
	});

	it("父链撞上本次 diff 的其他新 pid → 记录（中间层如 concurrently/npm 已脱离 bash）", () => {
		// vite(node) ← npm(node, 也是新pid) ← bash 已退出(ppid 993 不存在/断链)
		const parents = parentsOf([
			[7001, 7005],
			[7005, 9000], // 9000 不在映射 = bash 已退出
		]);
		expect(shouldTrackBackgroundServer(7001, parents, new Set([7001, 7005]), SERVER)).toBe(true);
	});

	it("断链（父已退出/reparent）→ 保守记录", () => {
		// nohup 起的 python：其父 bash 已退出，ppid 查不到
		const parents = parentsOf([[8001, 88888]]);
		expect(shouldTrackBackgroundServer(8001, parents, new Set([8001]), SERVER)).toBe(true);
	});

	it("完整父链回溯到系统根未命中 → 跳过（自己开的 Chrome）", () => {
		// chrome ← explorer ← (拉平) ← 0/1
		const parents = parentsOf([
			[5001, 5002],
			[5002, 5003],
			[5003, 0],
			[0, 0],
		]);
		expect(shouldTrackBackgroundServer(5001, parents, new Set([5001]), SERVER)).toBe(false);
	});

	it("完整父链到根且根自引用 → 跳过（POSIX 风格 0 根/演进到 1）", () => {
		const parents = parentsOf([
			[5001, 1],
			[1, 0],
			[0, 0],
		]);
		expect(shouldTrackBackgroundServer(5001, parents, new Set([5001]), SERVER)).toBe(false);
		// 根 1 的父缺失但 cur===1 → 完整链，跳过
		expect(shouldTrackBackgroundServer(5001, parentsOf([[5001, 1]]), new Set([5001]), SERVER)).toBe(false);
	});

	it("Playwright 拉的 Chrome：父链经 node 到服务器 → 记录", () => {
		// chrome ← node(playwright) ← bash ← server
		const parents = parentsOf([
			[3001, 3002],
			[3002, 3003],
			[3003, SERVER],
		]);
		expect(shouldTrackBackgroundServer(3001, parents, new Set([3001]), SERVER, "chrome.exe")).toBe(true);
	});

	it("微信进程树（WeChatAppEx 等子进程，父链完整且不涉服务器）→ 跳过", () => {
		// wechatappex ← wechatmain ← explorer ← ... ← 0
		const parents = parentsOf([
			[6001, 6002],
			[6002, 6003],
			[6003, 0],
			[0, 0],
		]);
		expect(shouldTrackBackgroundServer(6001, parents, new Set([6001]), SERVER, "WeChatAppEx.exe")).toBe(false);
	});

	it("循环链防御：不会死循环，最终完整链 → 跳过", () => {
		const parents = parentsOf([
			[7777, 7778],
			[7778, 7777],
		]);
		expect(shouldTrackBackgroundServer(7777, parents, new Set([7777]), SERVER)).toBe(false);
	});
});
