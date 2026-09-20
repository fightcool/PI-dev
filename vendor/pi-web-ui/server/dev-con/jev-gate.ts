/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED jev-model.ts（配置/判定/缓存键/事件聚合）, jev-settings.ts（配置来源）,
 *            jev-samples.ts（真实调用后落一条样本；唯一 hook 点，见 @GOTCHA）,
 *            jev-review.ts（复盘到期判定：snapshotStatus().review 带出去）,
 *            channel-accounts.ts（复用的有界 fetchJson）, ../agent-service.ts（唯一装配处）
 *   @CONTRACT 本层只负责「发一次有界请求 + 把答案归一化成三态 + 记账」：
 *             不读盘、不解析密钥（apiKey 由调用方解析后传入），密钥正文绝不进入
 *             任何返回值/事件/错误文本。
 *   @WHY 门禁是**可选增强**，绝不能成为编码路径的故障点：任何失败（超时/限流/缺答/
 *        越界/内部异常）都在 evaluate 内部被捕获，统一返回 outcome:"review" + 明确 error。
 *        绝不降级为 approve —— 门禁坏了是「转人工」，不是「放行」。
 *   @GOTCHA 只有「拿到全部命题的 0..1 分数」才算一次有效决策：缺答（answers 里没有该
 *        命题 / type !== "noul"）与越界（非数字或不在 0..1）必须失败，不能补 0、不能猜。
 *   @ASSUME 请求/响应形状已用真实密钥验证（2026-09-20）：请求
 *         `{model, state, questions}`（questions 是 **record**，value 带 `type:"noul"`），
 *         响应 `answers[name] = {type:"noul", noul: 0..1}`（外加 id/model/provider/usage）。
 *         解析器对未知字段容忍、对缺失字段**一律报错**（宁可不放行，也不猜）。
 *   @BUGFIX 2026-09-20: 首次真实联网即 400（questions 写成数组 + 缺 type 判别字段）；
 *            fix: buildJevQuestions 已改为 record + type（单一事实源，CLI/Web 共用）。
 *            同时让失败文案带上游错误正文（否则 alpha 接口的 400 无法排障）。
 *   @COUPLED jev-cache.ts（持久决策缓存：CI 确定性回放的第二级缓存，派生可丢）。
 *   @GOTCHA 样本只在**真实调用（cache=miss）**的那一次记（`captureSample`）——
 *         缓存命中/磁盘回放、单飞的后续参与者、以及还没出网就被拒的（未启用/未配凭据/
 *         无限题/限频）都不记：同一内容重放一百次也只有一个真相，
 *         而没出网的拒绝既无分数也无内容，记下来只会把「待复盘」条数变成噪声。
 *   @GOTCHA 采样绝不参与判定：写在决策对象构造完之后、走 appendJevSample（内部兜住异常）。
 *   @PERF snapshotStatus() 每次都读一遍样本文件做到期判定（上限 2000 条 / 8 MiB，毫秒级）：
 *         它只在「会话 ready」与「刚发生决策」时被调用，不在热路径上。
 *   @MAGIC MAX_BODY_BYTES=64KiB（复用 fetchJson 的上限）/ 事件环形缓冲 200 / 缓存上限 200 /
 *         磁盘缓存 8MiB 轮转 + 20_000 条（见 jev-cache.ts）。
 * ──────────────────────────────────────────────────
 */
import { dirname, join } from "node:path";
import { fetchJson } from "./channel-accounts.js";
import {
	appendJevSample,
	captureJevSample,
	loadJevReviewAck,
	loadJevSamples,
	type JevSampleSource,
} from "./jev-samples.js";
import { reviewStatus as computeReviewStatus, type JevReviewStatus } from "./jev-review.js";
import {
	JEV_CACHE_MAX_ENTRIES as JEV_DISK_MAX_ENTRIES,
	JEV_CACHE_VERSION,
	appendJevCacheEntry,
	cacheEntryMatches,
	capJevCacheEntries,
	loadJevCache,
	type JevCacheAudit,
	type JevCacheEntry,
} from "./jev-cache.js";
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
/**
 * @MAGIC 磁盘镜像的修剪余量：到上限后每多这么多条才重建一次（摊薄排序成本）。
 * 镜像丢掉的条目仍在磁盘上，最坏代价是重启前多花一次调用。
 */
const DISK_MIRROR_SLACK = 256;

/** 归一化错误（用户可见文案中文 + errorEn 英文；不含任何密钥内容）。 */
export interface JevGateError {
	code: string;
	error: string;
	errorEn: string;
}

/** @MAGIC 上游错误正文的展示上限：错误文案只用于排障，不承载完整响应体。 */
const JEV_ERROR_DETAIL_MAX = 300;

/**
 * 清洗上游错误正文后拼进错误文案。
 * @CONTRACT 先抹掉**本次密钥**（上游不该回显密钥，但这是出网文案，不能指望上游）；
 *   再去掉换行/多余空白并截断到 JEV_ERROR_DETAIL_MAX。
 * @WHY alpha 接口的 400 只给状态码等于无法排障：实测形状错时，正文（zod 报错）才是唯一线索。
 */
function sanitizeUpstreamDetail(detail: string | undefined, apiKey: string): string | undefined {
	if (!detail) return undefined;
	let text = apiKey ? detail.split(apiKey).join("***") : detail;
	text = text.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return text.length > JEV_ERROR_DETAIL_MAX ? `${text.slice(0, JEV_ERROR_DETAIL_MAX)}…` : text;
}

export interface JevDecisionAudit {
	requestId?: string;
	model?: string;
	provider?: string;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	elapsedMs: number;
	/** hit=进程内 TTL 缓存；disk=磁盘持久缓存（CI 回放靠它）；miss=真实调用。 */
	cache: "hit" | "disk" | "miss";
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
	/**
	 * 失败的错误码（`error` 非空时必定有值；与决策事件里的 code 同源）。
	 * @WHY 复盘时要能把「转人工」按原因分类（超时/限流/缺答/越界是完全不同的问题）。
	 */
	errorCode?: string;
}

export interface JevEvaluateInput {
	/**
	 * 被审查的内容（原样放进请求体 state 字段；本地不做任何判定）。
	 * @CONTRACT state 只参与 cacheKey 的哈希，**绝不落盘**（磁盘缓存里只有摘要，见 jev-cache.ts）。
	 *   @GOTCHA 唯一的例外在样本里（jev-samples.ts）：recordSamples=true 时把**原始 state**
	 *   （截断 + 密钥形状检测后）写进样本文件——那是「一周后拿真实样本复盘」的唯一内容来源。
	 */
	state: unknown;
	/** 命题负载（buildJevQuestions 的产物）；决定必须被回答的命题名。 */
	questions: unknown;
	/** 密钥正文：只用于本次请求头，绝不落盘/回显/进事件。 */
	apiKey: string;
	/** 调用方的取消信号（与超时叠加）。 */
	signal?: AbortSignal;
	/**
	 * false = 强制新鲜判定：内存与磁盘缓存都不读、本次结果也不写（CLI 的 --no-cache）。
	 * @WHY 排障/验证上游时必须能绕过缓存，否则「看起来通过」可能只是一周前的那次答案。
	 */
	useCache?: boolean;
	/**
	 * 本次决策从哪里发起（复盘时区分 agent 主动问的与脚本/CI 跑的）；默认 "unknown"。
	 */
	source?: JevSampleSource;
	/**
	 * false = 本次**不写样本**（默认写）。
	 * @WHY 取样只对「真实使用」有意义：`tune` 一次跑几十上百条**语料**，
	 *   把它们写进真实样本会把「一周真实使用」的口径整个淹掉（见 scripts/jev-gate.ts 的 runTune）。
	 * @CONTRACT 只影响采样，绝不影响判定；缓存命中/回放本来就不采。
	 */
	recordSample?: boolean;
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
	/**
	 * 持久决策缓存文件路径（jevCachePath(agentDir)）。
	 * @CONTRACT 不传/null = **关闭**磁盘缓存（测试与旧调用完全不受影响）。
	 */
	cachePath?: string | null;
	/**
	 * 样本文件路径（jevSamplesPath(agentDir)）。
	 * @CONTRACT 不传/null = **关闭**采样（测试与旧调用完全不受影响）。
	 *   samplePath 的目录同时也是复盘确认文件（jev-review.json）的目录（见 reviewAckPathOf）。
	 */
	samplesPath?: string | null;
}

/**
 * 复盘确认文件的路径：与样本文件**同目录**（`<agentDir>/dev-con/jev-review.json`）。
 * @WHY 由 samplesPath 推出来，而不是再要一个 options 字段：两者必须成对指向同一个 agentDir，
 *   分开传就给了「服务端读 A 目录的样本、CLI 写 B 目录的 ack」这种静默错配一个机会。
 */
function reviewAckPathOf(samplesPath: string): string {
	return join(dirname(samplesPath), "jev-review.json");
}

/** 原始 state 文本（能 JSON.stringify 就 stringify 原对象；拿不到就空串）。
 *  @CONTRACT **不是** canonicalizeState：样本要的是调用方本来传进来的那份文本（键顺序不限），
 *    规范化只属于 cacheKey 的领域。 */
function rawStateText(state: unknown): string {
	if (typeof state === "string") return state;
	try {
		const text = JSON.stringify(state);
		return typeof text === "string" ? text : "";
	} catch {
		return "";
	}
}

/**
 * 运行态 + 样本复盘状态：Agent 回执/底栏一次拿全（一个时间戳、一次读盘）。
 * @GOTCHA 字段叫 `reviewStatus`，**不能**叫 `review`：`JevRuntimeStatus.review` 已经是
 *   「结论为转人工的**调用条数**」（三态计数之一，UI 运行卡片与 e2e 都在读它）。
 *   一个是计数、一个是复盘状态，同名就变成两个意思共用一个字段。
 */
export interface JevGateRuntimeStatus extends JevRuntimeStatus {
	reviewStatus: JevReviewStatus;
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
	/** 磁盘决策缓存的路径（null = 关闭）。 */
	private readonly cachePath: string | null;
	/** 样本文件路径（null = 关闭采样）。 */
	private readonly samplesPath: string | null;
	/** 复盘确认文件路径（null = 没有样本，也就没有复盘状态）。 */
	private readonly reviewAckPath: string | null;
	/** 惰性加载的磁盘缓存镜像（key → entry）；useCache:false 时连读都不读。 */
	private diskMirror: Map<string, JevCacheEntry> | null = null;

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
		this.cachePath = opts.cachePath ?? null;
		this.samplesPath = opts.samplesPath ?? null;
		this.reviewAckPath = this.samplesPath ? reviewAckPathOf(this.samplesPath) : null;
	}

	/** 当前配置（**深**副本，避免调用方改到内部状态：perProposition 是嵌套对象，浅拷会漏）。 */
	config(): JevGateConfig {
		const per = this.configValue.thresholds.perProposition;
		return {
			...this.configValue,
			credentialRef: this.configValue.credentialRef ? { ...this.configValue.credentialRef } : null,
			thresholds: {
				...this.configValue.thresholds,
				...(per ? { perProposition: Object.fromEntries(Object.entries(per).map(([id, e]) => [id, { ...e }])) } : {}),
			},
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

	/** 运行态聚合（内存态 + 环形事件缓冲 + 样本复盘状态）。 */
	snapshotStatus(): JevGateRuntimeStatus {
		return { ...aggregateJevStatus(this.events), reviewStatus: this.reviewStatus() };
	}

	/**
	 * 样本复盘状态：读样本 + 上次确认时间，算「该不该拿真实样本回看」。
	 * @CONTRACT 读盘失败/未配置样本路径一律返回**空状态**（pending 0 / due false），绝不抛 ——
	 *   它是回执的一部分，不能因为一个统计文件把状态推送搞崩（对标 appendJevSample 的尽力而为）。
	 */
	reviewStatus(now?: number): JevReviewStatus {
		const at = now ?? this.now();
		const path = this.samplesPath;
		const ackPath = this.reviewAckPath;
		if (!path || !ackPath) {
			// 空状态也走同一个纯函数，阈值口径只有一个（不手写第二份默认值）。
			return computeReviewStatus([], { lastAckAt: null, now: at });
		}
		try {
			const { entries } = loadJevSamples(path);
			const ack = loadJevReviewAck(ackPath);
			return computeReviewStatus(entries, { lastAckAt: ack?.lastAckAt ?? null, now: at });
		} catch {
			return computeReviewStatus([], { lastAckAt: null, now: at });
		}
	}

	/** 最近决策事件（副本，最新在后）；审计/排障用。 */
	recentEvents(): JevDecisionEvent[] {
		return this.events.map((event) => ({ ...event, checks: { ...event.checks } }));
	}

	/** 测试/维护用：清空缓存、限频游标与事件缓冲（磁盘镜像只丢弃、**不删文件**）。 */
	reset(): void {
		this.cache.clear();
		this.inFlight.clear();
		this.events.length = 0;
		this.lastCallAt = null;
		this.diskMirror = null;
	}

	/** 磁盘缓存可用吗（未配置路径 = 关闭；cacheTtlMs=0 = 「不缓存」，两份都关）。 */
	private diskEnabled(): boolean {
		return this.cachePath !== null && this.configValue.cacheTtlMs > 0;
	}

	/** 磁盘缓存镜像（首次访问才读盘；读盘失败 loadJevCache 已兜底为空表）。 */
	private diskCache(): Map<string, JevCacheEntry> {
		if (!this.diskMirror) this.diskMirror = this.cachePath ? loadJevCache(this.cachePath) : new Map();
		return this.diskMirror;
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
		// useCache:false = 两级缓存都不读（排障/验证上游时的强制新鲜判定）。
		const useCache = input.useCache !== false;
		const cached = useCache ? this.cache.get(key) : undefined;
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

		if (useCache && this.diskEnabled()) {
			const entry = this.diskCache().get(key);
			// 同构校验（model + 命题集合）：错配的旧条目必须当 miss，不能当答案。
			if (entry && cacheEntryMatches(entry, config.model, names)) {
				// @WHY 只复用**分数**，结论用**当前**阈值重算：阈值改了之后旧答案不会被旧标准放行。
				const decision = decideOutcome(entry.checks, config.thresholds);
				const diskHit: JevDecision = {
					outcome: decision.outcome,
					reason: decision.reason,
					reasonEn: decision.reasonEn,
					checks: { ...entry.checks },
					audit: { ...entry.audit, elapsedMs: this.now() - startedAt, cache: "disk" },
				};
				this.record({ at: this.now(), result: diskHit, error: undefined });
				return diskHit;
			}
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
			const decision = await promise;
			// 只有**发起者**（真正打了一次接口的那位）到这里：单飞的其它参与者拿的是同一个结论，
			// 记第二次就是把一次真相数成两次（见头部 @GOTCHA）。
			this.captureSample(input, decision, key, names);
			return decision;
		} finally {
			this.inFlight.delete(key);
		}
	}

	/**
	 * 把一次真实决策（cache=miss）写成样本：截断 + 密钥形状检测由 captureJevSample 负责。
	 * @CONTRACT ① 决策**已经算完**才调用；② 任何失败都静默（appendJevSample 内部兜住），
	 *   采样绝不能改变判定结果、也不能把异常抛回编码路径。
	 *   ③ stateHash 复用本次 cacheKey（sha256 摘要），不另算第二个摘要。
	 */
	private captureSample(input: JevEvaluateInput, decision: JevDecision, key: string, names: readonly string[]): void {
		const path = this.samplesPath;
		if (!path || !this.configValue.recordSamples) return;
		if (input.recordSample === false) return;
		if (decision.audit.cache !== "miss") return;
		try {
			appendJevSample(
				path,
				captureJevSample({
					at: this.now(),
					state: rawStateText(input.state),
					propositions: names,
					checks: decision.checks,
					outcome: decision.outcome,
					reason: decision.reason,
					reasonEn: decision.reasonEn,
					source: input.source ?? "unknown",
					model: decision.audit.model ?? this.configValue.model,
					stateHash: key,
					error: decision.error
						? {
								code: decision.errorCode ?? "unknown",
								error: decision.error,
								errorEn: decision.errorEn ?? "",
							}
						: undefined,
				}),
			);
		} catch {
			/* 采样尽力而为（见 @CONTRACT） */
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
				// 错误响应体只用于排障文案（见 sanitizeUpstreamDetail），它**不是**决策依据。
				{ captureErrorDetail: true },
			);
			const elapsedMs = this.now() - startedAt;
			if (!res.ok) {
				const failure = this.fetchFailure(res.kind, res.status, config.timeoutMs);
				return this.finish(
					this.review(this.withUpstreamDetail(failure, sanitizeUpstreamDetail(res.detail, input.apiKey))),
					{ elapsedMs, cache: "miss" },
					{},
				);
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
			if (input.useCache !== false) {
				this.rememberDecision(key, startedAt, result);
				this.rememberDecisionOnDisk(key, startedAt, result, config.model);
			}
			this.record({ at: this.now(), result, error: undefined });
			return result;
		} finally {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** 附加上游错误正文（拿不到就原样返回）：只改文案，不改错误种类/三态。 */
	private withUpstreamDetail(failure: JevGateError, detail: string | undefined): JevGateError {
		if (!detail) return failure;
		return {
			code: failure.code,
			error: `${failure.error}（上游：${detail}）`,
			errorEn: `${failure.errorEn} (upstream: ${detail})`,
		};
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
			errorCode: reviewed.failure.code,
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

	/**
	 * 把一次**成功**判定写进磁盘缓存（派生、可丢：失败静默，绝不阻塞判定）。
	 * @CONTRACT 只有 `error` 为空且 `checks` 非空才写：超时/401/限流/缺答一律不落盘，
	 *   否则一次网络抖动会被固化成「以后都算它」。
	 * @GOTCHA 写进去的只有 cacheKey 摘要 + 元数据 + 分数：state、密钥、被审文本都不落盘。
	 */
	private rememberDecisionOnDisk(key: string, at: number, decision: JevDecision, model: string): void {
		if (!this.cachePath || !this.diskEnabled()) return;
		if (decision.error || Object.keys(decision.checks).length === 0) return;
		const audit: JevCacheAudit = { elapsedMs: decision.audit.elapsedMs };
		if (decision.audit.requestId) audit.requestId = decision.audit.requestId;
		if (decision.audit.model) audit.model = decision.audit.model;
		if (decision.audit.provider) audit.provider = decision.audit.provider;
		if (decision.audit.inputTokens !== undefined) audit.inputTokens = decision.audit.inputTokens;
		if (decision.audit.outputTokens !== undefined) audit.outputTokens = decision.audit.outputTokens;
		if (decision.audit.cost !== undefined) audit.cost = decision.audit.cost;
		const entry: JevCacheEntry = {
			v: JEV_CACHE_VERSION,
			key,
			at,
			model,
			outcome: decision.outcome,
			checks: { ...decision.checks },
			audit,
		};
		// 镜像同步更新（同一进程里的下一次同 key 调用即可命中，不必等重新读盘）。
		// `JEV_CACHE_MAX_ENTRIES`（200）是**内存 TTL 缓存**的上限；磁盘那一份叫 `JEV_DISK_MAX_ENTRIES`
		// （20_000，与磁盘文件同口径）。两者不是一个东西，不要互相顶替。
		this.rememberInDiskMirror(key, entry);
		appendJevCacheEntry(this.cachePath, entry);
	}

	/** 镜像写入 + 有界修剪（长期运行的实例不能因为 state 多样而无限长内存）。 */
	private rememberInDiskMirror(key: string, entry: JevCacheEntry): void {
		const mirror = this.diskCache();
		mirror.set(key, entry);
		if (mirror.size > JEV_DISK_MAX_ENTRIES + DISK_MIRROR_SLACK) {
			this.diskMirror = capJevCacheEntries(mirror.values());
		}
	}
}
