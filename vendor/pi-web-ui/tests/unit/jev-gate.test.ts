/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-gate.ts, ../../server/dev-con/jev-cache.ts
 * 📖 docs/DEV-CON-PROPOSAL.md §7（有界外部调用、失败转人工、可观测）
 * 全部用例注入 fetchImpl / now，**绝不真联网**：
 * 成功路径、缺答/越界必须失败、超时、非 JSON、体积超限、401/402/429、缓存命中、
 * 单飞去重、限频、失败不污染缓存也不把计数清零、密钥绝不出现在回显/诊断里；
 * 磁盘持久缓存（cachePath + mkdtempSync 隔离）：跨进程命中、useCache:false、不写失败、
 * model/命题集合错配一律当 miss、diskHits 计数。
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JevGate } from "../../server/dev-con/jev-gate.js";
import { JEV_CACHE_VERSION, appendJevCacheEntry, clearJevCache, jevCachePath } from "../../server/dev-con/jev-cache.js";
import {
	jevReviewAckPath,
	jevSamplesPath,
	loadJevSamples,
	saveJevReviewAck,
} from "../../server/dev-con/jev-samples.js";
import {
	JEV_PROBE_PROPOSITION_ID,
	buildJevQuestions,
	cacheKey,
	defaultJevGateConfig,
	type JevGateConfig,
} from "../../server/dev-con/jev-model.js";

/** 合成密钥（运行时拼接，避免被发布检查当成真实密钥字面量）。 */
const SYNTHETIC_KEY = ["sk", "or", "TESTONLY0123456789abcdef0123"].join("-");

const QUESTIONS = buildJevQuestions([JEV_PROBE_PROPOSITION_ID]);
const STATE = { diff: "-export function f(): void\n+export function f(x: number): void" };

interface Captured {
	url: string;
	init: RequestInit;
}

/** 构造一个 Response 替身：fetchJson 只用到 status/ok/body.getReader。 */
function response(body: string, status = 200): Response {
	const bytes = new TextEncoder().encode(body);
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

function jsonResponse(body: unknown, status = 200): Response {
	return response(JSON.stringify(body), status);
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler): { impl: typeof fetch; calls: Captured[] } {
	const calls: Captured[] = [];
	const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), init: init ?? {} });
		return handler(String(input), init ?? {});
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function config(overrides: Partial<JevGateConfig> = {}): JevGateConfig {
	return { ...defaultJevGateConfig(), minIntervalMs: 0, ...overrides };
}

const noul = (score: number, type = "noul"): Record<string, unknown> => ({
	answers: { [JEV_PROBE_PROPOSITION_ID]: { type, noul: score } },
});

/** 同上，但能答多条命题（磁盘缓存的命题集合校验用）。 */
const noulMany = (scores: Record<string, number>): Record<string, unknown> => ({
	answers: Object.fromEntries(Object.entries(scores).map(([name, score]) => [name, { type: "noul", noul: score }])),
});

const gate = (
	impl: typeof fetch,
	overrides: Partial<JevGateConfig> = {},
	extra: { now?: () => number } = {},
): JevGate =>
	new JevGate({
		fetchImpl: impl,
		config: config(overrides),
		now: extra.now,
		cacheTtlMs: overrides.cacheTtlMs ?? 300_000,
	});

describe("JevGate.evaluate — happy path", () => {
	it("sends a bounded POST and maps the score into the three-state outcome", async () => {
		const { impl, calls } = stubFetch(() =>
			jsonResponse({
				...noul(0.97),
				id: "gen-1",
				model: "typesafe/jev-1.13",
				provider: "OpenRouter",
				usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 },
			}),
		);
		const g = gate(impl);
		const decision = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });

		expect(decision.outcome).toBe("approve");
		expect(decision.checks).toEqual({ [JEV_PROBE_PROPOSITION_ID]: 0.97 });
		expect(decision.error).toBeUndefined();
		expect(decision.audit).toMatchObject({
			requestId: "gen-1",
			model: "typesafe/jev-1.13",
			provider: "OpenRouter",
			inputTokens: 12,
			outputTokens: 3,
			cache: "miss",
		});
		expect(decision.audit.cost).toBeCloseTo(0.0004);

		// 请求形状：POST + Bearer + {model, state, questions}；重定向策略由共享的有界 fetch 固定。
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(defaultJevGateConfig().endpoint);
		expect(calls[0].init.method).toBe("POST");
		expect(calls[0].init.redirect).toBe("manual");
		expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);
		const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
		expect(sent).toEqual({ model: "typesafe/jev-1.13", state: STATE, questions: QUESTIONS });
		// @BUGFIX 2026-09-20：真实 Decisions 接口要求 questions 是 **record**（键=命题名），
		// 每个 value 带 `type` 判别字段。写成数组/缺 type 会被上游 zod 直接 400。
		expect(Array.isArray(sent.questions)).toBe(false);
		expect(Object.keys(sent.questions as object)).toEqual([JEV_PROBE_PROPOSITION_ID]);
		expect((sent.questions as Record<string, unknown>)[JEV_PROBE_PROPOSITION_ID]).toMatchObject({ type: "noul" });
	});

	it("blocks on a low score instead of approving", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.02)));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("block");
		expect(decision.reason).toContain(`${JEV_PROBE_PROPOSITION_ID}=0.02`);
	});

	it("reviews in the middle band", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.5)));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.error).toBeUndefined();
	});
});

describe("JevGate.evaluate — invalid answers must fail (never degrade to approve)", () => {
	it("fails when the answer is missing entirely", async () => {
		const { impl } = stubFetch(() => jsonResponse({ id: "gen-2" }));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).not.toBe("approve");
		expect(decision.outcome).toBe("review");
		expect(decision.error).toContain("未返回 answers");
		expect(decision.errorEn).toContain("no answers");
	});

	it("fails when the answer type is not noul", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.99, "boolean")));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.error).toContain("未回答命题");
	});

	it("fails when the score is outside 0..1", async () => {
		for (const score of [1.5, -0.2, Number.NaN, "0.99"]) {
			const { impl } = stubFetch(() => jsonResponse(noul(score as number)));
			const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
			expect(decision.outcome).toBe("review");
			expect(decision.error).toContain("0..1");
		}
	});

	it("fails when there are no propositions to ask", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.99)));
		const decision = await gate(impl).evaluate({ state: STATE, questions: [], apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.error).toContain("判定命题");
		expect(calls).toHaveLength(0);
	});
});

describe("JevGate.evaluate — transport failures are normalized (bilingual)", () => {
	it("reports a timeout", async () => {
		const { impl } = stubFetch(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				}),
		);
		const decision = await gate(impl, { timeoutMs: 20 }).evaluate({
			state: STATE,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
		});
		expect(decision.outcome).toBe("review");
		expect(decision.error).toContain("超时");
		expect(decision.errorEn).toContain("timed out");
	});

	it("reports a non-JSON body", async () => {
		const { impl } = stubFetch(() => response("<html>nope</html>"));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.errorEn).toContain("not JSON");
	});

	it("reports an oversized body instead of parsing it", async () => {
		const { impl } = stubFetch(() => response(`{"pad":"${"a".repeat(70 * 1024)}"}`));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.errorEn).toContain("size limit");
	});

	it("reports auth / credits / rate-limit / upstream errors", async () => {
		const cases: { status: number; code: string; zh: string }[] = [
			{ status: 401, code: "http-401", zh: "鉴权失败" },
			{ status: 402, code: "http-402", zh: "额度不足" },
			{ status: 429, code: "http-429", zh: "限流" },
			{ status: 503, code: "http-5xx", zh: "上游错误" },
			{ status: 404, code: "http-error", zh: "HTTP 404" },
		];
		for (const item of cases) {
			const { impl } = stubFetch(() => jsonResponse({ error: "nope" }, item.status));
			const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
			expect(decision.outcome).toBe("review");
			expect(decision.error).toContain(item.zh);
			expect(decision.errorEn).toBeTruthy();
		}
	});

	it("surfaces the upstream error body (bounded, key-scrubbed) on 4xx", async () => {
		// 真实上游 400 的正文才是排障唯一线索（实测：zod 校验错误），但不得包含本次密钥。
		const upstream = {
			error: { message: "Invalid input: expected record, received array", code: 400 },
			leaked: SYNTHETIC_KEY,
		};
		const { impl } = stubFetch(() => jsonResponse(upstream, 400));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.error).toContain("expected record, received array");
		expect(decision.error).not.toContain(SYNTHETIC_KEY);
		expect(decision.errorEn).toContain("upstream:");
		// 错误体不是决策依据：不得因此产生分数。
		expect(decision.checks).toEqual({});
	});

	it("keeps the status-code message when the error body cannot be read", async () => {
		const { impl } = stubFetch(() => response("", 400));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.error).toContain("HTTP 400");
		expect(decision.error).not.toContain("上游");
	});

	it("rejects redirects instead of following them", async () => {
		const { impl } = stubFetch(() => response("", 302));
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.errorEn).toContain("redirect");
	});

	it("never throws, even when the transport explodes", async () => {
		const impl = (() => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const decision = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("review");
		expect(decision.error).toBeTruthy();
	});

	it("fails cleanly when disabled or without a credential", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.99)));
		const disabled = await gate(impl, { enabled: false }).evaluate({
			state: STATE,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
		});
		expect(disabled).toMatchObject({ outcome: "review" });
		expect(disabled.error).toContain("未启用");
		const noKey = await gate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: "" });
		expect(noKey.outcome).toBe("review");
		expect(noKey.error).toContain("凭据");
		expect(calls).toHaveLength(0);
	});

	it("never retries a failed call", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse({}, 500));
		const g = gate(impl);
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(1);
	});
});

describe("JevGate — cache, single-flight and rate limiting", () => {
	it("serves the second identical call from cache and marks it as a hit", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = gate(impl);
		const first = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		const second = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(1);
		expect(first.audit.cache).toBe("miss");
		expect(second.audit.cache).toBe("hit");
		expect(second.outcome).toBe(first.outcome);
		// 状态里必须能看见「命中了几次」，否则缓存是不可观测的黑盒。
		expect(g.snapshotStatus()).toMatchObject({ total: 2, approve: 2, cacheHits: 1 });
	});

	it("keys the cache by state (different state ⇒ a new call)", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = gate(impl);
		await g.evaluate({ state: { diff: "a" }, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		await g.evaluate({ state: { diff: "b" }, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(2);
	});

	it("collapses concurrent identical calls into one upstream request", async () => {
		const { impl, calls } = stubFetch(
			() =>
				new Promise<Response>((resolve) => {
					setTimeout(() => resolve(jsonResponse(noul(0.95))), 10);
				}),
		);
		const g = gate(impl);
		const [a, b] = await Promise.all([
			g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY }),
			g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY }),
		]);
		expect(calls).toHaveLength(1);
		expect(a.outcome).toBe("approve");
		expect(b.outcome).toBe("approve");
		// 单飞只算一次调用（不是两次）。
		expect(g.snapshotStatus().total).toBe(1);
	});

	it("enforces the minimum interval between real calls", async () => {
		let clock = 1_000_000;
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = gate(impl, { minIntervalMs: 1_000 }, { now: () => clock });
		const first = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(first.outcome).toBe("approve");
		clock += 100;
		const second = await g.evaluate({ state: { diff: "other" }, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(1);
		expect(second.outcome).toBe("review");
		expect(second.error).toContain("过于频繁");
	});

	it("drops the cache when the config changes", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = gate(impl);
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		g.applyConfig(config({ model: "typesafe/jev-1.14" }));
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(2);
	});
});

describe("JevGate — observability keeps history on failure", () => {
	it("keeps earlier counters and tokens (no zeroing) when a call fails", async () => {
		let failNext = false;
		const { impl } = stubFetch(() =>
			failNext
				? jsonResponse({}, 429)
				: jsonResponse({ ...noul(0.95), usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.001 } }),
		);
		const g = gate(impl);
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		failNext = true;
		const failed = await g.evaluate({ state: { diff: "second" }, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(failed.outcome).toBe("review");
		const status = g.snapshotStatus();
		expect(status).toMatchObject({ total: 2, approve: 1, review: 1, failed: 1, inputTokens: 12, outputTokens: 3 });
		expect(status.cost).toBeCloseTo(0.001);
		expect(status.lastError).toMatchObject({ code: "http-429" });
		expect(status.avgElapsedMs).toBeGreaterThanOrEqual(0);
	});

	it("never caches a failure (a retry hits the network again)", async () => {
		let failNext = true;
		const { impl, calls } = stubFetch(() => (failNext ? jsonResponse({}, 500) : jsonResponse(noul(0.95))));
		const g = gate(impl);
		const first = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(first.outcome).toBe("review");
		failNext = false;
		const second = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(second.outcome).toBe("approve");
		expect(calls).toHaveLength(2);
	});

	it("bounds the in-memory event ring", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = new JevGate({ fetchImpl: impl, config: config(), eventCapacity: 3 });
		for (let i = 0; i < 6; i++) {
			await g.evaluate({ state: { diff: `s-${i}` }, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		}
		expect(g.recentEvents()).toHaveLength(3);
		expect(g.snapshotStatus().total).toBe(3);
	});
});

describe("JevGate — secrets never surface", () => {
	it("keeps the key out of decisions, events, status and error text", async () => {
		const { impl } = stubFetch(() => jsonResponse({}, 401));
		const g = gate(impl);
		const decision = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		const surfaces = [
			JSON.stringify(decision),
			JSON.stringify(decision.error),
			JSON.stringify(decision.errorEn),
			JSON.stringify(g.snapshotStatus()),
			JSON.stringify(g.recentEvents()),
			JSON.stringify(g.config()),
		];
		for (const surface of surfaces) expect(surface).not.toContain(SYNTHETIC_KEY);
		expect(decision.audit).not.toHaveProperty("authorization");
		expect(JSON.stringify(g.recentEvents())).not.toContain("authorization");
	});

	it("keeps the key out of the success path too", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = gate(impl);
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(JSON.stringify(g.recentEvents())).not.toContain(SYNTHETIC_KEY);
		expect(JSON.stringify(g.snapshotStatus())).not.toContain(SYNTHETIC_KEY);
	});
});

/**
 * 磁盘持久缓存：目的有两个 —— ① CI 确定性回放（同一提交得到同一结论，消掉 ~0.08 的概率抖动）；
 * ② 省钱（决策近似是 (model, questions, state) 的纯函数，可 memoize）。
 * 全部用 mkdtempSync 隔离的临时文件，零真实网络。
 */
describe("JevGate — 磁盘持久缓存（cachePath）", () => {
	let dir = "";
	let cachePath = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jev-gate-cache-"));
		cachePath = jevCachePath(dir);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** 带磁盘缓存的 gate（每调用一次模拟一个新进程）。 */
	const diskGate = (
		impl: typeof fetch,
		overrides: Partial<JevGateConfig> = {},
		extra: { now?: () => number; cacheTtlMs?: number } = {},
	): JevGate =>
		new JevGate({
			fetchImpl: impl,
			config: config(overrides),
			now: extra.now,
			cacheTtlMs: extra.cacheTtlMs ?? overrides.cacheTtlMs ?? 300_000,
			cachePath,
		});

	it("第一次 miss → 网络；换一个进程（同一 cachePath）第二次同输入 → 不发起网络且 cache=disk", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const first = await diskGate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(first.audit.cache).toBe("miss");
		expect(calls).toHaveLength(1);

		// 第二个实例 = 一次 CI 重放：只有磁盘缓存能救它。
		const second = await diskGate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(1);
		expect(second.audit.cache).toBe("disk");
		expect(second.outcome).toBe("approve");
		expect(second.checks).toEqual({ [JEV_PROBE_PROPOSITION_ID]: 0.95 });
		expect(second.error).toBeUndefined();
		// 写盘一律 0600（缓存里没有密钥，但也不该给同机其他用户读）。
		expect(statSync(cachePath).mode & 0o777).toBe(0o600);
	});

	it("同一进程内内存 TTL 过期后落到磁盘（磁盘缓存不随 cacheTtlMs 过期）", async () => {
		let clock = 1_000_000;
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = diskGate(impl, { cacheTtlMs: 1_000 }, { now: () => clock, cacheTtlMs: 1_000 });
		const first = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(first.audit.cache).toBe("miss");
		clock += 5_000;
		const second = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(1);
		expect(second.audit.cache).toBe("disk");
		expect(second.outcome).toBe("approve");
	});

	it("useCache:false 每次都走网络，且不读不写磁盘缓存", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = diskGate(impl);
		const a = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY, useCache: false });
		const b = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY, useCache: false });
		expect(calls).toHaveLength(2);
		expect([a.audit.cache, b.audit.cache]).toEqual(["miss", "miss"]);
		expect(existsSync(cachePath)).toBe(false);
	});

	it("已有缓存时 useCache:false 仍然强制新鲜判定（不能让旧答案冒充新调用）", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = diskGate(impl);
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		const fresh = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY, useCache: false });
		expect(calls).toHaveLength(2);
		expect(fresh.audit.cache).toBe("miss");
	});

	it("失败的判定一律不入缓存（401 / 缺答 / 超时），失败后再调用仍走网络", async () => {
		const http401 = stubFetch(() => jsonResponse({ error: "nope" }, 401));
		const g401 = diskGate(http401.impl);
		await g401.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		await g401.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(http401.calls).toHaveLength(2);

		const missing = stubFetch(() => jsonResponse({ id: "gen-2" }));
		const gMissing = diskGate(missing.impl);
		await gMissing.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		await gMissing.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(missing.calls).toHaveLength(2);

		const timeout = stubFetch(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				}),
		);
		const gTimeout = diskGate(timeout.impl, { timeoutMs: 20 });
		await gTimeout.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		await gTimeout.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(timeout.calls).toHaveLength(2);

		// 三种失败都不该在磁盘上留下任何东西。
		expect(existsSync(cachePath)).toBe(false);
	});

	it("model 变更后旧条目失效（换 model 会 miss）", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		await diskGate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		const other = await diskGate(impl, { model: "typesafe/jev-1.14" }).evaluate({
			state: STATE,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
		});
		expect(calls).toHaveLength(2);
		expect(other.audit.cache).toBe("miss");
	});

	it("条目的 model 与本次不一致 → 当 miss（即使 cacheKey 相同）", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const key = cacheKey({ model: defaultJevGateConfig().model, questions: QUESTIONS, state: STATE });
		appendJevCacheEntry(cachePath, {
			v: JEV_CACHE_VERSION,
			key,
			at: 1,
			model: "typesafe/jev-0.1",
			outcome: "approve",
			checks: { [JEV_PROBE_PROPOSITION_ID]: 0.99 },
			audit: { elapsedMs: 1 },
		});
		const decision = await diskGate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(1);
		expect(decision.audit.cache).toBe("miss");
	});

	it("命题集合变化后旧条目失效（checks 键集合必须与本次问的命题完全一致）", async () => {
		const two = buildJevQuestions([JEV_PROBE_PROPOSITION_ID, "test_asserts_behavior"]);
		const scores = { [JEV_PROBE_PROPOSITION_ID]: 0.95, test_asserts_behavior: 0.95 };
		const { impl, calls } = stubFetch(() => jsonResponse(noulMany(scores)));
		const model = defaultJevGateConfig().model;

		// 少一条（旧答案只覆盖了一个命题）与多一条（旧答案覆盖了这次没问的命题）都必须 miss。
		const stale: Record<string, number>[] = [
			{ [JEV_PROBE_PROPOSITION_ID]: 0.99 },
			{ [JEV_PROBE_PROPOSITION_ID]: 0.99, change_within_task_scope: 0.99 },
		];
		for (const checks of stale) {
			clearJevCache(cachePath);
			appendJevCacheEntry(cachePath, {
				v: JEV_CACHE_VERSION,
				key: cacheKey({ model, questions: two, state: STATE }),
				at: 1,
				model,
				outcome: "approve",
				checks,
				audit: { elapsedMs: 1 },
			});
			const decision = await diskGate(impl).evaluate({ state: STATE, questions: two, apiKey: SYNTHETIC_KEY });
			expect(decision.audit.cache).toBe("miss");
		}
		// 两次都是真实调用（错配的旧条目一次都没被当答案）。
		expect(calls).toHaveLength(2);

		// 反证：键集合一致时确实能命中（否则上面的「miss」可能只是因为缓存根本没生效）。
		clearJevCache(cachePath);
		const hit = await diskGate(impl).evaluate({ state: STATE, questions: two, apiKey: SYNTHETIC_KEY });
		const again = await diskGate(impl).evaluate({ state: STATE, questions: two, apiKey: SYNTHETIC_KEY });
		expect(hit.audit.cache).toBe("miss");
		expect(again.audit.cache).toBe("disk");
		expect(again.checks).toEqual(scores);
	});

	it("换了命题集合（cacheKey 也变了）不会串答案：仍是真实调用", async () => {
		const two = buildJevQuestions([JEV_PROBE_PROPOSITION_ID, "test_asserts_behavior"]);
		const scores = { [JEV_PROBE_PROPOSITION_ID]: 0.95, test_asserts_behavior: 0.2 };
		const { impl, calls } = stubFetch(() => jsonResponse(noulMany(scores)));
		const first = await diskGate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(first.audit.cache).toBe("miss");
		const second = await diskGate(impl).evaluate({ state: STATE, questions: two, apiKey: SYNTHETIC_KEY });
		expect(calls).toHaveLength(2);
		expect(second.audit.cache).toBe("miss");
		expect(second.checks).toEqual(scores);
		// 两个命题集合现在各有自己的条目：两边都能命中。
		const again = await diskGate(impl).evaluate({ state: STATE, questions: two, apiKey: SYNTHETIC_KEY });
		expect(again.audit.cache).toBe("disk");
	});

	it("diskHits 单独计数，cacheHits 仍是 hit + disk 之和", async () => {
		let clock = 1_000_000;
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = diskGate(impl, { cacheTtlMs: 1_000 }, { now: () => clock, cacheTtlMs: 1_000 });
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY }); // miss（网络）
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY }); // 内存 hit
		clock += 5_000;
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY }); // 磁盘 hit
		expect(calls).toHaveLength(1);
		expect(g.snapshotStatus()).toMatchObject({ total: 3, cacheHits: 2, diskHits: 1, approve: 3 });
		// diskHits 必须能从事件缓冲单独取出来（设置面板/CLI 的「磁盘命中」就是它）。
		expect(g.recentEvents().filter((e) => e.cache === "disk")).toHaveLength(1);
	});
});

/**
 * 真实样本（samplesPath）：一周后拿真实样本校准阈值/判据的**唯一**内容来源。
 * 全部用 mkdtempSync 隔离的临时文件，零真实网络。
 * @CONTRACT 只记**真实调用**（cache=miss）：缓存命中/磁盘回放、单飞的后续参与者、
 *   以及还没出网就被拒的（未启用/未配凭据/限频）都不记；采样绝不改变判定。
 */
describe("JevGate — 真实样本（samplesPath）", () => {
	let dir = "";
	let samplesPath = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jev-gate-samples-"));
		samplesPath = jevSamplesPath(dir);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const sampleGate = (
		impl: typeof fetch,
		overrides: Partial<JevGateConfig> = {},
		extra: { now?: () => number; samplesPath?: string | null; cachePath?: string | null; cacheTtlMs?: number } = {},
	): JevGate =>
		new JevGate({
			fetchImpl: impl,
			config: config(overrides),
			now: extra.now,
			cacheTtlMs: extra.cacheTtlMs ?? overrides.cacheTtlMs ?? 300_000,
			cachePath: extra.cachePath ?? null,
			samplesPath: extra.samplesPath === undefined ? samplesPath : extra.samplesPath,
		});

	it("真实调用（miss）落一条样本：原始 state 文本 + cacheKey 摘要 + 来源/命题/分数", async () => {
		// 两个键**故意逆序**：canonicalizeState 会按键名排序，样本要的是调用方传进来的原文。
		const state = { zeta: 1, alpha: 2 };
		const { impl } = stubFetch(() => jsonResponse(noul(0.95)));
		const decision = await sampleGate(impl).evaluate({
			state,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
			source: "tool",
		});
		expect(decision.outcome).toBe("approve");

		const { entries, skipped } = loadJevSamples(samplesPath);
		expect(skipped).toBe(0);
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;
		expect(entry.outcome).toBe("approve");
		expect(entry.source).toBe("tool");
		expect(entry.propositions).toEqual([JEV_PROBE_PROPOSITION_ID]);
		expect(entry.checks).toEqual({ [JEV_PROBE_PROPOSITION_ID]: 0.95 });
		expect(entry.model).toBe(defaultJevGateConfig().model);
		// 落盘的是**原始** state 文本（键顺序不限），不是 canonicalizeState 的结果。
		expect(entry.state).toBe('{"zeta":1,"alpha":2}');
		expect(entry.stateChars).toBe(entry.state.length);
		// stateHash 复用本次 cacheKey 的 sha256 摘要（不另算第二个摘要）。
		expect(entry.stateHash).toBe(cacheKey({ model: defaultJevGateConfig().model, questions: QUESTIONS, state }));
		expect(entry.error).toBeUndefined();
		// 样本 0600（同机其他用户不该读到你审过的代码）。
		expect(statSync(samplesPath).mode & 0o777).toBe(0o600);
	});

	it("缓存命中与磁盘回放都不再写样本（同一内容重放一百次也只是一个真相）", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		const cachePath = jevCachePath(dir);
		// 第一个进程：真实调用（miss）→ 1 条样本。
		const first = sampleGate(impl, {}, { cachePath });
		await first.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		// 同进程第二次 = 内存命中。
		const hit = await first.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		// 另一个进程同输入 = 磁盘回放（cache=disk）。
		const replayed = await sampleGate(impl, {}, { cachePath }).evaluate({
			state: STATE,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
		});

		expect([hit.audit.cache, replayed.audit.cache]).toEqual(["hit", "disk"]);
		expect(calls).toHaveLength(1);
		// 样本只跟着**真实调用**走：3 次 evaluate 里只有 1 条样本。
		expect(loadJevSamples(samplesPath).entries).toHaveLength(1);
	});

	it("失败调用也记（outcome=review + 错误码），坏掉不等于放行", async () => {
		const { impl } = stubFetch(() => jsonResponse({ error: "nope" }, 429));
		const decision = await sampleGate(impl).evaluate({
			state: STATE,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
			source: "cli",
		});
		expect(decision.outcome).toBe("review");
		expect(decision.errorCode).toBe("http-429");
		const entry = loadJevSamples(samplesPath).entries[0]!;
		expect(entry.outcome).toBe("review");
		expect(entry.source).toBe("cli");
		expect(entry.error?.code).toBe("http-429");
		expect(entry.checks).toEqual({});
	});

	it("还没出网就被拒的（未启用 / 未配凭据 / 限频）不留样本", async () => {
		const { impl, calls } = stubFetch(() => jsonResponse(noul(0.95)));
		await sampleGate(impl, { enabled: false }).evaluate({
			state: STATE,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
		});
		await sampleGate(impl).evaluate({ state: STATE, questions: QUESTIONS, apiKey: "" });
		expect(calls).toHaveLength(0);
		expect(existsSync(samplesPath)).toBe(false);

		// 限频：第一次真实调用记一条，紧接着的第二次被限频（没有请求、没有分数）不记。
		let clock = 1_000_000;
		const paced = sampleGate(impl, { minIntervalMs: 1_000 }, { now: () => clock });
		await paced.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		clock += 100;
		const limited = await paced.evaluate({ state: { diff: "other" }, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(limited.error).toContain("过于频繁");
		expect(loadJevSamples(samplesPath).entries).toHaveLength(1);
	});

	it("recordSamples=false（配置）或 recordSample=false（单次）都不写盘，判定照常", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.95)));
		const off = await sampleGate(impl, { recordSamples: false }).evaluate({
			state: STATE,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
		});
		expect(off.outcome).toBe("approve");
		const perCall = await sampleGate(impl).evaluate({
			state: STATE,
			questions: QUESTIONS,
			apiKey: SYNTHETIC_KEY,
			recordSample: false,
		});
		expect(perCall.outcome).toBe("approve");
		expect(existsSync(samplesPath)).toBe(false);
	});

	it("写盘失败（不可写路径）时判定仍照常返回，绝不因为采样而抛", async () => {
		const { impl } = stubFetch(() => jsonResponse(noul(0.95)));
		// /proc 下建不了目录：appendJevSample 内部兜住，evaluate 必须原样返回决策。
		const g = sampleGate(impl, {}, { samplesPath: "/proc/jev-no-such-dir/jev-samples.jsonl" });
		const decision = await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		expect(decision.outcome).toBe("approve");
		expect(decision.error).toBeUndefined();
		expect(g.snapshotStatus()).toMatchObject({ total: 1, approve: 1 });
	});

	it("snapshotStatus().reviewStatus：无样本时 pending 0 / due false；有样本时按 ack 与阈值判定", async () => {
		// ① 没有样本文件（含**未配置** samplesPath 的旧调用）→ 空状态，不抛。
		const noPath = new JevGate({ config: config() });
		expect(noPath.snapshotStatus().reviewStatus).toMatchObject({
			pending: 0,
			due: false,
			reason: null,
			oldestPendingAt: null,
			newestPendingAt: null,
			needsHumanLabel: 0,
			lastAckAt: null,
		});
		const empty = sampleGate(stubFetch(() => jsonResponse(noul(0.95))).impl);
		expect(empty.snapshotStatus().reviewStatus).toMatchObject({ pending: 0, due: false });

		// ② 一条样本 + 8 天后 → 到期（原因 = 等够时间，不是条数）。
		const at = 1_700_000_000_000;
		const { impl } = stubFetch(() => jsonResponse(noul(0.95)));
		const g = sampleGate(impl, {}, { now: () => at });
		await g.evaluate({ state: STATE, questions: QUESTIONS, apiKey: SYNTHETIC_KEY });
		const stale = g.reviewStatus(at + 8 * 24 * 60 * 60_000);
		expect(stale).toMatchObject({ pending: 1, due: true, reason: "age", needsHumanLabel: 0, lastAckAt: null });
		expect(stale.oldestPendingAt).toBe(at);
		expect(stale.thresholds).toMatchObject({ minEntries: 40 });

		// ③ ack 之后 pending 归零（ack 文件与样本文件同目录：这是 CLI 与服务端必须一致的那条契约）。
		expect(saveJevReviewAck(jevReviewAckPath(dir), at + 1)).toBe(true);
		expect(g.reviewStatus(at + 8 * 24 * 60 * 60_000)).toMatchObject({ pending: 0, due: false, lastAckAt: at + 1 });
	});
});
