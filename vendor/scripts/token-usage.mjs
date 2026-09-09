export const DEFAULT_USAGE_LIMITS = Object.freeze({
  maxRequestTokens: 128_000,
  warnAtRatio: 0.7,
  compactAtRatio: 0.85,
  maxRunMs: 10 * 60_000,
});

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

export class TokenUsageTracker {
  #current = { input: 0, output: 0, total: 0 };
  #turn = { input: 0, output: 0, total: 0 };
  #cumulative = { input: 0, output: 0, total: 0 };
  #startedAt = null;
  constructor(limits = {}) { this.limits = { ...DEFAULT_USAGE_LIMITS, ...limits }; }
  startRun(now = Date.now()) { this.#startedAt = now; this.#turn = { input: 0, output: 0, total: 0 }; return this.snapshot(now); }
  record(usage = {}, now = Date.now()) {
    const input = nonNegative(Number(usage.input ?? usage.prompt_tokens ?? 0), "input");
    const output = nonNegative(Number(usage.output ?? usage.completion_tokens ?? 0), "output");
    const total = nonNegative(Number(usage.total ?? input + output), "total");
    this.#current = { input, output, total };
    for (const target of [this.#turn, this.#cumulative]) { target.input += input; target.output += output; target.total += total; }
    return this.snapshot(now);
  }
  snapshot(now = Date.now(), requestTokens = this.#current.input) {
    const ratio = requestTokens / this.limits.maxRequestTokens;
    const elapsedMs = this.#startedAt !== null ? Math.max(0, now - this.#startedAt) : 0;
    const state = requestTokens > this.limits.maxRequestTokens ? "blocked" : ratio >= this.limits.compactAtRatio ? "compact" : ratio >= this.limits.warnAtRatio ? "warn" : "allow";
    return { current: { ...this.#current }, turn: { ...this.#turn }, cumulative: { ...this.#cumulative }, requestTokens, ratio, state, elapsedMs, longTask: elapsedMs >= this.limits.maxRunMs };
  }
  endRun(now = Date.now()) { const result = this.snapshot(now); this.#startedAt = null; return result; }
}

export function normalizeUsageEvent(event) {
  const usage = event?.usage ?? event?.message?.usage ?? event?.assistantMessageEvent?.usage;
  if (!usage) return null;
  return { input: usage.input ?? usage.input_tokens ?? usage.prompt_tokens ?? 0, output: usage.output ?? usage.output_tokens ?? usage.completion_tokens ?? 0, total: usage.total ?? usage.total_tokens };
}
