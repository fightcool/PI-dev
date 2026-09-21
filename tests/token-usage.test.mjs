/*
 * 🍞 AI Breadcrumb — @COUPLED vendor/pi-web-ui/lib/usage/token-usage.mjs
 * 📖 docs/NEWAPI-GATEWAY.md §4（两条口径：本地估算 vs 网关自报）与 docs/DEV-CON-PROPOSAL.md §7/§9
 *    「用量身份」（历史留档）：累计/增量/终结的区分、同一消息去重、重试/子代理来源标注、缓存与费用字段。
 * @CONTRACT 归属只到**服务商 + 模型**这一层：渠道概念已随单网关接入移除（见 NEWAPI-GATEWAY §1），
 *    所以这里的规格用例不再断言 channelId/凭据名/绑定版本，而是钉住「服务商/模型分辨 + 未归属诚实标记」。
 * 用例按真实 SDK 事件顺序（message_start → N×message_update → message_end → turn_end）重放。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TokenUsageTracker, isFailedStopReason, normalizeUsageEvent } from "../vendor/pi-web-ui/lib/usage/token-usage.mjs";

/** 真实 SDK Usage 形状（pi-ai types.d.ts：totalTokens / cacheRead / cacheWrite / cost）。 */
const sdkUsage = (over = {}) => ({
	input: 1000,
	output: 50,
	cacheRead: 800,
	cacheWrite: 120,
	totalTokens: 1970,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
	...over,
});

const assistant = (usage, timestamp, extra = {}) => ({ role: "assistant", model: "m1", provider: "main", usage, timestamp, ...extra });

test("records the terminal value once even though the SDK streams many partial events", () => {
  const t = new TokenUsageTracker({ maxRequestTokens: 100_000 });
  t.startRun(0);
  const message = assistant(sdkUsage(), 1_000);
  // 1) message_start：全 0，仅更新请求级视图
  const started = assistant(sdkUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }), 1_000);
  t.record(normalizeUsageEvent({ type: "message_start", message: started }), 10);
  // 2) 流式增量：output 逐步增长（同一消息，共享 usage 对象）
  for (const out of [5, 12, 30, 44, 50]) {
    t.record(normalizeUsageEvent({ type: "message_update", message: assistant(sdkUsage({ output: out }), 1_000) }), 20);
  }
  const midRun = t.snapshot(20);
  assert.equal(midRun.current.output, 50, "request view follows the stream");
  assert.equal(midRun.turn.output, 0, "streaming deltas must not accumulate into the run");
  assert.equal(midRun.streaming, true);
  // 3) message_end：终结值 → 累加
  t.record(normalizeUsageEvent({ type: "message_end", message }), 30);
  // 4) turn_end：同一条消息 → 必须去重
  t.record(normalizeUsageEvent({ type: "turn_end", message }), 40);
  const snap = t.snapshot(40);
  assert.deepEqual(snap.turn, { input: 1000, output: 50, cacheRead: 800, cacheWrite: 120, total: 1970, cost: 0.033 });
  assert.deepEqual(snap.cumulative, snap.turn, "run and session agree");
  assert.equal(snap.requests, 1);
  assert.equal(snap.streaming, false);
});

test("deduplicates by provider response id across message_end/turn_end", () => {
  const t = new TokenUsageTracker();
  t.startRun(0);
  const message = assistant(sdkUsage(), 5, { responseId: "resp-1" });
  t.record(normalizeUsageEvent({ type: "message_end", message }));
  t.record(normalizeUsageEvent({ type: "turn_end", message }));
  t.record(normalizeUsageEvent({ type: "message_end", message: { ...message, timestamp: 6 } }));
  assert.equal(t.snapshot().turn.total, 1970, "one provider response counted once");
});

test("counts every retry attempt separately and labels the source", () => {
  const t = new TokenUsageTracker();
  t.startRun(0);
  const failed = assistant(sdkUsage({ output: 5, totalTokens: 1905 }), 10, { stopReason: "error" });
  const ok = assistant(sdkUsage(), 20);
  t.record(normalizeUsageEvent({ type: "message_end", message: failed }), 10, { source: "retry", modelId: "main/m1" });
  t.record(normalizeUsageEvent({ type: "message_end", message: ok }), 20, { source: "retry", modelId: "main/m1" });
  const snap = t.snapshot();
  assert.equal(snap.turn.total, 1905 + 1970, "each attempt is its own request");
  assert.equal(snap.requests, 2);
  assert.equal(t.attributionList().length, 1);
  assert.equal(t.attributionList()[0].source, "retry");
});

test("attributes usage per source, provider and model and never merges providers", () => {
  const t = new TokenUsageTracker();
  t.startRun(0);
  t.record(normalizeUsageEvent({ type: "message_end", message: assistant(sdkUsage(), 1) }), 1, {
    source: "user",
    modelId: "main/m1",
  });
  t.record(normalizeUsageEvent({ type: "message_end", message: assistant(sdkUsage({ input: 10, output: 1, totalTokens: 11, cost: { total: 0.5 } }), 2) }), 2, {
    source: "subagent",
    modelId: null,
  });
  const buckets = t.attributionList();
  assert.equal(buckets.length, 2);
  const user = buckets.find((b) => b.source === "user");
  // 归属随事件记录：服务商/模型来自那次消息本身，不用今天的配置回推。
  assert.deepEqual(
    { provider: user.providerId, model: user.modelId },
    { provider: "main", model: "m1" },
  );
  // 子代理那次也带自己的 provider/model（同一批 SDK 事件里就有），不推断、不合并。
  const child = buckets.find((b) => b.source === "subagent");
  assert.equal(child.providerId, "main");
  assert.equal(child.modelId, "m1");
});

test("keeps different providers in different buckets (the old 'never merges channels' rule)", () => {
  const t = new TokenUsageTracker();
  t.startRun(0);
  // 两条消息必须有不同的稳定标识（无 responseId 时 id 由 role+timestamp 派生）——
  // 否则第二条会被当成同一条响应去重掉，测试就测不到「分桶」这件事。
  let at = 1;
  for (const provider of ["newapi", "othergw"]) {
    t.record(
      normalizeUsageEvent({
        type: "message_end",
        message: { role: "assistant", model: "m1", provider, timestamp: at, responseId: `resp-${provider}`, usage: sdkUsage() },
      }),
      at++,
      { source: "user", modelId: `${provider}/m1` },
    );
  }
  const buckets = t.attributionList();
  assert.equal(buckets.length, 2, "同一模型在两个服务商下必须是两个桶");
  assert.deepEqual(buckets.map((b) => b.providerId).sort(), ["newapi", "othergw"]);
});

test("records mark usage as unreported instead of claiming zero tokens (real-provider finding)", () => {
  const t = new TokenUsageTracker();
  t.startRun(1_000);
  // 供应商返回成功但整条 usage 全 0 / 未带 usage（真实链路上某网关如此）。
  const bare = normalizeUsageEvent({ type: "message_end", message: { role: "assistant", model: "m", provider: "p", timestamp: 1, usage: { input: 0, output: 0, totalTokens: 0 } } });
  t.record(bare, 1_000, { source: "user", conversationId: "c1" });
  const [record] = t.snapshot().records;
  assert.equal(record.usageKnown, false, "全 0 且无费用 → 未上报");
  assert.equal(record.total, 0);
  // 正常上报的请求标记为已知。
  t.record(normalizeUsageEvent({ type: "message_end", message: { role: "assistant", model: "m", provider: "p", timestamp: 2, usage: sdkUsage() } }), 2_000, { source: "user", conversationId: "c1" });
  assert.equal(t.snapshot().records[0].usageKnown, true, "有 token/费用 → 已知");
});

test("per-request records carry a stable id, run/conversation refs, time and a pricing basis (§7)", () => {
  const t = new TokenUsageTracker({ maxRecords: 2 });
  t.startRun(1_000);
  const message = assistant(sdkUsage(), 1_000, { responseId: "resp-7" });
  t.record(normalizeUsageEvent({ type: "message_end", message }), 1_500, {
    source: "user", conversationId: "c1", cwd: "/proj",
  });
  // 同一消息的 turn_end 不得再产生一条记录（去重与聚合口径一致）。
  t.record(normalizeUsageEvent({ type: "turn_end", message }), 1_600, { source: "user", conversationId: "c1" });
  const [record] = t.snapshot().records;
  assert.deepEqual(
    { id: record.id, at: record.at, runId: record.runId, conversationId: record.conversationId, cwd: record.cwd,
      source: record.source, provider: record.providerId, model: record.modelId,
      total: record.total, cost: record.cost, costBasis: record.costBasis, currency: record.currency },
    { id: "r:resp-7", at: 1_500, runId: "run-1", conversationId: "c1", cwd: "/proj", source: "user",
      provider: "main", model: "m1",
      total: 1970, cost: 0.033, costBasis: "sdk-model-pricing", currency: "USD" },
  );
  assert.equal(t.snapshot().records.length, 1);
});

test("records stay bounded and mark unknown pricing instead of pretending it is free", () => {
  const t = new TokenUsageTracker({ maxRecords: 2 });
  t.startRun(0);
  for (let i = 0; i < 4; i++) {
    t.record(normalizeUsageEvent({ type: "message_end", message: assistant(sdkUsage(), i, { responseId: `resp-${i}` }) }), i, { source: "user" });
  }
  assert.deepEqual(t.snapshot().records.map((r) => r.id), ["r:resp-3", "r:resp-2"], " newest first, bounded");
  // 没有 cost 对象的事件 → 计价依据未知（不得展示为 0 费用）。
  const bare = normalizeUsageEvent({ type: "message_end", message: { role: "assistant", model: "m2", provider: "main", timestamp: 9, usage: { input: 5, output: 1, totalTokens: 6 } } });
  t.record(bare, 99, { source: "probe" });
  const [record] = t.snapshot().records;
  assert.equal(record.costBasis, "unknown");
  assert.equal(record.currency, null);
  assert.equal(record.total, 6);
});

test("retry attempts get one record each", () => {
  const t = new TokenUsageTracker();
  t.startRun(0);
  t.record(normalizeUsageEvent({ type: "message_end", message: assistant(sdkUsage({ totalTokens: 10, output: 1 }), 1, { responseId: "try-1" }) }), 1, { source: "retry", conversationId: "c1" });
  t.record(normalizeUsageEvent({ type: "message_end", message: assistant(sdkUsage(), 2, { responseId: "try-2" }) }), 2, { source: "retry", conversationId: "c1" });
  const records = t.snapshot().records;
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.source), ["retry", "retry"]);
  assert.equal(t.snapshot().turn.total, 10 + 1970);
});

test("keeps legacy governance thresholds and tolerates unknown providers", () => {
  const t = new TokenUsageTracker({ maxRequestTokens: 100, maxRunMs: 50 });
  t.startRun(0);
  t.record(normalizeUsageEvent({ type: "message_end", message: assistant(sdkUsage({ input: 90, output: 0 }), 1) }), 0);
  assert.equal(t.snapshot(60).state, "compact");
  assert.equal(t.snapshot(60, 101).state, "blocked");
  assert.equal(t.snapshot(60, 10).longTask, true);
  assert.equal(normalizeUsageEvent({ type: "noise" }), null);
  assert.equal(new TokenUsageTracker().snapshot().turn.total, 0);
});

test("normalizes snake_case provider events and ignores a missing usage", () => {
  const normalized = normalizeUsageEvent({ assistantMessageEvent: { usage: { input_tokens: 3, completion_tokens: 4, total_tokens: 7 } } });
  assert.deepEqual(
    { input: normalized.input, output: normalized.output, total: normalized.total, cacheRead: normalized.cacheRead },
    { input: 3, output: 4, total: 7, cacheRead: 0 },
  );
  assert.equal(normalized.scope, "partial");
  assert.equal(normalizeUsageEvent({ type: "agent_start" }), null);
});

test("per-request records carry the failure verdict and a bounded reason (白烧口径)", () => {
  const t = new TokenUsageTracker();
  t.startRun(0);
  // 网关搞流：SDK 写 stopReason=error + errorMessage，而 usage 里的输入早就被计费了。
  const longReason = `Anthropic stream ended before message_stop: ${"x".repeat(300)}`;
  t.record(
    normalizeUsageEvent({
      type: "message_end",
      message: assistant(sdkUsage({ output: 0, totalTokens: 1920 }), 1, { responseId: "resp-err", stopReason: "error", errorMessage: longReason }),
    }),
    1,
    { source: "user" },
  );
  const failed = t.snapshot().records[0];
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.failureReason.length, 120, "证据要截断到有界长度：用量历史是 append-only JSONL，不能无界膨胀");
  assert.ok(longReason.startsWith(failed.failureReason), "截断保留原文前缀，不改写证据");
  // 正常结束不写 failureReason：不给每条记录多塞空字段（旧记录也没有这些字段）。
  t.record(normalizeUsageEvent({ type: "message_end", message: assistant(sdkUsage(), 2, { responseId: "resp-ok", stopReason: "stop" }) }), 2, { source: "user" });
  const ok = t.snapshot().records[0];
  assert.equal("failureReason" in ok, false);
  assert.equal(ok.stopReason, "stop");
});

test("only stopReason=error counts as failure; a user abort never does", () => {
  // 用户主动中止时 SDK 同样写 stopReason/errorMessage，但它是有意为之：
  // 当成故障会让渠道告警变噪声，并把结论指向错误的渠道。
  assert.equal(isFailedStopReason("error"), true);
  assert.equal(isFailedStopReason("aborted"), false);
  assert.equal(isFailedStopReason("stop"), false);
  assert.equal(isFailedStopReason(undefined), false);
  const t = new TokenUsageTracker();
  t.startRun(0);
  t.record(
    normalizeUsageEvent({ type: "message_end", message: assistant(sdkUsage(), 3, { responseId: "resp-abort", stopReason: "aborted", errorMessage: "Request was aborted" }) }),
    3,
  );
  // 中止的事实照记（留证据），是不是「失败」由 isFailedStopReason 的唯一口径决定。
  assert.equal(t.snapshot().records[0].stopReason, "aborted");
});
