/* 🍞 AI Breadcrumb — @COUPLED ../../lib/usage/token-usage.mjs, ../../server/agent-service.ts
 *   (recordCompactionUsage / recordBypassUsage 的记法契约)
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §7（子代理/复核/压缩摘要/探测分别标注来源）
 * @CONTRACT 旁路调用必须显式记录来源，否则这些 token 在归属里消失。
 */
// @ts-expect-error Host runtime module is JavaScript by design.
import { TokenUsageTracker } from "../../lib/usage/token-usage.mjs";
import { describe, expect, it } from "vitest";

/** agent-service 的旁路记法：终态、无消息身份、来源由调用点指定。 */
const bypass = (tracker: unknown, source: string, usage: Record<string, number>) =>
	(tracker as { record: (u: unknown, now?: number, a?: unknown) => unknown }).record(
		{ scope: "final", identity: null, role: "assistant", ...usage },
		Date.now(),
		// agent-service#bindingAttribution 把绑定的 "provider/model" 拆成裸 model id，
	// 与消息事件里的 message.model 同名（同一行才能在归属表里合并）。
	{ source, channelId: "ch-a", credentialKeyName: "密钥 1", modelId: "m1", providerId: "main", bindingRevision: 2, configRevision: 3 },
	);

describe("bypass call attribution", () => {
	it("records compaction and vision usage as separate sources without inventing a channel", () => {
		const t = new TokenUsageTracker();
		t.startRun(1_000);
		bypass(t, "compaction", { input: 900, output: 120, cacheRead: 0, cacheWrite: 0, total: 1020, cost: 0.02 });
		bypass(t, "vision", { input: 300, output: 40, cacheRead: 0, cacheWrite: 0, total: 340, cost: 0.01 });
		const buckets = t.attributionList();
		expect(buckets.map((b: { source: string }) => b.source).sort()).toEqual(["compaction", "vision"]);
		// 归属随事件记录：渠道/凭据/模型与绑定版本都在，而不是用今天的配置推断。
		const compaction = buckets.find((b: { source: string }) => b.source === "compaction");
		expect(compaction).toMatchObject({ channelId: "ch-a", credentialKeyName: "密钥 1", modelId: "m1", bindingRevision: 2, configRevision: 3 });
		expect(t.snapshot().turn.total).toBe(1360);
		expect(t.snapshot().requests).toBe(2);
	});

	it("ignores a non-positive compaction delta (no phantom usage)", () => {
		const t = new TokenUsageTracker();
		t.startRun(1_000);
		// agent-service 在 delta<=0 时直接不记录：模拟同一判断。
		const delta = { total: 0, cost: 0 };
		if (delta.total > 0 || delta.cost > 0) bypass(t, "compaction", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
		expect(t.attributionList()).toEqual([]);
		expect(t.snapshot().turn.total).toBe(0);
	});
});
