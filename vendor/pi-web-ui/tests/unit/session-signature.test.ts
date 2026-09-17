/**
 * 会话目录签名（server/session-signature.ts）单测。
 *
 * 契约：签名必须覆盖 SDK 会解析的**全部** transcript，且两种目录布局都要认；
 * 目录不存在时返回空表而不是抛错（首次启动、项目目录尚未建立）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanSessionStamps, sessionsRootDir } from "../../server/session-signature.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-session-sig-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
});

const touch = (path: string, body = "{}\n", mtimeSec?: number) => {
	writeFileSync(path, body);
	if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
};

describe("sessionsRootDir", () => {
	it("默认取 <agentDir>/sessions，env 覆盖时用扁平目录", () => {
		expect(sessionsRootDir("/data/agent")).toBe("/data/agent/sessions");
		process.env.PI_CODING_AGENT_SESSION_DIR = "/flat/sessions";
		expect(sessionsRootDir("/data/agent")).toBe("/flat/sessions");
	});
});

describe("scanSessionStamps", () => {
	it("目录不存在时返回空表（不抛错）", async () => {
		expect(await scanSessionStamps(join(root, "missing"))).toEqual(new Map());
	});

	it("覆盖每个 cwd 子目录下的 *.jsonl，忽略非 jsonl 与其他目录层级", async () => {
		mkdirSync(join(root, "--proj-a--"));
		mkdirSync(join(root, "--proj-b--"));
		touch(join(root, "--proj-a--", "one.jsonl"));
		touch(join(root, "--proj-b--", "two.jsonl"));
		touch(join(root, "--proj-a--", "notes.txt"));
		touch(join(root, "readme.jsonl"));

		const stamps = await scanSessionStamps(root);
		expect([...stamps.keys()].sort()).toEqual([
			join(root, "--proj-a--", "one.jsonl"),
			join(root, "--proj-b--", "two.jsonl"),
			join(root, "readme.jsonl"),
		]);
		for (const [path, stamp] of stamps) expect(stamp).toMatch(/^\d+(?:\.\d+)?:\d+$/);
		expect(stamps.get(join(root, "--proj-a--", "one.jsonl"))).toMatch(/:3$/);
	});

	it("mtime/size 变化会反映到签名里（缓存据此判断是否重扫）", async () => {
		const file = join(root, "s.jsonl");
		touch(file, "{}\n", 1_700_000_000);
		// 实测签名用 mtimeMs（可能带小数，比整秒精确）+ 字节数；同一 mtime 下 size 变化也能发现。
		const before = await scanSessionStamps(root);
		touch(file, '{"type":"session"}\n', 1_700_000_100);
		const after = await scanSessionStamps(root);
		expect(before.get(file)).not.toBe(after.get(file));
		expect(after.get(file)).toBe(`${1_700_000_100_000}:19`);
	});
});
