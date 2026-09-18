/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../chrome-collapse.ts（纯判定 + 单测）, ../chrome-collapse-settings.ts（开关）,
 *            ../components/ChatInput.tsx（setComposerFocused + collapsed）, ../components/GoalBar.tsx,
 *            ../components/MessageList.tsx（setAtBottom）, App.tsx（Provider）
 *   @CONTRACT 状态栏（FooterBar）不消费本上下文：它显示即时监控（上下文占用、缓存命中率、
 *             实时速率），不参与自动收起。
 *   📖 docs/architecture-core.md
 *   @CONTRACT 三个信号由消费方上报：消息列表报 atBottom、输入框报聚焦、App 提供 streaming；
 *             `collapsed` 由纯函数 chromeCollapsed 算出（规则见该文件）。
 *   @GOTCHA 上报必须**幂等**：重复上报同一个值不能重置用户的一次性手动值（MessageList 的
 *            effect 会在 context 变化时重跑，不问变化就清空 force 会把手动展开立刻吃掉）。
 * ────────────────────────────────────────────────────────────────────────── */
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PropsWithChildren,
} from "react";
import { chromeCollapsed, toggledForce, type ChromeForce } from "../chrome-collapse";
import { useAutoCollapseChrome } from "../chrome-collapse-settings";

export interface ChromeCollapseApi {
	/** true = 底部控件（目标条 / 输入工具条）应收起，把竖向空间让给正文。
	 *  底部状态栏不在此列（始终可见，见 chrome-collapse.ts 的 @CONTRACT）。 */
	collapsed: boolean;
	/** 会话是否停在最底部（MessageList 上报）。 */
	setAtBottom: (atBottom: boolean) => void;
	/** 输入框是否聚焦（ChatInput 上报）。 */
	setComposerFocused: (focused: boolean) => void;
	/** 手动展开/收起（一次性：滚动或新一轮输出后回到自动规则）。 */
	toggle: () => void;
}

const ChromeCollapseContext = createContext<ChromeCollapseApi | null>(null);

/**
 * 底部控件自动收缩的状态与上下文。
 * @WHY 放在 App 层而不是某个组件里：信号来自消息列表（滚动）与输入框（聚焦），
 *   消费方在状态栏/目标条/输入框三处 —— 只有提到共同祖先才不会出现「一半收起一半没动」。
 */
export function useChromeCollapseProvider(streaming: boolean, active = true): ChromeCollapseApi {
	const enabled = useAutoCollapseChrome();
	const [atBottom, setAtBottomState] = useState(true);
	const [focused, setFocusedState] = useState(false);
	const [force, setForce] = useState<ChromeForce>(null);
	const atBottomRef = useRef(true);
	const focusedRef = useRef(false);
	// 渲染期快照：toggle 需要「此刻」的收起状态（不能在 setState 回调解算）。
	const signalsRef = useRef({ streaming, atBottom, focused, force });
	signalsRef.current = { streaming, atBottom, focused, force };

	// 新一轮输出开始 → 丢掉上一次的一次性手动值（这一轮按规则收起）。
	const prevStreaming = useRef(streaming);
	useEffect(() => {
		if (streaming && !prevStreaming.current) setForce(null);
		prevStreaming.current = streaming;
	}, [streaming]);

	const setAtBottom = useCallback((next: boolean) => {
		if (atBottomRef.current === next) return; // 幂等：重复上报不动状态，也不吃手动值
		atBottomRef.current = next;
		setAtBottomState(next);
		// 滚动是新的意图：清掉一次性手动值，让规则说话（滑到最底部 = 展开，往上翻 = 收起）。
		setForce(null);
	}, []);

	const setComposerFocused = useCallback((next: boolean) => {
		if (focusedRef.current === next) return;
		focusedRef.current = next;
		setFocusedState(next);
	}, []);

	const toggle = useCallback(() => {
		setForce(toggledForce(chromeCollapsed(signalsRef.current)));
	}, []);

	const collapsed = enabled && active && chromeCollapsed({ streaming, atBottom, focused, force });
	return useMemo(
		() => ({ collapsed, setAtBottom, setComposerFocused, toggle }),
		[collapsed, setAtBottom, setComposerFocused, toggle],
	);
}

/** 提供底部控件收缩状态（App 挂一次）。
 * @CONTRACT `active` = 当前正在看对话（view === "chat"）：终端/Git 视图里不做任何收缩，
 *   否则用户在看终端时状态栏会因为后台的会话输出而消失。 */
export function ChromeCollapseProvider({
	streaming,
	active = true,
	children,
}: PropsWithChildren<{
	streaming: boolean;
	active?: boolean;
}>) {
	const api = useChromeCollapseProvider(streaming, active);
	return <ChromeCollapseContext.Provider value={api}>{children}</ChromeCollapseContext.Provider>;
}

/**
 * 读取底部控件收缩状态。
 * @CONTRACT 没有 Provider（例如单测直接渲染某个组件）时返回 null，消费方按「不收起」处理，
 *   这样组件可以脱离 App 独立渲染。
 */
export function useChromeCollapse(): ChromeCollapseApi | null {
	return useContext(ChromeCollapseContext);
}
