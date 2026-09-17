// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/ChannelForm.tsx（被测件）,
 *   ../../web/src/components/ChannelDialog.tsx（弹窗壳 + 可折叠分区）,
 *   ../../web/src/components/ChannelSettings.tsx（挂载点）
 * 📖 docs/DEV-CON-PROPOSAL.md §6（设置页）
 * @CONTRACT 渠道编辑与账户查询必须是**同一种**交互（用户投诉「同一个面板两套交互」）：
 *   ① 是真弹窗：role=dialog + aria-modal + aria-labelledby；ESC / 点遮罩关闭；
 *   ② 保存按钮在固定页脚里（不必滚到底）；
 *   ③ 进阶字段默认收起，折叠时用摘要说明里面配了什么（不再是 12 个字段一条直列）；
 *   ④ 折叠的分区里字段**不渲染**，展开后才出现（避免"看起来必填"）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ChannelForm, channelDraftOf } from "../../web/src/components/ChannelForm.js";
import { LanguageProvider } from "../../web/src/i18n.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// @GOTCHA LanguageProvider 在英文词典未就绪时只渲染 boot-wait 占位（jsdom 里取不到服务端）。
localStorage.setItem("pi-web-ui:lang", "zh");

let root: Root | null = null;

function mount(existing = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const saved: unknown[] = [];
	const cancelled = vi.fn();
	const draft = existing
		? channelDraftOf(
				{
					id: "uu-claude",
					displayName: "UU Claude",
					providerId: "uu-api",
					endpointId: "",
					credentialRef: null,
					accountRef: "",
					models: [],
					enabled: true,
				} as never,
				"uu-api",
			)
		: channelDraftOf(null, "uu-api");
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ChannelForm, {
					draft,
					providerIds: ["uu-api"],
					providerKeys: {},
					models: [],
					onSave: (r: unknown) => saved.push(r),
					onCancel: cancelled,
				}),
			),
		);
	});
	return { container, saved, cancelled };
}

afterEach(() => {
	act(() => root?.unmount());
	document.body.innerHTML = "";
});

const textOf = (c: HTMLElement) => c.textContent ?? "";
const buttons = (c: HTMLElement) => [...c.querySelectorAll("button")];

describe("渠道编辑弹窗（与账户查询同一种交互）", () => {
	it("是真弹窗：role=dialog + aria-modal + 标题被 aria-labelledby 指到", () => {
		const { container } = mount();
		const dialog = container.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog!.getAttribute("aria-modal")).toBe("true");
		const titleId = dialog!.getAttribute("aria-labelledby")!;
		expect(container.querySelector(`#${titleId}`)?.textContent).toBeTruthy();
	});

	it("ESC 关闭；点遮罩关闭；点弹窗内部不关", () => {
		const { container, cancelled } = mount();
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(cancelled).toHaveBeenCalledTimes(1);
		const dialog = container.querySelector('[role="dialog"]')!;
		act(() => {
			dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(cancelled).toHaveBeenCalledTimes(1); // 内部点击不关
		act(() => {
			container.querySelector(".modal-backdrop")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(cancelled).toHaveBeenCalledTimes(2);
	});

	it("保存按钮在固定页脚里（不用滚到底找）", () => {
		const { container } = mount();
		const foot = container.querySelector(".chan-dialog-foot");
		expect(foot).not.toBeNull();
		expect(buttons(foot as HTMLElement).length).toBeGreaterThanOrEqual(2);
	});

	it("进阶字段默认收起：协议端点/账户引用不在初始 DOM 里，展开后才出现", () => {
		const { container } = mount(true);
		expect(textOf(container)).not.toContain("账户引用");
		const advanced = buttons(container).find((b) => (b.textContent ?? "").includes("进阶设置"))!;
		expect(advanced.getAttribute("aria-expanded")).toBe("false");
		act(() => {
			advanced.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(advanced.getAttribute("aria-expanded")).toBe("true");
		expect(textOf(container)).toContain("账户引用");
		expect(textOf(container)).toContain("协议端点");
	});

	it("账户查询仍是弹窗里的入口（一行摘要 + 配置按钮），不再是内嵌一堆字段", () => {
		const { container } = mount(true);
		act(() => {
			buttons(container).find((b) => (b.textContent ?? "").includes("进阶设置"))!
				.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const configure = buttons(container).find((b) => (b.textContent ?? "").includes("配置账户查询"));
		expect(configure).toBeTruthy();
		// 摘要行说明当前状态（没配过 = 不查询），用户不点开也知道。
		expect(container.querySelector(".chan-account-row")?.textContent).toContain("不查询");
	});
});
