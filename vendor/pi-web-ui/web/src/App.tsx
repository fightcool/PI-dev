/**
 * 🍞 AI Breadcrumb: @COUPLED app/chat-view.tsx, app/app-views.tsx, app/app-dialogs.tsx.
 * @CONTRACT One useChat connection owns buffers; views mount on access and stay
 * mounted while hidden. PendingAttachment remains a type-only public export.
 */
import { useCallback, type CSSProperties } from "react";
import { TopBar } from "./components/TopBar";
import { FooterBar } from "./components/FooterBar";
import { TemplateProvider } from "./components/PromptTemplates";
import { useChat } from "./use-chat";
import { useT } from "./i18n";
import { playSound, type SoundKind } from "./sounds";
import { AppDialogs } from "./app/app-dialogs";
import { AppViews } from "./app/app-views";
import { ChatView } from "./app/chat-view";
import { NoticeToast } from "./app/notices";
import { usePanels } from "./app/panels";
import { useAppDialogs } from "./app/use-app-dialogs";
import { useAppEffects } from "./app/use-app-effects";
import { useAppViews } from "./app/use-app-views";
import { useAttachments } from "./app/use-attachments";
import { useTerminalViewBridge } from "./app/use-terminal-view-bridge";
import type { ViewName } from "./app/types";
export type { PendingAttachment } from "./app/use-attachments";

export function App() {
	const t = useT();
	const baseConnection = useChat();
	const { chat, dismissNotice, pushNotice } = baseConnection;
	const { terminal, terminalSend, send } = useTerminalViewBridge(
		baseConnection,
		!chat.tabs || chat.tabs.includes("terminal"),
	);
	const connection = { ...baseConnection, send, terminal };
	const views = useAppViews(connection);
	const panels = usePanels(send);
	const dialogs = useAppDialogs();
	const uploads = useAttachments(chat, pushNotice);
	const { sound, setSound, themes, theme, switchTheme } = useAppEffects(chat, send);
	const { setView, chooseView } = views;
	const { setDrawer } = panels;
	const onViewChange = useCallback(
		(view: ViewName) => {
			chooseView(view);
			setDrawer(null);
		},
		[chooseView, setDrawer],
	);
	const onSwitchToTerminal = useCallback(() => {
		setView("terminal");
		setDrawer(null);
	}, [setView, setDrawer]);
	const onSwitchToChat = useCallback(() => {
		setView("chat");
		setDrawer(null);
	}, [setView, setDrawer]);

	return (
		<div className="app" {...uploads.dropHandlers}>
			{uploads.appDragOver && (
				<div className="app-drop-overlay" aria-hidden>
					<span>📎 {t("dropHereToAttach")}</span>
				</div>
			)}
			<TopBar
				chat={chat}
				send={send}
				terminal={terminal}
				view={views.view}
				plugins={views.enabledPlugins}
				onViewChange={onViewChange}
				onOpenPanel={setDrawer}
				onOpenSettings={() => dialogs.setSettingsOpen(true)}
				onOpenBgTasks={() => dialogs.setBgTasksOpen(true)}
				onOpenGlobalSearch={() => dialogs.setGlobalSearchOpen(true)}
				sound={sound}
				onSoundChange={setSound}
				onSoundPreview={(kind: SoundKind) => playSound(kind, sound)}
				themes={themes}
				theme={theme}
				onThemeChange={switchTheme}
			/>
			{chat.protocolMismatch && <div className="protocol-banner">⚠ {t("protocolMismatch")}</div>}
			<div className="notices">
				{chat.notices.map((notice) => (
					<NoticeToast key={notice.id} notice={notice} onDismiss={dismissNotice} />
				))}
			</div>
			<TemplateProvider send={send}>
				<div
					className="layout"
					style={{ "--left-w": `${panels.leftWidth}px`, "--right-w": `${panels.rightWidth}px` } as CSSProperties}
				>
					{panels.drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />}
					<ChatView connection={connection} view={views.view} panels={panels} dialogs={dialogs} uploads={uploads} />
					<AppViews
						connection={connection}
						views={views}
						terminalSend={terminalSend}
						onSwitchToTerminal={onSwitchToTerminal}
					/>
				</div>
			</TemplateProvider>
			<FooterBar chat={chat} send={send} onQueryUsageHistory={connection.channelApi.queryUsageHistory} />
			<AppDialogs
				connection={connection}
				dialogs={dialogs}
				attach={uploads.attach}
				onSwitchToTerminal={onSwitchToTerminal}
				onSwitchToChat={onSwitchToChat}
			/>
		</div>
	);
}
