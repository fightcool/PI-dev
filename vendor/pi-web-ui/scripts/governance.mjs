export const DEFAULT_GOVERNANCE = Object.freeze({
  maxInputTokens: 128_000,
  warnAtRatio: 0.7,
  compactAtRatio: 0.85,
  maxToolOutputBytes: 64 * 1024,
  maxToolOutputLines: 1_500,
  maxToolOutputTokens: 12_000,
});

export function validateGovernance(input = {}) {
  const value = { ...DEFAULT_GOVERNANCE, ...input };
  if (!Number.isInteger(value.maxInputTokens) || value.maxInputTokens < 1)
    throw new Error("maxInputTokens must be a positive integer");
  if (!(value.warnAtRatio > 0 && value.warnAtRatio < 1))
    throw new Error("warnAtRatio must be between 0 and 1");
  if (!(value.compactAtRatio > value.warnAtRatio && value.compactAtRatio < 1))
    throw new Error("compactAtRatio must exceed warnAtRatio and be below 1");
  for (const field of ["maxToolOutputBytes", "maxToolOutputLines", "maxToolOutputTokens"])
    if (!Number.isInteger(value[field]) || value[field] < 1)
      throw new Error(`${field} must be a positive integer`);
  return value;
}

export function assessInputBudget(inputTokens, governance = DEFAULT_GOVERNANCE) {
  const policy = validateGovernance(governance);
  if (!Number.isFinite(inputTokens) || inputTokens < 0)
    throw new Error("inputTokens must be a non-negative number");
  const ratio = inputTokens / policy.maxInputTokens;
  return {
    inputTokens,
    ratio,
    state: inputTokens > policy.maxInputTokens
      ? "blocked"
      : ratio >= policy.compactAtRatio
        ? "compact"
        : ratio >= policy.warnAtRatio
          ? "warn"
          : "allow",
    remainingTokens: Math.max(0, policy.maxInputTokens - inputTokens),
  };
}

export function assessToolOutput({ bytes, lines, tokens }, governance = DEFAULT_GOVERNANCE) {
  const policy = validateGovernance(governance);
  const measures = { bytes, lines, tokens };
  const exceeded = Object.entries({
    bytes: policy.maxToolOutputBytes,
    lines: policy.maxToolOutputLines,
    tokens: policy.maxToolOutputTokens,
  }).filter(([key, limit]) => Number.isFinite(measures[key]) && measures[key] > limit);
  return {
    truncated: exceeded.length > 0,
    exceeded: exceeded.map(([key, limit]) => ({ metric: key, limit, actual: measures[key] })),
  };
}
