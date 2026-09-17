import { useCallback, useEffect, useState } from "react";
import type { PreviewFile } from "../components/FilePreview";

export function useAppDialogs() {
	const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
	// Setup modal: one-time prompt when the pi agent config is missing.
	const [setupDismissed, setSetupDismissed] = useState(false);
	// 内置服务商与密钥面板（原模型下拉页脚的「管理模型」）。
	// @WHY 2026-09-17 模型下拉里的入口已撤除（两处改同一批东西）；现在只由
	// 「设置 → 渠道 → 内置服务商与密钥」打开，所以不再导出 openManageModels。
	const [manageModelsOpen, setManageModelsOpen] = useState(false);
	// 用量明细面板：底栏令牌项和「渠道余额」chip 都能打开（状态提到 App 层，
	// 否则输入框工具条里的 chip 无法触发底栏那张面板）。
	const [usageOpen, setUsageOpen] = useState(false);
	// Settings panel (system prompt / skills / extensions / presets).
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Background-task panel (AI-started servers — stop individually or all).
	const [bgTasksOpen, setBgTasksOpen] = useState(false);
	// Global search panel (sessions / projects / workspace files).
	const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
	// 新建项目：左栏「＋」打开的目录选择器（浏览 → 新建文件夹 → 建完即打开）。
	// @WHY 状态在 App 层：选择器要用 chat.pathCompletions，而它属于连接，不在左栏里。
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	/** 全局搜索「会话」结果点击后的跳转目标：切到该会话并定位到命中消息。
	 *  由 MessageList 消费（消息载入即跳转+高亮），跳完后置空。 */
	const [searchJump, setSearchJump] = useState<{
		path: string;
		role: string;
		timestamp: number;
	} | null>(null);
	// 兜底：跳转请求应在下次快照载入时即被 MessageList 消费；超过 15s 未消费
	//（用户中途切走会话等）则清空，避免陈旧目标挂起、日后误触发。
	useEffect(() => {
		if (!searchJump) return;
		const t = setTimeout(() => setSearchJump(null), 15_000);
		return () => clearTimeout(t);
	}, [searchJump]);

	// Ctrl+K / Cmd+K opens global search (also reachable via the topbar button).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
			e.preventDefault();
			setGlobalSearchOpen((v) => !v);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const openUsage = useCallback(() => setUsageOpen(true), []);
	const openNewProject = useCallback(() => setNewProjectOpen(true), []);
	const onJumpDone = useCallback(() => setSearchJump(null), []);
	const [searchVisited, setSearchVisited] = useState(false);
	useEffect(() => {
		if (globalSearchOpen) setSearchVisited(true);
	}, [globalSearchOpen]);
	return {
		previewFile,
		setPreviewFile,
		setupDismissed,
		setSetupDismissed,
		manageModelsOpen,
		setManageModelsOpen,
		usageOpen,
		setUsageOpen,
		openUsage,
		settingsOpen,
		setSettingsOpen,
		bgTasksOpen,
		setBgTasksOpen,
		globalSearchOpen,
		setGlobalSearchOpen,
		newProjectOpen,
		setNewProjectOpen,
		openNewProject,
		searchJump,
		setSearchJump,
		onJumpDone,
		searchVisited,
	};
}
