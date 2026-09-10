/*
 * 🍞 AI Breadcrumb Navigation
 * @COUPLED=linked files; @CONTRACT=interface contract; @GOTCHA=known trap
 * @COUPLED ../SearchBar.tsx, ../../search-folded.ts
 * @CONTRACT collapsedIds includes every unmounted or collapsed message row.
 * @GOTCHA A row in collapsedIds uses data hits even if transitional DOM still exists.
 */
import type { UiMessage } from "../../types";
import { collectFoldedHits, type FoldedResultMessage } from "../../search-folded";

/** A mounted text range, or a data hit whose row must be mounted and expanded. */
export type SearchHit =
	{ kind: "dom"; range: Range; msgId: string; k: number } | { kind: "folded"; msgId: string; k: number };

/** Stable semantic position across mounting/expansion. */
export interface HitKey {
	msgId: string;
	k: number;
}

/** Case-insensitive, node-local matches in document order. Exclude search UI,
 * collapsed summaries and all rows owned by the data index. */
function collectRanges(root: HTMLElement, query: string, collapsedIds: ReadonlySet<string>): Range[] {
	const all: Range[] = [];
	const needle = query.toLowerCase();
	if (!needle) return all;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const el = node.parentElement;
			if (!el || el.closest(".search-bar") || el.closest(".msg-collapsed")) return NodeFilter.FILTER_REJECT;
			const msgId = el.closest<HTMLElement>("[data-msg-id]")?.dataset.msgId;
			if (!msgId || collapsedIds.has(msgId)) return NodeFilter.FILTER_REJECT;
			return (node.textContent ?? "").toLowerCase().includes(needle)
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_SKIP;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const lower = (node.textContent ?? "").toLowerCase();
		let idx = lower.indexOf(needle);
		while (idx !== -1) {
			const r = document.createRange();
			r.setStart(node, idx);
			r.setEnd(node, idx + needle.length);
			all.push(r);
			idx = lower.indexOf(needle, idx + needle.length);
		}
	}
	return all;
}

/** Merge rendered text and data hits in message order without mounting any rows. */
export function collectAllHits(
	wrap: HTMLElement,
	query: string,
	messages: readonly UiMessage[],
	collapsedIds: ReadonlySet<string>,
	toolResults: ReadonlyMap<string, UiMessage>,
): SearchHit[] {
	const foldedCounts = collectFoldedHits(
		messages,
		collapsedIds,
		query,
		toolResults as ReadonlyMap<string, FoldedResultMessage>,
	);
	const domByMsg = new Map<string, Range[]>();
	for (const r of collectRanges(wrap, query, collapsedIds)) {
		const node = r.startContainer.parentElement?.closest<HTMLElement>("[data-msg-id]");
		if (!node?.dataset.msgId) continue;
		const arr = domByMsg.get(node.dataset.msgId);
		if (arr) arr.push(r);
		else domByMsg.set(node.dataset.msgId, [r]);
	}
	const hits: SearchHit[] = [];
	for (const m of messages) {
		const dr = domByMsg.get(m.id);
		if (dr) {
			for (let k = 0; k < dr.length; k++) {
				hits.push({ kind: "dom", range: dr[k], msgId: m.id, k });
			}
		}
		const n = foldedCounts.get(m.id);
		if (n) {
			for (let k = 0; k < n; k++) hits.push({ kind: "folded", msgId: m.id, k });
		}
	}
	return hits;
}

export function hitIndexOf(hits: SearchHit[], key: HitKey): number {
	return hits.findIndex((h) => h.msgId === key.msgId && h.k === key.k);
}

export function setHighlight(name: string, ranges: Range[]) {
	const css = CSS as unknown as { highlights?: Map<string, unknown> };
	if (!css.highlights) return;
	if (ranges.length === 0) {
		css.highlights.delete(name);
		return;
	}
	// Older DOM typings omit Highlight; feature-detect it at runtime.
	const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
	if (Ctor) css.highlights.set(name, new Ctor(...ranges));
}

/** Scrollable ancestors, innermost first, excluding the message container. */
function collectScrollers(start: HTMLElement | null, end: HTMLElement): HTMLElement[] {
	const out: HTMLElement[] = [];
	let el = start;
	while (el && el !== end) {
		const cs = getComputedStyle(el);
		if (
			/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX) &&
			(el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
		) {
			out.push(el);
		}
		el = el.parentElement;
	}
	return out;
}

/** Center the word inside each clipped ancestor, then the message container.
 * Re-read geometry after each scroll. Long unwrapped tool/bash lines can be
 * clipped horizontally even when vertically visible, so always check both axes. */
export function scrollRangeIntoView(wrap: HTMLElement, range: Range) {
	const start = range.startContainer.parentElement as HTMLElement | null;
	for (const s of collectScrollers(start, wrap)) {
		const rr = range.getBoundingClientRect();
		const sr = s.getBoundingClientRect();
		if (rr.height <= 0 || rr.width <= 0) return;
		if (!(rr.top >= sr.top + 4 && rr.bottom <= sr.bottom - 4)) {
			s.scrollTop += rr.top - sr.top - (s.clientHeight - rr.height) / 2;
		}
		if (!(rr.left >= sr.left + 4 && rr.right <= sr.right - 4)) {
			s.scrollLeft += rr.left - sr.left - (s.clientWidth - rr.width) / 2;
		}
	}
	const rr = range.getBoundingClientRect();
	const wr = wrap.getBoundingClientRect();
	if (rr.height <= 0 || rr.width <= 0) return;
	// Leave 6px around visible words, avoiding jitter between adjacent hits.
	const vVisible = rr.top >= wr.top + 6 && rr.bottom <= wr.bottom - 6;
	const hVisible = rr.left >= wr.left + 6 && rr.right <= wr.right - 6;
	if (vVisible && hVisible) return;
	if (!vVisible) wrap.scrollTop += rr.top - wr.top - (wr.height - rr.height) / 2;
	if (!hVisible) {
		wrap.scrollLeft += rr.left - wr.left - (wr.width - rr.width) / 2;
	}
}
