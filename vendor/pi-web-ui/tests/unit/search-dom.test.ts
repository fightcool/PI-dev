// @vitest-environment jsdom
/* 🍞 AI Breadcrumb Navigation
 * @COUPLED=linked files: ../../web/src/components/message-list/search-dom.ts
 * @CONTRACT=regressions: exclusive data/DOM indexing and precise nested scrolling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../web/src/types";
import {
	collectAllHits,
	hitIndexOf,
	scrollRangeIntoView,
	setHighlight,
} from "../../web/src/components/message-list/search-dom";

const message = (id: string, text: string): UiMessage => ({ id, role: "user", content: [{ type: "text", text }] });
const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);

function container(html: string) {
	const wrap = document.createElement("div");
	wrap.innerHTML = html;
	document.body.append(wrap);
	return wrap;
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("virtual row search index", () => {
	it("uses data exclusively for unmounted/collapsed rows, even with transitional DOM", () => {
		const wrap = container(`
			<div data-msg-id="mounted"><b>Needle</b> and needle</div>
			<div data-msg-id="folded" class="msg-collapsed">needle summary</div>
			<div data-msg-id="transition">needle stale DOM needle</div>
			<div class="search-bar" data-msg-id="mounted">needle</div>
			<div>needle shell</div>
		`);
		const messages = [
			message("absent", "needle needle"),
			message("mounted", "source text differs"),
			message("folded", "needle"),
			message("transition", "needle"),
		];
		const html = wrap.innerHTML;
		const hits = collectAllHits(wrap, "needle", messages, new Set(["absent", "folded", "transition"]), new Map());
		expect(hits.map(({ kind, msgId, k }) => [kind, msgId, k])).toEqual([
			["folded", "absent", 0],
			["folded", "absent", 1],
			["dom", "mounted", 0],
			["dom", "mounted", 1],
			["folded", "folded", 0],
			["folded", "transition", 0],
		]);
		expect(hits.filter((h) => h.kind === "dom").map((h) => h.range.toString())).toEqual(["Needle", "needle"]);
		expect(wrap.innerHTML).toBe(html);
		expect(wrap.querySelector('[data-msg-id="absent"]')).toBeNull();
		expect(collectAllHits(wrap, "", messages, new Set(["absent"]), new Map())).toEqual([]);
	});

	it("keeps occurrence keys when a data hit becomes a DOM range", () => {
		const wrap = container("");
		const messages = [message("row", "needle needle")];
		const key = { msgId: "row", k: 1 };
		const before = collectAllHits(wrap, "needle", messages, new Set(["row"]), new Map());
		expect(hitIndexOf(before, key)).toBe(1);
		wrap.innerHTML = '<div data-msg-id="row">needle <em>needle</em></div>';
		const after = collectAllHits(wrap, "needle", messages, new Set(), new Map());
		const hit = after[hitIndexOf(after, key)];
		expect(hit.kind).toBe("dom");
		if (hit.kind === "dom") expect(hit.range.startContainer.parentElement?.tagName).toBe("EM");
	});

	it("indexes an absent tool result under its unmounted host", () => {
		const wrap = container("");
		const host: UiMessage = {
			id: "host",
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name: "read", argumentsText: "{}" }],
		};
		const result = { ...message("result", "needle output"), role: "toolResult", toolCallId: "call" };
		expect(collectAllHits(wrap, "needle", [host, result], new Set(["host"]), new Map([["call", result]]))).toEqual([
			{ kind: "folded", msgId: "host", k: 0 },
		]);
	});
});

describe("range scrolling", () => {
	it("reveals horizontal overflow first, then recomputes geometry for the outer scroll", () => {
		const wrap = container('<pre style="overflow-x:auto"><span>needle</span></pre>');
		const inner = wrap.firstElementChild as HTMLElement;
		const range = document.createRange();
		range.selectNodeContents(inner.firstElementChild!);
		Object.defineProperties(inner, {
			clientWidth: { value: 100 },
			scrollWidth: { value: 800 },
			clientHeight: { value: 80 },
			scrollHeight: { value: 80 },
		});
		vi.spyOn(inner, "getBoundingClientRect").mockReturnValue(rect(20, 400, 100, 80));
		vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 200));
		const geometry = vi.fn(() => rect(500 - inner.scrollLeft, 420, 20, 10));
		range.getBoundingClientRect = geometry;
		scrollRangeIntoView(wrap, range);
		expect(inner.scrollLeft).toBe(440);
		expect(inner.scrollTop).toBe(0);
		expect(wrap.scrollTop).toBe(325);
		expect(wrap.scrollLeft).toBe(0);
		expect(geometry).toHaveBeenCalledTimes(2);
	});

	it("does not move already visible or zero-size ranges", () => {
		const wrap = container("<span>needle</span>");
		const range = document.createRange();
		range.selectNodeContents(wrap.firstElementChild!);
		vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 200));
		range.getBoundingClientRect = () => rect(20, 20, 30, 10);
		scrollRangeIntoView(wrap, range);
		expect([wrap.scrollTop, wrap.scrollLeft]).toEqual([0, 0]);
		range.getBoundingClientRect = () => rect(500, 500, 0, 0);
		scrollRangeIntoView(wrap, range);
		expect([wrap.scrollTop, wrap.scrollLeft]).toEqual([0, 0]);
	});
});

it("sets and clears CSS highlights, with a no-highlight fallback", () => {
	const highlights = new Map();
	vi.stubGlobal("CSS", { highlights });
	class Highlight {
		constructor(public readonly ranges: Range[]) {}
	}
	vi.stubGlobal(
		"Highlight",
		class extends Highlight {
			constructor(...ranges: Range[]) {
				super(ranges);
			}
		},
	);
	const range = document.createRange();
	setHighlight("msg-search", [range]);
	expect(highlights.get("msg-search").ranges).toEqual([range]);
	setHighlight("msg-search", []);
	expect(highlights.size).toBe(0);
	vi.stubGlobal("CSS", {});
	expect(() => setHighlight("msg-search", [range])).not.toThrow();
});
