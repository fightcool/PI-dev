/**
 * PR 门禁判定映射的单测：**只有 block 拦**、出错绝不假绿、跳过必须说成跳过。
 *
 * 背景（2026-09-20）：门禁接进编码路径后跑了几小时真实调用 0 次（没有触发点）。补 CI 卡口时，
 * 最容易坏的不是模型，而是**这层翻译**：把 block 说成通过、把「没跑成」说成绿色，卡口就成了装饰。
 * 这个文件把三条铁律固化成断言。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SKIP_TEXT,
  describeChecks,
  skipReason,
  thresholdOf,
  verdictOf,
} from "../scripts/ci/jev-gate-verdict.mjs";

const CONFIG = {
  thresholds: {
    approveAt: 0.9,
    blockAt: 0.1,
    perProposition: {
      test_asserts_behavior: { approveAt: 0.95, blockAt: 0.15 },
    },
  },
};

test("approve / review → 退出码 0（不拦）", () => {
  assert.deepEqual(
    verdictOf({ decision: { outcome: "approve", checks: {} }, status: 0 }),
    {
      kind: "approve",
      exitCode: 0,
    },
  );
  assert.equal(
    verdictOf({ decision: { outcome: "review", checks: {} }, status: 2 })
      .exitCode,
    0,
  );
});

test("block → 退出码 1（唯一会拦的状态）", () => {
  assert.deepEqual(
    verdictOf({ decision: { outcome: "block", checks: {} }, status: 1 }),
    {
      kind: "block",
      exitCode: 1,
    },
  );
});

test("CLI 退出码说 0、但结论是 block → 仍然拦（block 优先，fail-safe）", () => {
  assert.equal(
    verdictOf({ decision: { outcome: "block", checks: {} }, status: 0 })
      .exitCode,
    1,
  );
});

test("没跑成一律 3：没有 JSON / 超时（status=null）/ decision.error / 未知结论", () => {
  assert.equal(verdictOf({ decision: null, status: 3 }).exitCode, 3);
  assert.equal(verdictOf({ decision: null, status: null }).exitCode, 3);
  assert.equal(
    verdictOf({
      decision: { outcome: "review", error: "鉴权失败（HTTP 401）" },
      status: 3,
    }).exitCode,
    3,
  );
  assert.equal(
    verdictOf({ decision: { outcome: "something-new" }, status: 0 }).exitCode,
    3,
  );
});

test("出错时带上可读原因，且不给 kind=approve（绝不假绿）", () => {
  const verdict = verdictOf({
    decision: { outcome: "review", error: "鉴权失败（HTTP 401）" },
    status: 3,
  });
  assert.equal(verdict.kind, "error");
  assert.match(String(verdict.error), /401/);
});

test("跳过只有两种：没凭据 / 空 diff；跳过文案必须写明「不是通过」", () => {
  assert.equal(
    skipReason({ hasCredential: false, diffChars: 1234 }),
    "no-credential",
  );
  assert.equal(skipReason({ hasCredential: true, diffChars: 0 }), "empty-diff");
  assert.equal(skipReason({ hasCredential: true, diffChars: 42 }), null);
  assert.match(SKIP_TEXT["no-credential"], /没有运行|不是通过/);
  assert.match(SKIP_TEXT["empty-diff"], /SKIPPED/);
});

test("阈值展示：逐判定项独立阈值优先，缺项回落全局", () => {
  assert.deepEqual(thresholdOf(CONFIG, "test_asserts_behavior"), {
    approveAt: 0.95,
    blockAt: 0.15,
    scoped: true,
  });
  assert.deepEqual(thresholdOf(CONFIG, "change_preserves_public_api"), {
    approveAt: 0.9,
    blockAt: 0.1,
    scoped: false,
  });
});

test("分数表把每个判定项的分数与生效阈值都写出来（含「独立阈值」标注）", () => {
  const lines = describeChecks(
    { checks: { test_asserts_behavior: 0.94, change_within_task_scope: 0.42 } },
    CONFIG,
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0], /0\.94.*0\.95.*0\.15.*独立阈值/);
  assert.match(lines[1], /0\.42.*0\.9.*0\.1.*全局/);
});
