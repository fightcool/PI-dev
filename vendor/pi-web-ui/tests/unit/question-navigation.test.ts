// @vitest-environment jsdom
/*
 * AI Breadcrumb Navigation
 * @COUPLED (coverage): web/src/components/message-list/QuestionNavigation.tsx
 * and web/src/components/message-list/question-navigation-window.ts.
 * @WHY: test bounded DOM and access to the entire question collection.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	QuestionNavigation,
	type QuestionNavigationProps,
} from "../../web/src/components/message-list/QuestionNavigation";
import {
	QUESTION_RAIL_LIMIT,
	QUESTION_ROW_HEIGHT,
	questionListWindow,
	questionRailIndices,
} from "../../web/src/components/message-list/question-navigation-window";

vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function mount(count = 550, activeIdx = 274) {
	const host = document.createElement("div");
	const messages = document.createElement("div");
	Object.defineProperty(messages, "clientHeight", { value: 600, configurable: true });
	document.body.append(host, messages);
	const onJump = vi.fn();
	const questions = Array.from({ length: count }, (_, i) => ({ id: `q${i}`, text: `Question ${i + 1}` }));
	const props: QuestionNavigationProps = { questions, activeIdx, onJump, scrollRef: { current: messages } };
	root = createRoot(host);
	const render = (overrides: Partial<QuestionNavigationProps> = {}) => {
		act(() => root!.render(createElement(QuestionNavigation, { ...props, ...overrides })));
	};
	render();
	return { host, messages, props, onJump, render };
}

function key(target: Element, value: string) {
	act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
}

function list(host: HTMLElement) {
	return host.querySelector<HTMLDivElement>(".qn-list")!;
}

function focusRail(host: HTMLElement) {
	act(() => host.querySelector<HTMLElement>(".qn-rail")!.focus());
}

describe("bounded question geometry", () => {
	it("samples all sizes with sorted unique indices and an active tick", () => {
		for (const count of [0, 1, 2, 20, 550, 100_000]) {
			for (const height of [0, 35, 200, 600, 2000]) {
				for (const active of [-1, 0, Math.floor(count / 2), count - 1]) {
					const indices = questionRailIndices(count, active, height);
					expect(indices.length).toBeLessThanOrEqual(QUESTION_RAIL_LIMIT);
					expect(indices).toEqual([...new Set(indices)].sort((a, b) => a - b));
					expect(indices.every((i) => i >= 0 && i < count)).toBe(true);
					if (active >= 0 && active < count) expect(indices).toContain(active);
					if (indices.length > 2) {
						expect(indices[0]).toBe(0);
						expect(indices.at(-1)).toBe(count - 1);
					}
				}
			}
		}
	});

	it("bounds every virtual window and clamps after shrink", () => {
		for (let i = 0; i < 550; i++) {
			const range = questionListWindow(550, i * QUESTION_ROW_HEIGHT, 280);
			expect(range.start).toBeLessThanOrEqual(i);
			expect(range.end).toBeGreaterThan(i);
			expect(range.end - range.start).toBeLessThanOrEqual(14);
		}
		expect(questionListWindow(0, 9000, 280)).toEqual({ start: 0, end: 0, top: 0 });
		expect(questionListWindow(2, 9000, 56)).toEqual({ start: 0, end: 2, top: 0 });
	});
});

describe("QuestionNavigation", () => {
	it("bounds both render paths and highlights unsampled active questions without scanning messages", () => {
		const { host, messages } = mount();
		const scan = vi.spyOn(messages, "querySelector");
		focusRail(host);
		expect(host.querySelectorAll(".qn-bar")).toHaveLength(40);
		expect(host.querySelector(".qn-bar.active")?.getAttribute("aria-label")).toBe("275. Question 275");
		expect(host.querySelectorAll(".qn-list-item").length).toBeLessThanOrEqual(15);
		expect(host.querySelector(".qn-list-item.active")?.getAttribute("aria-setsize")).toBe("550");
		expect(scan).not.toHaveBeenCalled();
	});

	it("lets keyboard users reach and jump to both ends and dismiss with Escape", () => {
		const { host, onJump } = mount();
		focusRail(host);
		const panel = list(host);
		key(panel, "End");
		key(panel, "Enter");
		expect(onJump).toHaveBeenLastCalledWith("q549");
		expect(document.getElementById(panel.getAttribute("aria-activedescendant")!)?.textContent).toContain(
			"Question 550",
		);
		key(panel, "Home");
		key(panel, " ");
		expect(onJump).toHaveBeenLastCalledWith("q0");
		key(panel, "ArrowDown");
		key(panel, "Enter");
		expect(onJump).toHaveBeenLastCalledWith("q1");
		key(panel, "PageDown");
		key(panel, "Enter");
		expect(onJump).toHaveBeenLastCalledWith("q11");
		key(panel, "Escape");
		expect(panel.style.visibility).toBe("hidden");
		expect(document.activeElement).toBe(host.querySelector(".qn-rail"));
	});

	it("can scroll to and click every question while keeping row count bounded", () => {
		const { host, onJump } = mount();
		focusRail(host);
		const panel = list(host);
		for (let i = 0; i < 550; i++) {
			act(() => {
				panel.scrollTop = i * QUESTION_ROW_HEIGHT;
				panel.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			const option = panel.querySelector<HTMLButtonElement>(`[aria-posinset="${i + 1}"]`)!;
			expect(option).not.toBeNull();
			expect(panel.querySelectorAll(".qn-list-item").length).toBeLessThanOrEqual(15);
			act(() => option.click());
			expect(onJump).toHaveBeenLastCalledWith(`q${i}`);
		}
	}, 15000);

	it("preserves a mouse selection when focus enters a hover-open list", () => {
		const { host, onJump } = mount();
		act(() => host.querySelector(".qn-rail")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		const panel = list(host);
		act(() => {
			panel.scrollTop = 0;
			panel.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		act(() => panel.querySelector<HTMLButtonElement>('[aria-posinset="2"]')!.click());
		expect(onJump).toHaveBeenLastCalledWith("q1");
		expect(panel.scrollTop).toBe(0);
		expect(document.getElementById(panel.getAttribute("aria-activedescendant")!)?.getAttribute("aria-posinset")).toBe(
			"2",
		);
		act(() => host.querySelector<HTMLElement>(".qn-rail")!.blur());
		act(() => panel.blur());
		expect(panel.style.visibility).toBe("hidden");
	});

	it("routes wheel events over the rail to messages and over the list to the list", () => {
		const { host, messages } = mount();
		focusRail(host);
		const panel = list(host);
		act(() =>
			host
				.querySelector(".qn-bar")!
				.dispatchEvent(new WheelEvent("wheel", { deltaY: 2, deltaMode: 1, bubbles: true, cancelable: true })),
		);
		expect(messages.scrollTop).toBe(56);
		const before = panel.scrollTop;
		act(() => panel.dispatchEvent(new WheelEvent("wheel", { deltaY: 56, bubbles: true, cancelable: true })));
		expect(panel.scrollTop).toBe(before + 56);
		expect(messages.scrollTop).toBe(56);
	});

	it("handles empty, append, shrink, invalid active indices, and container resize", () => {
		const { host, render, props, messages } = mount(0, -1);
		expect(host.childElementCount).toBe(0);
		const questions = Array.from({ length: 550 }, (_, i) => ({ id: `q${i}`, text: `Q ${i}` }));
		render({ questions, activeIdx: 549 });
		focusRail(host);
		key(list(host), "End");
		render({ questions: questions.slice(0, 2), activeIdx: 999 });
		expect(list(host).scrollTop).toBe(0);
		expect(host.querySelectorAll(".qn-list-item")).toHaveLength(2);
		expect(host.querySelector(".qn-bar.active")).toBeNull();
		Object.defineProperty(messages, "clientHeight", { value: 100 });
		act(() => window.dispatchEvent(new Event("resize")));
		render({ ...props, questions });
		expect(host.querySelectorAll(".qn-bar").length).toBeLessThanOrEqual(11);
		render({ questions: [] });
		expect(host.childElementCount).toBe(0);
	});
});
