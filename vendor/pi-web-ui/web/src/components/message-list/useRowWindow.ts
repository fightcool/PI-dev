/*
 * 🍞 AI Breadcrumb Navigation — @COUPLED=callers; @GOTCHA=layout contract.
 * @COUPLED ../MessageList.tsx, ../../lazy-row-window.ts, useBottomScroll.ts
 * @GOTCHA Measure only mounted rows; never mount history to discover its height.
 * @WHY Message identity and display mode invalidate measurements, including same-length edits.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { UiMessage } from "../../types";
import {
	estimateMessageHeight,
	renderedRowIndices,
	rowAtOffset,
	rowOffsets,
	visibleRowRange,
} from "../../lazy-row-window";

export interface MessageRow {
	message: UiMessage;
	collapsed: boolean;
	old: boolean;
}
interface Measurement {
	message: UiMessage;
	collapsed: boolean;
	layout: string;
	height: number;
}

export function useRowWindow(
	messages: readonly UiMessage[],
	expanded: ReadonlySet<string>,
	rootRef: RefObject<HTMLDivElement | null>,
	stickRef: { current: boolean },
	layout: string,
) {
	const cache = useRef(new Map<string, Measurement>());
	const elements = useRef(new Map<string, HTMLDivElement>());
	const [revision, setRevision] = useState(0);
	const [position, setPosition] = useState<{ top: number; height: number } | null>(null);
	const [retained, setRetained] = useState<string | null>(null);
	const target = useRef<string | null>(null);
	const correction = useRef(0);
	const raf = useRef(0);
	const rows = useMemo(() => {
		const recentStart = messages.length > 30 ? messages.length - 15 : 0;
		return messages.flatMap((message, i): MessageRow[] =>
			message.role === "toolResult"
				? []
				: [{ message, old: i < recentStart, collapsed: i < recentStart && !expanded.has(message.id) }],
		);
	}, [messages, expanded]);
	const indices = useMemo(() => new Map(rows.map((row, i) => [row.message.id, i])), [rows]);
	const offsets = useMemo(
		() =>
			rowOffsets(
				rows.map((row) => {
					const measured = cache.current.get(row.message.id);
					return measured?.message === row.message && measured.collapsed === row.collapsed && measured.layout === layout
						? measured.height
						: row.collapsed
							? 44
							: estimateMessageHeight(row.message.role, row.message.customType);
				}),
			),
		[rows, layout, revision],
	);
	const total = offsets[offsets.length - 1];
	const viewportHeight = position?.height ?? 800;
	const top = stickRef.current
		? Math.max(0, total - viewportHeight)
		: (position?.top ?? Math.max(0, total - viewportHeight));
	const range = messages.length <= 30 ? { start: 0, end: rows.length } : visibleRowRange(offsets, top, viewportHeight);
	const rendered = renderedRowIndices(
		range.start,
		range.end,
		retained ? (indices.get(retained) ?? -1) : -1,
		rows.length,
	);
	const latest = useRef({ rows, offsets, indices, layout });
	latest.current = { rows, offsets, indices, layout };

	const update = useCallback(() => {
		const root = rootRef.current;
		if (!root) return;
		const current = latest.current;
		const anchor = rowAtOffset(current.offsets, root.scrollTop);
		let deltaAbove = 0;
		let changed = false;
		for (const [id, el] of elements.current) {
			const i = current.indices.get(id);
			if (i === undefined) continue;
			const row = current.rows[i];
			const height = Math.max(1, el.getBoundingClientRect().height);
			const oldHeight = current.offsets[i + 1] - current.offsets[i];
			if (Math.abs(height - oldHeight) > 0.5) {
				cache.current.set(id, { message: row.message, collapsed: row.collapsed, layout: current.layout, height });
				if (i < anchor) deltaAbove += height - oldHeight;
				changed = true;
			}
		}
		if (changed) {
			if (!stickRef.current && !target.current) correction.current += deltaAbove;
			setRevision((n) => n + 1);
		}
		setPosition((prev) =>
			prev?.top === root.scrollTop && prev.height === root.clientHeight
				? prev
				: { top: root.scrollTop, height: root.clientHeight },
		);
	}, [rootRef, stickRef]);
	const schedule = useCallback(() => {
		if (raf.current) return;
		raf.current = requestAnimationFrame(() => {
			raf.current = 0;
			update();
		});
	}, [update]);
	const observer = useRef<ResizeObserver | null>(null);
	const attach = useCallback((id: string, el: HTMLDivElement | null) => {
		const previous = elements.current.get(id);
		if (previous) observer.current?.unobserve(previous);
		if (el) {
			elements.current.set(id, el);
			observer.current?.observe(el);
		} else elements.current.delete(id);
	}, []);

	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		if (correction.current) {
			root.scrollTop += correction.current;
			correction.current = 0;
		}
		const id = target.current;
		const el = id ? elements.current.get(id) : null;
		if (el) {
			root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top;
			target.current = null;
		}
		update();
	}, [offsets, rendered.join(","), update, rootRef]);

	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const ro = new ResizeObserver(schedule);
		observer.current = ro;
		ro.observe(root);
		for (const el of elements.current.values()) ro.observe(el);
		let width = root.clientWidth;
		const resized = new ResizeObserver(() => {
			if (root.clientWidth === width) return;
			width = root.clientWidth;
			cache.current.clear();
			setRevision((n) => n + 1);
			schedule();
		});
		resized.observe(root);
		return () => {
			ro.disconnect();
			resized.disconnect();
			observer.current = null;
			cancelAnimationFrame(raf.current);
		};
	}, [rootRef, schedule]);
	useLayoutEffect(() => {
		for (const id of cache.current.keys()) if (!indices.has(id)) cache.current.delete(id);
		if (retained && !indices.has(retained)) setRetained(null);
	}, [indices, retained]);

	const reveal = useCallback(
		(id: string) => {
			const root = rootRef.current;
			const i = latest.current.indices.get(id);
			if (!root || i === undefined) return;
			target.current = id;
			setPosition({ top: latest.current.offsets[i], height: root.clientHeight });
		},
		[rootRef],
	);
	// An open edit composer stays mounted even after it scrolls away. Only one
	// user message can be actively edited via the focused composer at a time.
	const retainEditor = useCallback(() => {
		const root = rootRef.current;
		const active = document.activeElement;
		const editor =
			root?.contains(active) && active?.matches(".msg textarea")
				? active
				: root?.querySelector<HTMLTextAreaElement>(".msg textarea");
		setRetained(editor?.closest<HTMLElement>("[data-msg-id]")?.dataset.msgId ?? null);
	}, [rootRef]);
	const indexedIds = useMemo(() => {
		const shown = new Set(rendered.map((i) => rows[i].message.id));
		return new Set(rows.filter((row) => row.collapsed || !shown.has(row.message.id)).map((row) => row.message.id));
	}, [rows, rendered.join(",")]);
	return { rows, offsets, rendered, indexedIds, attach, schedule, reveal, retainEditor, elements };
}
