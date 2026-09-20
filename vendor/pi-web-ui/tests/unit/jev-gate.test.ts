/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-gate.ts
 * 📖 docs/DEV-CON-PROPOSAL.md §7（有界外部调用、失败转人工、可观测）
 * 全部用例注入 fetchImpl / now，**绝不真联网**：
 * 成功路径、缺答/越界必须失败、超时、非 JSON、体积超限、401/402/429、缓存命中、
 * 单飞去重、限频、失败不污染缓存也不把计数清零、密钥绝不出现在回显/诊断里。
 */
import { describe, expect, it } from "vitest";
import { JevGate } from "../../server/dev-con/jev-gate.js";
import {
	JEV_PROBE_PROPOSITION_ID,
	buildJevQuestions,
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
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			model: "typesafe/jev-1.13",
			state: STATE,
			questions: QUESTIONS,
		});
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
