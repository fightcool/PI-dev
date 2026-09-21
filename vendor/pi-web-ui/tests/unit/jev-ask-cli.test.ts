/* 🍞 AI Breadcrumb — @COUPLED ../../scripts/jev-ask.ts（瘦入口）, ../../scripts/jev-gate.ts（参照实现）
 * 📖 docs/JEV-TRIM.md §延迟 —— 这个入口存在的唯一理由是**快**，所以测试要同时钉「等价」和「更快」。
 * 全部零网络：只走到「参数/密钥闸门」，不发请求。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CLI_TIMEOUT = 60_000;
const ROOT = join(__dirname, "..", "..");
const NOUL = { type: "noul", instructions: { question: "q" }, criteria: { true: "y", false: "n" } };

describe("瘦入口 jev-ask.ts", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jev-ask-slim-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const run = (args: string[], entry = "scripts/jev-ask.ts"): { code: number; out: string } => {
		try {
			const out = execFileSync(process.execPath, ["--import", "tsx", entry, ...args], {
				encoding: "utf8",
				cwd: ROOT,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return { code: 0, out };
		} catch (err) {
			const e = err as { status?: number; stdout?: string; stderr?: string };
			return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
		}
	};
	const questionsFile = (content: string): string => {
		const path = join(dir, "questions.json");
		writeFileSync(path, content);
		return path;
	};

	it(
		"与完整 CLI 的参数闸门行为一致（同输入 → 同错误、同退出码）",
		() => {
			const cases = [
				[],
				["--questions-file", questionsFile("{ not json")],
				["--questions-file", questionsFile(JSON.stringify({ BadId: NOUL }))],
				["--questions-file", questionsFile(JSON.stringify({ q: { type: "noul" } }))],
				["--questions-file", questionsFile(JSON.stringify({ q: NOUL })), "--state-file", "-"],
			];
			for (const args of cases) {
				const slim = run([...args, "--agent-dir", dir]);
				const full = run(["ask", ...args, "--agent-dir", dir], "scripts/jev-gate.ts");
				expect(slim.code, `参数：${JSON.stringify(args)}`).toBe(full.code);
			}
			// 具体原因也要对得上（不是笼统地都失败）。
			expect(
				run(["--questions-file", questionsFile(JSON.stringify({ q: NOUL })), "--state-file", "-", "--agent-dir", dir])
					.out,
			).toMatch(/密钥/);
			expect(run(["--agent-dir", dir]).out).toMatch(/缺少 --questions-file/);
		},
		CLI_TIMEOUT,
	);

	it(
		"agentDir 等价复制不漂移：`--print-agent-dir` 与 SDK getAgentDir() 逐例一致",
		() => {
			// @WHY 瘦入口不能用 SDK（import 一次实测 2.5s，全部冷启动开销都在这里），只能自己解析 agentDir。
			// 所以这里直接对比两者：SDK 的语义（环境变量名/默认目录/`~` 展开）一变，这条断言就红。
			const withEnv = <T>(value: string | undefined, fn: () => T): T => {
				const saved = process.env.PI_CODING_AGENT_DIR;
				if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = value;
				try {
					return fn();
				} finally {
					if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
					else process.env.PI_CODING_AGENT_DIR = saved;
				}
			};
			for (const value of ["/tmp/agent-x", undefined, "~/custom-agent"]) {
				const sdk = withEnv(value, () => getAgentDir());
				const slim = withEnv(value, () => {
					const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/jev-ask.ts", "--print-agent-dir"], {
						encoding: "utf8",
						cwd: ROOT,
						stdio: ["pipe", "pipe", "pipe"],
					});
					return out.trim();
				});
				expect(slim, `PI_CODING_AGENT_DIR=${String(value)}`).toBe(sdk);
			}
			// 兜底：确实没有 import 那个 SDK（这是瘦的全部意义）。用源码级断言防止有人「顺手」加回去。
			const source = readFileSync(join(ROOT, "scripts", "jev-ask.ts"), "utf8");
			expect(source).not.toMatch(/from "@earendil-works\/pi-coding-agent"/);
		},
		CLI_TIMEOUT,
	);

	it(
		"确实更快：瘦入口冷启动明显低于完整 CLI",
		() => {
			const time = (entry: string, args: string[]): number => {
				const started = Date.now();
				run([...args, "--agent-dir", dir], entry);
				return Date.now() - started;
			};
			const args = ["--questions-file", questionsFile(JSON.stringify({ q: NOUL })), "--state-file", "-"];
			time("scripts/jev-ask.ts", args); // 预热（磁盘/编译缓存）
			time("scripts/jev-gate.ts", ["ask", ...args]);
			const slim = time("scripts/jev-ask.ts", args);
			const full = time("scripts/jev-gate.ts", ["ask", ...args]);
			// 实测 ~0.4s vs ~2.7s；留足余量（CI 机器慢），只要求瘦入口快一倍以上。
			expect(slim * 2).toBeLessThan(full);
		},
		CLI_TIMEOUT,
	);
});
