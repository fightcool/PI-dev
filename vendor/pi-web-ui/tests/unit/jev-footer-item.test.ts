// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/JevFooterItem.tsx（被测件：底栏 Jev 项 + 浮层）,
 *   ../../web/src/components/FooterBar.tsx（唯一挂载点：decision 来自 chat.jev.probe）,
 *   ../../web/src/jev-decision.ts（effectiveThresholds / formatScore / pickReason 的复用来源）,
 *   ../../web/src/jev-footer.ts（最近结论的推断：计数差 → 三态）,
 *   ../../server/protocol.ts（UiJevGateConfig / UiJevDecision / UiJevProposition 的形状来源）
 * @CONTRACT 浮层只展示**服务端给的事实**：
 *   ① 判定理由 = 客户端手里最近一次真实决策回包的 reason（reasonEn 给非中文界面），没有就不渲染；
 *   ② 逐判定项生效阈值 = 直接读 config.thresholds 回显（缺的一侧回落全局），不在客户端重新推导数值；
 *      没有独立阈值时整节不渲染（否则与上面那行全局阈值完全重复）；
 *   ③ 样本复盘（本切片）= runtime.reviewStatus 回显 + 两条 CLI 命令。徽标**只在 due** 时出现
 *      （未到期却天天挂条数会被读成噪声），而待复盘条数本身在浮层里始终看得见。
 *      @GOTCHA 字段是 reviewStatus，不是 review（后者是「转人工的**调用条数**」）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { JevFooterItem } from "../../web/src/components/JevFooterItem.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { JevStatusMsg } from "../../web/src/use-chat.js";
import type {
	UiJevDecision,
	UiJevGateConfig,
	UiJevProposition,
	UiJevReviewStatus,
	UiJevRuntimeStatus,
} from "../../web/src/types.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
localStorage.setItem("pi-web-ui:lang", "zh");

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const RUNTIME: UiJevRuntimeStatus = {
	total: 5,
	approve: 3,
	block: 1,
	review: 1,
	failed: 0,
	inputTokens: 100,
	outputTokens: 10,
	cost: 0.001,
	cacheHits: 0,
	diskHits: 0,
	avgElapsedMs: 300,
	lastError: null,
	// 默认夹具：没有待复盘的样本（−0 与「不在期」是两件事，所以这两个值都写出来）。
	reviewStatus: review({ pending: 0, due: false, needsHumanLabel: 0, oldestPendingAt: null }),
};

/** UiJevReviewStatus 夹具：只有用例关心的字段给值，其余取「未到期 / 无待复盘」的中性值。 */
function review(patch: Partial<UiJevReviewStatus>): UiJevReviewStatus {
	return {
		pending: 0,
		due: false,
		reason: null,
		oldestPendingAt: null,
		newestPendingAt: null,
		needsHumanLabel: 0,
		// 阈值即服务端的 JEV_REVIEW_MIN_ENTRIES / JEV_REVIEW_MAX_AGE_MS（40 条 / 7 天）。
		thresholds: { minEntries: 40, maxAgeMs: 7 * 24 * 60 * 60_000 },
		lastAckAt: null,
		...patch,
	};
}

const PROPOSITIONS: UiJevProposition[] = [
	{
		id: "change_preserves_public_api",
		instructions: "Decide whether the API stays compatible.",
		criteria: { true: "t", false: "f" },
	},
	{ id: "touches_auth", instructions: "Decide whether the auth path is touched.", criteria: { true: "t", false: "f" } },
];

const CONFIG: UiJevGateConfig = {
	enabled: true,
	endpoint: "https://openrouter.ai/api/alpha/decisions",
	model: "typesafe/jev-1.13",
	credentialRef: { providerId: "openrouter", keyName: "prod" },
	thresholds: { approveAt: 0.9, blockAt: 0.1 },
	timeoutMs: 8000,
	cacheTtlMs: 300000,
	minIntervalMs: 1000,
	recordSamples: true,
};

/** 服务端**主动推送**的 jev_status（reqId 0）：带配置、运行聚合与命题表，**不带**决策理由。 */
const pushed = (config: UiJevGateConfig = CONFIG, runtime: UiJevRuntimeStatus = RUNTIME): JevStatusMsg => ({
	type: "jev_status",
	reqId: 0,
	ok: true,
	status: { config, runtime, propositions: PROPOSITIONS },
});

const DECISION: UiJevDecision = {
	outcome: "review",
	reason: "全部明确：change_within_task_scope=0.4（独立阈值 0.5/0.1）未达标，转人工确认",
	reasonEn: "change_within_task_scope=0.4 (override 0.5/0.1) is below its threshold; needs human review",
	checks: { change_within_task_scope: 0.4 },
	audit: { elapsedMs: 300, cache: "miss" },
};

/** 点开底栏那项，返回浮层容器。 */
function mount({ status, decision }: { status: JevStatusMsg | null; decision?: UiJevDecision | null }) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() =>
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(JevFooterItem, { status, decision, onOpenSettings: () => {} }) as ReactNode,
			),
		),
	);
	act(() => {
		(container.querySelector("button.status-jev") as HTMLButtonElement).dispatchEvent(
			new MouseEvent("click", { bubbles: true }),
		);
	});
	const panel = container.querySelector(".usage-panel.jev-panel") as HTMLElement;
	expect(panel, "浮层已打开").toBeTruthy();
	return { container, panel, text: panel.innerText ?? panel.textContent ?? "" };
}

/** 阈值一节的逐项行（.jev-prop-facts .chan-account-row）；没有那一节时返回空数组。 */
const factRows = (panel: HTMLElement) =>
	[...panel.querySelectorAll(".jev-prop-facts .chan-account-row")].map((row) => ({
		id: row.querySelector(".field-label")?.textContent ?? "",
		metas: [...row.querySelectorAll(".chan-meta")].map((m) => m.textContent ?? ""),
	}));

describe("底栏 Jev 浮层：判定理由与逐判定项生效阈值", () => {
	it("有客户端手里的决策回包时显示判定理由原文（服务端 reason 已经是给人读的）", () => {
		const { text } = mount({ status: pushed(), decision: DECISION });
		expect(text).toContain("判定理由");
		expect(text).toContain(DECISION.reason);
	});

	it("没有决策回包时不渲染理由一节（不拿配置或聚合数拼一句假的理由）", () => {
		const { text } = mount({ status: pushed(), decision: null });
		expect(text).not.toContain("判定理由");
	});

	it("没有独立阈值时不渲染逐判定项一节（否则与上面那行全局阈值完全重复）", () => {
		const { panel, text } = mount({ status: pushed(), decision: null });
		expect(factRows(panel).length).toBe(0);
		expect(text).toContain("0.9"); // 全局阈值仍然在
	});

	it("有独立阈值时逐项显示**生效**阈值：覆盖值 + 缺的一侧回落全局，并标出哪一项是独立阈值", () => {
		const { panel } = mount({
			status: pushed({
				...CONFIG,
				thresholds: {
					approveAt: 0.9,
					blockAt: 0.1,
					perProposition: { change_preserves_public_api: { approveAt: 0.55 } },
				},
			}),
			decision: null,
		});
		const rows = factRows(panel);
		expect(rows.map((r) => r.id)).toEqual(["change_preserves_public_api", "touches_auth"]);
		// 覆盖了放行 0.55、拦截回落全局 0.1 → 显示 0.55 / 0.1（不是全局的 0.9 / 0.1）。
		expect(rows[0].metas).toEqual(["0.55 / 0.1", "独立阈值"]);
		// 没覆盖的那一项如实显示全局值 + 「继承全局」。
		expect(rows[1].metas).toEqual(["0.9 / 0.1", "继承全局"]);
	});

	it("独立配置自相矛盾（磁盘被手改）时按全局值显示：与服务端 resolvePropositionThresholds 同规则", () => {
		const { panel } = mount({
			status: pushed({
				...CONFIG,
				thresholds: {
					approveAt: 0.9,
					blockAt: 0.1,
					perProposition: { touches_auth: { approveAt: 0.2, blockAt: 0.4 } },
				},
			}),
			decision: null,
		});
		const auth = factRows(panel).find((r) => r.id === "touches_auth");
		expect(auth?.metas).toEqual(["0.9 / 0.1", "继承全局"]);
	});
});

/** 待复盘夹具：12 条待复盘、其中 3 条转人工（没有真值，只能人判）。 */
const DUE_REVIEW = review({
	pending: 12,
	due: true,
	reason: "entries",
	oldestPendingAt: 1758000000000,
	newestPendingAt: 1758100000000,
	needsHumanLabel: 3,
});

const withReview = (patch: Partial<UiJevReviewStatus>): UiJevRuntimeStatus => ({
	...RUNTIME,
	reviewStatus: review(patch),
});

/** 底栏那项里的徽标（没到期时不存在）。 */
const badge = (container: HTMLElement) => container.querySelector("button.status-jev .jev-review-due");
/** 浮层里的复盘事实行（整节没渲染时不存在）。 */
const reviewFacts = (panel: HTMLElement) => panel.querySelector(".jev-review-facts");

describe("底栏 Jev 浮层：样本复盘", () => {
	it("到期时底栏项挂出「待复盘 N 条」徽标（条数取回包里的 pending）", () => {
		const { container, text } = mount({ status: pushed(CONFIG, withReview(DUE_REVIEW)), decision: null });
		const el = badge(container);
		expect(el, "到期时徽标存在").toBeTruthy();
		expect(el?.textContent).toContain("待复盘 12 条");
		expect(el?.className).toContain("jev-review-due");
		// 触发条件默认读服务端的 40 条 / 7 天（不在客户端写死）。
		expect(text).toContain("每 40 条或每 7 天");
	});

	it("未到期但有待复盘样本：不挂徽标（不天天打扰），浮层里仍有一行状态", () => {
		const { container, panel, text } = mount({
			status: pushed(CONFIG, withReview({ ...DUE_REVIEW, due: false, reason: null })),
			decision: null,
		});
		expect(badge(container), "未到期时不挂徽标").toBeNull();
		expect(reviewFacts(panel), "浮层里仍有复盘一节").toBeTruthy();
		expect(text).toContain("待复盘 12 条");
	});

	it("转人工条数单独写出来：那些样本没有真值，只能人判", () => {
		const { text } = mount({ status: pushed(CONFIG, withReview(DUE_REVIEW)), decision: null });
		expect(text).toContain("其中 3 条转人工，没有真值只能人判");
	});

	it("没有转人工样本时不写那一行（0 条不是需要人判的事实，别占地方）", () => {
		const { text } = mount({
			status: pushed(CONFIG, withReview({ ...DUE_REVIEW, needsHumanLabel: 0 })),
			decision: null,
		});
		expect(text).toContain("待复盘 12 条");
		expect(text).not.toContain("转人工，没有真值");
	});

	it("最老一条的时间与触发条件都写出来（阈值读服务端回包，不在客户端写死）", () => {
		// 服务端回包里改过阈值（20 条 / 3 天）→ 文案要跟着变，不能被写死的 40/7 盖掉。
		const { text, panel } = mount({
			status: pushed(
				CONFIG,
				withReview({ ...DUE_REVIEW, thresholds: { minEntries: 20, maxAgeMs: 3 * 24 * 60 * 60_000 } }),
			),
			decision: null,
		});
		expect(text).toContain("最老一条");
		expect(text).toContain("每 20 条或每 3 天");
		expect(text).not.toContain("每 40 条或每 7 天");
		expect(reviewFacts(panel)).toBeTruthy();
	});

	it("两条命令原文可复制：导出语料 + 导出后 ack（各带一个复制按钮）", () => {
		const { panel, text } = mount({ status: pushed(CONFIG, withReview(DUE_REVIEW)), decision: null });
		expect(text).toContain("npm run jev -- review export --since 7d > corpus.week.jsonl");
		expect(text).toContain("npm run jev -- review ack");
		// 命令给全还不够：每条都要能直接复制走（复用既有 CopyButton，不自己写剪贴板）。
		const commands = [...panel.querySelectorAll(".jev-review-cmd")];
		expect(commands.length).toBe(2);
		expect(commands.every((row) => row.querySelector("button.copy-btn") !== null)).toBe(true);
	});

	it("没有待复盘样本时整节不渲染（列一堆 0 只是噪声）", () => {
		const { container, panel, text } = mount({ status: pushed(CONFIG, withReview({ pending: 0 })), decision: null });
		expect(badge(container)).toBeNull();
		expect(reviewFacts(panel)).toBeNull();
		expect(text).not.toContain("待复盘");
	});

	it("旧服务端没有 reviewStatus 字段：不崩、不挂徽标、整节不渲染", () => {
		// 旧的推送 payload：整个字段缺失（不是空对象，也不是 0）。
		// @GOTCHA mount 本身就断言了「底栏项能点开、浮层渲染出来」：这里能往下走到断言
		//   就说明缺字段没有把组件搞崩（不另写一次 expect(...).not.toThrow() 的重复挂载）。
		const { reviewStatus: _omitted, ...legacy } = RUNTIME;
		const { container, panel, text } = mount({
			status: pushed(CONFIG, legacy as UiJevRuntimeStatus),
			decision: null,
		});
		expect(badge(container)).toBeNull();
		expect(reviewFacts(panel)).toBeNull();
		expect(text).not.toContain("待复盘");
		// 其余一节照旧渲染（缺字段只影响它自己那一节，不是整块白屏）。
		expect(text).toContain("最近结论");
	});
});
