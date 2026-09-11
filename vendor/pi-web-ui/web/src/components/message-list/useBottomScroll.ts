/*
 * 🍞 AI Breadcrumb Navigation — @COUPLED=callers; @BUGFIX=regression contract.
 * @COUPLED ../MessageList.tsx, ../scroll-classify.ts, useRowWindow.ts
 * @BUGFIX 2026-09-10: preserve escape intent across window swaps and streaming finalization.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { classifyScroll } from "../scroll-classify";

export function useBottomScroll(rootRef: RefObject<HTMLDivElement | null>) {
	const [stickBottom, setStickBottom] = useState(true);
	const stickRef = useRef(true);
	const escaped = useRef(false);
	const graceUntil = useRef(0);
	const previous = useRef({ top: 0, height: 0 });
	const raf = useRef(0);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const snap = useCallback(() => {
		const root = rootRef.current;
		if (!root || !stickRef.current || escaped.current) return;
		// 🍞 @PERF 已经贴底时不要重复写 scrollTop：读 scrollHeight 本身就会强制布局，
		// 而写入会再让浏览器重算一遍——流式期间每 ~60ms 就有一次渲染。内容没长高
		// 时这里什么都不做；内容长了才真正贴底。
		if (root.scrollTop >= root.scrollHeight - root.clientHeight) return;
		root.scrollTop = root.scrollHeight;
	}, [rootRef]);
	const leaveBottom = useCallback(() => {
		escaped.current = true;
		stickRef.current = false;
		graceUntil.current = 0;
		setStickBottom(false);
	}, []);
	const onScroll = useCallback(() => {
		const root = rootRef.current;
		if (!root) return;
		const dSt = root.scrollTop - previous.current.top;
		const dSh = root.scrollHeight - previous.current.height;
		previous.current = { top: root.scrollTop, height: root.scrollHeight };
		const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
		const programmatic = Date.now() < graceUntil.current;
		const decision = classifyScroll({
			dSt,
			dSh,
			escaped: escaped.current,
			graceActive: programmatic,
			stuck: stickRef.current,
		});
		if (decision.reassert) {
			graceUntil.current = Date.now() + 250;
			snap();
		}
		if (decision.flipEscape) escaped.current = true;
		if (nearBottom && dSt >= 0) escaped.current = false;
		if (!programmatic) {
			if (dSt < 0) stickRef.current = nearBottom && !escaped.current;
			else if (nearBottom) stickRef.current = true;
		}
		setStickBottom(stickRef.current);
	}, [rootRef, snap]);
	const scrollToBottom = useCallback(() => {
		stickRef.current = true;
		escaped.current = false;
		setStickBottom(true);
		const reassert = () => {
			if (!stickRef.current || escaped.current) return;
			graceUntil.current = Date.now() + 250;
			snap();
		};
		reassert();
		for (const timer of timers.current) clearTimeout(timer);
		timers.current = [120, 300, 600].map((delay) => setTimeout(reassert, delay));
	}, [snap]);
	// Before paint, including stream -> persisted replacement and row measurements.
	useLayoutEffect(snap);
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const schedule = () => {
			if (raf.current) return;
			raf.current = requestAnimationFrame(() => {
				raf.current = 0;
				snap();
			});
		};
		const ro = new ResizeObserver(schedule);
		ro.observe(root);
		const mo = new MutationObserver(schedule);
		mo.observe(root, { childList: true, subtree: true, characterData: true });
		// Real input outranks the grace window, even immediately after a jump.
		const wheel = (event: WheelEvent) => {
			if (event.deltaY < 0) leaveBottom();
		};
		root.addEventListener("wheel", wheel, { passive: true });
		return () => {
			ro.disconnect();
			mo.disconnect();
			root.removeEventListener("wheel", wheel);
			cancelAnimationFrame(raf.current);
			for (const timer of timers.current) clearTimeout(timer);
		};
	}, [rootRef, snap, leaveBottom]);
	return { stickBottom, stickRef, onScroll, scrollToBottom, leaveBottom };
}
