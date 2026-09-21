/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-ask.ts（形状闸门）, ../../scripts/jev-gate.ts（ask 子命令）
 * 📖 docs/JEV-HARNESS-PLAN.md §6 —— 「临时命题」是 harness 用 Jev 的统一入口（裁剪/重排/路由/护栏）。
 * 全部零网络：纯解析随便跑；CLI 部分只走到「校验通过 → 缺密钥退出 3」为止，不发请求。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASK_MAX_QUESTIONS, JevAskError, askExitCode, parseAskQuestions } from "../../server/dev-con/jev-ask.js";

const NOUL = {
	type: "noul",
	instructions: { question: "Is this section needed?" },
	criteria: { true: "yes", false: "no" },
};

describe("parseAskQuestions（纯形状闸门）", () => {
	it("接受合法载荷并原样返回（不改写内容）", () => {
		const payload = { keep_1: NOUL, keep_2: { type: "score", instructions: "how relevant", criteria: {} } };
		expect(parseAskQuestions(payload)).toBe(payload);
	});

	it("拒绝非对象 / 空载荷 / 超量", () => {
		for (const bad of [null, "nope", 42, [], [NOUL]]) {
			expect(() => parseAskQuestions(bad)).toThrow(JevAskError);
		}
		expect(() => parseAskQuestions({})).toThrow(/为空/);
		const tooMany = Object.fromEntries(Array.from({ length: ASK_MAX_QUESTIONS + 1 }, (_, i) => [`q_${i}`, NOUL]));
		expect(() => parseAskQuestions(tooMany)).toThrow(/过多/);
	});

	it("拒绝非法 id（与注册表同一套规则：小写字母开头）", () => {
		for (const badId of ["Keep", "1keep", "keep-1", "keep 1", "", "a".repeat(103)]) {
			expect(() => parseAskQuestions({ [badId]: NOUL })).toThrow(/id 非法/);
		}
		expect(() => parseAskQuestions({ keep_1: NOUL })).not.toThrow();
	});

	it("拒绝缺 type / type 错 / 缺 instructions（上游 zod 的判别字段）", () => {
		expect(() => parseAskQuestions({ q: { instructions: "x" } })).toThrow(/type 必须是/);
		expect(() => parseAskQuestions({ q: { type: "magic", instructions: "x" } })).toThrow(/type 必须是/);
		expect(() => parseAskQuestions({ q: { type: "noul" } })).toThrow(/缺少 instructions/);
		expect(() => parseAskQuestions({ q: { type: "noul", instructions: "   " } })).toThrow(/缺少 instructions/);
		expect(() => parseAskQuestions({ q: { type: "noul", instructions: {} } })).toThrow(/缺少 instructions/);
	});

	it("错误信息不回显载荷正文（state 可能是整份源码）", () => {
		const secretish = "SUPER-SECRET-BODY-TEXT";
		try {
			parseAskQuestions({ BadId: { type: "noul", instructions: secretish } });
			expect.unreachable("应当抛错");
		} catch (err) {
			expect((err as Error).message).not.toContain(secretish);
		}
	});
});

describe("askExitCode（三态 vs 只要数）", () => {
	const ok = (outcome: string) => ({ error: null, outcome });
	it("默认套三态阈值：approve/block/review → 0/1/2", () => {
		expect(askExitCode(ok("approve"), false)).toBe(0);
		expect(askExitCode(ok("block"), false)).toBe(1);
		expect(askExitCode(ok("review"), false)).toBe(2);
	});
	it("--raw 只要数：成功一律 0（排序/筛选不该因为「被判 block」看着像失败）", () => {
		expect(askExitCode(ok("block"), true)).toBe(0);
		expect(askExitCode(ok("review"), true)).toBe(0);
	});
	it("出错一律 3，与 raw 无关（门禁坏了不许伪装成成功）", () => {
		const bad = { error: { code: "timeout" }, outcome: "review" };
		expect(askExitCode(bad, false)).toBe(3);
		expect(askExitCode(bad, true)).toBe(3);
	});
});

describe("CLI ask（真实进程，零网络）", () => {
	// tsx 冷启动 ~2-4s，默认超时不够。
	const CLI_TIMEOUT = 30_000;
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jev-ask-cli-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const run = (args: string[]): { code: number; out: string } => {
		try {
			const out = execFileSync(
				process.execPath,
				["--import", "tsx", "scripts/jev-gate.ts", "ask", "--agent-dir", dir, ...args],
				{
					encoding: "utf8",
					cwd: join(__dirname, "..", ".."),
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			return { code: 0, out };
		} catch (err) {
			const e = err as { status?: number; stdout?: string; stderr?: string };
			return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
		}
	};

	/** 写一个命题文件，返回路径。 */
	const questionsFile = (content: string): string => {
		const path = join(dir, "questions.json");
		writeFileSync(path, content);
		return path;
	};

	it(
		"缺 --questions-file → 退出码 3 且给出可定位提示",
		() => {
			const r = run(["--state-file", "-"]);
			expect(r.code).toBe(3);
			expect(r.out).toMatch(/缺少 --questions-file/);
		},
		CLI_TIMEOUT,
	);

	it(
		"questions-file 不是 JSON → 3；形状非法 → 3（都带原因）",
		() => {
			const bad = run(["--questions-file", questionsFile("{ not json")]);
			expect(bad.code).toBe(3);
			expect(bad.out).toMatch(/不是合法 JSON/);

			const shape = run(["--questions-file", questionsFile(JSON.stringify({ q: { type: "noul" } }))]);
			expect(shape.code).toBe(3);
			expect(shape.out).toMatch(/缺少 instructions/);
		},
		CLI_TIMEOUT,
	);

	it(
		"校验通过后因未绑定密钥退出 3（证明参数闸门放行、且不发网络请求）",
		() => {
			const r = run(["--questions-file", questionsFile(JSON.stringify({ keep_1: NOUL })), "--state-file", "-"]);
			expect(r.code).toBe(3);
			expect(r.out).toMatch(/密钥|credentialRef|key-name/);
		},
		CLI_TIMEOUT,
	);
});
