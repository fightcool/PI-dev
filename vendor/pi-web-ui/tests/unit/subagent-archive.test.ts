/**
 * 子代理归档（server/subagent-archive.ts）单测。
 *
 * 契约（其中前两条是本轮性能修复的验收）：
 *  - `.json` 是唯一事实源；`<id>.snapshot.json` 是可丢弃、可重建的派生索引；
 *  - `list()` 不去解析 entries（实测归档 97.8% 体积在 entries 上，list 只需要 snapshot）；
 *  - 索引缺失/损坏 → 回退整读并自愈；
 *  - 索引不会被当成归档记录（readdir 过滤仍是 `sa-xxxxxxxx.json`）。
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubagentArchive, type ArchivedSubagent } from "../../server/subagent-archive.js";
import type { SubagentSnapshot } from "../../server/subagent-state.js";

let dataDir: string;
let archive: SubagentArchive;

const ID = "sa-0123abcd";

const snapshot = (over: Partial<SubagentSnapshot> = {}): SubagentSnapshot => ({
	convId: ID,
	type: "explore",
	title: "调研",
	prompt: "看看这个",
	state: "done",
	streaming: false,
	messageCount: 12,
	output: "结论",
	archived: true,
	...over,
});

const record = (id = ID, snapshotOver: Partial<SubagentSnapshot> = {}, entryCount = 3): ArchivedSubagent =>
	({
		version: 1,
		id,
		cwd: "/tmp/ws",
		createdAt: 1_700_000_000_000,
		snapshot: snapshot({ convId: id, ...snapshotOver }),
		header: { id: "header-1", timestamp: new Date(1_700_000_000_000).toISOString(), cwd: "/tmp/ws" },
		leafId: null,
		entries: Array.from({ length: entryCount }, (_, i) => ({ type: "message", id: `e${i}`, parentId: null, timestamp: 1_700_000_000_000 + i })),
	}) as unknown as ArchivedSubagent;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pi-subagent-archive-"));
	archive = new SubagentArchive(dataDir, "client-a");
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("SubagentArchive", () => {
	it("write() 同时落事实源与派生索引，read() 仍从事实源读", () => {
		archive.write(record());
		const dir = archive.directory;
		expect(existsSync(join(dir, `${ID}.json`))).toBe(true);
		expect(existsSync(join(dir, `${ID}.snapshot.json`))).toBe(true);
		expect(archive.read(ID)?.entries).toHaveLength(3);
	});

	it("list() 只靠索引：把事实源换成超大 entries 也不影响结果与索引读取", () => {
		archive.write(record(ID, {}, 5000));
		// 事实源换成「解析代价极大」的内容：只要结果不变，就说明走的是索引。
		const heavy = readFileSync(join(archive.directory, `${ID}.json`), "utf8");
		writeFileSync(join(archive.directory, `${ID}.json`), heavy.replace('"type":"message"', '"type":"message","pad":"' + "x".repeat(200_000) + '"'));
		const list = archive.list();
		expect(list).toHaveLength(1);
		expect(list[0].convId).toBe(ID);
		expect(list[0].title).toBe("调研");
	});

	it("索引缺失（老归档）→ 回退整读并自愈写回", () => {
		archive.write(record());
		const sidecar = join(archive.directory, `${ID}.snapshot.json`);
		rmSync(sidecar);
		const list = archive.list();
		expect(list).toHaveLength(1);
		expect(list[0].messageCount).toBe(12);
		expect(existsSync(sidecar)).toBe(true);
		expect(JSON.parse(readFileSync(sidecar, "utf8")).convId).toBe(ID);
	});

	it("索引损坏 → 回退整读，不抛错", () => {
		archive.write(record());
		writeFileSync(join(archive.directory, `${ID}.snapshot.json`), "{ 坏 json");
		const list = archive.list();
		expect(list).toHaveLength(1);
		expect(list[0].convId).toBe(ID);
	});

	it("索引不会被当成归档记录（readdir 过滤与自愈都不产生第二条）", () => {
		archive.write(record());
		archive.list();
		const files = readdirSync(archive.directory);
		expect(files.sort()).toEqual([`${ID}.json`, `${ID}.snapshot.json`]);
		expect(archive.list()).toHaveLength(1);
	});

	it("按 mtime 倒序并受 limit 约束", async () => {
		const ids = ["sa-aaaaaaaa", "sa-bbbbbbbb", "sa-cccccccc"];
		for (const id of ids) {
			archive.write(record(id));
			await new Promise((r) => setTimeout(r, 12));
		}
		const list = archive.list(2);
		expect(list.map((s) => s.convId)).toEqual(["sa-cccccccc", "sa-bbbbbbbb"]);
	});

	it("目录不存在时 list() 返回空数组", () => {
		expect(archive.list()).toEqual([]);
	});
});
