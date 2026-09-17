/* 🍞 AI Breadcrumb — @COUPLED ../run-smoke.mjs（冒烟清单 ALL = 被判定的用例集合）,
 *   ../<name>-test.mjs（各自声明端口：`const PORT = 8898` 或 `Number(process.argv[2] || 8955)`）
 * @CONTRACT 冒烟跑器并发执行清单内用例（默认 JOBS=3），因此**清单内任意两个用例不得占用同一端口**：
 *   同端口会互相踩——后起的用例 freePort 会把先起用例的 server 杀掉，或直接连上别人的 server，
 *   表现为与本功能无关的假失败（"no result" / 回执永远不来）。
 *   不绑固定端口的用例（纯 CLI、或 `listen(0)` 取动态端口）视为「无端口」，不参与唯一性判定。
 * @BUGFIX 2026-09-17：实测有 6 组端口冲突（8898 被 conv-cwd/preview/restart-handoff 三个共用，
 *   8967 被 left-panel-delete/vscode-editor-plugin 共用，另有 8908 / 8955+8956 / 8978 / 8979 / 8981）。
 *   跑批时确实复现过 preview-test 全项 "no result"（单独跑通过）。本用例把「端口唯一」变成
 *   可执行约束，而不是靠人记得。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

/** run-smoke.mjs 的 ALL 清单（被判定的用例名）。 */
function smokeList(): string[] {
	const src = readFileSync(join(root, "tests", "run-smoke.mjs"), "utf8");
	const block = src.match(/const ALL = \[([\s\S]*?)\];/);
	if (!block) throw new Error("run-smoke.mjs 里找不到 ALL 清单");
	return [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

/**
 * 某用例占用的固定端口。覆盖仓库里实际存在的两种写法：
 *   `const PORT = 8898;` 与 `const PORT = Number(process.argv[2] || 8955);`
 * 以及派生端口 `const MOCK_PORT = PORT + 1;`（成对占用，必须一起判唯一）。
 */
function portsOf(name: string): number[] {
	const src = readFileSync(join(root, "tests", `${name}.mjs`), "utf8");
	const literal = src.match(/\bPORT\s*=\s*(\d+)\b/)?.[1];
	const viaArgv = src.match(/process\.argv\[\d+\]\s*(?:\|\||\?\?)\s*(\d+)/)?.[1];
	const base = Number(literal ?? viaArgv ?? 0);
	if (!base) return [];
	const ports = new Set<number>([base]);
	for (const m of src.matchAll(/\b[A-Z_]*PORT\s*=\s*PORT\s*\+\s*(\d+)/g)) ports.add(base + Number(m[1]));
	return [...ports];
}

describe("冒烟清单端口唯一性", () => {
	const list = smokeList();

	it("清单非空（解析逻辑没坏）", () => {
		expect(list.length).toBeGreaterThan(30);
	});

	it("同一个端口不会被清单里两个用例同时占用", () => {
		const owners = new Map<number, string[]>();
		for (const name of list) {
			for (const port of portsOf(name)) owners.set(port, [...(owners.get(port) ?? []), name]);
		}
		const clashes = [...owners.entries()]
			.filter(([, who]) => who.length > 1)
			.map(([port, who]) => `${port} → ${who.join(", ")}`);
		expect(
			clashes,
			"同端口并发会互相踩（假失败）；给新用例分配未被占用的端口，见 run-smoke.mjs 的并发说明",
		).toEqual([]);
	});

	it("端口都在可用区间（≥8900 且非线上 8787）", () => {
		// ≥8900 是 vendor AGENTS.md「测试规范：端口隔离（≥8900）」的硬约束：8900 以下是
		// 常见本地开发/示例服务的占用区间，容易与操作人正在跑的东西撞。
		const bad: string[] = [];
		for (const name of list) {
			for (const port of portsOf(name)) {
				if (port < 8900 || port > 65535 || port === 8787) bad.push(`${name}:${port}`);
			}
		}
		expect(bad).toEqual([]);
	});

	it("清单里的用例都有对应文件", () => {
		const missing = list.filter((name) => {
			try {
				readFileSync(join(root, "tests", `${name}.mjs`));
				return false;
			} catch {
				return true;
			}
		});
		expect(missing).toEqual([]);
	});
});
