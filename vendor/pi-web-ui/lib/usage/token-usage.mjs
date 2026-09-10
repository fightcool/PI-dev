/*
 * 🍞 AI Breadcrumb Navigation
 * Tag meanings: @COUPLED=linked files @CONTRACT=interface contract @GOTCHA=gotcha
 *               @WHY=design rationale @MAGIC=magic number
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../server/agent-service.ts (onEvent → record, buildLightState → snapshot)
 *   @COUPLED ../../tests/token-usage.test.mjs, ../../tests/environment.test.mjs
 *   📖 docs/DEV-CON-PROPOSAL.md §7（Token/费用口径）与 §9「用量身份」
 *   @CONTRACT record() 只接受 normalizeUsageEvent() 的输出；累计必须按「终态 + 消息身份去重」，
 *             流式 message_update 只更新 current（请求级视图），不得累加。
 *   @GOTCHA SDK 对同一条 assistant 消息会依次发 message_start(0)/多个 message_update/
 *           message_end/turn_end，且 message_update 的 usage 与流式对象共享引用；旧实现
 *           对每个事件都累加 → 同一条消息被记 N+2 次（DEV-CON P0 实测）。这里用
 *           message_end/turn_end 的终结值 + 身份去重修掉。
 *   @GOTCHA 字段名是 totalTokens / cacheRead / cacheWrite（pi-ai types.d.ts），
 *           不是 total_tokens；旧实现丢掉了缓存与费用。
 *   @MAGIC DEFAULT_USAGE_LIMITS.maxRequestTokens=128000: 单请求预算告警线（治理用）。
 */

export const DEFAULT_USAGE_LIMITS = Object.freeze({
  maxRequestTokens: 128_000,
  warnAtRatio: 0.7,
  compactAtRatio: 0.85,
  maxRunMs: 10 * 60_000,
});

/** 用量来源分类（§7：子代理、重试、压缩摘要、探测分别标注）。 */
export const USAGE_SOURCES = Object.freeze(["user", "retry", "subagent", "compaction", "vision", "review", "wizard", "probe", "system"]);

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

function addTokens(target, tokens) {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
  target.total += tokens.total;
  target.cost += tokens.cost;
}

function cloneTokens(tokens) {
  return { ...tokens };
}

/** 消息身份：优先 provider 响应 id，其次 role+timestamp（与 UI 消息 id 同源）。 */
function messageIdentity(message) {
  if (!message || typeof message !== "object") return null;
  if (typeof message.responseId === "string" && message.responseId) return `r:${message.responseId}`;
  if (typeof message.timestamp === "number") return `${message.role ?? "?"}:${message.timestamp}`;
  return null;
}

/**
 * 把 SDK 事件里的 usage 归一化成计账输入。
 * scope: "final" = 终结值（可累加）；"partial" = 流式中途值（只更新请求级视图）。
 */
export function normalizeUsageEvent(event) {
  const message = event?.message ?? event?.assistantMessageEvent?.message ?? null;
  const usage = event?.usage ?? message?.usage ?? event?.assistantMessageEvent?.usage;
  if (!usage) return null;
  const input = num(usage.input ?? usage.input_tokens ?? usage.prompt_tokens);
  const output = num(usage.output ?? usage.output_tokens ?? usage.completion_tokens);
  const cacheRead = num(usage.cacheRead ?? usage.cache_read_input_tokens ?? 0);
  const cacheWrite = num(usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0);
  const total = num(usage.totalTokens ?? usage.total ?? input + output + cacheRead + cacheWrite);
  const cost = num(usage.cost?.total ?? usage.cost ?? 0);
  const type = event?.type;
  const scope = type === "message_end" || type === "turn_end" ? "final" : "partial";
  return {
    scope,
    identity: messageIdentity(message),
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    cost,
    reasoning: Number.isFinite(usage.reasoning) ? usage.reasoning : undefined,
    provider: typeof message?.provider === "string" ? message.provider : undefined,
    modelId: typeof message?.model === "string" ? message.model : undefined,
    responseModel: typeof message?.responseModel === "string" ? message.responseModel : undefined,
    role: typeof message?.role === "string" ? message.role : undefined,
  };
}

/**
 * 请求/运行/会话三级用量。
 * - current: 最近一次 provider 请求（覆盖语义；流式期间即最新值）
 * - turn: 本次 run 的累计（终结值去重累加）
 * - cumulative: 本对话跨 run 累计（同一 tracker 生命周期内）
 * - attribution: 按 来源/渠道/模型 归组的累计（P2 归属）
 */
export class TokenUsageTracker {
  #current = emptyTokens();
  #turn = emptyTokens();
  #cumulative = emptyTokens();
  #finalized = new Set();
  #startedAt = null;
  #runSeq = 0;
  #runId = null;
  #requests = 0;
  #attribution = new Map();
  #lastError = null;

  constructor(limits = {}) {
    this.limits = { ...DEFAULT_USAGE_LIMITS, ...limits };
  }

  /** 开始一次 run（agent_start）。runId 用于快照与归属。 */
  startRun(now = Date.now()) {
    this.#startedAt = now;
    this.#turn = emptyTokens();
    this.#finalized.clear();
    this.#runSeq += 1;
    this.#runId = `run-${this.#runSeq}`;
    return this.snapshot(now);
  }

  get runId() {
    return this.#runId;
  }

  /**
   * 记一次用量事件。
   * @param normalized normalizeUsageEvent() 的输出
   * @param attribution 请求级归属 {source, channelId, credentialKeyName, modelId, providerId, bindingRevision, configRevision}
   */
  record(normalized, now = Date.now(), attribution = {}) {
    if (!normalized) throw new Error("record() expects normalizeUsageEvent() output");
    const tokens = {
      input: nonNegative(num(normalized.input), "input"),
      output: nonNegative(num(normalized.output), "output"),
      cacheRead: nonNegative(num(normalized.cacheRead), "cacheRead"),
      cacheWrite: nonNegative(num(normalized.cacheWrite), "cacheWrite"),
      total: nonNegative(num(normalized.total), "total"),
      cost: nonNegative(num(normalized.cost), "cost"),
    };
    this.#current = { ...tokens, scope: normalized.scope, provider: normalized.provider, modelId: normalized.modelId };
    if (normalized.scope !== "final") return this.snapshot(now);
    if (normalized.identity && this.#finalized.has(normalized.identity)) return this.snapshot(now);
    if (normalized.identity) this.#finalized.add(normalized.identity);
    addTokens(this.#turn, tokens);
    addTokens(this.#cumulative, tokens);
    if (normalized.role === "assistant") this.#requests += 1;
    this.attribute(tokens, normalized, attribution);
    return this.snapshot(now);
  }

  /** 按来源/渠道/模型归组累计（不用今天的配置推断过去：归属随事件一起记录）。 */
  attribute(tokens, normalized, attribution) {
    const source = USAGE_SOURCES.includes(attribution.source) ? attribution.source : "user";
    const providerId = normalized.provider ?? attribution.providerId ?? "unknown";
    const modelId = normalized.responseModel ?? normalized.modelId ?? attribution.modelId ?? "unknown";
    const key = [source, attribution.channelId ?? "-", providerId, modelId].join("|");
    const bucket =
      this.#attribution.get(key) ??
      {
        source,
        channelId: attribution.channelId ?? null,
        credentialKeyName: attribution.credentialKeyName ?? null,
        providerId,
        modelId,
        bindingRevision: attribution.bindingRevision ?? null,
        configRevision: attribution.configRevision ?? null,
        requests: 0,
        ...emptyTokens(),
      };
    addTokens(bucket, tokens);
    bucket.requests += normalized.role === "assistant" ? 1 : 0;
    this.#attribution.set(key, bucket);
  }

  /** 归属明细（快照推送用；只含引用，不含密钥）。 */
  attributionList() {
    return [...this.#attribution.values()].map((b) => ({ ...b }));
  }

  snapshot(now = Date.now(), requestTokens = this.#current.input) {
    const ratio = requestTokens / this.limits.maxRequestTokens;
    const elapsedMs = this.#startedAt !== null ? Math.max(0, now - this.#startedAt) : 0;
    const state =
      requestTokens > this.limits.maxRequestTokens
        ? "blocked"
        : ratio >= this.limits.compactAtRatio
          ? "compact"
          : ratio >= this.limits.warnAtRatio
            ? "warn"
            : "allow";
    return {
      current: cloneTokens(this.#current),
      turn: cloneTokens(this.#turn),
      cumulative: cloneTokens(this.#cumulative),
      requestTokens,
      ratio,
      state,
      elapsedMs,
      longTask: elapsedMs >= this.limits.maxRunMs,
      runId: this.#runId,
      requests: this.#requests,
      streaming: this.#current.scope === "partial",
      error: this.#lastError,
    };
  }

  /** 记录一次运行级错误（重试/失败分类供 UI 显示，不参与计费）。 */
  noteError(message) {
    this.#lastError = message ?? null;
  }

  endRun(now = Date.now()) {
    const result = this.snapshot(now);
    this.#startedAt = null;
    this.#current = { ...this.#current, scope: "final" };
    return result;
  }

  /** 本轮 run 的归属明细（run 结束上报用）。 */
  runAttribution() {
    return this.attributionList();
  }

  /** 重置跨 run 累计（会话切换/重建时）。 */
  reset(now = Date.now()) {
    this.#current = emptyTokens();
    this.#turn = emptyTokens();
    this.#cumulative = emptyTokens();
    this.#finalized.clear();
    this.#requests = 0;
    this.#attribution.clear();
    this.#runId = null;
    this.#lastError = null;
    this.#startedAt = null;
    return this.snapshot(now);
  }
}
