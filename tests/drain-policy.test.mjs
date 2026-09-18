/**
 * 排空门禁判定的单测：孤儿队列不该让人干等，停滞该早退并点名。
 *
 * 背景（2026-09-18）：生产切换因为「2 条没有运行在消费的排队消息」白等 45 分钟后
 * aborted。这个文件把那条经验固化成断言，防止改回去。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STALL_MS, evaluateDrain } from "../scripts/lifecycle/drain-policy.mjs";

const idle = { activeConversations: 0, drainableMessages: 0, orphanedMessages: 0, pendingMessages: 0 };

test("没有工作时直接放行", () => {
	const verdict = evaluateDrain(idle);
	assert.equal(verdict.done, true);
	assert.equal(verdict.abort, null);
	assert.equal(verdict.note, null);
	assert.equal(verdict.detail, "active=0 drainable=0 orphaned=0");
});

test("孤儿队列不阻塞排空，但要照实报出来（2026-09-18 事故的形状）", () => {
	// 真实快照：active=0、pendingMessages=2，两条都在没有运行的对话里排队。
	const verdict = evaluateDrain({ ...idle, pendingMessages: 2, orphanedMessages: 2 }, { tolerate: 1 });
	assert.equal(verdict.done, true, "没有运行在消费的队列等多久都不会变，必须放行");
	assert.equal(verdict.abort, null);
	assert.match(verdict.note ?? "", /2 条排队消息没有任何运行在消费/);
	assert.match(verdict.note ?? "", /重启会丢弃/);
});

test("有运行在消费的排队消息仍要等（那是真的在飞的工作）", () => {
	const verdict = evaluateDrain(
		{ activeConversations: 1, drainableMessages: 2, orphanedMessages: 0, pendingMessages: 2 },
		{ tolerate: 1, stalledMs: 30_000 },
	);
	assert.equal(verdict.done, false);
	assert.equal(verdict.abort, null, "刚过去 30 秒，不该放弃");
	assert.equal(verdict.detail, "active=1 drainable=2 orphaned=0");
});

test("长回合不改变计数是正常的：不到停滞阈值不早退", () => {
	const status = { activeConversations: 1, drainableMessages: 1, orphanedMessages: 0, pendingMessages: 1 };
	assert.equal(evaluateDrain(status, { stalledMs: DEFAULT_STALL_MS - 1 }).abort, null);
	// tolerate=1 时这条在飞的工作还在门禁之内 → 可以继续切换。
	assert.equal(evaluateDrain(status, { tolerate: 1 }).done, true);
	// 队列多一条（drainable=2）就超出公差：仍要等，但不到阈值不早退。
	const busy = { ...status, drainableMessages: 2, pendingMessages: 2 };
	assert.equal(evaluateDrain(busy, { tolerate: 1, stalledMs: 1000 }).done, false);
	assert.equal(evaluateDrain(busy, { tolerate: 1, stalledMs: 1000 }).abort, null);
});

test("停滞超过阈值就早退，并点名持有者（谁在流式、谁排队、多久没输出）", () => {
	const verdict = evaluateDrain(
		{
			activeConversations: 1,
			drainableMessages: 1,
			orphanedMessages: 0,
			pendingMessages: 1,
			drainHolders: [
				{ id: "01a0aff8", streaming: true, queued: 1, idleSeconds: 900 },
				{ id: "deadbeef", streaming: false, queued: 0, idleSeconds: 3 },
			],
		},
		{ stalledMs: DEFAULT_STALL_MS, stallLimitMs: DEFAULT_STALL_MS },
	);
	assert.equal(verdict.done, false);
	assert.match(verdict.abort ?? "", /排空停滞 5.0 分钟/);
	assert.match(verdict.abort ?? "", /active=1 drainable=1 orphaned=0/);
	assert.match(verdict.abort ?? "", /对话 01a0aff8（流式中，已 15 分钟 无输出，排队 1 条）/);
	assert.doesNotMatch(verdict.abort ?? "", /deadbeef/, "没持有工作的对话不该出现在诊断里");
	assert.match(verdict.abort ?? "", /SWITCH_DRAIN_TOLERATE/);
});

test("旧服务没有新字段时回退到 pendingMessages（不能误判成已排空）", () => {
	// 升级前的旧进程只回 activeConversations / pendingMessages：行为与修复前一致，继续等。
	const legacy = evaluateDrain({ activeConversations: 0, pendingMessages: 2 }, { stalledMs: 1000 });
	assert.equal(legacy.done, false);
	assert.equal(legacy.detail, "active=0 drainable=2 orphaned=0");
	// 旧进程真的空了才放行。
	assert.equal(evaluateDrain({ activeConversations: 0, pendingMessages: 0 }).done, true);
});

test("tolerate 同时作用于活跃对话与可排空队列", () => {
	const status = { activeConversations: 2, drainableMessages: 2, orphanedMessages: 0, pendingMessages: 2 };
	assert.equal(evaluateDrain(status, { tolerate: 1 }).done, false);
	assert.equal(evaluateDrain(status, { tolerate: 2 }).done, true);
	assert.equal(evaluateDrain(status, { tolerate: 3 }).done, true);
});
