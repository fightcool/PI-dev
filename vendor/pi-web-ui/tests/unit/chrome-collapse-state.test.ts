// @vitest-environment jsdom
/*
 * 🍞 AI Breadcrumb — @COUPLED ../../web/src/app/use-chrome-collapse.tsx（React 层状态机）
 * 📖 docs/architecture-core.md
 * @CONTRACT jsdom 里验证「信号 → 收起」的接线（纯判定由 chrome-collapse.test.ts 钉死）：
 *   输出中自动收起、翻历史收起、滑到底展开、聚焦输入框永不收起、手动展开不会被重复上报吃掉、
 *   设置关掉后完全不干预。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
	ChromeCollapseProvider,
	useChromeCollapse,
	type ChromeCollapseApi,
} from "../../web/src/app/use-chrome-collapse.js";
import { CHROME_COLLAPSE_SETTINGS_KEY, saveChromeCollapseSettings } from "../../web/src/chrome-collapse-settings.js";

let root: Root | null = null;
let api: ChromeCollapseApi | null = null;

function Probe() {
	api = useChromeCollapse();
	return null;
}

/** 挂载 Provider（streaming 由 props 推动，和 App 把 chat.state.isStreaming 传进来一致）。 */
function mount(streaming: boolean) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(ChromeCollapseProvider, { streaming }, createElement(Probe)));
	});
	return container;
}

function rerender(streaming: boolean) {
	act(() => {
		root!.render(createElement(ChromeCollapseProvider, { streaming }, createElement(Probe)));
	});
}

afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	api = null;
	document.body.innerHTML = "";
	localStorage.clear();
});

describe("底部控件自动收缩（React 层）", () => {
	it("输出开始 → 收起；输出结束且停在最底部 → 展开", () => {
		mount(false);
		expect(api?.collapsed).toBe(false);
		rerender(true);
		expect(api?.collapsed).toBe(true); // 流式刷屏时把竖向空间让给正文
		rerender(false);
		expect(api?.collapsed).toBe(false); // 默认停在最底部（MessageList 初始上报 true）
	});

	it("向上翻历史 → 收起；滑回最底部 → 展开", () => {
		mount(false);
		act(() => api?.setAtBottom(false));
		expect(api?.collapsed).toBe(true);
		act(() => api?.setAtBottom(true));
		expect(api?.collapsed).toBe(false);
	});

	it("输入框聚焦时永不收起（含输出中）", () => {
		mount(true);
		expect(api?.collapsed).toBe(true);
		act(() => api?.setComposerFocused(true));
		expect(api?.collapsed).toBe(false);
		act(() => api?.setComposerFocused(false));
		expect(api?.collapsed).toBe(true);
	});

	it("手动展开是一次性的，但重复上报同一个底部状态不会把它吃掉", () => {
		mount(true);
		act(() => api?.toggle());
		expect(api?.collapsed).toBe(false);
		// @GOTCHA MessageList 的 effect 会在 context 变化后重跑：重复上报同一个值必须幂等，
		//   否则用户刚点开的控件会立刻被重新收起。
		act(() => api?.setAtBottom(true));
		expect(api?.collapsed).toBe(false);
		// 真正滚动（值变化）后回到自动规则：离开底部 → 收起。
		act(() => api?.setAtBottom(false));
		expect(api?.collapsed).toBe(true);
	});

	it("手动收起在底部空闲时也生效，滚动回来后回到自动规则", () => {
		mount(false);
		act(() => api?.toggle());
		expect(api?.collapsed).toBe(true);
		act(() => api?.setAtBottom(false));
		act(() => api?.setAtBottom(true));
		expect(api?.collapsed).toBe(false);
	});

	it("设置里关掉自动收缩 → 完全不干预", () => {
		act(() => saveChromeCollapseSettings({ autoCollapse: false }));
		expect(JSON.parse(localStorage.getItem(CHROME_COLLAPSE_SETTINGS_KEY) ?? "{}")).toEqual({ autoCollapse: false });
		mount(true);
		expect(api?.collapsed).toBe(false);
		act(() => api?.setAtBottom(false));
		expect(api?.collapsed).toBe(false);
		// 打开开关立刻生效（订阅路径）。
		act(() => saveChromeCollapseSettings({ autoCollapse: true }));
		expect(api?.collapsed).toBe(true);
	});
});
