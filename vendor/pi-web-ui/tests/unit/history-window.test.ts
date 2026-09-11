import { describe, expect, it } from "vitest";
import {
	historyPage,
	snapshotWindow,
	HISTORY_PAGE_MESSAGES,
	SNAPSHOT_TAIL_MESSAGES,
} from "../../server/history-window.js";
import type { UiMessage } from "../../server/protocol.js";

const msg = (i: number): UiMessage => ({ id: `m${i}`, role: "user", content: [{ type: "text", text: `#${i}` }] });
const list = (n: number) => Array.from({ length: n }, (_, i) => msg(i));

describe("snapshotWindow（尾部优先）", () => {
	it("小会话整份发出", () => {
		const { messages, omitted } = snapshotWindow(list(10), false);
		expect(messages).toHaveLength(10);
		expect(omitted).toBe(0);
	});

	it("大历史只发尾部，并给出更早的条数", () => {
		const { messages, omitted } = snapshotWindow(list(1460), false);
		expect(messages).toHaveLength(SNAPSHOT_TAIL_MESSAGES);
		expect(messages[0].id).toBe(`m${1460 - SNAPSHOT_TAIL_MESSAGES}`);
		expect(omitted).toBe(1460 - SNAPSHOT_TAIL_MESSAGES);
	});

	it("恰好等于阈值时不截断（omitted 为 0）", () => {
		expect(snapshotWindow(list(SNAPSHOT_TAIL_MESSAGES), false).omitted).toBe(0);
	});

	it("客户端已补全过 → 之后的全量快照不再截断", () => {
		const { messages, omitted } = snapshotWindow(list(1460), true);
		expect(messages).toHaveLength(1460);
		expect(omitted).toBe(0);
	});
});

describe("historyPage（向上分页）", () => {
	it("按 before 往前取一页，并回报更早的剩余条数", () => {
		const messages = list(1000);
		const page = historyPage(messages, { before: "m960" });
		expect(page.messages).toHaveLength(HISTORY_PAGE_MESSAGES);
		expect(page.messages[0].id).toBe(`m${960 - HISTORY_PAGE_MESSAGES}`);
		expect(page.messages.at(-1)?.id).toBe("m959");
		expect(page.omittedBefore).toBe(960 - HISTORY_PAGE_MESSAGES);
		expect(page.complete).toBe(false);
	});

	it("取到最早一条时标记 complete", () => {
		const page = historyPage(list(300), { before: "m100" });
		expect(page.messages[0].id).toBe("m0");
		expect(page.omittedBefore).toBe(0);
		expect(page.complete).toBe(true);
	});

	it("all:true 一次补全（搜索用）", () => {
		const page = historyPage(list(1460), { before: "m1420", all: true });
		expect(page.messages).toHaveLength(1420);
		expect(page.omittedBefore).toBe(0);
		expect(page.complete).toBe(true);
	});

	it("不带 before 时取最新一页（等价于全量快照的口径）", () => {
		const page = historyPage(list(500), {});
		expect(page.messages).toHaveLength(HISTORY_PAGE_MESSAGES);
		expect(page.messages.at(-1)?.id).toBe("m499");
	});

	it("before 未知（id 已被压缩替换）→ 空页且 complete，不猜内容", () => {
		const page = historyPage(list(500), { before: "gone" });
		expect(page.messages).toEqual([]);
		expect(page.complete).toBe(true);
	});

	it("limit 生效且不会越界", () => {
		const page = historyPage(list(50), { before: "m10", limit: 25 });
		expect(page.messages).toHaveLength(10);
		expect(page.complete).toBe(true);
	});
});
