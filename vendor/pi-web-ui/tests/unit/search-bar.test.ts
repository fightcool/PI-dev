// @vitest-environment jsdom
/* 🍞 AI Breadcrumb Navigation
 * @COUPLED=linked files: ../../web/src/components/SearchBar.tsx
 * @CONTRACT=regressions: release bottom pin before mounting only the selected row.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { SearchBar } from "../../web/src/components/SearchBar";

vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));

type Props = Parameters<typeof SearchBar>[0];
let root: Root;
let host: HTMLDivElement;
let wrap: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let highlights: Map<string, { ranges: Range[] }>;
let props: Props;

function render(patch: Partial<Props> = {}) {
	props = { ...props, ...patch };
	act(() => root.render(createElement(SearchBar, props)));
}

function flushFrames() {
	let passes = 0;
	while (frames.size) {
		if (++passes > 10) throw new Error("Search never settled");
		const queued = [...frames.values()];
		frames.clear();
		act(() => queued.forEach((callback) => callback(0)));
	}
}

function query(value: string) {
	const input = host.querySelector("input")!;
	act(() => {
		input.value = value;
		Simulate.change(input);
	});
	flushFrames();
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	frames = new Map();
	let nextFrame = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	highlights = new Map();
	vi.stubGlobal("CSS", { highlights });
	vi.stubGlobal(
		"Highlight",
		class {
			ranges: Range[];
			constructor(...ranges: Range[]) {
				this.ranges = ranges;
			}
		},
	);
	const createRange = document.createRange.bind(document);
	vi.spyOn(document, "createRange").mockImplementation(() => {
		const range = createRange();
		range.getBoundingClientRect = () => new DOMRect(10, 10, 20, 10);
		return range;
	});
	host = document.createElement("div");
	wrap = document.createElement("div");
	document.body.append(wrap, host);
	vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 300));
	root = createRoot(host);
	props = {
		containerRef: { current: wrap },
		messages: [
			{ id: "first", role: "user", content: [{ type: "text", text: "needle needle" }] },
			{ id: "second", role: "user", content: [{ type: "text", text: "needle" }] },
		],
		collapsedIds: new Set(["first", "second"]),
		toolResults: new Map(),
		onExpand: vi.fn(),
		onProgrammaticScroll: vi.fn(),
		open: true,
		onClose: vi.fn(),
	};
});

afterEach(() => {
	act(() => root.unmount());
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("releases bottom pin before mounting each navigated row and settles without mounting the rest", () => {
	const events: string[] = [];
	render({
		onProgrammaticScroll: () => events.push("release"),
		onExpand: (id) => events.push(`mount:${id}`),
	});
	query("needle");
	expect(events).toEqual(["release", "mount:first"]);
	expect(host.querySelector(".search-count")?.textContent).toBe("1/3");
	expect(wrap.childElementCount).toBe(0);

	// Move to the second occurrence while the target is still waiting to mount.
	act(() => host.querySelectorAll<HTMLButtonElement>("button")[1].click());
	flushFrames();
	expect(events).toEqual(["release", "mount:first", "release", "mount:first"]);
	wrap.innerHTML = '<div data-msg-id="first">needle <b>needle</b></div>';
	render({ collapsedIds: new Set(["second"]) });
	flushFrames();
	expect(events.at(-1)).toBe("release");
	expect(host.querySelector(".search-count")?.textContent).toBe("2/3");
	const active = highlights.get("msg-search-active")?.ranges[0];
	expect(active?.toString()).toBe("needle");
	expect(active?.startContainer.parentElement?.tagName).toBe("B");

	// Streaming updates refresh ranges but must not trigger another jump.
	const previousEvents = [...events];
	render({ messages: [...props.messages] });
	flushFrames();
	expect(events).toEqual(previousEvents);

	act(() => host.querySelectorAll<HTMLButtonElement>("button")[1].click());
	flushFrames();
	expect(events.slice(-2)).toEqual(["release", "mount:second"]);
});

it("cancels pending navigation and removes highlights on clear, close, and unmount", () => {
	wrap.innerHTML = '<div data-msg-id="first">needle</div>';
	render({ collapsedIds: new Set(["second"]) });
	query("needle");
	expect(highlights.has("msg-search-active")).toBe(true);
	query("");
	expect(highlights.size).toBe(0);
	query("needle");
	expect(highlights.has("msg-search-active")).toBe(true);
	act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
	expect(props.onClose).toHaveBeenCalledTimes(1);
	act(() => host.querySelectorAll<HTMLButtonElement>("button")[2].click());
	expect(props.onClose).toHaveBeenCalledTimes(2);
	// Queue navigation to a data hit, then close before its frame can run.
	act(() => host.querySelectorAll<HTMLButtonElement>("button")[1].click());
	render({ open: false });
	flushFrames();
	expect(props.onExpand).not.toHaveBeenCalled();
	expect(highlights.size).toBe(0);
	expect(host.childElementCount).toBe(0);
	render({ open: true });
	flushFrames();
	expect(highlights.has("msg-search-active")).toBe(true);
	act(() => root.render(null));
	expect(highlights.size).toBe(0);
});
