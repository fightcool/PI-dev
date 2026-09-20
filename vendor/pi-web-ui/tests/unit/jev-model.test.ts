/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-model.ts
 * 📖 docs/DEV-CON-PROPOSAL.md §4（配置校验/回显清洗）、§7（判定与观测）
 * 纯逻辑单测：三态边界、配置校验与回显清洗、缓存键稳定性、命题注册表、运行聚合。
 * 合成密钥在运行时拼接（本仓库发布检查把 `sk-` + 24 字符以上的字面量判为疑似密钥）。
 */
import { describe, expect, it } from "vitest";
import {
	JEV_DEFAULT_ENDPOINT,
	JEV_DEFAULT_MODEL,
	JEV_PROPOSITIONS,
	JEV_STATE_NOT_EVIDENCE,
	aggregateJevStatus,
	cacheKey,
	canonicalizeState,
	decideOutcome,
	defaultJevGateConfig,
	normalizeJevDecisionEvent,
	propositionById,
	questionNamesOf,
	redactJevGateConfigForEcho,
	validateJevGateConfig,
	type JevDecisionEvent,
	type JevGateConfig,
} from "../../server/dev-con/jev-model.js";

/** 合成「明文密钥」：刻意拼出来而不是写字面量（见文件头说明）。 */
const SYNTHETIC_SECRET = ["sk", "TESTONLY", "0123456789abcdef0123"].join("-");

const THRESHOLDS = { approveAt: 0.9, blockAt: 0.1 };

function event(overrides: Partial<JevDecisionEvent>): JevDecisionEvent {
	return {
		at: 1_000,
		outcome: "approve",
		checks: { a: 0.95 },
		model: JEV_DEFAULT_MODEL,
		provider: "openrouter",
		requestId: null,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		cache: "miss",
		elapsedMs: 10,
		...overrides,
	};
}

describe("decideOutcome", () => {
	it("approves only when every check reaches the approve threshold (boundary included)", () => {
		const exactly = decideOutcome({ a: 0.9 }, THRESHOLDS);
		expect(exactly.outcome).toBe("approve");
		expect(exactly.failed).toEqual([]);

		const allHigh = decideOutcome({ a: 1, b: 0.99 }, THRESHOLDS);
		expect(allHigh.outcome).toBe("approve");
		expect(allHigh.reason).toContain("a=1");
	});

	it("blocks when any check is at or below the block threshold (boundary included)", () => {
		const exactly = decideOutcome({ a: 0.1 }, THRESHOLDS);
		expect(exactly.outcome).toBe("block");

		const withLow = decideOutcome({ a: 0.95, is_breaking_change: 0.02 }, THRESHOLDS);
		expect(withLow.outcome).toBe("block");
		// reason 必须列出 name=score 形式的失败项，且 failed 点名该判定项。
		expect(withLow.reason).toContain("is_breaking_change=0.02");
		expect(withLow.failed).toEqual(["is_breaking_change"]);
		expect(withLow.reasonEn).toContain("is_breaking_change=0.02");
	});

	it("falls back to review in the middle band", () => {
		const mid = decideOutcome({ a: 0.95, b: 0.5 }, THRESHOLDS);
		expect(mid.outcome).toBe("review");
		expect(mid.failed).toEqual(["b"]);
		expect(mid.reason).toContain("b=0.5");
	});

	it("never approves without evidence (empty checks / non-finite scores)", () => {
		expect(decideOutcome({}, THRESHOLDS).outcome).toBe("review");
		expect(decideOutcome({ a: Number.NaN }, THRESHOLDS).outcome).toBe("block");
	});
});

describe("validateJevGateConfig", () => {
	it("fills defaults for an empty object", () => {
		const result = validateJevGateConfig({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.endpoint).toBe(JEV_DEFAULT_ENDPOINT);
		expect(result.config.model).toBe(JEV_DEFAULT_MODEL);
		expect(result.config.thresholds).toEqual({ approveAt: 0.9, blockAt: 0.1 });
		expect(result.config.credentialRef).toBeNull();
	});

	it("rejects non-https endpoints with a bilingual error", () => {
		const result = validateJevGateConfig({ endpoint: "http://openrouter.ai/x" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("https");
		expect(result.errorEn).toContain("https");
	});

	it("rejects blockAt >= approveAt and out-of-range thresholds", () => {
		expect(validateJevGateConfig({ thresholds: { approveAt: 0.5, blockAt: 0.5 } }).ok).toBe(false);
		expect(validateJevGateConfig({ thresholds: { approveAt: 0.5, blockAt: 0.8 } }).ok).toBe(false);
		expect(validateJevGateConfig({ thresholds: { approveAt: 1.4, blockAt: 0.1 } }).ok).toBe(false);
		expect(validateJevGateConfig({ thresholds: { approveAt: 0.9, blockAt: -0.1 } }).ok).toBe(false);
	});

	it("rejects timeouts and cache TTLs outside the sane range", () => {
		expect(validateJevGateConfig({ timeoutMs: 10 }).ok).toBe(false);
		expect(validateJevGateConfig({ timeoutMs: 999_999 }).ok).toBe(false);
		expect(validateJevGateConfig({ cacheTtlMs: -1 }).ok).toBe(false);
		expect(validateJevGateConfig({ cacheTtlMs: 999_999_999 }).ok).toBe(false);
		expect(validateJevGateConfig({ minIntervalMs: "1" }).ok).toBe(false);
	});

	it("rejects empty model / endpoint and half-filled credential refs", () => {
		expect(validateJevGateConfig({ model: "   " }).ok).toBe(false);
		expect(validateJevGateConfig({ endpoint: "" }).ok).toBe(false);
		expect(validateJevGateConfig({ credentialRef: { providerId: "openrouter", keyName: "" } }).ok).toBe(false);
		expect(validateJevGateConfig({ credentialRef: { providerId: "", keyName: "密钥 1" } }).ok).toBe(false);
	});

	it("refuses literal secrets anywhere in the config", () => {
		const result = validateJevGateConfig({ endpoint: JEV_DEFAULT_ENDPOINT, apiKey: SYNTHETIC_SECRET });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("apiKey");
		expect(result.errorEn).toContain("literal secret");
		expect(result.error).not.toContain(SYNTHETIC_SECRET);
	});

	it("accepts a key NAME reference (names are not secrets)", () => {
		const result = validateJevGateConfig({ credentialRef: { providerId: "openrouter", keyName: "密钥 1" } });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.credentialRef).toEqual({ providerId: "openrouter", keyName: "密钥 1" });
	});
});

describe("redactJevGateConfigForEcho", () => {
	it("keeps only the credential name fields", () => {
		const config = { ...defaultJevGateConfig(), credentialRef: { providerId: "openrouter", keyName: "密钥 1" } };
		expect(redactJevGateConfigForEcho(config).credentialRef).toEqual({ providerId: "openrouter", keyName: "密钥 1" });
	});

	it("scrubs secret-shaped values and secret-shaped keys even in rogue fields", () => {
		const rogue = {
			...defaultJevGateConfig(),
			apiKey: SYNTHETIC_SECRET,
			credentialRef: { providerId: "openrouter", keyName: SYNTHETIC_SECRET },
			extra: { authorization: `Bearer ${SYNTHETIC_SECRET}` },
		} as unknown as JevGateConfig;
		const echoed = redactJevGateConfigForEcho(rogue);
		expect(echoed.credentialRef).toBeNull();
		expect(JSON.stringify(echoed)).not.toContain(SYNTHETIC_SECRET);
		expect(JSON.stringify(echoed)).not.toContain("apiKey");
		expect(JSON.stringify(echoed)).not.toContain("Bearer");
	});

	it("keeps the plain fields untouched", () => {
		const echoed = redactJevGateConfigForEcho(defaultJevGateConfig());
		expect(echoed).toEqual(defaultJevGateConfig());
	});
});

describe("canonicalizeState / cacheKey", () => {
	it("is independent of object key order", () => {
		expect(canonicalizeState({ b: 1, a: { d: 2, c: [3] } })).toBe(canonicalizeState({ a: { c: [3], d: 2 }, b: 1 }));
		const k1 = cacheKey({
			model: "m",
			questions: [{ name: "q", criteria: { true: "t", false: "f" } }],
			state: { b: 1, a: 2 },
		});
		const k2 = cacheKey({
			model: "m",
			questions: [{ name: "q", criteria: { false: "f", true: "t" } }],
			state: { a: 2, b: 1 },
		});
		expect(k1).toBe(k2);
	});

	it("changes when the state, model or propositions change", () => {
		const base = { model: "m", questions: [{ name: "q" }], state: "one" };
		expect(cacheKey(base)).not.toBe(cacheKey({ ...base, state: "two" }));
		expect(cacheKey(base)).not.toBe(cacheKey({ ...base, model: "m2" }));
		expect(cacheKey(base)).not.toBe(cacheKey({ ...base, questions: [{ name: "q2" }] }));
	});

	it("survives cyclic / non-JSON values without throwing", () => {
		const cyclic: Record<string, unknown> = { name: "loop" };
		cyclic.self = cyclic;
		const canonical = canonicalizeState({ cyclic, fn: () => 1, big: 1n, nan: Number.NaN });
		expect(canonical).toContain("loop");
		expect(canonical).toContain("depth-limit");
		expect(cacheKey({ model: "m", questions: [], state: cyclic })).toHaveLength(64);
	});
});

describe("JEV_PROPOSITIONS", () => {
	it("ships the three coding propositions with explicit injection guards", () => {
		expect(JEV_PROPOSITIONS.map((p) => p.id)).toEqual([
			"is_breaking_change",
			"test_asserts_behavior",
			"change_out_of_scope",
		]);
		for (const proposition of JEV_PROPOSITIONS) {
			expect(proposition.instructions.trim().length).toBeGreaterThan(0);
			// 官方 model-jaggedness：Jev 默认不把 state 当敌意输入 → 判定标准里必须显式声明。
			expect(proposition.criteria.true).toContain(JEV_STATE_NOT_EVIDENCE);
			expect(proposition.criteria.false).toContain(JEV_STATE_NOT_EVIDENCE);
			// 语义方向一致：true = 「是」，false = 「否」。
			expect(proposition.criteria.true.startsWith("是：")).toBe(true);
			expect(proposition.criteria.false.startsWith("否：")).toBe(true);
		}
	});

	it("resolves ids exactly and refuses unknown ones", () => {
		expect(propositionById("is_breaking_change")?.id).toBe("is_breaking_change");
		expect(propositionById("nope")).toBeNull();
		expect(propositionById("")).toBeNull();
	});

	it("extracts question names from arrays and records, and never invents them", () => {
		expect(questionNamesOf([{ name: "a" }, { id: "b" }, "c"])).toEqual(["a", "b", "c"]);
		expect(questionNamesOf({ a: {}, b: {} })).toEqual(["a", "b"]);
		expect(questionNamesOf(null)).toEqual([]);
		expect(questionNamesOf([{ nope: 1 }])).toEqual([]);
	});
});

describe("aggregateJevStatus", () => {
	it("counts outcomes, failures, tokens, cost and cache hits", () => {
		const status = aggregateJevStatus([
			event({ at: 1, outcome: "approve", inputTokens: 10, outputTokens: 2, cost: 0.01, elapsedMs: 100 }),
			event({ at: 2, outcome: "block", inputTokens: 20, outputTokens: 3, cost: 0.02, elapsedMs: 300 }),
			event({ at: 3, outcome: "review", cache: "hit", elapsedMs: 1 }),
			event({
				at: 4,
				outcome: "review",
				elapsedMs: 50,
				error: { code: "timeout", error: "超时", errorEn: "timed out" },
			}),
		]);
		expect(status).toMatchObject({
			total: 4,
			approve: 1,
			block: 1,
			review: 2,
			failed: 1,
			inputTokens: 30,
			outputTokens: 5,
			cacheHits: 1,
			avgElapsedMs: 113,
		});
		expect(status.cost).toBeCloseTo(0.03);
		expect(status.lastError).toMatchObject({ at: 4, code: "timeout" });
	});

	it("reports zeroed counters (and no error) for an empty history", () => {
		expect(aggregateJevStatus([])).toMatchObject({ total: 0, failed: 0, avgElapsedMs: 0, lastError: null });
	});

	it("skips malformed events instead of counting them", () => {
		const status = aggregateJevStatus([event({ at: 1 }), { at: 2 } as unknown as JevDecisionEvent]);
		expect(status.total).toBe(1);
	});
});

describe("normalizeJevDecisionEvent", () => {
	it("accepts a well-formed event and normalizes optional fields", () => {
		const normalized = normalizeJevDecisionEvent(event({ requestId: "req-1" }));
		expect(normalized).toMatchObject({ requestId: "req-1", cache: "miss", model: JEV_DEFAULT_MODEL });
	});

	it("rejects events missing the audit essentials", () => {
		expect(normalizeJevDecisionEvent(null)).toBeNull();
		expect(normalizeJevDecisionEvent({ outcome: "approve" })).toBeNull();
		expect(normalizeJevDecisionEvent({ at: 1, outcome: "maybe", cache: "miss", elapsedMs: 1 })).toBeNull();
		expect(normalizeJevDecisionEvent({ at: 1, outcome: "approve", cache: "half", elapsedMs: 1 })).toBeNull();
		expect(normalizeJevDecisionEvent({ at: 1, outcome: "approve", cache: "miss" })).toBeNull();
	});
});
