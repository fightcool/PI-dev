/* 🍞 AI Breadcrumb — @COUPLED ../run-smoke.mjs（冒烟清单 ALL = 并发执行的用例集合）,
 *   ../<name>-test.mjs（各自声明端口：`const PORT = 8898` 或 `Number(process.argv[2] || 8955)`）
 * @CONTRACT 凡是**自己起 server 并绑定固定端口**的用例，都不得与他人共用同一端口：
 *   同端口会互相踩——后起的用例 freePort 会把先起用例的 server 杀掉，或直接连上别人的 server，
 *   表现为与本功能无关的假失败（"no result" / 回执永远不来）。
 *   两类用例都被覆盖：① run-smoke 跑批内的（并发，默认 JOBS=3）；
 *   ② 跑批外但会自己起 server 的浏览器 E2E（人手同时跑 / CI 分片跑）。
 *   不绑固定端口的用例（纯 CLI、或 `listen(0)` 取动态端口）视为「无端口」，不参与唯一性判定。
 * @BUGFIX 2026-09-17：实测跑批内有 6 组端口冲突（8898 被 conv-cwd/preview/restart-handoff 三个共用，
 *   8967 被 left-panel-delete/vscode-editor-plugin 共用，另有 8908 / 8955+8956 / 8978 / 8979 / 8981）。
 *   跑批时确实复现过 preview-test 全项 "no result"（单独跑通过）。本用例把「端口唯一」变成
 *   可执行约束，而不是靠人记得。
 * @KNOWN 跑批外仍有 7 组**历史冲突**（测试基座欠账，改它们要单独把对应 E2E 跑一遍，未并入本次
 *   修复）：见 KNOWN_PREEXISTING_PORTS。它们被排除在断言之列，但「排除名单必须仍然冲突」
 *   （清单过期会让用例失败提醒清理）——同时新增用例仍不准再撞这些端口。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

/** 跑批外已知的历史冲突端口（测试基座欠账）。修好后从本名单里删掉，用例会提醒你。 */
const KNOWN_PREEXISTING_PORTS = [8898, 8899, 8901, 8937, 8962, 8965, 8977];

/** run-smoke.mjs 的 ALL 清单（被判定的用例名）。 */
function smokeList(): string[] {
	const src = readFileSync(join(root, "tests", "run-smoke.mjs"), "utf8");
	const block = src.match(/const ALL = \[([\s\S]*?)\];/);
	if (!block) throw new Error("run-smoke.mjs 里找不到 ALL 清单");
	return [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

/**
 * 某用例占用的固定端口。覆盖仓库里实际存在的写法：
 *   `const PORT = 8898;`、`const PORT = Number(process.argv[2] || 8955);`、
 *   派生端口 `const MOCK_PORT = PORT + 1;`，以及**按名字另起的第二台 server**
 *   `const PORT2 = 8970;` + `PI_WEB_PORT: String(PORT2)`。
 * @BUGFIX 2026-09-21：解析原来漏了 `PI_WEB_PORT: String(PORT + 1)` 这种写法，于是
 *   left-panel-delete-test 的第二台 server（8968）与 db-client-test 的主端口撞车却判不出来
 *   —— 并发跑批时它连到了别人的 server，表现为「启动恢复最近会话」假失败（CI 稳定复现）。
 *   现在把 `PI_WEB_PORT` 的两种写法（常量名 / 直接写字面量）一并纳入判定。
 */
function portsOf(name: string): number[] {
	const src = readFileSync(join(root, "tests", `${name}.mjs`), "utf8");
	const literal = src.match(/\bPORT\s*=\s*(\d+)\b/)?.[1];
	const viaArgv = src.match(/process\.argv\[\d+\]\s*(?:\|\||\?\?)\s*(\d+)/)?.[1];
	const base = Number(literal ?? viaArgv ?? 0);
	const ports = new Set<number>();
	if (base) ports.add(base);
	// 同文件里按名字声明的其它端口（PORT2 / MOCK_PORT / …）：`const NAME = \d+;`
	for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*PORT[0-9]*)\s*=\s*(\d{4,5})\b/g)) ports.add(Number(m[2]));
	// 派生端口：`… = PORT + 1` / `= <base> + 1`
	for (const m of src.matchAll(/\b[A-Z_]*PORT[0-9]*\s*=\s*(?:PORT|\d+)\s*\+\s*(\d+)/g)) {
		const baseOfRule = /^\s*([A-Z_]*PORT[0-9]*)\s*=/.exec(m[0])?.[1] ?? "";
		if (base) ports.add(base + Number(m[1]));
		else if (baseOfRule) void baseOfRule;
	}
	// 起 server 时实际用的端口：`PI_WEB_PORT: String(PORT + 1)` / `String(PORT2)` / `String(8968)`
	for (const m of src.matchAll(/PI_WEB_PORT:\s*String\(\s*(?:(PORT[0-9]*)|(\d{4,5}))\s*(?:\+\s*(\d+))?\s*\)/g)) {
		const named = m[1];
		const extra = Number(m[3] ?? 0);
		if (m[2]) ports.add(Number(m[2]) + extra);
		else if (named === "PORT") ports.add(base + extra);
		else {
			const decl = new RegExp(`\\bconst\\s+${named}\\s*=\\s*(\\d{4,5})`).exec(src);
			if (decl) ports.add(Number(decl[1]) + extra);
		}
	}
	return [...ports].filter((p) => p > 0);
}

/** 跑批外会自起 server 的用例名（含浏览器 E2E）——它们同样不能共端口。 */
function serverSpawningTests(): string[] {
	return readdirSync(join(root, "tests"))
		.filter((f) => f.endsWith("-test.mjs"))
		.map((f) => f.replace(/\.mjs$/, ""))
		.filter((name) => {
			try {
				return readFileSync(join(root, "tests", `${name}.mjs`), "utf8").includes("dist/server/index.js");
			} catch {
				return false;
			}
		});
}

/** 端口 → 占用它的用例名（只在给定用例集合里统计）。 */
function portOwners(names: string[]): Map<number, string[]> {
	const owners = new Map<number, string[]>();
	for (const name of names) {
		for (const port of portsOf(name)) owners.set(port, [...(owners.get(port) ?? []), name]);
	}
	return owners;
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
		expect(clashes, "同端口并发会互相踩（假失败）；给新用例分配未被占用的端口，见 run-smoke.mjs 的并发说明").toEqual(
			[],
		);
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

describe("自起 server 的用例端口唯一性（跑批之外）", () => {
	const spawners = serverSpawningTests();

	it("确实扫到了自起 server 的用例（解析逻辑没坏）", () => {
		expect(spawners.length).toBeGreaterThan(30);
	});

	it("跑批外的历史冲突只在名单内，且不得新增", () => {
		const clashes = [...portOwners(spawners).entries()]
			.filter(([, who]) => who.length > 1)
			.filter(([port]) => !KNOWN_PREEXISTING_PORTS.includes(port))
			.map(([port, who]) => `${port} → ${who.join(", ")}`);
		expect(clashes, "新用例请挑一个没人用的端口（8900+，见上面空闲区间）").toEqual([]);
	});

	it("已知冲突名单没有过期（修掉一个就该从名单里删掉）", () => {
		const owners = portOwners(spawners);
		const stale = KNOWN_PREEXISTING_PORTS.filter((port) => (owners.get(port)?.length ?? 0) < 2);
		expect(stale, "这些端口已经不冲突了，请从 KNOWN_PREEXISTING_PORTS 里移除").toEqual([]);
	});
});
