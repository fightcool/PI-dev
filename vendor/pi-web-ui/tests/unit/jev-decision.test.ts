/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/jev-decision.ts（被测件：逐判定项阈值的纯函数）,
 *   ../../server/dev-con/jev-model.ts（resolvePropositionThresholds / validateJevGateConfig 是权威，
 *   本文件钉的是界面侧展示镜像与出站补丁的口径）,
 *   ../../server/dev-con/jev-settings.ts（mergeThresholds 的 null / 缺字段删除语义）,
 *   ../../web/src/components/JevSettings.tsx（草稿 → 补丁的调用方）
 * 📖 docs/JEV-DECISION-GATE.md §4.3（逐命题阈值的实测依据）
 * @WHY 这几个纯函数决定三件事，错了都很贵：
 *   ① 界面上「这一项到底按多少判」显示得对不对（effectiveThresholds = resolvePropositionThresholds 的展示镜像）；
 *   ② 就地校验能不能拦住白填一轮（checkPropositionDraft：越界 / 拦截 ≥ 放行——留空按全局补齐后再判）；
 *   ③ 保存时会不会把别的客户端刚设的独立阈值覆盖掉（propositionThresholdsPatch：只提交改过的项，
 *      留空 = 不带字段，整项留空 = null 删除）。
 */
import { describe, expect, it } from "vitest";
import {
	checkPropositionDraft,
	effectiveDraftThresholds,
	effectiveThresholds,
	propositionDraftOf,
	propositionThresholdsPatch,
	type JevPropositionDrafts,
} from "../../web/src/jev-decision.js";
import type { UiJevThresholds } from "../../web/src/types.js";

const GLOBAL = { approveAt: 0.9, blockAt: 0.1 };
const withOverrides = (perProposition: UiJevThresholds["perProposition"]): UiJevThresholds => ({
	...GLOBAL,
	perProposition,
});

describe("effectiveThresholds（读服务端回显的生效阈值）", () => {
	it("没有独立配置：返回全局值并标记 scoped=false", () => {
		expect(effectiveThresholds("scope", withOverrides(undefined))).toEqual({ ...GLOBAL, scoped: false });
		expect(effectiveThresholds("scope", withOverrides({}))).toEqual({ ...GLOBAL, scoped: false });
	});

	it("只配 approveAt：blockAt 一侧回落全局", () => {
		expect(effectiveThresholds("scope", withOverrides({ scope: { approveAt: 0.5 } }))).toEqual({
			approveAt: 0.5,
			blockAt: 0.1,
			scoped: true,
		});
	});

	it("只配 blockAt：approveAt 一侧回落全局（实测 scope 的拦截侧就是 0.1）", () => {
		expect(effectiveThresholds("scope", withOverrides({ scope: { blockAt: 0.15 } }))).toEqual({
			approveAt: 0.9,
			blockAt: 0.15,
			scoped: true,
		});
	});

	it("未配置的判定项不受同一个 perProposition 里其它项的影响", () => {
		const t = withOverrides({ scope: { approveAt: 0.5, blockAt: 0.1 } });
		expect(effectiveThresholds("scope", t)).toEqual({ approveAt: 0.5, blockAt: 0.1, scoped: true });
		expect(effectiveThresholds("tests", t)).toEqual({ ...GLOBAL, scoped: false });
	});

	it("独立配置自相矛盾（blockAt >= approveAt）时整体回落全局（与服务端同规则）", () => {
		expect(effectiveThresholds("scope", withOverrides({ scope: { approveAt: 0.2, blockAt: 0.4 } }))).toEqual({
			...GLOBAL,
			scoped: false,
		});
	});

	it("非有限数值不算「给了值」：回落全局而不是显示 NaN", () => {
		const t = withOverrides({ scope: { approveAt: Number.NaN, blockAt: 0.2 } });
		expect(effectiveThresholds("scope", t)).toEqual({ approveAt: 0.9, blockAt: 0.2, scoped: true });
	});
});

describe("effectiveDraftThresholds（草稿层生效阈值）", () => {
	it("两侧都留空 = 继承全局（scoped=false，不是「配了一对等于全局的值」）", () => {
		expect(effectiveDraftThresholds({ approveAt: "", blockAt: "" }, GLOBAL)).toEqual({ ...GLOBAL, scoped: false });
	});

	it("只填一侧：另一侧回落全局并标记 scoped=true", () => {
		expect(effectiveDraftThresholds({ approveAt: "0.5", blockAt: "" }, GLOBAL)).toEqual({
			approveAt: 0.5,
			blockAt: 0.1,
			scoped: true,
		});
	});
});

describe("checkPropositionDraft（就地校验）", () => {
	it("留空 = 继承全局：恒合法（继承的全局值本身由全局那一关校验）", () => {
		expect(checkPropositionDraft({ approveAt: "", blockAt: "" }, GLOBAL)).toBe(true);
		expect(checkPropositionDraft({ approveAt: "", blockAt: "0.05" }, GLOBAL)).toBe(true);
	});

	it("越界（<0 / >1）与非法数字一律拒绝", () => {
		expect(checkPropositionDraft({ approveAt: "1.2", blockAt: "" }, GLOBAL)).toBe(false);
		expect(checkPropositionDraft({ approveAt: "", blockAt: "-0.1" }, GLOBAL)).toBe(false);
		expect(checkPropositionDraft({ approveAt: "abc", blockAt: "" }, GLOBAL)).toBe(false);
	});

	it("拦截 ≥ 放行拒绝；**留空的一侧按全局补齐后**再判（这是最容易漏的一条）", () => {
		// 全局 0.9 / 0.1：只把放行压到 0.05 → 生效是 0.1 ≥ 0.05，必须拦下（服务端也会拒）。
		expect(checkPropositionDraft({ approveAt: "0.05", blockAt: "" }, GLOBAL)).toBe(false);
		// 全局 0.9 / 0.1：只把拦截抬到 0.95 → 生效是 0.95 ≥ 0.9，同样拦下。
		expect(checkPropositionDraft({ approveAt: "", blockAt: "0.95" }, GLOBAL)).toBe(false);
		// 两侧都给且顺序正确：放行。
		expect(checkPropositionDraft({ approveAt: "0.55", blockAt: "0.15" }, GLOBAL)).toBe(true);
	});
});

describe("propositionDraftOf", () => {
	it("回显里没有这一项：两侧都是空串（继承全局）", () => {
		expect(propositionDraftOf(undefined)).toEqual({ approveAt: "", blockAt: "" });
	});

	it("回显里只给了一侧：另一侧是空串（而不是 0）", () => {
		expect(propositionDraftOf({ blockAt: 0.15 })).toEqual({ approveAt: "", blockAt: "0.15" });
	});
});

describe("propositionThresholdsPatch（保存补丁）", () => {
	it("一项都没改：返回 undefined（调用方据此不带 perProposition，绝不整块回写）", () => {
		expect(propositionThresholdsPatch({})).toBeUndefined();
	});

	it("只改一项：补丁里只有那一项", () => {
		const drafts: JevPropositionDrafts = { scope: { approveAt: "0.5", blockAt: "" } };
		const patch = propositionThresholdsPatch(drafts);
		expect(Object.keys(patch ?? {})).toEqual(["scope"]);
		// 留空的一侧**不带字段**（带 undefined 会把 JSON 里也带出去不存在的键，服务端合并语义就变了）。
		expect(Object.keys(patch!.scope as object)).toEqual(["approveAt"]);
		expect(patch!.scope).toEqual({ approveAt: 0.5 });
	});

	it("只改某一侧的字段：另一侧不会被带出去（服务端逐项合并，缺字段 = 保留磁盘上的值）", () => {
		const patch = propositionThresholdsPatch({ tests: { approveAt: "", blockAt: "0.15" } });
		expect(patch!.tests).toEqual({ blockAt: 0.15 });
		expect(Object.keys(patch!.tests as object)).toEqual(["blockAt"]);
	});

	it("整项留空 = 继承全局 = 提交 null（协议里的删除语义）", () => {
		expect(propositionThresholdsPatch({ scope: { approveAt: "  ", blockAt: "" } })).toEqual({ scope: null });
	});

	it("多项各自独立：改的带值、清空的带 null、没动的根本不出现", () => {
		const patch = propositionThresholdsPatch({
			scope: { approveAt: "0.5", blockAt: "0.1" },
			tests: { approveAt: "", blockAt: "" },
		});
		expect(patch).toEqual({ scope: { approveAt: 0.5, blockAt: 0.1 }, tests: null });
		expect(Object.keys(patch ?? {})).toEqual(["scope", "tests"]);
	});

	it("非法数字不会变成 NaN 混进补丁：当作留空（被 checkPropositionDraft 拦下的输入本来也不该走到保存）", () => {
		expect(propositionThresholdsPatch({ scope: { approveAt: "abc", blockAt: "" } })).toEqual({ scope: null });
	});
});
