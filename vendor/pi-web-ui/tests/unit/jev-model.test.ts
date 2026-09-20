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
	JEV_PROBE_PROPOSITION_ID,
	JEV_STATE_NOT_EVIDENCE,
	aggregateJevStatus,
	buildJevQuestions,
	cacheKey,
	canonicalizeState,
	decideOutcome,
	defaultJevGateConfig,
	formatJevProse,
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

		const withLow = decideOutcome({ a: 0.95, change_preserves_public_api: 0.02 }, THRESHOLDS);
		expect(withLow.outcome).toBe("block");
		// reason 必须列出 name=score 形式的失败项，且 failed 点名该判定项。
		expect(withLow.reason).toContain("change_preserves_public_api=0.02");
		expect(withLow.failed).toEqual(["change_preserves_public_api"]);
		expect(withLow.reasonEn).toContain("change_preserves_public_api=0.02");
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
			"change_preserves_public_api",
			"test_asserts_behavior",
			"change_within_task_scope",
		]);
		for (const proposition of JEV_PROPOSITIONS) {
			expect(formatJevProse(proposition.instructions).trim().length).toBeGreaterThan(0);
			// 官方 model-jaggedness：Jev 默认不把 state 当敌意输入 → 判定标准里必须显式声明。
			// 判据现在是结构化的（{what, examples}）：声明收在 what 里，渲染出来仍须在场。
			expect(formatJevProse(proposition.criteria.true)).toContain(JEV_STATE_NOT_EVIDENCE);
			expect(formatJevProse(proposition.criteria.false)).toContain(JEV_STATE_NOT_EVIDENCE);
			// 语义方向一致：true = 「是」，false = 「否」。模型输入文本是英文（官方：Jev 英文准确率最优）。
			expect(formatJevProse(proposition.criteria.true).startsWith("Yes:")).toBe(true);
			expect(formatJevProse(proposition.criteria.false).startsWith("No:")).toBe(true);
			// 送进模型的文本不得含中文：CJK 可用但不保证准确率。
			expect(
				`${formatJevProse(proposition.instructions)}${formatJevProse(proposition.criteria.true)}${formatJevProse(proposition.criteria.false)}`,
			).not.toMatch(/[\u4e00-\u9fff]/);
		}
	});

	it("phrases every proposition positively, because a high score means approve", () => {
		// @BUGFIX 2026-09-20：命题若写成缺陷式（true = 坏事），就与「高分→放行」方向相反——
		// 实测把破坏性变更判成 approve、把干净改动判成 block。新增命题必须遵守同一条：
		// true 侧必须是「好事」（安全 / 达标），所以 id 与 true 标准只能用正向措辞。
		const defectWording = /\b(breaking|out_of_scope|unsafe|violat|breaks)\b/i;
		for (const proposition of JEV_PROPOSITIONS) {
			expect(proposition.id).not.toMatch(defectWording);
			expect(formatJevProse(proposition.criteria.true)).not.toMatch(defectWording);
		}
	});

	it("pins the boundary cases the 2026-09-20 calibration run exposed", () => {
		// @WHY docs/JEV-DECISION-GATE.md §4.2：纯文本判据下，弱断言拿到 0.89–0.94，
		// 与合格断言完全重叠——该轮证明「拧阈值救不了」，只能把边界写进判据。
		// 下列四条政策必须一直显式在场；删掉任何一条都是把那次实测的教训丢了。
		const byId = (id: string) => propositionById(id)!;
		const testFalse = formatJevProse(byId("test_asserts_behavior").criteria.false);
		// 弱断言的具体形状（真实误放行样本用的就是这几种）必须在 false 侧逐一点名。
		for (const weak of ["toBeDefined", "toBeNull", "toHaveBeenCalled", "exists", "is truthy"]) {
			expect(testFalse).toContain(weak);
		}
		expect(testFalse).toContain("examples");

		const apiFalse = formatJevProse(byId("change_preserves_public_api").criteria.false);
		// 两条实测拿不准的政策：新增**必填**参数/prop = 破坏；改名已发布 id = 破坏。
		expect(apiFalse).toContain("REQUIRED");
		expect(apiFalse).toContain("renames");
		// 反向：新增可选参数仍算保持（避免矫枉过正把它判成破坏）。
		expect(formatJevProse(byId("change_preserves_public_api").criteria.true)).toContain("OPTIONAL");

		const scopeFalse = formatJevProse(byId("change_within_task_scope").criteria.false);
		// 顺带清理、无关修复、重排版都属于越界（实测这三类都被正确拦下，判据要继续写明）。
		for (const out of ["incidental refactor", "unrelated fix", "reformat"]) {
			expect(scopeFalse).toContain(out);
		}
	});

	it("pins the applicability rule on the test proposition (no test change ⇒ not a weak-test defect)", () => {
		// @BUGFIX 2026-09-20：命题问的是「新增/修改的测试是否断言具体行为」，但改动**根本不碰测试**时
		// 模型把「没有断言」答成「否」→ 实测 0.08 → 被 test 的阻断线（0.15）拦下：纯注释改动被判 block。
		// 根因是适用性没写进判据（不是阈值问题——再拧阈值也只能二选一）。
		// 修完后实测：纯注释改动 0.98（approve）；弱断言用例仍 0.14（block）；强断言 0.97（approve）。
		const test = propositionById("test_asserts_behavior")!;
		expect(formatJevProse(test.instructions)).toMatch(/no test code at all|does not apply/i);
		expect(formatJevProse(test.criteria.true)).toMatch(/does not apply/i);
		expect(formatJevProse(test.criteria.false)).toMatch(/only when the change did add or modify test code/i);
	});

	it("resolves ids exactly and refuses unknown ones", () => {
		expect(propositionById("change_preserves_public_api")?.id).toBe("change_preserves_public_api");
		expect(propositionById("nope")).toBeNull();
		expect(propositionById("")).toBeNull();
		// 退场的缺陷式 id 不得再存在（否则门禁方向又反了）。
		expect(propositionById("is_breaking_change")).toBeNull();
		expect(propositionById("change_out_of_scope")).toBeNull();
	});

	it("extracts question names from arrays and records, and never invents them", () => {
		expect(questionNamesOf([{ name: "a" }, { id: "b" }, "c"])).toEqual(["a", "b", "c"]);
		expect(questionNamesOf({ a: {}, b: {} })).toEqual(["a", "b"]);
		expect(questionNamesOf(null)).toEqual([]);
		expect(questionNamesOf([{ nope: 1 }])).toEqual([]);
	});
});

describe("buildJevQuestions", () => {
	// @BUGFIX 2026-09-20：真实 Decisions 接口用 zod 校验请求体，questions 必须是 record
	// （键=命题名），每个 value 带 `type` 判别字段；数组/缺 type 一律 400（实测）。
	it("builds the upstream record shape keyed by proposition name", () => {
		const questions = buildJevQuestions([JEV_PROBE_PROPOSITION_ID]);
		expect(Array.isArray(questions)).toBe(false);
		expect(Object.keys(questions)).toEqual([JEV_PROBE_PROPOSITION_ID]);
		expect(questions[JEV_PROBE_PROPOSITION_ID]).toEqual({
			type: "noul",
			// 判据现在可以是结构化文本（JevProse）：这里只钉「两项都在场」，逐字不变由下一条断言负责。
			instructions: expect.anything(),
			criteria: { true: expect.anything(), false: expect.anything() },
		});
		// record 的键必须与 questionNamesOf 读到的名字一致，否则缓存匹配与「缺答」判定会错位。
		expect(questionNamesOf(questions)).toEqual([JEV_PROBE_PROPOSITION_ID]);
	});

	it("sends the proposition text verbatim and never invents unknown ids", () => {
		const questions = buildJevQuestions(["change_preserves_public_api", "nope"]);
		expect(Object.keys(questions)).toEqual(["change_preserves_public_api"]);
		const source = JEV_PROPOSITIONS.find((p) => p.id === "change_preserves_public_api")!;
		expect(questions.change_preserves_public_api).toEqual({
			type: "noul",
			instructions: source.instructions,
			criteria: source.criteria,
		});
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
