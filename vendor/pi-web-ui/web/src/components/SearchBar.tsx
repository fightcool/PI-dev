/*
 * 🍞 AI Breadcrumb Navigation
 * @COUPLED=linked files; @CONTRACT=interface contract; @GOTCHA=known trap
 * @COUPLED MessageList.tsx, message-list/search-dom.ts
 * @CONTRACT Search indexes unmounted rows from data and mounts only the active hit.
 * @GOTCHA Release stick-to-bottom before onExpand can mount or scroll a target.
 */
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FiChevronDown, FiChevronUp, FiX } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT } from "../i18n";
import {
	collectAllHits,
	hitIndexOf,
	scrollRangeIntoView,
	setHighlight,
	type HitKey,
	type SearchHit,
} from "./message-list/search-dom";

interface SearchBarProps {
	/** Message scroll container; DOM collection and scrolling stay inside it. */
	containerRef: RefObject<HTMLDivElement | null>;
	messages: readonly UiMessage[];
	/** ALL unmounted or collapsed rows. Other rows use their actual rendered text. */
	collapsedIds: ReadonlySet<string>;
	/** toolCallId → toolResult; data hits belong to the host toolCall message. */
	toolResults: ReadonlyMap<string, UiMessage>;
	/** Mount, expand and scroll this one target row; never render all for search. */
	onExpand: (id: string) => void;
	/** Release stick-to-bottom before any programmatic mount/jump. */
	onProgrammaticScroll?: () => void;
	open: boolean;
	onClose: () => void;
}

/** Browser-find style search: mounted text uses DOM Ranges and CSS Highlights;
 * unmounted text uses data hits until the selected row is mounted. Semantic keys
 * preserve the selected occurrence across that transition. Streaming refreshes
 * highlighting without taking over the user's scroll position. */
export function SearchBar({
	containerRef,
	messages,
	collapsedIds,
	toolResults,
	onExpand,
	onProgrammaticScroll,
	open,
	onClose,
}: SearchBarProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [activeKey, setActiveKey] = useState<HitKey | null>(null);
	const [total, setTotal] = useState(0);
	const [, setActiveIdx] = useState(0);
	const deferredQuery = useDeferredValue(query);
	const q = open ? deferredQuery.trim() : "";

	// Mirror the latest semantic position for rAF and navigation callbacks.
	const activeKeyRef = useRef<HitKey | null>(null);
	activeKeyRef.current = activeKey;
	const hitsRef = useRef<SearchHit[]>([]);
	const lastActiveRef = useRef<{ key: HitKey | null; kind?: string }>({ key: null });
	const lastQueryRef = useRef("");

	useEffect(() => {
		if (!open) return;
		setActiveKey(null);
		requestAnimationFrame(() => inputRef.current?.select());
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	useEffect(() => {
		if (!open) {
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
		}
		return () => {
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
		};
	}, [open]);

	// activeKey is a dependency so every prev/next refreshes the active range.
	// Scroll only for navigation, changed queries, or a folded→DOM transition.
	useLayoutEffect(() => {
		const clear = () => {
			setTotal(0);
			setActiveKey(null);
			setActiveIdx(0);
			hitsRef.current = [];
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
			lastActiveRef.current = { key: null };
			lastQueryRef.current = "";
		};
		if (!open || !q) {
			clear();
			return;
		}
		const wrap = containerRef.current;
		if (!wrap) return;
		let cancelled = false;
		const raf = requestAnimationFrame(() => {
			if (cancelled) return;
			const hits = collectAllHits(wrap, q, messages, collapsedIds, toolResults);
			hitsRef.current = hits;
			const n = hits.length;
			setTotal(n);
			if (n === 0) {
				setActiveKey(null);
				setActiveIdx(0);
				setHighlight("msg-search", []);
				setHighlight("msg-search-active", []);
				lastActiveRef.current = { key: null };
				lastQueryRef.current = q;
				return;
			}
			// DOM rendering can reduce occurrence counts (e.g. markdown escapes).
			// Clamp within the same message before falling back to the first hit.
			const key = activeKeyRef.current;
			let idx: number;
			if (key) {
				idx = hitIndexOf(hits, key);
				if (idx === -1) {
					const same: number[] = [];
					for (let j = 0; j < hits.length; j++) {
						if (hits[j].msgId === key.msgId) same.push(j);
					}
					idx = same.length > 0 ? same[Math.min(key.k, same.length - 1)] : 0;
				}
			} else {
				idx = 0;
			}
			if (idx < 0) idx = 0;
			if (idx >= n) idx = n - 1;
			// Equal values must not trigger another render/effect/rAF loop.
			if (!key || key.msgId !== hits[idx].msgId || key.k !== hits[idx].k) {
				setActiveKey({ msgId: hits[idx].msgId, k: hits[idx].k });
			}
			setActiveIdx(idx);
			const hit = hits[idx];
			const last = lastActiveRef.current;
			const userMoved =
				last.key?.msgId !== hit.msgId ||
				last.key?.k !== hit.k ||
				(last.kind === "folded" && hit.kind === "dom") ||
				q !== lastQueryRef.current;
			lastActiveRef.current = { key: { msgId: hit.msgId, k: hit.k }, kind: hit.kind };
			lastQueryRef.current = q;

			const allRanges = hits
				.filter((h): h is Extract<SearchHit, { kind: "dom" }> => h.kind === "dom")
				.map((h) => h.range);
			setHighlight("msg-search", allRanges);

			if (hit.kind === "folded") {
				// onExpand mounts + expands + scrolls only this row. Release the
				// host's bottom pin BEFORE it mutates DOM or schedules a jump.
				// The next collapsedIds update resolves the precise DOM range.
				setHighlight("msg-search-active", []);
				if (userMoved) {
					onProgrammaticScroll?.();
					onExpand(hit.msgId);
				}
				return;
			}
			setHighlight("msg-search-active", [hit.range]);
			if (userMoved) {
				onProgrammaticScroll?.();
				scrollRangeIntoView(wrap, hit.range);
			}
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
		};
	}, [open, q, messages, containerRef, activeKey, collapsedIds, toolResults, onExpand, onProgrammaticScroll]);

	const step = useCallback((dir: 1 | -1) => {
		const hits = hitsRef.current;
		const n = hits.length;
		if (n === 0) return;
		const key = activeKeyRef.current;
		const cur = key ? hitIndexOf(hits, key) : 0;
		const nextKey = hits[(cur + dir + n) % n];
		setActiveKey({ msgId: nextKey.msgId, k: nextKey.k });
	}, []);

	if (!open) return null;
	const shownIdx = activeKey ? Math.max(0, hitIndexOf(hitsRef.current, activeKey)) : 0;
	return (
		<div className="search-bar" role="search">
			<input
				ref={inputRef}
				className="search-input"
				type="text"
				value={query}
				placeholder={t("searchPlaceholder")}
				onChange={(e) => {
					// Keep the semantic key while typing; collection handles fallback.
					setQuery(e.target.value);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						step(e.shiftKey ? -1 : 1);
					}
				}}
			/>
			<span className={`search-count ${total === 0 ? "empty" : ""}`}>
				{total === 0 ? t("searchNoResults") : `${Math.min(shownIdx + 1, total)}/${total}`}
			</span>
			<button
				type="button"
				className="search-btn"
				title={t("searchPrev")}
				disabled={total === 0}
				onClick={() => step(-1)}
			>
				<FiChevronUp />
			</button>
			<button
				type="button"
				className="search-btn"
				title={t("searchNext")}
				disabled={total === 0}
				onClick={() => step(1)}
			>
				<FiChevronDown />
			</button>
			<button type="button" className="search-btn" title={t("searchClose")} onClick={onClose}>
				<FiX />
			</button>
		</div>
	);
}
