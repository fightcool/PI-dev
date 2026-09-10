/*
 * AI Breadcrumb Navigation
 * @COUPLED (integration): ../MessageList.tsx owns activeIdx and onJump.
 * @COUPLED (layout): ../../styles.css .qn-*; ./question-navigation-window.ts.
 * @CONTRACT: questions use stable unique ids; no message DOM scanning here.
 * @WHY: fixed rows and sampled ticks bound rendering, not question availability.
 * Docs: vendor/pi-web-ui/docs/architecture-core.md; docs/development.md.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, RefObject } from "react";
import { useT } from "../../i18n";
import {
	QUESTION_LIST_HEIGHT,
	QUESTION_ROW_HEIGHT,
	questionListWindow,
	questionRailIndices,
} from "./question-navigation-window";

export interface QuestionNavigationProps {
	questions: readonly { id: string; text: string }[];
	activeIdx: number;
	onJump: (id: string) => void;
	scrollRef: RefObject<HTMLDivElement | null>;
}

export function QuestionNavigation({ questions, activeIdx, onJump, scrollRef }: QuestionNavigationProps) {
	const t = useT();
	const id = useId();
	const railRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState(600);
	const [open, setOpen] = useState(false);
	const [cursor, setCursor] = useState(0);
	const [scrollTop, setScrollTop] = useState(0);
	const count = questions.length;
	const current = Math.max(0, Math.min(cursor, count - 1));
	const indices = questionRailIndices(count, activeIdx, height);
	const listHeight = Math.min(QUESTION_LIST_HEIGHT, Math.max(28, height - 20), count * QUESTION_ROW_HEIGHT);
	const windowed = questionListWindow(count, scrollTop, listHeight);
	const gap = Math.max(0, Math.min(27, (height - 20 - indices.length * 3) / Math.max(1, indices.length - 1)));

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const measure = () => setHeight(el.clientHeight);
		measure();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		observer?.observe(el);
		window.addEventListener("resize", measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [scrollRef]);

	useLayoutEffect(() => {
		const list = listRef.current;
		if (!list) return;
		list.scrollTop = windowed.top;
		if (scrollTop !== windowed.top) setScrollTop(windowed.top);
	}, [windowed.top, scrollTop]);

	// @GOTCHA: CSS opens only on hover. Inline visibility also supports focus/touch/Escape.
	const reveal = (index = activeIdx) => {
		const next = Math.max(0, Math.min(index, count - 1));
		setCursor(next);
		setScrollTop(questionListWindow(count, next * QUESTION_ROW_HEIGHT - listHeight / 2, listHeight).top);
		setOpen(true);
	};

	useEffect(() => {
		const rail = railRef.current;
		if (!rail) return;
		const wheel = (event: WheelEvent) => {
			const list = listRef.current;
			const inList = list?.contains(event.target as Node);
			const target = inList ? list : scrollRef.current;
			if (!target) return;
			event.preventDefault();
			const delta =
				event.deltaY * (event.deltaMode === 1 ? QUESTION_ROW_HEIGHT : event.deltaMode === 2 ? target.clientHeight : 1);
			target.scrollTop += delta;
			if (inList) setScrollTop(target.scrollTop);
		};
		rail.addEventListener("wheel", wheel, { passive: false });
		return () => rail.removeEventListener("wheel", wheel);
	}, [scrollRef, count > 0]);

	const jump = (index: number) => {
		const question = questions[index];
		if (question) onJump(question.id);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			railRef.current?.focus({ preventScroll: true });
			setOpen(false);
			return;
		}
		const page = Math.max(1, Math.floor(listHeight / QUESTION_ROW_HEIGHT));
		const next = {
			ArrowDown: current + 1,
			ArrowUp: current - 1,
			Home: 0,
			End: count - 1,
			PageDown: current + page,
			PageUp: current - page,
		}[event.key];
		if (next !== undefined) {
			event.preventDefault();
			reveal(next);
			listRef.current?.focus({ preventScroll: true });
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			if (open) jump(current);
			else reveal();
		}
	};

	if (count === 0) return null;
	return (
		<div
			className="qn-rail many"
			ref={railRef}
			role="navigation"
			tabIndex={0}
			aria-label={t("questionNavTitle")}
			style={{ "--rail-gap": `${gap}px` } as CSSProperties}
			onMouseEnter={() => {
				if (!open) reveal();
			}}
			onMouseLeave={() => {
				if (!railRef.current?.contains(document.activeElement)) setOpen(false);
			}}
			onFocus={(event) => {
				if (!open && !event.currentTarget.contains(event.relatedTarget)) reveal();
			}}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
			}}
			onKeyDown={onKeyDown}
		>
			{indices.map((index) => (
				<button
					type="button"
					key={questions[index].id}
					className={`qn-bar ${index === activeIdx ? "active" : ""}`}
					tabIndex={-1}
					aria-label={`${index + 1}. ${questions[index].text}`}
					aria-current={index === activeIdx ? "step" : undefined}
					onClick={() => {
						reveal(index);
						jump(index);
					}}
				/>
			))}
			<div
				className="qn-list"
				ref={listRef}
				role="listbox"
				tabIndex={open ? 0 : -1}
				aria-label={t("questionNavTitle")}
				aria-activedescendant={current >= windowed.start && current < windowed.end ? `${id}-${current}` : undefined}
				onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
				style={{
					display: "block",
					height: listHeight,
					maxHeight: "100%",
					bottom: "auto",
					padding: 0,
					boxSizing: "content-box",
					overflowAnchor: "none",
					overscrollBehavior: "contain",
					visibility: open ? "visible" : "hidden",
					opacity: open ? 1 : 0,
					pointerEvents: open ? "auto" : "none",
				}}
			>
				<div role="presentation" style={{ height: count * QUESTION_ROW_HEIGHT, position: "relative" }}>
					{questions.slice(windowed.start, windowed.end).map((question, offset) => {
						const index = windowed.start + offset;
						return (
							<button
								type="button"
								key={question.id}
								id={`${id}-${index}`}
								role="option"
								tabIndex={-1}
								aria-selected={index === current}
								aria-current={index === activeIdx ? "step" : undefined}
								aria-posinset={index + 1}
								aria-setsize={count}
								aria-label={`${index + 1}. ${question.text}`}
								className={`qn-list-item ${index === activeIdx ? "active" : ""}`}
								style={{
									position: "absolute",
									top: index * QUESTION_ROW_HEIGHT,
									left: 0,
									width: "100%",
									height: QUESTION_ROW_HEIGHT - 2,
									boxSizing: "border-box",
									outline: open && index === current ? "1px solid var(--accent)" : undefined,
									outlineOffset: -1,
								}}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => {
									setCursor(index);
									listRef.current?.focus({ preventScroll: true });
									jump(index);
								}}
							>
								<span className="qn-list-idx">{index + 1}</span>
								<span className="qn-list-text">{question.text}</span>
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
