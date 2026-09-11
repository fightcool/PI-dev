/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/storage-usage.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §8 P4 候选「必要运维」
 * 覆盖：目录递归求和、单文件区域、缺失路径、符号链接不跟随、遍历上限（truncated）。
 */
import { describe, expect, it } from "vitest";
import { MAX_FILES, measureAreas, measurePath } from "../../server/dev-con/storage-usage.js";

type Entry = { name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean };
const dirEntry = (name: string): Entry => ({ name, isDirectory: true, isFile: false, isSymbolicLink: false });
const fileEntry = (name: string): Entry => ({ name, isDirectory: false, isFile: true, isSymbolicLink: false });
const linkEntry = (name: string): Entry => ({ name, isDirectory: false, isFile: false, isSymbolicLink: true });

/** 极简内存文件系统替身：路径 → 子项 / 大小。 */
function fakeFs(tree: Record<string, Entry[]>, sizes: Record<string, number>) {
	return {
		readdir: (path: string) => tree[path] ?? null,
		kindOf: (path: string) =>
			tree[path] ? { kind: "dir" as const, size: 0 } : path in sizes ? { kind: "file" as const, size: sizes[path] } : { kind: "missing" as const, size: 0 },
		now: () => 0,
	};
}

describe("storage usage measurement", () => {
	it("sums a directory tree, ignores symlinks and reports missing paths separately", () => {
		const io = fakeFs(
			{ "/data": [dirEntry("sessions"), fileEntry("a.bin"), linkEntry("link")], "/data/sessions": [fileEntry("s.jsonl"), fileEntry("t.jsonl")] },
			{ "/data/a.bin": 100, "/data/sessions/s.jsonl": 200, "/data/sessions/t.jsonl": 300, "/data/link": 9999 },
		);
		const area = measurePath({ path: "/data", label: "data" }, io);
		expect(area).toMatchObject({ label: "data", bytes: 600, files: 3, truncated: false, missing: false });
		expect(measurePath({ path: "/nope", label: "gone" }, io)).toMatchObject({ bytes: 0, files: 0, missing: true });
	});

	it("treats a single file as its own area", () => {
		const io = fakeFs({}, { "/data/usage-history.jsonl": 4096 });
		expect(measurePath({ path: "/data/usage-history.jsonl", label: "history" }, io)).toMatchObject({ bytes: 4096, files: 1, missing: false });
	});

	it("stops at the walk limit and marks the number incomplete", () => {
		const entries = Array.from({ length: MAX_FILES + 10 }, (_, i) => fileEntry(`f${i}`));
		const sizes: Record<string, number> = {};
		for (const entry of entries) sizes[`/big/${entry.name}`] = 1;
		const area = measurePath({ path: "/big", label: "big" }, fakeFs({ "/big": entries }, sizes));
		expect(area.truncated).toBe(true);
		expect(area.files).toBe(MAX_FILES);
		expect(area.bytes).toBe(MAX_FILES);
	});

	it("sorts areas by size descending and keeps labels stable on ties", () => {
		const io = fakeFs({ "/a": [fileEntry("x")], "/b": [fileEntry("y")], "/c": [fileEntry("z")] }, { "/a/x": 10, "/b/y": 50, "/c/z": 10 });
		const rows = measureAreas([{ path: "/a", label: "a" }, { path: "/b", label: "b" }, { path: "/c", label: "c" }], io);
		expect(rows.map((r) => r.label)).toEqual(["b", "a", "c"]);
	});
});
