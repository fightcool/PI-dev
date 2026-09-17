/* 🍞 @COUPLED web/src/components/SettingsModal.tsx, web/src/components/ModelConfigModal.tsx
 *   （内置服务商删除 = settings.hiddenBuiltinProviders 传入；
 *    自定义服务商的连接/密钥不再由这里下发 —— 见 ModelConfigModal 的 @WHY）
 *   @WHY 2026-09-17：ModelConfigModal 的入口从模型下拉页脚改成「设置 → 渠道 → 内置服务商与密钥」：
 *        渠道面板是服务商/密钥/模型的唯一入口，不再两处交叉。
 *   — 📖 docs/DEV-CON-PROPOSAL.md §6/§4 */
import { lazy, Suspense } from "react";
import { useT } from "../i18n";
// @WHY 不做 lazy：它已被 FooterBar 静态引用（底栏常在），再 dynamic import 只会拿到
// vite 的「无法拆分」警告，不产生任何体积收益。
import { DirectoryPicker } from "../components/DirectoryPicker";
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
	const t = useT();
	const { chat, send, channelApi, terminal } = connection;
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
				/* 内置服务商与密钥（原「管理模型」）。
				   @BUGFIX 2026-09-17：它现在由「设置 → 渠道」打开，而本节点在 JSX 里排在
				   SettingsModal **之前**：两者的 .modal-backdrop 同为 z-index:300，同层级下后渲染的
				   设置弹窗会盖在上面，把本弹窗的点击全部吃掉（看起来就是「点了没反应」）。
				   不靠调整 JSX 顺序解决：它是「后开的弹窗在上」这个语义，显式抬高层级才可预测。 */
				<div className="modal-layer-top">
					<ModelConfigModal
						send={send}
						providers={chat.modelsConfig}
						providerStatus={chat.providers}
						providerKeys={chat.providerKeys}
						hiddenProviders={chat.settings?.hiddenBuiltinProviders ?? []}
						onClose={() => setManageModelsOpen(false)}
					/>
				</div>
			)}
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					send={send}
					channelApi={channelApi}
					terminal={terminal}
					onSwitchToTerminal={onSwitchToTerminal}
					onOpenProviderKeys={() => setManageModelsOpen(true)}
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
