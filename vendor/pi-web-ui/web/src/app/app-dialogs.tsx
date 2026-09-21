/* 🍞 @COUPLED web/src/components/SettingsModal.tsx, web/src/components/GatewaySettings.tsx
 *   （单网关接入：网关的 baseUrl/Key 在「设置 → 网关」里配，不再有独立的「管理模型」弹窗）
 *   — 📖 docs/NEWAPI-GATEWAY.md §2 */
import { lazy, Suspense } from "react";
import { useT } from "../i18n";
// @WHY 不做 lazy：它已被 FooterBar 静态引用（底栏常在），再 dynamic import 只会拿到
// vite 的「无法拆分」警告，不产生任何体积收益。
import { DirectoryPicker } from "../components/DirectoryPicker";
import type { AppConnection } from "./types";
import type { useAppDialogs } from "./use-app-dialogs";
import type { useAttachments } from "./use-attachments";

const PiSetupModal = lazy(() => import("../components/PiSetupModal").then((m) => ({ default: m.PiSetupModal })));
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
	const t = useT();
	const { chat, send, opsApi, terminal } = connection;
	const {
		previewFile,
		setPreviewFile,
		setupDismissed,
		setSetupDismissed,
		settingsOpen,
		setSettingsOpen,
		bgTasksOpen,
		setBgTasksOpen,
		globalSearchOpen,
		setGlobalSearchOpen,
		newProjectOpen,
		setNewProjectOpen,
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
			{chat.ready && chat.state && chat.state.piConfigured === false && !setupDismissed && (
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
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					send={send}
					opsApi={opsApi}
					terminal={terminal}
					onSwitchToTerminal={onSwitchToTerminal}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			{bgTasksOpen && <BgTasksModal servers={chat.bgServers} send={send} onClose={() => setBgTasksOpen(false)} />}
			{newProjectOpen && (
				/* 新建项目：默认展开「文件夹名称」行，建完直接当工作目录打开（openAfterCreate）。
				   已存在的目录也能直接「选择」——同一个选择器两种用法，不再开第二个弹窗。 */
				<DirectoryPicker
					cwd={chat.state?.cwd ?? ""}
					completions={chat.pathCompletions}
					send={send}
					placement="modal"
					title={t("newProject")}
					hint={t("newProjectHint")}
					openAfterCreate
					newFolderOpen
					onClose={() => setNewProjectOpen(false)}
				/>
			)}
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
