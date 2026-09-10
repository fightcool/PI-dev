import { lazy, Suspense } from "react";
import type { AppConnection } from "./types";
import type { useAppDialogs } from "./use-app-dialogs";
import type { useAttachments } from "./use-attachments";

const PiSetupModal = lazy(() => import("../components/PiSetupModal").then((m) => ({ default: m.PiSetupModal })));
const ModelConfigModal = lazy(() =>
	import("../components/ModelConfigModal").then((m) => ({ default: m.ModelConfigModal })),
);
const SettingsModal = lazy(() => import("../components/SettingsModal").then((m) => ({ default: m.SettingsModal })));
const BgTasksModal = lazy(() => import("../components/BgTasksModal").then((m) => ({ default: m.BgTasksModal })));
const GlobalSearchModal = lazy(() =>
	import("../components/GlobalSearchModal").then((m) => ({ default: m.GlobalSearchModal })),
);
const FilePreview = lazy(() => import("../components/FilePreview").then((m) => ({ default: m.FilePreview })));

export function AppDialogs({
	connection,
	dialogs,
	attach,
	onSwitchToTerminal,
	onSwitchToChat,
}: {
	connection: AppConnection;
	dialogs: ReturnType<typeof useAppDialogs>;
	attach: ReturnType<typeof useAttachments>["attach"];
	onSwitchToTerminal: () => void;
	onSwitchToChat: () => void;
}) {
	const { chat, send, terminal } = connection;
	const {
		previewFile,
		setPreviewFile,
		setupDismissed,
		setSetupDismissed,
		manageModelsOpen,
		setManageModelsOpen,
		settingsOpen,
		setSettingsOpen,
		bgTasksOpen,
		setBgTasksOpen,
		globalSearchOpen,
		setGlobalSearchOpen,
		setSearchJump,
		searchVisited,
	} = dialogs;
	return (
		<Suspense fallback={null}>
			{previewFile && (
				<FilePreview
					file={previewFile}
					content={chat.fileContent}
					send={send}
					onAddLines={(path, name, start, end) => attach(path, name, "lines", false, { start, end })}
					onAttach={(path, name, mode) => attach(path, name, mode)}
					onClose={() => setPreviewFile(null)}
				/>
			)}
			{chat.ready && chat.state && chat.state.piConfigured === false && !setupDismissed && !manageModelsOpen && (
				<PiSetupModal
					send={send}
					piConfigured={chat.state.piConfigured}
					piAgentInstalled={chat.state.piAgentInstalled}
					managed={chat.managed}
					providers={chat.providers}
					installResult={chat.installResult}
					onClose={() => setSetupDismissed(true)}
				/>
			)}
			{manageModelsOpen && (
				<ModelConfigModal
					send={send}
					providers={chat.modelsConfig}
					providerStatus={chat.providers}
					providerKeys={chat.providerKeys}
					fetchModelsResult={chat.fetchModelsResult}
					cloneProviderResult={chat.cloneProviderResult}
					onClose={() => setManageModelsOpen(false)}
				/>
			)}
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					send={send}
					terminal={terminal}
					onSwitchToTerminal={onSwitchToTerminal}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			{bgTasksOpen && <BgTasksModal servers={chat.bgServers} send={send} onClose={() => setBgTasksOpen(false)} />}
			{(globalSearchOpen || searchVisited) && (
				<GlobalSearchModal
					open={globalSearchOpen}
					send={send}
					projects={chat.projects}
					cwd={chat.state?.cwd ?? ""}
					fileSearch={chat.fileSearch}
					sessionSearch={chat.sessionSearch}
					onClose={() => setGlobalSearchOpen(false)}
					onSwitchSession={(path, anchors) => {
						onSwitchToChat();
						void send({ type: "switch_session", path });
						// 跳到命中消息位置（锚点取自服务端返回；无锚点则只切换会话）
						const a = anchors && anchors[0];
						setSearchJump(a ? { path, role: a.role, timestamp: a.timestamp } : null);
					}}
					onSwitchProject={(path) => {
						void send({ type: "set_cwd", path });
					}}
					onPreviewFile={(path, name) => {
						setPreviewFile({ path, name });
					}}
				/>
			)}
		</Suspense>
	);
}
