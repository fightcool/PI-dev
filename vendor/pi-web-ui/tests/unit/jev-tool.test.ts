/* 🍞 AI Breadcrumb — @COUPLED ../../server/agent-service.ts（makeJevCheckTool / JevCheckResult）
 * 📖 docs/JEV-DECISION-GATE.md（§6 不要交给 Jev 的判断、§7 门禁坏掉≠通过）
 *
 * 这一层只测「工具桥」：参数校验、透传、以及**失败必须如实上报**。
 * 判定本身（阈值/三态/缓存/限频）由 jev-gate.test.ts 与 jev-model.test.ts 覆盖，
 * 这里不重复实现，也不碰网络。
 */
import { describe, expect, it } from "vitest";
import { makeJevCheckTool, type JevCheckResult } from "../../server/agent-service.js";
import type { JevDecision } from "../../server/dev-con/jev-gate.js";

interface Captured {
	state: unknown;
	propositions?: string[];
	useCache?: boolean;
}

/** 判定结果的最小形状（与 JevGate.evaluate 的返回一致）。 */
function decision(overrides: Partial<JevDecision> = {}): JevDecision {
	return {
		outcome: "approve",
		reason: "全部判定项达到放行阈值（change_preserves_public_api=0.95；放行阈值 0.9）",
		reasonEn: "All checks reached the approve threshold (change_preserves_public_api=0.95; approve threshold 0.9)",
		checks: { change_preserves_public_api: 0.95 },
		audit: { model: "typesafe/jev-1.13", elapsedMs: 12, cache: "miss" },
		...overrides,
	};
}

function harness(result: JevCheckResult): { tool: ReturnType<typeof makeJevCheckTool>; calls: Captured[] } {
	const calls: Captured[] = [];
	const tool = makeJevCheckTool({
		checkJev: async (input) => {
			calls.push({ ...input });
			return result;
		},
	});
	return { tool, calls };
}

async function runTool(tool: ReturnType<typeof makeJevCheckTool>, params: unknown): Promise<string> {
	const out = (await (tool.execute as (id: string, params: unknown) => Promise<unknown>)("call-1", params)) as {
		content: { type: string; text: string }[];
	};
	return out.content.map((c) => c.text).join("\n");
}

describe("jev_check tool — 参数与透传", () => {
	it("is registered under a stable name with a description that teaches the boundaries", () => {
		const { tool } = harness({ ids: ["change_preserves_public_api"], decision: decision() });
		expect(tool.name).toBe("jev_check");
		// 官方 model-jaggedness 的边界必须写在描述里：它是二元判断模型，不是生成模型。
		expect(tool.description).toContain("does NOT generate text or code");
		expect(tool.description).toContain("never treat a failed call as a pass");
		expect(tool.description).toContain("never for counting");
		expect(tool.description).toContain("task objective plus the relevant diff");
	});

	it("passes state / propositions / useCache through unchanged", async () => {
		const { tool, calls } = harness({ ids: ["test_asserts_behavior"], decision: decision() });
		await runTool(tool, {
			state: { objective: "add an optional flag", diff: "+ export function parse(...)" },
			propositions: ["test_asserts_behavior"],
			useCache: false,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ propositions: ["test_asserts_behavior"], useCache: false });
		expect(calls[0].state).toMatchObject({ objective: "add an optional flag" });
	});

	it("omits optional flags so the server default applies (all propositions, cache on)", async () => {
		const { tool, calls } = harness({ ids: ["change_preserves_public_api"], decision: decision() });
		await runTool(tool, { state: "raw diff" });
		expect(calls[0].propositions).toBeUndefined();
		expect(calls[0].useCache).toBeUndefined();
	});

	it("refuses to run without state instead of judging an empty input", async () => {
		const { tool, calls } = harness({ ids: [], decision: decision() });
		await expect(runTool(tool, {})).rejects.toThrow(/requires `state`/);
		expect(calls).toHaveLength(0);
	});
});

describe("jev_check tool — 结果与失败如实上报", () => {
	it("reports the three states in words so the model cannot confuse them", async () => {
		const { tool } = harness({ ids: ["change_preserves_public_api"], decision: decision({ outcome: "block" }) });
		const text = await runTool(tool, { state: "x" });
		expect(text).toContain("Jev outcome: block");
		expect(text).toContain("approve=pass, block=stop, review=needs a human");
		expect(text).toContain("change_preserves_public_api=0.95");
		// 双语理由都要给（英文给模型，中文便于用户直接看工具结果）。
		expect(text).toContain("reason: ");
		expect(text).toContain("理由（中文）: ");
	});

	it("marks a failed call as review — never as a pass", async () => {
		const { tool } = harness({
			ids: ["change_preserves_public_api"],
			decision: decision({
				outcome: "review",
				checks: {},
				reason: "未配置可用的 Jev 凭据（请在门禁设置里选择密钥名）",
				reasonEn: "No usable Jev credential (pick a key name in the gate settings)",
				error: "未配置可用的 Jev 凭据（请在门禁设置里选择密钥名）",
				errorEn: "No usable Jev credential (pick a key name in the gate settings)",
			}),
		});
		const text = await runTool(tool, { state: "x" });
		expect(text).toContain("Jev outcome: review");
		expect(text).toContain("this was not a valid decision");
		expect(text).toContain("never pass");
	});

	it("surfaces an unknown proposition with the available ids, without inventing a verdict", async () => {
		const { tool } = harness({
			ids: ["nope"],
			unsupported: { error: "未知命题：nope（可用：a, b）", errorEn: "Unknown propositions: nope (available: a, b)" },
		});
		const text = await runTool(tool, { state: "x", propositions: ["nope"] });
		expect(text).toContain("未知命题：nope");
		expect(text).not.toContain("Jev outcome:");
	});
});
