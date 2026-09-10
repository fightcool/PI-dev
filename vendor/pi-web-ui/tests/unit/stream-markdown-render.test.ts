// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const { parse } = vi.hoisted(() => ({
	parse: vi.fn((text: string) => ({ frozen: [], active: text, inFence: false })),
}));
vi.mock("../../web/src/stream-markdown", () => ({ segmentStream: parse }));
vi.mock("../../web/src/components/Markdown", () => ({ MarkdownBody: ({ text }: { text: string }) => text }));
import { StreamMarkdown } from "../../web/src/components/StreamMarkdown";

let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	vi.useRealTimers();
	parse.mockClear();
});

it("coalesces a burst before segmentation and renders the final tail", () => {
	vi.useFakeTimers();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const host = document.createElement("div");
	root = createRoot(host);
	act(() => root!.render(createElement(StreamMarkdown, { text: "start" })));
	for (let i = 0; i < 30; i++) act(() => root!.render(createElement(StreamMarkdown, { text: `tail ${i}` })));
	expect(parse).toHaveBeenCalledTimes(1);
	act(() => vi.advanceTimersByTime(100));
	expect(parse).toHaveBeenCalledTimes(2);
	expect(host.textContent).toBe("tail 29");
	act(() => root!.render(createElement(StreamMarkdown, { text: "final" })));
	act(() => vi.advanceTimersByTime(100));
	expect(host.textContent).toBe("final");
});
