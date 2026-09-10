import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FiChevronsLeft, FiChevronsRight } from "react-icons/fi";
import { useT } from "../i18n";
import type { ClientMessage } from "../types";
import type { AppConnection } from "./types";

// ---- 可拖拽面板宽度（桌面端；≤768px 抽屉模式固定宽度不受影响）----
const PANEL_MIN = 180;
const PANEL_MAX = 520;
const PANEL_DEFAULT = 240;
type PanelSide = "left" | "right";
const panelWidthKey = (side: PanelSide) => `pi-web-ui:${side}-panel-width`;
function readPanelWidth(side: PanelSide): number {
	const v = Number(localStorage.getItem(panelWidthKey(side)));
	return Number.isFinite(v) && v >= PANEL_MIN && v <= PANEL_MAX ? v : PANEL_DEFAULT;
}
const panelCollapsedKey = (side: PanelSide) => `pi-web-ui:${side}-panel-collapsed`;
function readPanelCollapsed(side: PanelSide): boolean {
	return localStorage.getItem(panelCollapsedKey(side)) === "1";
}

/** 面板与主区之间的拖拽分隔条：拖动改宽度，双击复位。 */
export function ResizeHandle({
	side,
	width,
	onResize,
}: {
	side: PanelSide;
	width: number;
	onResize: (w: number) => void;
}) {
	const t = useT();
	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = width;
			let last = startW;
			const move = (ev: PointerEvent) => {
				// 左侧手柄向右拖变宽，右侧相反
				const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
				last = Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(startW + delta)));
				onResize(last);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				document.body.classList.remove("panel-resizing");
				localStorage.setItem(panelWidthKey(side), String(last));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			document.body.classList.add("panel-resizing");
		},
		[side, width, onResize],
	);
	return (
		<div
			className={`resize-handle resize-${side}`}
			title={t("dragToResize")}
			onPointerDown={onPointerDown}
			onDoubleClick={() => onResize(PANEL_DEFAULT)}
		/>
	);
}

/** 面板折叠后留在原位置的展开条：贴在主区边缘，点击恢复面板。
 *  只在桌面端出现（移动端抽屉由顶栏按钮控制）。 */
export function PanelRail({ side, onClick }: { side: PanelSide; onClick: () => void }) {
	const t = useT();
	return (
		<button type="button" className={`panel-rail panel-rail-${side}`} title={t("expandPanel")} onClick={onClick}>
			{side === "left" ? <FiChevronsRight /> : <FiChevronsLeft />}
		</button>
	);
}

export function usePanels(send: AppConnection["send"]) {
	// 左右面板可拖拽宽度（桌面端）：localStorage 持久化，双击手柄复位。
	const [leftWidth, setLeftWidth] = useState(() => readPanelWidth("left"));
	const [rightWidth, setRightWidth] = useState(() => readPanelWidth("right"));
	const resizeLeft = useCallback((w: number) => setLeftWidth(w), []);
	const resizeRight = useCallback((w: number) => setRightWidth(w), []);
	// 左右面板折叠状态（桌面端）：localStorage 持久化，点击面板内收起按钮折叠，
	// 靠边缘的展开条恢复；移动端抽屉不受影响（始终由顶栏按钮开关）。
	const [leftCollapsed, setLeftCollapsed] = useState(() => readPanelCollapsed("left"));
	const [rightCollapsed, setRightCollapsed] = useState(() => readPanelCollapsed("right"));
	const toggleLeft = useCallback(() => {
		setLeftCollapsed((v) => {
			localStorage.setItem(panelCollapsedKey("left"), v ? "0" : "1");
			return !v;
		});
	}, []);
	const toggleRight = useCallback(() => {
		setRightCollapsed((v) => {
			localStorage.setItem(panelCollapsedKey("right"), v ? "0" : "1");
			return !v;
		});
	}, []);
	// Mobile: which side panel is open as a drawer (null = both closed).
	const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
	// Viewport class: ≤768px turns the side panels into sliding drawers
	// (matches the CSS breakpoint) — used to lazy-load panel data only when
	// a drawer is actually open on mobile.
	const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 768px)").matches);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	// Side panels live in mobile drawers — any action inside them (session
	// switch, cwd change, file list…) should close the drawer. Stable wrapper
	// so RightPanel's polling effect doesn't churn (send is stable).
	const panelSend = useCallback(
		(msg: ClientMessage) => {
			// Only close the mobile drawer on an explicit navigation/action. Mounting
			// LeftPanel fires read-only list_* probes that must NOT collapse the
			// freshly-opened drawer (they run through panelSend too). Otherwise the
			// drawer opens and immediately snaps shut.
			if (!msg.type.startsWith("list_") && !msg.type.startsWith("get_")) {
				setDrawer(null);
			}
			return send(msg);
		},
		[send],
	);

	return {
		leftWidth,
		rightWidth,
		resizeLeft,
		resizeRight,
		leftCollapsed,
		rightCollapsed,
		toggleLeft,
		toggleRight,
		drawer,
		setDrawer,
		isMobile,
		panelSend,
	};
}
