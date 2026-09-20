// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/JevFooterItem.tsx（被测件：底栏 Jev 项 + 浮层）,
 *   ../../web/src/components/FooterBar.tsx（唯一挂载点：decision 来自 chat.jev.probe）,
 *   ../../web/src/jev-decision.ts（effectiveThresholds / formatScore / pickReason 的复用来源）,
 *   ../../web/src/jev-footer.ts（最近结论的推断：计数差 → 三态）,
 *   ../../server/protocol.ts（UiJevGateConfig / UiJevDecision / UiJevProposition 的形状来源）
 * @CONTRACT 浮层只展示**服务端给的事实**：
 *   ① 判定理由 = 客户端手里最近一次真实决策回包的 reason（reasonEn 给非中文界面），没有就不渲染；
 *   ② 逐判定项生效阈值 = 直接读 config.thresholds 回显（缺的一侧回落全局），不在客户端重新推导数值；
 *      没有独立阈值时整节不渲染（否则与上面那行全局阈值完全重复）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { JevFooterItem } from "../../web/src/components/JevFooterItem.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { JevStatusMsg } from "../../web/src/use-chat.js";
import type { UiJevDecision, UiJevGateConfig, UiJevProposition, UiJevRuntimeStatus } from "../../web/src/types.js";

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
};

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
};

/** 服务端**主动推送**的 jev_status（reqId 0）：带配置、运行聚合与命题表，**不带**决策理由。 */
const pushed = (config: UiJevGateConfig = CONFIG): JevStatusMsg => ({
	type: "jev_status",
	reqId: 0,
	ok: true,
	status: { config, runtime: RUNTIME, propositions: PROPOSITIONS },
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
