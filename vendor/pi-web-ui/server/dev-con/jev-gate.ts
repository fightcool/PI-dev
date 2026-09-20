/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED jev-model.ts（配置/判定/缓存键/事件聚合）, jev-settings.ts（配置来源）,
 *            channel-accounts.ts（复用的有界 fetchJson）, ../agent-service.ts（唯一装配处）
 *   @CONTRACT 本层只负责「发一次有界请求 + 把答案归一化成三态 + 记账」：
 *             不读盘、不解析密钥（apiKey 由调用方解析后传入），密钥正文绝不进入
 *             任何返回值/事件/错误文本。
 *   @WHY 门禁是**可选增强**，绝不能成为编码路径的故障点：任何失败（超时/限流/缺答/
 *        越界/内部异常）都在 evaluate 内部被捕获，统一返回 outcome:"review" + 明确 error。
 *        绝不降级为 approve —— 门禁坏了是「转人工」，不是「放行」。
 *   @GOTCHA 只有「拿到全部命题的 0..1 分数」才算一次有效决策：缺答（answers 里没有该
 *        命题 / type !== "noul"）与越界（非数字或不在 0..1）必须失败，不能补 0、不能猜。
 *   @ASSUME 请求/响应形状按需求给定：请求 `{model, state, questions}`，响应
 *         `answers[name] = {type:"noul", noul: 0..1}`（外加可选的 id/model/provider/usage）。
 *         本仓库无法在离线单测里验证 alpha 接口的真实形状——因此解析器对未知字段容忍、
 *         对缺失字段**一律报错**（宁可不放行，也不猜），UI 的「测试连接」就是验证入口。
 *   @MAGIC MAX_BODY_BYTES=64KiB（复用 fetchJson 的上限）/ 事件环形缓冲 200 / 缓存上限 200。
 * ──────────────────────────────────────────────────
 */
import { fetchJson } from "./channel-accounts.js";
import {
	JEV_PROVIDER_ID,
	aggregateJevStatus,
	cacheKey,
	decideOutcome,
	defaultJevGateConfig,
	normalizeJevDecisionEvent,
	questionNamesOf,
	type JevDecisionEvent,
	type JevGateConfig,
	type JevOutcome,
	type JevRuntimeStatus,
} from "./jev-model.js";

/** 事件环形缓冲容量（内存态，进程内可观测）。 */
export const JEV_EVENT_CAPACITY = 200;
/** @MAGIC 决策缓存条数上限：state 不可预测地多，不设上限就是内存泄漏。 */
export const JEV_CACHE_MAX_ENTRIES = 200;

/** 归一化错误（用户可见文案中文 + errorEn 英文；不含任何密钥内容）。 */
export interface JevGateError {
	code: string;
	error: string;
	errorEn: string;
}

export interface JevDecisionAudit {
	requestId?: string;
	model?: string;
	provider?: string;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	elapsedMs: number;
	cache: "hit" | "miss";
}

export interface JevDecision {
	outcome: JevOutcome;
	reason: string;
	reasonEn: string;
	checks: Record<string, number>;
	audit: JevDecisionAudit;
	/** 非空 = 这次不是有效决策（outcome 必为 review）。 */
	error?: string;
	errorEn?: string;
}

export interface JevEvaluateInput {
	/** 被审查的内容（原样放进请求体 state 字段；本地不做任何判定）。 */
	state: unknown;
	/** 命题负载（buildJevQuestions 的产物）；决定必须被回答的命题名。 */
	questions: unknown;
	/** 密钥正文：只用于本次请求头，绝不落盘/回显/进事件。 */
	apiKey: string;
	/** 调用方的取消信号（与超时叠加）。 */
	signal?: AbortSignal;
}

/** 构造选项逐字对标 AccountRegistryOptions（见 channel-accounts.ts）。 */
export interface JevGateOptions {
	timeoutMs?: number;
	cacheTtlMs?: number;
	minIntervalMs?: number;
	now?: () => number;
	/** 测试注入；默认全局 fetch。 */
	fetchImpl?: typeof fetch;
	/** 初始配置（缺省默认值）；运行期由 applyConfig 更新。 */
	config?: JevGateConfig;
	/** 最近决策事件的环形缓冲容量。 */
	eventCapacity?: number;
}

interface CacheEntry {
	at: number;
	decision: JevDecision;
}

/**
 * Jev 决策门禁执行器：有界 HTTP + TTL 缓存 + 单飞去重 + 最小间隔限频 + 事件计数。
 * @CONTRACT 所有外部调用都是「一次尝试、绝不重试」：重试会把限流放大成雪崩，
 *   而门禁失败本来就该转人工。
 */
export class JevGate {
	private readonly now: () => number;
	private readonly fetchImpl: typeof fetch;
	private readonly eventCapacity: number;
	private configValue: JevGateConfig;
	/** key → {at, decision}（只存**成功**的决策：失败结果绝不进缓存）。 */
	private readonly cache = new Map<string, CacheEntry>();
	/** key → 进行中的调用（同 key 并发只打一次付费接口）。 */
	private readonly inFlight = new Map<string, Promise<JevDecision>>();
	private readonly events: JevDecisionEvent[] = [];
	private lastCallAt: number | null = null;

	constructor(opts: JevGateOptions = {}) {
		this.now = opts.now ?? (() => Date.now());
		this.fetchImpl = opts.fetchImpl ?? fetch;
		// 构造选项只是**初始配置的覆盖值**（对标 AccountRegistryOptions）：
		// 运行期唯一事实源是 config，保存新配置后立即生效（见 applyConfig）。
		const base = opts.config ?? defaultJevGateConfig();
		this.configValue = {
			...base,
			timeoutMs: opts.timeoutMs ?? base.timeoutMs,
			cacheTtlMs: opts.cacheTtlMs ?? base.cacheTtlMs,
			minIntervalMs: opts.minIntervalMs ?? base.minIntervalMs,
		};
		this.eventCapacity = Math.max(1, opts.eventCapacity ?? JEV_EVENT_CAPACITY);
	}

	/** 当前配置（副本，避免调用方改到内部状态）。 */
	config(): JevGateConfig {
		return {
			...this.configValue,
			credentialRef: this.configValue.credentialRef ? { ...this.configValue.credentialRef } : null,
			thresholds: { ...this.configValue.thresholds },
		};
	}

	/**
	 * 应用新配置（由保存成功后的调用方推送）。
	 * @CONTRACT 配置变了就清空缓存：改模型/改阈值后继续复用旧决策等于用旧标准放行。
	 */
	applyConfig(config: JevGateConfig): void {
		this.configValue = config;
		this.cache.clear();
	}

	/** 运行态聚合（内存态 + 环形事件缓冲）。 */
	snapshotStatus(): JevRuntimeStatus {
		return aggregateJevStatus(this.events);
	}

	/** 最近决策事件（副本，最新在后）；审计/排障用。 */
	recentEvents(): JevDecisionEvent[] {
		return this.events.map((event) => ({ ...event, checks: { ...event.checks } }));
	}

	/** 测试/维护用：清空缓存、限频游标与事件缓冲。 */
	reset(): void {
		this.cache.clear();
		this.inFlight.clear();
		this.events.length = 0;
		this.lastCallAt = null;
	}

	/**
	 * 评估一次决策。**永不抛异常**（见头部 @WHY）。
	 * @CONTRACT 返回的 outcome 只有三种：
	 *   - approve/block 来自真实分数；
	 *   - review 要么是真实分数落在中间段，要么是**任何失败**（此时 error 非空）。
	 */
	async evaluate(input: JevEvaluateInput): Promise<JevDecision> {
		const startedAt = this.now();
		try {
			return await this.run(input, startedAt);
		} catch (err) {
			// 兜底：任何未预期异常（含 JSON.stringify 循环引用）都变成 review + review 原因。
			return this.finish(
				this.review({
					code: "internal",
					error: `门禁内部错误：${(err as Error).message}`,
					errorEn: `Internal gate error: ${(err as Error).message}`,
				}),
				{ elapsedMs: this.now() - startedAt, cache: "miss" },
				{},
			);
		}
	}

	private async run(input: JevEvaluateInput, startedAt: number): Promise<JevDecision> {
		const config = this.configValue;
		if (!config.enabled) {
			return this.finish(
				this.review({ code: "disabled", error: "Jev 门禁未启用", errorEn: "The Jev gate is disabled" }),
				{ elapsedMs: this.now() - startedAt, cache: "miss" },
				{},
			);
		}
		if (!input.apiKey) {
			return this.finish(
				this.review({
					code: "missing-credential",
					error: "未配置可用的 Jev 凭据（请在门禁设置里选择密钥名）",
					errorEn: "No usable Jev credential (pick a key name in the gate settings)",
				}),
				{ elapsedMs: this.now() - startedAt, cache: "miss" },
				{},
			);
		}
		const names = questionNamesOf(input.questions);
		if (names.length === 0) {
			return this.finish(
				this.review({
					code: "no-questions",
					error: "没有可用的判定命题，无法得到决策",
					errorEn: "No usable propositions; the gate cannot produce a decision",
				}),
				{ elapsedMs: this.now() - startedAt, cache: "miss" },
				{},
			);
		}

		const key = cacheKey({ model: config.model, questions: input.questions, state: input.state });
		const cached = this.cache.get(key);
		if (cached && config.cacheTtlMs > 0 && startedAt - cached.at < config.cacheTtlMs) {
			// 缓存命中：结论复用，审计标明 hit，耗时记本次（不含网络）。
			// 命中同样进事件缓冲，否则运行态的「缓存命中数」永远是 0（假可观测）。
			const hit: JevDecision = {
				...cached.decision,
				checks: { ...cached.decision.checks },
				audit: { ...cached.decision.audit, elapsedMs: this.now() - startedAt, cache: "hit" },
			};
			this.record({ at: this.now(), result: hit, error: undefined });
			return hit;
		}

		const pending = this.inFlight.get(key);
		if (pending) {
			// 单飞去重：同一 key 的并发只打一次接口（后到者复用同一结果，含同一份审计）。
			return pending;
		}

		if (this.lastCallAt !== null && startedAt - this.lastCallAt < config.minIntervalMs) {
			// 限频：宁可转人工也不排队等待（等待会拖住编码路径）。
			// @CONTRACT 间隔按**发起时刻**计算（不是完成时刻）：慢调用不会额外抬高下一次的门槛。
			return this.finish(
				this.review({
					code: "rate-limited",
					error: `调用过于频繁（最小间隔 ${config.minIntervalMs}ms），本次转人工确认`,
					errorEn: `Called too frequently (min interval ${config.minIntervalMs}ms); needs human review`,
				}),
				{ elapsedMs: this.now() - startedAt, cache: "miss" },
				{},
			);
		}

		const promise = this.callUpstream(input, config, key, names, startedAt);
		this.inFlight.set(key, promise);
		try {
			return await promise;
		} finally {
			this.inFlight.delete(key);
		}
	}

	/** 真正的一次有界上游调用（失败返回 review，绝不抛出）。 */
	private async callUpstream(
		input: JevEvaluateInput,
		config: JevGateConfig,
		key: string,
		names: string[],
		startedAt: number,
	): Promise<JevDecision> {
		this.lastCallAt = startedAt;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.timeoutMs);
		const onAbort = (): void => controller.abort();
		input.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (input.signal?.aborted) controller.abort();
			const res = await fetchJson(
				this.fetchImpl,
				config.endpoint,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${input.apiKey}`,
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({ model: config.model, state: input.state, questions: input.questions }),
				},
				controller.signal,
			);
			const elapsedMs = this.now() - startedAt;
			if (!res.ok) {
				const failure = this.fetchFailure(res.kind, res.status, config.timeoutMs);
				return this.finish(this.review(failure), { elapsedMs, cache: "miss" }, {});
			}
			const parsed = this.parseAnswers(res.body, names);
			if ("failure" in parsed) {
				return this.finish(this.review(parsed.failure), { elapsedMs, cache: "miss" }, parsed.checks);
			}
			const decision = decideOutcome(parsed.checks, config.thresholds);
			const audit = this.auditOf(res.body, config, elapsedMs);
			const result: JevDecision = {
				outcome: decision.outcome,
				reason: decision.reason,
				reasonEn: decision.reasonEn,
				checks: parsed.checks,
				audit,
			};
			this.rememberDecision(key, startedAt, result);
			this.record({ at: this.now(), result, error: undefined });
			return result;
		} finally {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** fetchJson 的失败种类 → 双语归一化错误（不转发其账户查询语境的 error 文本）。 */
	private fetchFailure(kind: string | undefined, status: number, timeoutMs: number): JevGateError {
		switch (kind) {
			case "timeout":
				return {
					code: "timeout",
					error: `调用 Decisions 接口超时（${timeoutMs}ms）`,
					errorEn: `Decisions request timed out (${timeoutMs}ms)`,
				};
			case "network":
				return { code: "network", error: "无法连接 Decisions 接口", errorEn: "Cannot reach the Decisions endpoint" };
			case "redirect":
				return {
					code: "redirect",
					error: "Decisions 接口返回重定向，已按策略拒绝",
					errorEn: "The Decisions endpoint returned a redirect; refused by policy",
				};
			case "too-large":
				return {
					code: "too-large",
					error: "Decisions 接口响应体超出上限",
					errorEn: "The Decisions response body exceeded the size limit",
				};
			case "no-body":
				return { code: "no-body", error: "Decisions 接口无响应体", errorEn: "The Decisions response had no body" };
			case "not-json":
				return { code: "not-json", error: "Decisions 接口返回非 JSON", errorEn: "The Decisions response was not JSON" };
			default:
				break;
		}
		if (status === 401) {
			return {
				code: "http-401",
				error: "Decisions 接口鉴权失败（HTTP 401）",
				errorEn: "Decisions auth failed (HTTP 401)",
			};
		}
		if (status === 402) {
			return {
				code: "http-402",
				error: "Decisions 接口额度不足（HTTP 402）",
				errorEn: "Insufficient credits at the Decisions endpoint (HTTP 402)",
			};
		}
		if (status === 429) {
			return {
				code: "http-429",
				error: "Decisions 接口限流（HTTP 429）",
				errorEn: "Decisions rate limited (HTTP 429)",
			};
		}
		if (status >= 500) {
			return {
				code: "http-5xx",
				error: `Decisions 接口上游错误（HTTP ${status}）`,
				errorEn: `Decisions endpoint error (HTTP ${status})`,
			};
		}
		return {
			code: "http-error",
			error: `Decisions 接口返回 HTTP ${status}`,
			errorEn: `Decisions returned HTTP ${status}`,
		};
	}

	/**
	 * 校验并提取答案分数。
	 * @CONTRACT 每个被问到的命题都必须有 `answers[name] = {type:"noul", noul: 0..1}`：
	 *   缺答（缺条目 / type 不是 noul）与越界（非数字或不在 0..1）一律失败。
	 *   绝不把缺答补成 0/1，也绝不降级成 approve。
	 */
	private parseAnswers(
		body: unknown,
		names: string[],
	): { checks: Record<string, number> } | { failure: JevGateError; checks: Record<string, number> } {
		const root =
			body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
		const answersRaw = root?.answers;
		const answers =
			answersRaw !== null && typeof answersRaw === "object" && !Array.isArray(answersRaw)
				? (answersRaw as Record<string, unknown>)
				: null;
		if (!answers) {
			return {
				failure: {
					code: "missing-answer",
					error: `Decisions 接口未返回 answers（缺少命题：${names.join(", ")}）`,
					errorEn: `The Decisions response has no answers (missing: ${names.join(", ")})`,
				},
				checks: {},
			};
		}
		const checks: Record<string, number> = {};
		const missing: string[] = [];
		const outOfRange: string[] = [];
		for (const name of names) {
			const raw = answers[name];
			const answer =
				raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
			if (!answer || answer.type !== "noul") {
				missing.push(name);
				continue;
			}
			const score = typeof answer.noul === "number" && Number.isFinite(answer.noul) ? answer.noul : undefined;
			if (score === undefined || score < 0 || score > 1) {
				outOfRange.push(name);
				continue;
			}
			checks[name] = score;
		}
		if (missing.length > 0) {
			return {
				failure: {
					code: "missing-answer",
					error: `Decisions 接口未回答命题：${missing.join(", ")}`,
					errorEn: `The Decisions response did not answer: ${missing.join(", ")}`,
				},
				checks,
			};
		}
		if (outOfRange.length > 0) {
			return {
				failure: {
					code: "answer-out-of-range",
					error: `Decisions 接口返回的分数不在 0..1 区间：${outOfRange.join(", ")}`,
					errorEn: `The Decisions response returned scores outside 0..1: ${outOfRange.join(", ")}`,
				},
				checks,
			};
		}
		return { checks };
	}

	/** 审计元数据：只取 id/model/provider/usage/cost；取不到就是 undefined（不编造）。 */
	private auditOf(body: unknown, config: JevGateConfig, elapsedMs: number): JevDecisionAudit {
		const root =
			body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
		const usage =
			root.usage !== null && typeof root.usage === "object" && !Array.isArray(root.usage)
				? (root.usage as Record<string, unknown>)
				: {};
		const num = (...values: unknown[]): number | undefined => {
			for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
			return undefined;
		};
		const text = (...values: unknown[]): string | undefined => {
			for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
			return undefined;
		};
		const requestId = text(root.id, root.request_id, root.requestId);
		const model = text(root.model) ?? config.model;
		const provider = text(root.provider);
		const inputTokens = num(usage.prompt_tokens, usage.input_tokens, usage.inputTokens);
		const outputTokens = num(usage.completion_tokens, usage.output_tokens, usage.outputTokens);
		const cost = num(usage.cost, root.cost);
		const audit: JevDecisionAudit = { model, elapsedMs, cache: "miss" };
		if (requestId) audit.requestId = requestId;
		if (provider) audit.provider = provider;
		if (inputTokens !== undefined) audit.inputTokens = inputTokens;
		if (outputTokens !== undefined) audit.outputTokens = outputTokens;
		if (cost !== undefined) audit.cost = cost;
		return audit;
	}

	/** 失败决策：outcome 恒为 review + 明确错误（见头部 @WHY）。 */
	private review(failure: JevGateError): {
		outcome: JevOutcome;
		reason: string;
		reasonEn: string;
		failure: JevGateError;
	} {
		return { outcome: "review", reason: failure.error, reasonEn: failure.errorEn, failure };
	}

	/** 记录事件并返回决策（唯一出口，保证「有决策必有记账」）。 */
	private finish(
		reviewed: { outcome: JevOutcome; reason: string; reasonEn: string; failure: JevGateError },
		audit: JevDecisionAudit,
		checks: Record<string, number>,
	): JevDecision {
		const result: JevDecision = {
			outcome: reviewed.outcome,
			reason: reviewed.reason,
			reasonEn: reviewed.reasonEn,
			checks,
			audit,
			error: reviewed.failure.error,
			errorEn: reviewed.failure.errorEn,
		};
		this.record({ at: this.now(), result, error: reviewed.failure });
		return result;
	}

	private record(input: { at: number; result: JevDecision; error: JevGateError | undefined }): void {
		const { result } = input;
		const audit = result.audit;
		const event = normalizeJevDecisionEvent({
			at: input.at,
			outcome: result.outcome,
			checks: result.checks,
			model: audit.model ?? this.configValue.model,
			provider: audit.provider ?? JEV_PROVIDER_ID,
			requestId: audit.requestId ?? null,
			inputTokens: audit.inputTokens ?? 0,
			outputTokens: audit.outputTokens ?? 0,
			cost: audit.cost ?? 0,
			cache: audit.cache,
			elapsedMs: audit.elapsedMs,
			error: input.error,
		});
		if (!event) return;
		this.events.push(event);
		// 环形缓冲：超出容量丢最旧的（只保留最近的可观测窗口）。
		if (this.events.length > this.eventCapacity) this.events.splice(0, this.events.length - this.eventCapacity);
	}

	/** 只缓存成功决策（失败绝不进缓存，避免把一次网络抖动固化成一整段 TTL）。 */
	private rememberDecision(key: string, at: number, decision: JevDecision): void {
		if (this.configValue.cacheTtlMs <= 0) return;
		if (this.cache.size >= JEV_CACHE_MAX_ENTRIES) {
			let oldestKey: string | null = null;
			let oldestAt = Number.POSITIVE_INFINITY;
			for (const [k, entry] of this.cache) {
				if (entry.at < oldestAt) {
					oldestAt = entry.at;
					oldestKey = k;
				}
			}
			if (oldestKey !== null) this.cache.delete(oldestKey);
		}
		this.cache.set(key, { at, decision });
	}
}
