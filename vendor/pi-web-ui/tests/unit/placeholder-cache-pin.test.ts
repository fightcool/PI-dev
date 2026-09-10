// @vitest-environment jsdom
/*
 * 🍞 AI Breadcrumb Navigation — @COUPLED=behavior under test.
 * @COUPLED ../../web/src/components/message-list/useRowWindow.ts
 * @BUGFIX 2026-09-10: pin measured spacer heights through real hook execution,
 * including unmount/remount and same-length edits, without source regexes.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../web/src/types";
import { useRowWindow } from "../../web/src/components/message-list/useRowWindow";

let root: Root;
let host: HTMLDivElement;
let container: HTMLDivElement;
let current: ReturnType<typeof useRowWindow>;
let messages: UiMessage[];
let expanded: Set<string>;
let mounted: boolean;
let measuredHeight: number;
let layout: string;
const stickRef = { current: false };
let containerRef: { current: HTMLDivElement };
let resizeCallbacks: (() => void)[];

function Probe() {
	current = useRowWindow(messages, expanded, containerRef, stickRef, layout);
	return mounted
		? createElement("div", {
				ref: (el: HTMLDivElement | null) => {
					if (el)
						el.getBoundingClientRect = () => ({ height: measuredHeight, top: 0, bottom: measuredHeight }) as DOMRect;
					current.attach("m0", el);
				},
			})
		: null;
}
const render = () => {
	act(() => root.render(createElement(Probe)));
	// jsdom has no layout engine: deliver the browser's post-layout resize
	// notification explicitly, then run the hook's scheduled measurement frame.
	act(() => {
		resizeCallbacks.forEach((notify) => notify());
		vi.runOnlyPendingTimers();
	});
};
const firstHeight = () => current.offsets[1] - current.offsets[0];

beforeEach(() => {
	vi.useFakeTimers();
	resizeCallbacks = [];
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resizeCallbacks.push(callback);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	host = document.createElement("div");
	container = document.createElement("div");
	Object.defineProperty(container, "clientHeight", { value: 800 });
	Object.defineProperty(container, "clientWidth", { value: 860 });
	document.body.append(host, container);
	containerRef = { current: container };
	root = createRoot(host);
	messages = Array.from({ length: 40 }, (_, i) => ({
		id: `m${i}`,
		role: "user",
		content: [{ type: "text", text: "old text" }],
		timestamp: i,
	}));
	expanded = new Set();
	mounted = true;
	measuredHeight = 333;
	layout = "normal";
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	container.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("measured-height spacer cache", () => {
	it("keeps the measured height when a row unmounts and remounts", () => {
		render();
		expect(firstHeight()).toBe(333);
		const measuredTotal = current.offsets.at(-1);
		mounted = false;
		render();
		expect(firstHeight()).toBe(333);
		expect(current.offsets.at(-1)).toBe(measuredTotal);
		mounted = true;
		render();
		expect(firstHeight()).toBe(333);
		expect(current.offsets.at(-1)).toBe(measuredTotal);
	});

	it("invalidates an offscreen measurement for a same-length edit with the same id", () => {
		render();
		mounted = false;
		render();
		messages = messages.map((m, i) => (i === 0 ? { ...m, content: [{ type: "text", text: "new text" }] } : m));
		render();
		expect(firstHeight()).toBe(44);
		mounted = true;
		measuredHeight = 555;
		render();
		expect(firstHeight()).toBe(555);
	});

	it("invalidates measurements when a hidden row expands or search layout changes", () => {
		render();
		mounted = false;
		render();
		expanded = new Set(["m0"]);
		render();
		expect(firstHeight()).toBe(72);
		mounted = true;
		measuredHeight = 999;
		render();
		expect(firstHeight()).toBe(999);
		mounted = false;
		render();
		layout = "search";
		render();
		expect(firstHeight()).toBe(72);
		mounted = true;
		measuredHeight = 1234;
		render();
		expect(firstHeight()).toBe(1234);
	});

	it("prunes removed ids so a reintroduced row cannot inherit a stale measurement", () => {
		render();
		mounted = false;
		render();
		const original = messages;
		messages = messages.slice(1);
		render();
		messages = original;
		render();
		expect(firstHeight()).toBe(44);
	});
});
