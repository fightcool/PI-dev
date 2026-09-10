/* @COUPLED server/session-search.ts; fixtures must never use real session stores. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	collectSessionAnchors,
	messageSearchText,
	searchSessionInfos,
	sessionMatchesSearch,
} from "../../server/session-search.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

let dir: string;
let fileId = 0;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "piweb-session-search-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.mocked(createReadStream).mockReset();
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(createReadStream).mockImplementation(actual.createReadStream);
	await rm(dir, { recursive: true, force: true });
});

async function fixture(lines: unknown[], name = `${fileId++}.jsonl`): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
	return path;
}
function message(role: string, timestamp: unknown, content: unknown, extra = {}) {
	return { type: "message", timestamp: "2020-01-01T00:00:00Z", message: { role, timestamp, content }, ...extra };
}
function info(path: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path,
		id: path,
		cwd: dir,
		created: new Date(0),
		modified: new Date(1),
		messageCount: 2,
		firstMessage: "hello",
		allMessagesText: "needle",
		...overrides,
	};
}

describe("session matching and text", () => {
	it("matches name, basename, first message and full cached text case-insensitively", () => {
		const base = info(join(dir, "plain.jsonl"), { allMessagesText: "" });
		for (const override of [
			{ name: "NEEDLE" },
			{ path: join(dir, "NEEDLE.jsonl") },
			{ firstMessage: "NEEDLE" },
			{ allMessagesText: "an assistant's NEEDLE" },
		]) {
			expect(sessionMatchesSearch("needle", { ...base, ...override })).toBe(true);
		}
		expect(sessionMatchesSearch("needle", { ...base, path: join(dir, "needle", "plain.jsonl") })).toBe(false);
	});

	it("joins only text blocks with newlines without trimming or indexing other content", () => {
		expect(messageSearchText({ content: " Raw Text " })).toBe(" Raw Text ");
		expect(
			messageSearchText({
				content: [
					null,
					3,
					"needle",
					{},
					{ type: "image", text: "hidden" },
					{ type: "thinking", thinking: "hidden" },
					{ type: "toolCall", text: "hidden" },
					{ type: "text", text: 4 },
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("a\nb");
		for (const content of [undefined, null, 5, {}]) expect(messageSearchText({ content })).toBe("");
	});
});

describe("collectSessionAnchors", () => {
	it("skips malformed entries and excluded roles, using numeric message timestamps in file order", async () => {
		const path = await fixture([
			"",
			"  ",
			"{bad",
			"null",
			"7",
			"[]",
			{},
			{ type: "message" },
			{ type: "message", message: null },
			message("user", 100, "Needle", { type: "custom_message" }),
			...["toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary", "system"].map((role) =>
				message(role, 100, "needle"),
			),
			message("user", "123", "needle"),
			message("user", undefined, "needle"),
			message("assistant", null, "needle"),
			message("assistant", 1, [{ type: "thinking", thinking: "needle" }]),
			message("user", 90, "NEEDLE"),
			message("assistant", 0, [{ type: "text", text: "a Needle b" }]),
			message("user", -1, "needle", { parentId: "other-branch" }),
			message("user", -1, "needle"),
			message("user", 2, "unrelated"),
			"{broken-tail",
		]);
		expect(await collectSessionAnchors(path, "needle")).toEqual([
			{ role: "user", timestamp: 90 },
			{ role: "assistant", timestamp: 0 },
			{ role: "user", timestamp: -1 },
			{ role: "user", timestamp: -1 },
		]);
	});

	it("supports CRLF, unterminated final lines, and matching across text blocks", async () => {
		const path = await fixture([
			JSON.stringify(message("user", 3, "irrelevant")) +
				"\r\n" +
				JSON.stringify(
					message("assistant", 4, [
						{ type: "text", text: "NEED" },
						{ type: "text", text: "LE" },
					]),
				),
		]);
		expect(await collectSessionAnchors(path, "need\nle")).toEqual([{ role: "assistant", timestamp: 4 }]);
	});

	it("returns empty for missing/unreadable files and does not open files for an empty query", async () => {
		expect(await collectSessionAnchors(join(dir, "missing.jsonl"), "needle")).toEqual([]);
		expect(await collectSessionAnchors(dir, "needle")).toEqual([]);
		const path = await fixture([message("user", 1, "needle")]);
		await chmod(path, 0);
		try {
			expect(await collectSessionAnchors(path, "needle")).toEqual([]);
		} finally {
			await chmod(path, 0o600);
		}
		vi.mocked(createReadStream).mockClear();
		expect(await collectSessionAnchors(path, "")).toEqual([]);
		expect(createReadStream).not.toHaveBeenCalled();
	});

	it("caps at ten in transcript order, supports smaller caps, and closes early", async () => {
		const path = await fixture(Array.from({ length: 1000 }, (_, i) => message("user", i, "needle")));
		const anchors = Array.from({ length: 10 }, (_, timestamp) => ({ role: "user", timestamp }));
		expect(await collectSessionAnchors(path, "needle")).toEqual(anchors);
		expect(await collectSessionAnchors(path, "needle", 100)).toEqual(anchors);
		expect(await collectSessionAnchors(path, "needle", 2)).toEqual(anchors.slice(0, 2));
		expect(await collectSessionAnchors(path, "needle", 0)).toEqual([]);
		for (const result of vi.mocked(createReadStream).mock.results) {
			expect(result.value.closed).toBe(true);
			expect(result.value.bytesRead).toBeLessThan(100_000);
		}
	});

	it("finds late matches and text beyond a large single-line prefix without scan cutoffs", async () => {
		const path = await fixture([
			"null\n".repeat(100_000),
			message("assistant", 22, "x".repeat(2 * 1024 * 1024) + "NEEDLE"),
		]);
		expect(await collectSessionAnchors(path, "needle")).toEqual([{ role: "assistant", timestamp: 22 }]);
	});

	it("lets event-loop callbacks run while processing many small lines in one read buffer", async () => {
		const path = await fixture(["\n{bad\nnull\n".repeat(2000), message("user", 1, "needle")]);
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		let parsed = 0;
		let observed = -1;
		const parse = JSON.parse;
		vi.spyOn(JSON, "parse").mockImplementation((...args) => {
			parsed++;
			return parse(...args);
		});
		vi.mocked(createReadStream).mockImplementation((...args) => {
			const stream = actual.createReadStream(...args);
			stream.once("data", () =>
				setImmediate(() => {
					observed = parsed;
				}),
			);
			return stream;
		});
		expect(await collectSessionAnchors(path, "needle")).toEqual([{ role: "user", timestamp: 1 }]);
		expect(observed).toBeGreaterThan(0);
		expect(observed).toBeLessThan(4000);
	});
});

describe("searchSessionInfos", () => {
	it("normalizes queries, preserves summary shape, and keeps metadata-only/missing-file matches", async () => {
		const path = await fixture([message("assistant", 0, "NEEDLE")]);
		const metadata = info(join(dir, "missing.jsonl"), { name: "Needle", allMessagesText: "", modified: new Date(2) });
		const text = info(path);
		const ignored = info(path, { allMessagesText: "not cached as matching" });
		expect(await searchSessionInfos([text, ignored, metadata], "  NEEDLE  ")).toEqual([
			{
				path: metadata.path,
				name: "Needle",
				firstMessage: "hello",
				messageCount: 2,
				modified: 2,
				source: "web",
				anchors: [],
			},
			{
				path,
				name: undefined,
				firstMessage: "hello",
				messageCount: 2,
				modified: 1,
				source: "web",
				anchors: [{ role: "assistant", timestamp: 0 }],
			},
		]);
		vi.mocked(createReadStream).mockClear();
		expect(await searchSessionInfos([text], " \n ")).toEqual([]);
		expect(await searchSessionInfos([], "needle")).toEqual([]);
		expect(createReadStream).not.toHaveBeenCalled();
	});

	it("filters all infos before stable modified-desc sorting and cap50 without mutating input", async () => {
		const path = await fixture([message("user", 5, "needle")]);
		const infos = Array.from({ length: 120 }, (_, i) =>
			info(path, {
				name: `session-${i}`,
				allMessagesText: i < 55 ? "no match" : "needle",
				modified: new Date(Math.floor(i / 2)),
			}),
		);
		const original = [...infos];
		const expected = infos
			.slice(55)
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())
			.slice(0, 50);
		const results = await searchSessionInfos(infos, "needle");
		expect(results.map((s) => s.name)).toEqual(expected.map((s) => s.name));
		expect(results[0].name).toBe("session-118");
		expect(results[1].name).toBe("session-119");
		expect(results).toHaveLength(50);
		expect(createReadStream).toHaveBeenCalledTimes(50);
		expect(infos).toEqual(original);
	});

	it("bounds streams to four across overlapping searches and direct scans, releasing error/cap slots", async () => {
		const paths = await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				fixture(["null\n".repeat((12 - i) * 1000), ...Array.from({ length: 20 }, () => message("user", i, "needle"))]),
			),
		);
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		let active = 0;
		let peak = 0;
		vi.mocked(createReadStream).mockImplementation((...args) => {
			const stream = actual.createReadStream(...args);
			peak = Math.max(peak, ++active);
			stream.once("close", () => {
				active--;
			});
			return stream;
		});
		const infos = paths.map((path, i) => info(path, { modified: new Date(i) }));
		const [first, second, missing, direct] = await Promise.all([
			searchSessionInfos(infos, "needle"),
			searchSessionInfos(infos, "needle"),
			collectSessionAnchors(join(dir, "missing.jsonl"), "needle"),
			collectSessionAnchors(paths[0], "needle"),
		]);
		expect(peak).toBe(4);
		expect(active).toBe(0);
		expect(missing).toEqual([]);
		expect(direct).toHaveLength(10);
		for (const results of [first, second]) {
			expect(results.map((s) => s.path)).toEqual([...paths].reverse());
			results.forEach((s, i) =>
				expect(s.anchors).toEqual(Array.from({ length: 10 }, () => ({ role: "user", timestamp: 11 - i }))),
			);
		}
		expect(await collectSessionAnchors(paths[0], "needle", 1)).toEqual([{ role: "user", timestamp: 0 }]);
		expect(active).toBe(0);
	});
});
