import test from "node:test";
import assert from "node:assert/strict";
import { TokenUsageTracker, normalizeUsageEvent } from "../vendor/pi-web-ui/lib/usage/token-usage.mjs";

test("tracks current, single-run and cumulative usage", () => {
  const t = new TokenUsageTracker({ maxRequestTokens: 100 });
  t.startRun(0); t.record({ input: 30, output: 5 }, 10); t.record({ input: 20, output: 2 }, 20);
  assert.deepEqual(t.snapshot(20), { current: { input: 20, output: 2, total: 22 }, turn: { input: 50, output: 7, total: 57 }, cumulative: { input: 50, output: 7, total: 57 }, requestTokens: 20, ratio: .2, state: "allow", elapsedMs: 20, longTask: false });
});

test("governs large requests and long runs", () => {
  const t = new TokenUsageTracker({ maxRequestTokens: 100, maxRunMs: 50 });
  t.startRun(0); assert.equal(t.snapshot(60, 90).state, "compact"); assert.equal(t.snapshot(60, 101).state, "blocked"); assert.equal(t.snapshot(60, 10).longTask, true);
});

test("normalizes provider usage events", () => assert.deepEqual(normalizeUsageEvent({ assistantMessageEvent: { usage: { input_tokens: 3, completion_tokens: 4, total_tokens: 7 } } }), { input: 3, output: 4, total: 7 }));
