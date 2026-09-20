/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-cache.ts（被测件）,
 *   ../../server/dev-con/jev-gate.ts（唯一的消费者：evaluate 的第二级缓存）,
 *   ../../server/dev-con/jev-model.ts（cacheKey / buildJevQuestions / JevOutcome）
 * 📖 docs/JEV-DECISION-GATE.md §9（成本与限额：省钱的正确做法是缓存）
 * @CONTRACT 本文件只用真实文件系统（mkdtempSync 隔离临时目录），不真联网：
 *   隐私（state / 密钥绝不落盘）、轮转 + 两代同读、逐行容错、条目上限、清空。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JevGate } from "../../server/dev-con/jev-gate.js";
import {
	JEV_CACHE_MAX_ENTRIES,
	JEV_CACHE_MAX_BYTES,
	JEV_CACHE_VERSION,
	appendJevCacheEntry,
	capJevCacheEntries,
	clearJevCache,
	jevCachePath,
	jevCachePreviousPath,
	jevCacheStats,
	loadJevCache,
	type JevCacheEntry,
} from "../../server/dev-con/jev-cache.js";
import { JEV_PROBE_PROPOSITION_ID, buildJevQuestions, defaultJevGateConfig } from "../../server/dev-con/jev-model.js";

/** 合成密钥（运行时拼接，避免被发布检查当成真实密钥字面量）。 */
const SYNTHETIC_KEY = ["sk", "or", "TESTONLY0123456789abcdef0123"].join("-");
/** 被审内容里的特征串：缓存文件里出现一次即为隐私违规。 */
const STATE_MARKER = "JEV-CACHE-PRIVACY-MARKER-4f3a9c";

const QUESTIONS = buildJevQuestions([JEV_PROBE_PROPOSITION_ID]);

let dir = "";
let path = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jev-cache-"));
	path = jevCachePath(dir);
	// 部分用例直接写文件（模拟手改/外部写入），先把 dev-con 目录建出来。
	mkdirSync(join(dir, "dev-con"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<JevCacheEntry> = {}): JevCacheEntry {
	return {
		v: JEV_CACHE_VERSION,
		key: "a".repeat(64),
		at: 1_000,
		model: "typesafe/jev-1.13",
		outcome: "approve",
		checks: { [JEV_PROBE_PROPOSITION_ID]: 0.97 },
		audit: { elapsedMs: 120, model: "typesafe/jev-1.13", provider: "OpenRouter", inputTokens: 12, cost: 0.0004 },
		...overrides,
	};
}

/** 构造一个 Response 替身：fetchJson 只用到 status/ok/body.getReader。 */
function jsonResponse(body: unknown, status = 200): Response {
	const bytes = new TextEncoder().encode(JSON.stringify(body));
	let sent = false;
	return {
		status,
		ok: status >= 200 && status < 300,
		body: {
			getReader: () => ({
				read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
					if (sent) return { done: true };
					sent = true;
					return { done: false, value: bytes };
				},
				cancel: async (): Promise<void> => undefined,
			}),
		},
	} as unknown as Response;
}

function stubFetch(handler: () => Response): { impl: typeof fetch; calls: number[] } {
	const calls: number[] = [];
	const impl = (async (): Promise<Response> => {
		calls.push(calls.length + 1);
		return handler();
	}) as unknown as typeof fetch;
	return { impl, calls };
}

const noul = (score: number): Record<string, unknown> => ({
	answers: { [JEV_PROBE_PROPOSITION_ID]: { type: "noul", noul: score } },
});

describe("jev-cache — 追加 / 读回 / 逐行容错", () => {
	it("路径落在 <agentDir>/dev-con/ 下，追加后能原样读回", () => {
		expect(jevCachePath("/data/agent")).toBe("/data/agent/dev-con/jev-decisions-cache.jsonl");
		appendJevCacheEntry(path, entry());
		const loaded = loadJevCache(path);
		expect(loaded.size).toBe(1);
		expect(loaded.get("a".repeat(64))).toEqual(entry());
	});

	it("同 key 后写覆盖前写（两代之间也适用）", () => {
		appendJevCacheEntry(path, entry({ at: 1_000, outcome: "approve" }));
		appendJevCacheEntry(path, entry({ at: 2_000, outcome: "block", checks: { [JEV_PROBE_PROPOSITION_ID]: 0.01 } }));
		const loaded = loadJevCache(path);
		expect(loaded.size).toBe(1);
		expect(loaded.get("a".repeat(64))).toMatchObject({ at: 2_000, outcome: "block" });
	});

	it("损坏行/形状不符的行被跳过，不抛，也不污染其他条目", () => {
		writeFileSync(
			path,
			[
				JSON.stringify(entry({ key: "b".repeat(64), at: 5 })),
				"{ 这不是 JSON",
				"{}",
				JSON.stringify(entry({ key: "c".repeat(64), at: 6, v: 99 })),
				JSON.stringify(entry({ key: "d".repeat(64), at: 7, outcome: "maybe" as unknown as JevCacheEntry["outcome"] })),
				JSON.stringify(entry({ key: "e".repeat(64), at: 8, checks: {} })),
				"",
				JSON.stringify(entry({ key: "f".repeat(64), at: 9 })),
			].join("\n") + "\n",
			{ mode: 0o600 },
		);
		const loaded = loadJevCache(path);
		expect([...loaded.keys()].sort()).toEqual(["b".repeat(64), "f".repeat(64)]);
		expect(jevCacheStats(path).skipped).toBe(5);
	});

	it("文件不存在 / 路径不可读时返回空表而不是抛", () => {
		expect(loadJevCache(join(dir, "nope", "jev-decisions-cache.jsonl")).size).toBe(0);
		expect(jevCacheStats(path)).toMatchObject({ entries: 0, bytes: 0, oldestAt: null, newestAt: null });
	});
});

describe("jev-cache — 隐私硬约束（state 与密钥绝不落盘）", () => {
	it("走一遍真实判定后：缓存文件里没有 state 内容、没有密钥、没有 state 字段名", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.97)));
		const gate = new JevGate({ fetchImpl: impl, config: defaultJevGateConfig(), cachePath: path });
		const decision = await gate.evaluate({
			state: {
				// state 里既有特征串也有「看着像密钥」的内容：两者都不得落盘。
				note: STATE_MARKER,
				leaked: SYNTHETIC_KEY,
				diff: "- export function parse(input: string): Node\n+ export function parse(input: string, options: ParseOptions): Node",
			},
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
		});
		expect(decision.outcome).toBe("approve");

		const text = readFileSync(path, "utf8");
		expect(text.length).toBeGreaterThan(0);
		expect(text).not.toContain(STATE_MARKER);
		expect(text).not.toContain(SYNTHETIC_KEY);
		expect(text).not.toContain("state");
		expect(text).not.toContain("export function parse");

		// 记录形状只有白名单字段；key 是 sha256 摘要（64 位十六进制），不是 state 本身。
		const line = JSON.parse(text.trim()) as Record<string, unknown>;
		expect(Object.keys(line).sort()).toEqual(["at", "audit", "checks", "key", "model", "outcome", "v"]);
		expect(String(line.key)).toMatch(/^[0-9a-f]{64}$/);
		expect(line).not.toHaveProperty("state");
		expect(Object.keys(line.checks as object)).toEqual([JEV_PROBE_PROPOSITION_ID]);

		// 统计与回显同样只含计数/时间/路径。
		const surfaces = [
			JSON.stringify(jevCacheStats(path)),
			JSON.stringify(decision),
			JSON.stringify(gate.snapshotStatus()),
			JSON.stringify(gate.recentEvents()),
		];
		for (const surface of surfaces) {
			expect(surface).not.toContain(STATE_MARKER);
			expect(surface).not.toContain(SYNTHETIC_KEY);
		}
	});

	it("手改的文件塞进多余的 state 字段：读时丢弃，不会顺着决策回到回显里", async () => {
		writeFileSync(
			path,
			JSON.stringify({ ...entry(), state: { leaked: STATE_MARKER, key: SYNTHETIC_KEY }, extraJunk: 1 }) + "\n",
			{ mode: 0o600 },
		);
		const loaded = loadJevCache(path);
		const stored = loaded.get("a".repeat(64));
		expect(stored).toEqual(entry());
		expect(JSON.stringify(stored)).not.toContain(STATE_MARKER);
		expect(JSON.stringify(stored)).not.toContain(SYNTHETIC_KEY);
		expect(JSON.stringify(jevCacheStats(path))).not.toContain(STATE_MARKER);
	});

	it("未提供 cachePath 时完全不落盘（旧调用/测试零影响）", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.97)));
		const gate = new JevGate({ fetchImpl: impl, config: defaultJevGateConfig() });
		await gate.evaluate({ state: { note: STATE_MARKER }, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(existsSync(path)).toBe(false);
	});
});

describe("jev-cache — 轮转（8MiB 只留一代）与清除", () => {
	/** 制造一条够大的记录（checks 里塞长命题名）：几条就能顶过 8MiB，避免几十万次 append。 */
	const bigEntry = (n: number, at: number): JevCacheEntry => {
		const checks: Record<string, number> = {};
		for (let i = 0; i < 3_000; i++) checks[`p-${n}-${i}-${"x".repeat(200)}`] = 0.5;
		return entry({ key: `${n}`.padStart(64, "0"), at, checks });
	};

	it("超过上限即轮转到 .1；读时两代都读", () => {
		const first = bigEntry(1, 1_000);
		appendJevCacheEntry(path, first);
		expect(existsSync(jevCachePreviousPath(path))).toBe(false);
		// 第一条已经写满/超过上限：下一条 append 之前先把当前文件轮转为 .1。
		for (let n = 2; n <= 14; n++) {
			appendJevCacheEntry(path, bigEntry(n, n * 1_000));
			if (existsSync(jevCachePreviousPath(path))) break;
		}
		expect(existsSync(jevCachePreviousPath(path))).toBe(true);
		expect(statSync(jevCachePreviousPath(path)).size).toBeGreaterThanOrEqual(JEV_CACHE_MAX_BYTES);

		const loaded = loadJevCache(path);
		// 两代都读：上一条（第一代）也必须在结果里。
		expect(loaded.get(first.key)).toEqual(first);
		expect(loaded.size).toBeGreaterThan(1);
	});

	it("clearJevCache 删掉当前代与 .1，并如实报告删了什么", () => {
		appendJevCacheEntry(path, entry());
		writeFileSync(jevCachePreviousPath(path), JSON.stringify(entry({ key: "9".repeat(64) })) + "\n", { mode: 0o600 });
		const cleared = clearJevCache(path);
		expect(cleared.removed).toEqual([path, jevCachePreviousPath(path)]);
		expect(cleared.bytes).toBeGreaterThan(0);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(jevCachePreviousPath(path))).toBe(false);
		expect(loadJevCache(path).size).toBe(0);
		// 再清一次：什么都不删，也不抛。
		expect(clearJevCache(path)).toEqual({ removed: [], bytes: 0 });
	});
});

describe("jev-cache — 有界", () => {
	it("条目数超出上限时保留最新（按 at）", () => {
		const total = JEV_CACHE_MAX_ENTRIES + 7;
		const lines: string[] = [];
		for (let i = 0; i < total; i++) lines.push(JSON.stringify(entry({ key: `k${i}`, at: 1_000 + i })));
		writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });

		const loaded = loadJevCache(path);
		expect(loaded.size).toBe(JEV_CACHE_MAX_ENTRIES);
		// 最旧的 7 条被丢掉，最新的一条还在。
		for (let i = 0; i < 7; i++) expect(loaded.has(`k${i}`)).toBe(false);
		expect(loaded.has(`k${total - 1}`)).toBe(true);
		expect(loaded.has("k7")).toBe(true);
	});

	it("capJevCacheEntries：超出上限只保留最新（镜像与读盘共用同一个上限）", () => {
		const all = Array.from({ length: JEV_CACHE_MAX_ENTRIES + 3 }, (_, i) => entry({ key: `m${i}`, at: 1_000 + i }));
		const capped = capJevCacheEntries(all);
		expect(capped.size).toBe(JEV_CACHE_MAX_ENTRIES);
		expect(capped.has("m0")).toBe(false);
		expect(capped.has("m2")).toBe(false);
		expect(capped.has("m3")).toBe(true);
		expect(capped.has(`m${JEV_CACHE_MAX_ENTRIES + 2}`)).toBe(true);
		expect(capJevCacheEntries(all.slice(0, 3)).size).toBe(3);
	});

	it("统计给出条目数 / 字节数 / 时间范围", () => {
		appendJevCacheEntry(path, entry({ key: "1".repeat(64), at: 1_000 }));
		appendJevCacheEntry(path, entry({ key: "2".repeat(64), at: 2_000 }));
		const stats = jevCacheStats(path);
		expect(stats).toMatchObject({ path, entries: 2, oldestAt: 1_000, newestAt: 2_000, skipped: 0 });
		expect(stats.bytes).toBe(statSync(path).size);
	});
});
