/*
 * 🍞 AI Breadcrumb Navigation — @COUPLED=linked modules; @CONTRACT=public API.
 * @COUPLED ../App.tsx, ./SearchBar.tsx, ./message-list/useRowWindow.ts, ./message-list/QuestionNavigation.tsx
 * @CONTRACT App callbacks and conversation key remain unchanged. Offscreen rows have no DOM anchors;
 * all navigation resolves message ids through useRowWindow before querying mounted DOM.
 * @BUGFIX 2026-09-10: bound collapsed history and initial mount with aggregate spacers.
 * 📖 docs/architecture-core.md
 */
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiArrowDown } from "react-icons/fi";
import type { PromptAttachment, ToolStatus, UiChannelInfo, UiMessage, UiState } from "../types";
import { Message, asText } from "./Message";
import { channelErrorView, type ChannelErrorView } from "../error-hint";
import { collectQuestionAttachments } from "../question-attachments";
import { parseSkillBlock } from "../skill-block";
import { CollapsedMessage } from "./CollapsedMessage";
import { SearchBar } from "./SearchBar";
import { EmptyTemplateCards } from "./PromptTemplates";
import { useT } from "../i18n";
import { useRowWindow } from "./message-list/useRowWindow";
import { useBottomScroll } from "./message-list/useBottomScroll";
import { MessageListStatus } from "./message-list/MessageListStatus";
import { QuestionNavigation } from "./message-list/QuestionNavigation";

const EMPTY_LIVE = new Map<string, { toolName: string; text: string }>();
/** 没有渠道清单时的稳定空数组（避免每次 render 新数组，冲掉 errorHints 的 memo）。 */
const EMPTY_CHANNELS: UiChannelInfo[] = [];
const hasToolCall = (m: UiMessage) => m.content.some((b) => b.type === "toolCall");

interface MessageListProps {
	state: UiState;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	onEdit?: (messageId: string, text: string, attachments?: PromptAttachment[]) => void;
	onKillBash?: () => void;
	onRetry?: () => void;
	onRemoveQueued?: (kind: "steer" | "followUp", text: string) => void;
	/** 尾部优先历史：请求更早的一页（`all` = 搜索/问题导航前一次补全）。 */
	onLoadHistory?: (opts: { before?: string; all?: boolean }) => void;
	thinkingWrap?: boolean;
	toolsWrap?: boolean;
	/** 渠道清单（channel_state）：报错卡需要把消息里的 providerId 还原成渠道显示名。
	 *  UiState 本身不带渠道清单，所以由 chat-view 单独传入。 */
	channels?: UiChannelInfo[];
	jumpTarget?: { path: string; role: string; timestamp: number } | null;
	onJumpDone?: () => void;
}

const MeasuredRow = memo(function MeasuredRow({
	id,
	attach,
	children,
}: {
	id: string;
	attach: (id: string, el: HTMLDivElement | null) => void;
	children: ReactNode;
}) {
	const ref = useCallback((el: HTMLDivElement | null) => attach(id, el), [attach, id]);
	return (
		<div ref={ref} data-row-id={id} style={{ display: "flow-root" }}>
			{children}
		</div>
	);
});

export function MessageList({
	state,
	liveOutputs,
	toolStatuses,
	onEdit,
	onKillBash,
	onRetry,
	onRemoveQueued,
	onLoadHistory,
	thinkingWrap,
	toolsWrap,
	channels: channelsProp,
	jumpTarget,
	onJumpDone,
}: MessageListProps) {
	const t = useT();
	const scrollRef = useRef<HTMLDivElement>(null);
	const bottom = useBottomScroll(scrollRef);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [searchOpen, setSearchOpen] = useState(false);
	const messages = useMemo(
		() => (state.streamingMessage ? [...state.messages, state.streamingMessage] : state.messages),
		[state.messages, state.streamingMessage],
	);
	const windowed = useRowWindow(
		state.messages,
		expanded,
		scrollRef,
		bottom.stickRef,
		`${searchOpen}:${thinkingWrap}:${toolsWrap}`,
	);
	const toolResults = useMemo(() => {
		const map = new Map<string, UiMessage>();
		for (const message of state.messages)
			if (message.role === "toolResult" && message.toolCallId) map.set(message.toolCallId, message);
		return map;
	}, [state.messages]);
	const questionAttachments = useMemo(() => collectQuestionAttachments(state.messages), [state.messages]);
	/** 当前对话有效绑定的渠道 id（报错归属的首选）；取到基本类型，Memo 依赖才不会每次快照都变。 */
	const boundChannelId = state.channelBinding?.effective?.channelId ?? null;
	/**
	 * 报错消息的上下文（渠道 · 模型 · 人话原因 · 充值页）。
	 * @WHY 只在**报错消息**上算：普通消息不进 Map，报错卡拿到的一直是同一个对象，
	 *   Message 的 memo 不会因为每次快照重算而失效。
	 */
	const errorHints = useMemo(() => {
		const map = new Map<string, ChannelErrorView>();
		const channels = channelsProp ?? EMPTY_CHANNELS;
		for (const message of state.messages) {
			if (!message.errorMessage) continue;
			map.set(
				message.id,
				channelErrorView({
					errorMessage: message.errorMessage,
					provider: message.provider,
					modelId: message.model,
					channels,
					boundChannelId,
				}),
			);
		}
		return map;
	}, [state.messages, channelsProp, boundChannelId]);
	const questions = useMemo(
		() =>
			state.messages.flatMap((message) => {
				if (message.role !== "user") return [];
				const joined = message.content
					.map((b) => asText(b)?.text ?? "")
					.filter(Boolean)
					.join(" ");
				const skill = parseSkillBlock(joined);
				const text = skill ? (skill.userMessage ?? `skill:${skill.name}`) : joined.trim();
				return text ? [{ id: message.id, text }] : [];
			}),
		[state.messages],
	);
	const qnIndex = useMemo(() => new Map(questions.map((q, i) => [q.id, i])), [questions]);
	const [activeIdx, setActiveIdx] = useState(-1);
	const lastId = messages[messages.length - 1]?.id;
	const expand = useCallback((id: string) => setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);
	const collapse = useCallback(
		(id: string) =>
			setExpanded((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			}),
		[],
	);
	const jumpFrame = useRef(0);
	const jumpTo = useCallback(
		(id: string) => {
			bottom.leaveBottom();
			expand(id);
			windowed.reveal(id);
			setActiveIdx(qnIndex.get(id) ?? -1);
			cancelAnimationFrame(jumpFrame.current);
			jumpFrame.current = requestAnimationFrame(() => {
				const row = windowed.elements.current.get(id);
				scrollRef.current?.querySelectorAll(".msg-flash").forEach((el) => el.classList.remove("msg-flash"));
				const node = row?.querySelector<HTMLElement>("[data-msg-id]");
				if (node) {
					node.classList.remove("msg-flash");
					void node.offsetWidth;
					node.classList.add("msg-flash");
				}
			});
		},
		[bottom.leaveBottom, expand, windowed.reveal, windowed.elements, qnIndex],
	);
	useEffect(() => () => cancelAnimationFrame(jumpFrame.current), []);

	// ---------------------------------------------------------------------
	// 尾部优先历史（P1-8）：大历史首屏只带最近若干条，更早的按需补。
	// @PERF 目标是把「切换会话」的 wire 从数百 KB 降到几十 KB（实测见
	// docs/PERF-SESSION-LOAD.md）；代价是向上翻/搜索时要补一次。
	// ---------------------------------------------------------------------
	const omitted = state.messagesOmitted ?? 0;
	const loadingOlder = useRef(false);
	/** 用户按了搜索但历史还没补全：补全到位后自动打开。 */
	const pendingSearch = useRef(false);
	/** 前置历史时保住视口：记录滚动前的 scrollHeight，DOM 更新后补回差值。 */
	const prependAnchor = useRef<{ height: number; top: number } | null>(null);
	const requestOlder = useCallback(
		(all: boolean) => {
			if (!onLoadHistory || loadingOlder.current) return;
			const root = scrollRef.current;
			loadingOlder.current = true;
			if (root) prependAnchor.current = { height: root.scrollHeight, top: root.scrollTop };
			// 总是带 before：服务端只回「缺的那一段」，不会把已持有的尾部再发一遍。
			onLoadHistory({ before: state.messages[0]?.id, ...(all ? { all: true } : {}) });
		},
		[onLoadHistory, state.messages],
	);
	useLayoutEffect(() => {
		// 新的一页到位：把视口按高度差补回去（否则视口会被顶到很下面）。
		const anchor = prependAnchor.current;
		loadingOlder.current = false;
		if (!anchor) return;
		prependAnchor.current = null;
		const root = scrollRef.current;
		if (!root) return;
		root.scrollTop = anchor.top + (root.scrollHeight - anchor.height);
	}, [state.messages]);

	/**
	 * 打开会话内搜索。历史被截断时先补全（客户端搜索是对已加载 messages 建索引，
	 * 只搜尾部会给出「搜不到」的假象）；补全后再开，用户看到的是完整命中集。
	 * 这是与需求方确认过的方案 A：补全发生在一次显式动作之前，代价是一次全量传输。
	 */
	const openSearch = useCallback(() => {
		if ((state.messagesOmitted ?? 0) > 0 && onLoadHistory) {
			requestOlder(true);
			pendingSearch.current = true;
			return;
		}
		setSearchOpen(true);
	}, [onLoadHistory, requestOlder, state.messagesOmitted]);
	useEffect(() => {
		// 补全到位（omitted 归零）→ 兑现用户刚才的搜索意图。
		if (!pendingSearch.current || (state.messagesOmitted ?? 0) > 0) return;
		pendingSearch.current = false;
		setSearchOpen(true);
	}, [state.messagesOmitted]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
			const target = event.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
			event.preventDefault();
			openSearch();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [openSearch]);
	// Search only mounts its current target. Ordinary scrolling remains virtual.
	const revealSearch = useCallback(
		(id: string) => {
			bottom.leaveBottom();
			expand(id);
			windowed.reveal(id);
		},
		[bottom.leaveBottom, expand, windowed.reveal],
	);
	const [freshCompactionId, setFreshCompactionId] = useState<string | null>(null);
	const seenCompactions = useRef<Set<string> | null>(null);
	useEffect(() => {
		const ids = state.messages.filter((m) => m.role === "compactionSummary").map((m) => m.id);
		if (seenCompactions.current) {
			const fresh = ids.find((id) => !seenCompactions.current!.has(id));
			if (fresh) {
				setFreshCompactionId(fresh);
				jumpTo(fresh);
			}
		}
		seenCompactions.current = new Set(ids);
	}, [state.messages, jumpTo]);
	useEffect(() => {
		if (!jumpTarget || state.sessionFile !== jumpTarget.path) return;
		const target = state.messages.find((m) => m.role === jumpTarget.role && m.timestamp === jumpTarget.timestamp);
		if (target) {
			jumpTo(target.id);
			onJumpDone?.();
		} else if (state.messages.length) onJumpDone?.();
	}, [jumpTarget, state.sessionFile, state.messages, jumpTo, onJumpDone]);
	// Binary search estimated/measured row offsets instead of querying every question.
	useEffect(() => {
		const root = scrollRef.current;
		if (!root || !questions.length) return;
		const rowIndex = new Map(windowed.rows.map((row, i) => [row.message.id, i]));
		let lo = 0,
			hi = questions.length - 1,
			best = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const at = windowed.offsets[rowIndex.get(questions[mid].id) ?? 0];
			if (at <= root.scrollTop + 140) {
				best = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		setActiveIdx(best);
	}, [questions, windowed.offsets, windowed.rendered.join(",")]);
	const onScroll = () => {
		bottom.onScroll();
		windowed.retainEditor();
		windowed.schedule();
		// 滚到顶部附近且还有更早的消息 → 自动补一页（节流由 loadingOlder 守住）。
		const root = scrollRef.current;
		if (omitted > 0 && root && root.scrollTop <= 48) requestOlder(false);
	};
	let previousEnd = 0;
	return (
		<div className="messages-wrap">
			<div
				className="messages"
				ref={scrollRef}
				onScroll={onScroll}
				onFocusCapture={windowed.retainEditor}
				style={{ overflowAnchor: "none" }}
			>
				{omitted > 0 && (
					<div className="msg-older">
						<button type="button" className="msg-older-btn" onClick={() => requestOlder(false)}>
							{t("loadEarlierMessages", { n: omitted })}
						</button>
					</div>
				)}
				{!messages.length && (
					<div className="empty-state">
						<EmptyTemplateCards />
					</div>
				)}
				{windowed.rendered.map((i) => {
					const { message: m, collapsed, old } = windowed.rows[i];
					const gap = windowed.offsets[i] - windowed.offsets[previousEnd];
					previousEnd = i + 1;
					const qIdx = qnIndex.get(m.id);
					return (
						<Fragment key={m.id}>
							{gap > 0 && <div className="msg-window-spacer" aria-hidden="true" style={{ height: gap }} />}
							<MeasuredRow id={m.id} attach={windowed.attach}>
								{collapsed ? (
									<CollapsedMessage message={m} onExpand={expand} />
								) : (
									<Message
										message={m}
										errorHint={errorHints.get(m.id)}
										qnIndex={qIdx}
										qnActive={qIdx === activeIdx}
										onJump={jumpTo}
										toolResults={toolResults}
										liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
										toolStatuses={toolStatuses}
										streaming={state.isStreaming}
										onKillBash={onKillBash}
										onRetry={m.id === lastId ? onRetry : undefined}
										toolsWrap={toolsWrap}
										thinkingWrap={thinkingWrap}
										isLast={m.id === lastId}
										onEdit={onEdit}
										questionAttachments={questionAttachments.get(m.id)}
										onCollapse={old ? collapse : undefined}
										searchActive={searchOpen}
										autoExpand={m.id === freshCompactionId}
									/>
								)}
							</MeasuredRow>
						</Fragment>
					);
				})}
				{previousEnd < windowed.rows.length && (
					<div
						className="msg-window-spacer"
						aria-hidden="true"
						style={{ height: windowed.offsets[windowed.rows.length] - windowed.offsets[previousEnd] }}
					/>
				)}
				{state.streamingMessage && (
					<Message
						key={state.streamingMessage.id}
						message={state.streamingMessage}
						toolResults={toolResults}
						liveOutputs={hasToolCall(state.streamingMessage) ? liveOutputs : EMPTY_LIVE}
						toolStatuses={toolStatuses}
						streaming
						isLast
						onEdit={onEdit}
						onKillBash={onKillBash}
						toolsWrap={toolsWrap}
						thinkingWrap={thinkingWrap}
						searchActive={searchOpen}
					/>
				)}
				<MessageListStatus state={state} onRemoveQueued={onRemoveQueued} />
			</div>
			{!bottom.stickBottom && (
				<button type="button" className="scroll-bottom" onClick={bottom.scrollToBottom}>
					<FiArrowDown /> {t("backToBottom")}
				</button>
			)}
			<SearchBar
				containerRef={scrollRef}
				messages={messages}
				collapsedIds={windowed.indexedIds}
				toolResults={toolResults}
				onExpand={revealSearch}
				onProgrammaticScroll={bottom.leaveBottom}
				open={searchOpen}
				onClose={() => setSearchOpen(false)}
			/>
			<QuestionNavigation questions={questions} activeIdx={activeIdx} onJump={jumpTo} scrollRef={scrollRef} />
		</div>
	);
}
