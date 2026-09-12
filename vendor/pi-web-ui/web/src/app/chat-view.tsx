/* 🍞 @COUPLED web/src/components/ChatInput.tsx, web/src/app/app-dialogs.tsx — 📖 docs/DEV-CON-PROPOSAL.md §6 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { LeftPanel } from "../components/LeftPanel";
import { RightPanel } from "../components/RightPanel";
import { ChatInput } from "../components/ChatInput";
import { GoalBar } from "../components/GoalBar";
import { useT } from "../i18n";
import { useWideChat } from "../chat-width-settings";
import type { PromptAttachment, UiMessage } from "../types";
import type { AppConnection, ViewName } from "./types";
import type { useAppDialogs } from "./use-app-dialogs";
import type { useAttachments } from "./use-attachments";
import { PanelRail, ResizeHandle, type usePanels } from "./panels";
import { perfMarkPaint } from "../perf-trace";
const Dialog = lazy(() => import("../components/Dialog").then((m) => ({ default: m.Dialog })));
// 🍞 @PERF 对话区（MessageList → Message → markdown 渲染器 + highlight.js）改为动态 chunk：
// 它以前是 App chunk 的**静态依赖**，于是「打开 WebSocket」必须等这 ~507KB（153KB gz）
// 下载并执行完。现在 App 一执行就握手，markdown 下载与 hello→首份 snapshot 并行。
// 对话区首屏必定要用，所以挂载后立刻预取——目的是并行，不是条件加载。
const MessageList = lazy(() => import("../components/MessageList").then((m) => ({ default: m.MessageList })));
const DshQuestionDialog = lazy(() =>
	import("../components/DshQuestionDialog").then((m) => ({ default: m.DshQuestionDialog })),
);
const EMPTY_MESSAGES: UiMessage[] = [];

/** @COUPLED components/MessageList.tsx: callbacks must survive token deltas. */
export function ChatView({
	connection,
	view,
	panels,
	dialogs,
	uploads,
}: {
	connection: AppConnection;
	view: ViewName;
	panels: ReturnType<typeof usePanels>;
	dialogs: ReturnType<typeof useAppDialogs>;
	uploads: ReturnType<typeof useAttachments>;
}) {
	const { chat, send, pushNotice, channelApi } = connection;
	const t = useT();
	const wide = useWideChat();
	const {
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
	} = panels;
	const { setPreviewFile, searchJump, onJumpDone, openManageModels, openUsage } = dialogs;
	const {
		attachments,
		attach,
		clearAttachments,
		removeAttachment: removeAttachmentCb,
		addImageFiles: addImageFilesCb,
		addLocalFiles: addLocalFilesCb,
	} = uploads;
	const onKillBash = useCallback(() => {
		send({ type: "abort_bash" });
	}, [send]);
	const onRetry = useCallback(() => {
		send({ type: "retry_last" });
	}, [send]);
	// Edit-and-re-ask: the server forks a new session at that message and re-asks
	// the edited text there (stable callback — Message is memoized). Attachments
	// carry the question's original images (fork drops their aside cards) plus
	// any newly pasted/dropped ones — same pipeline as a normal prompt.
	const onEditMessage = useCallback(
		(messageId: string, text: string, attachments?: PromptAttachment[]) => {
			send({ type: "edit_message", messageId, text, attachments });
		},
		[send],
	);

	// Remove one queued prompt (the ✕ on a pending bubble).
	const onRemoveQueued = useCallback(
		(kind: "steer" | "followUp", text: string) => {
			send({ type: "queue_remove", kind, text });
		},
		[send],
	);

	// Narrow snapshot of the model/thinking fields for the memoized ChatInput →
	// ModelThinking chain; identity is stable while tokens stream in.
	const model = chat.state?.model;
	const thinkingLevel = chat.state?.thinkingLevel;
	const availableThinkingLevels = chat.state?.availableThinkingLevels;
	const modelState = useMemo(
		() =>
			model
				? {
						model,
						thinkingLevel: thinkingLevel ?? "off",
						availableThinkingLevels: availableThinkingLevels ?? [],
					}
				: null,
		// Deps are the STABLE inner refs (server reuses them across snapshots),
		// so the object identity survives token deltas and ChatInput's memo holds.
		[model, thinkingLevel, availableThinkingLevels],
	);
	// DEV-CON：channelBinding 由服务端在每个 checkpoint 重新构造（对象身份每次都变），
	// 直接透传会击穿上面这条 memo 链；按内容键缓存，内容不变就保持同一引用。
	const rawChannelBinding = chat.state?.channelBinding ?? null;
	const channelBindingKey = rawChannelBinding
		? JSON.stringify([rawChannelBinding.source, rawChannelBinding.effective, rawChannelBinding.pending])
		: "";
	const channelBinding = useMemo(() => rawChannelBinding, [channelBindingKey]);

	// 端到端打点：会话内容「已提交到 DOM」的时刻（配合 switch 点击点算出可感知延迟）。
	// 依赖只看 conversationId，流式 token 不会反复打点。
	const activeConvId = chat.state?.conversationId ?? null;
	const paintedConvRef = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (!activeConvId || paintedConvRef.current === activeConvId) return;
		paintedConvRef.current = activeConvId;
		perfMarkPaint(activeConvId);
	}, [activeConvId]);

	return (
		<div className={`view-pane ${view === "chat" ? "" : "hidden"}`}>
			{!isMobile && leftCollapsed && <PanelRail side="left" onClick={toggleLeft} />}
			<div
				className={`panel-drawer drawer-left ${drawer === "left" ? "open" : ""}${isMobile ? "" : leftCollapsed ? " hidden" : ""}`}
			>
				<LeftPanel
					collapsible={!isMobile}
					onToggleCollapse={toggleLeft}
					send={panelSend}
					active={!isMobile || drawer === "left"}
					ready={chat.ready}
					status={chat.status}
					cwd={chat.state?.cwd ?? ""}
					sessionFile={chat.state?.sessionFile ?? null}
					conversations={chat.conversations}
					sessions={chat.sessions}
					projects={chat.projects}
					activeConversationId={chat.activeConversationId}
				/>
			</div>
			{!isMobile && <ResizeHandle side="left" width={leftWidth} onResize={resizeLeft} />}
			<main className={wide ? "main wide-chat" : "main"}>
				{chat.state && !chat.switching ? (
					// 对话区 chunk 还没到位时先占位（与首帧占位同一外观）。
					<Suspense
						fallback={
							<div className="boot-wait" role="status">
								{t("loadingSession")}
							</div>
						}
					>
						<MessageList
							key={chat.state.conversationId ?? "boot"}
							state={chat.state}
							liveOutputs={chat.liveOutputs}
							toolStatuses={chat.toolStatuses}
							onEdit={onEditMessage}
							onKillBash={onKillBash}
							onRetry={onRetry}
							onRemoveQueued={onRemoveQueued}
							// 尾部优先历史：向上翻/搜索前补全更早的消息（P1-8）。
							onLoadHistory={(opts) => send({ type: "load_history", ...opts })}
							thinkingWrap={chat.settings?.thinkingWrap ?? true}
							toolsWrap={chat.settings?.toolsWrap ?? false}
							jumpTarget={searchJump}
							onJumpDone={onJumpDone}
						/>
					</Suspense>
				) : (
					// 首帧加载与乐观切换共用同一个占位：切换时先揭掉上一个会话的内容，
					// 目标快照一到（reducer 清掉 switching）立刻换成真实内容——不再出现
					// 「点了没反应，几秒后整页跳一下」的观感。
					<div className="boot-wait" role="status" aria-live="polite">
						{chat.ready ? t("loadingSession") : t("connectingServer")}
					</div>
				)}
				{chat.settings?.goalModeEnabled !== false && (
					<GoalBar
						send={send}
						goal={chat.goal}
						models={chat.models}
						modelsLoading={chat.modelsLoading}
						activeConversationId={chat.activeConversationId}
						engine={chat.engine}
					/>
				)}
				{/* 扩展问卷：非模态内联面板，插在输入框上方，对话内容保持可见 */}
				<Suspense fallback={null}>{chat.dialog && <Dialog dialog={chat.dialog} send={send} />}</Suspense>
				<Suspense fallback={null}>
					{chat.question && <DshQuestionDialog question={chat.question} send={send} />}
				</Suspense>
				<ChatInput
					send={send}
					ready={chat.ready}
					streaming={chat.state?.isStreaming ?? false}
					messages={chat.state?.messages ?? EMPTY_MESSAGES}
					slashCommands={chat.slashCommands}
					modelState={modelState}
					models={chat.models}
					modelsLoading={chat.modelsLoading}
					providerKeys={chat.providerKeys}
					channelState={chat.channelState}
					channelBinding={channelBinding}
					channelResults={chat.channelResults}
					channelApi={channelApi}
					attachments={attachments}
					onRemoveAttachment={removeAttachmentCb}
					onAddImageFiles={addImageFilesCb}
					onAddLocalFiles={addLocalFilesCb}
					onNotice={pushNotice}
					onManageModels={openManageModels}
					onOpenUsage={openUsage}
					onSent={clearAttachments}
					quickPhrases={chat.settings?.quickPhrases ?? []}
					quickPhrasesEnabled={chat.settings?.quickPhrasesEnabled ?? true}
				/>
			</main>
			{!isMobile && <ResizeHandle side="right" width={rightWidth} onResize={resizeRight} />}
			<div
				className={`panel-drawer drawer-right ${drawer === "right" ? "open" : ""}${isMobile ? "" : rightCollapsed ? " hidden" : ""}`}
			>
				<RightPanel
					collapsible={!isMobile}
					onToggleCollapse={toggleRight}
					send={panelSend}
					files={chat.files}
					fileChanged={chat.fileChanged}
					widgets={chat.widgets}
					cwd={chat.state?.cwd ?? ""}
					onAttach={(path, name, mode, isDir) => {
						setDrawer(null);
						attach(path, name, mode, isDir);
					}}
					onPreview={(path, name) => {
						setDrawer(null);
						setPreviewFile({ path, name });
					}}
					onNotice={(level, text) => pushNotice(level, text)}
				/>
			</div>
			{!isMobile && rightCollapsed && <PanelRail side="right" onClick={toggleRight} />}
		</div>
	);
}
