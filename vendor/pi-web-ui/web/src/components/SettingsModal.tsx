import { useEffect, useRef, useState } from "react";
import {
	FiArchive,
	FiBox,
	FiClock,
	FiCpu,
	FiDownload,
	FiEdit3,
	FiEye,
	FiFileText,
	FiHelpCircle,
	FiMessageSquare,
	FiPackage,
	FiPlus,
	FiRefreshCw,
	FiSend,
	FiSettings,
	FiSliders,
	FiTag,
	FiTerminal,
	FiTrash2,
	FiUpload,
	FiUsers,
	FiX,
	FiZap,
} from "react-icons/fi";
import { CopyButton } from "./copy-button";
import { PluginSettingsForm } from "./PluginSettingsForm";
import type {
	ClientMessage,
	CommandDef,
	UiExtensionInfo,
	UiPluginCatalogEntry,
	UiPluginInfo,
	UiSettingsState,
	UiSkillInfo,
	UiSubagentTemplate,
} from "../types";
import {
	clearPromptHistory,
	DEFAULT_PROMPT_HISTORY_SETTINGS,
	loadPromptHistory,
	loadPromptHistorySettings,
	savePromptHistorySettings,
} from "../prompt-history";
import { randomUuid } from "../uuid";
import { useWideChat, saveChatWidthSettings } from "../chat-width-settings";
import { useProjectTitle, saveTitleSettings } from "../title-settings";
import { sanitizeWallpaperUrl, fileToWallpaperUrl, saveWallpaperSettings, useWallpaperSettings } from "../wallpaper";
import { useT, useI18n } from "../i18n";
import { QUICK_PHRASE_DEFAULTS } from "../quick-phrases";
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_TOKENS, isReadonlyPromptSource } from "../../../server/prompt-composer.js";

/** Minimal terminal-tab bridge (same shape SCMPanel uses). */
interface SettingsTerminalBridge {
	create: (meta: {
		id: string;
		conversationId: string;
		title: string;
		cwd: string;
		cols: number;
		rows: number;
		running: boolean;
		exitCode: number | null;
		command?: CommandDef;
	}) => void;
	restart: (id: string) => void;
	select: (id: string) => void;
}

interface SettingsModalProps {
	chat: {
		settings: UiSettingsState | null;
		plugins: UiPluginInfo[];
		/** Installable-plugin list (marketplace) — one-click install candidates. */
		pluginCatalog: UiPluginCatalogEntry[];
		/** DSH engine: <dataDir>/dsh-patches user patch files. */
		dshPatches: { patchDir: string; files: { name: string; path: string; size: number; mtimeMs: number }[] } | null;
		/** Engine id ("pi" | "dsh") — dsh-only sections render when set. */
		engine?: string;
		/** PI_WEB_MANAGED=1 — no plugin marketplace, updates come from outside. */
		managed?: boolean;
		terminals: {
			id: string;
			title: string;
			conversationId: string;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}[];
		state?: { cwd: string; conversationId: string } | null;
		activeConversationId?: string | null;
	};
	send: (msg: ClientMessage) => boolean;
	terminal: SettingsTerminalBridge;
	/** Switch the top-level view to the terminal (uninstall runs there). */
	onSwitchToTerminal: () => void;
	onClose: () => void;
}

/** A row with an enable/disable switch (skill / extension). */
/**
 * 「？」悬浮提示：长解释默认不占版面，hover / 键盘聚焦时浮出全文。
 * 靠近视口右缘时自动翻转气泡方向（.flip → 向左展开），避免弹窗超出
 * 容器/窗口被裁掉。
 */
/** 文件大小人类可读（设置面板 DSH 补丁列表用）。 */
function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function HintTip({ text }: { text: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [flip, setFlip] = useState(false);
	// 气泡最大 320px；右侧剩余空间不足就向左展开。
	const updateFlip = () => {
		const rect = ref.current?.getBoundingClientRect();
		if (rect) setFlip(window.innerWidth - rect.right < 340);
	};
	return (
		<span
			ref={ref}
			className={`set-tip${flip ? " flip" : ""}`}
			tabIndex={0}
			aria-label={text}
			onMouseEnter={updateFlip}
			onFocus={updateFlip}
		>
			?
			<span className="set-tip-bubble" role="tooltip">
				{text}
			</span>
		</span>
	);
}

function ToggleRow({
	title,
	subtitle,
	tip,
	enabled,
	onToggle,
	action,
}: {
	title: string;
	subtitle?: string;
	/** 长解释走「？」悬浮提示，不再平铺（subtitle 与 tip 二选一）。 */
	tip?: string;
	enabled: boolean;
	onToggle: () => void;
	/** Optional extra control rendered left of the switch (e.g. uninstall). */
	action?: React.ReactNode;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div className="set-row-info">
				<div className="set-row-name">
					{title}
					{tip && <HintTip text={tip} />}
				</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			{action}
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-checked={enabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}

/** 设置弹窗的左侧分组导航（一次只显示一个区块，消灭长滚动）。 */
type SettingsTab =
	| "prompt"
	| "prompt-history"
	| "terminal"
	| "question"
	| "edit"
	| "display"
	| "quick"
	| "markers"
	| "skills"
	| "extensions"
	| "plugins"
	| "review"
	| "vision"
	| "presets"
	| "subagent-templates";

export function SettingsModal({ chat, send, terminal, onSwitchToTerminal, onClose }: SettingsModalProps) {
	const t = useT();
	const { locale } = useI18n();
	// {{token}} 元数据文案键是动态的（promptTok_<token>[,_desc]），用 tt 跳过字面量类型。
	const tt = (k: string) => t(k as Parameters<typeof t>[0]);
	const settings = chat.settings;
	// DSH 引擎：无 pi 扩展/技能体系与视觉桥概念 —— 隐藏对应分区/改占位说明。
	const isDsh = chat.engine === "dsh";
	// 当前左侧导航选中的分组。
	const [tab, setTab] = useState<SettingsTab>("prompt");
	// 内容滚动容器：切换分组后回到顶部（各组高度不同，停留旧滚动位置会像没切换）。
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bodyRef.current?.scrollTo({ top: 0 });
	}, [tab]);
	// DSH 引擎：打开插件分组时拉一次用户 patch 列表（pi 引擎忽略该消息）。
	useEffect(() => {
		if (tab === "plugins" && chat.engine === "dsh") {
			send({ type: "dsh_patches_list" });
		}
	}, [tab, chat.engine, send]);

	// Compose prompt — 组合模板（{{token}} 自由拼装）+ 各来源覆盖。本地草稿：
	// 模板聚焦中不覆盖；某个来源的覆盖框聚焦中不覆盖该 key（防回显打断输入）。
	const [promptTemplateDraft, setPromptTemplateDraft] = useState("");
	const [promptOverridesDraft, setPromptOverridesDraft] = useState<Record<string, string>>({});
	const templateFocus = useRef(false);
	const overrideFocus = useRef<string | null>(null);
	// 未覆盖来源行内默认内容预览：点击预览进入覆盖输入（editingSource）；长文本展开/收起。
	const [editingSource, setEditingSource] = useState<string | null>(null);
	const [defaultOpen, setDefaultOpen] = useState<Record<string, boolean>>({});
	// Vision-bridge prompt draft — same local-edit/re-sync pattern as above.
	const [vbPromptDraft, setVbPromptDraft] = useState("");
	const [vbPromptMode, setVbPromptMode] = useState<"append" | "replace">("append");
	const vbPromptFocus = useRef(false);
	// Goal-review prompt is an independent draft: it does not change the main
	// agent system prompt and is only used by the isolated reviewer.
	const [reviewPromptDraft, setReviewPromptDraft] = useState("");
	const reviewPromptFocus = useRef(false);
	const [presetName, setPresetName] = useState("");
	// 正在编辑的子代理模板草稿（新建 = 空模板；null = 关闭编辑表单）。
	const [tplDraft, setTplDraft] = useState<UiSubagentTemplate | null>(null);
	// 删除子代理模板的两步确认。
	const [confirmTplDelete, setConfirmTplDelete] = useState<string | null>(null);
	// Read-only viewer for the FULL system prompt actually in effect.
	const [showFullPrompt, setShowFullPrompt] = useState(false);
	// 宽屏聊天列开关（纯前端 localStorage，见 chat-width-settings.ts）。
	const wideChat = useWideChat();
	const projectTitle = useProjectTitle();
	// 聊天背景图（纯前端 localStorage，见 wallpaper.ts）：地址输入框用本地草稿，
	// 失焦/回车才提交（避免边输边校验）；压暗/模糊滑杆直接提交即时预览。
	const wallpaper = useWallpaperSettings();
	const [wallpaperDraft, setWallpaperDraft] = useState(wallpaper.url);
	const wallpaperFocus = useRef(false);
	const wallpaperFileRef = useRef<HTMLInputElement>(null);
	const [wallpaperUploading, setWallpaperUploading] = useState(false);
	const [wallpaperUploadError, setWallpaperUploadError] = useState(false);
	useEffect(() => {
		// data: 图不回填输入框（太长），下方缩略预览即表示生效中。
		if (!wallpaperFocus.current) setWallpaperDraft(wallpaper.url.startsWith("data:") ? "" : wallpaper.url);
	}, [wallpaper.url]);
	const onPickWallpaperFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		setWallpaperUploading(true);
		setWallpaperUploadError(false);
		try {
			const url = await fileToWallpaperUrl(file);
			const clean = url ? sanitizeWallpaperUrl(url) : "";
			if (!clean) {
				setWallpaperUploadError(true);
				return;
			}
			setWallpaperDraft("");
			saveWallpaperSettings({ ...wallpaper, url: clean });
		} finally {
			setWallpaperUploading(false);
		}
	};
	// Prompt history settings (纯前端 localStorage，不经过 server).
	const [phSettings, setPhSettings] = useState(() => loadPromptHistorySettings());
	const [phCount, setPhCount] = useState(() => {
		try {
			return loadPromptHistory().length;
		} catch {
			return 0;
		}
	});
	const [phClearConfirm, setPhClearConfirm] = useState(false);
	const refreshPhCount = () => {
		try {
			setPhCount(loadPromptHistory().length);
		} catch {
			setPhCount(0);
		}
	};
	useEffect(() => {
		if (tab === "prompt-history") refreshPhCount();
	}, [tab]);
	useEffect(() => {
		if (!phClearConfirm) return;
		const id = window.setTimeout(() => setPhClearConfirm(false), 3000);
		return () => window.clearTimeout(id);
	}, [phClearConfirm]);
	// Two-step uninstall confirm: which extension id is awaiting confirmation.
	const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
	// Two-step uninstall confirm for UI plugins (<dataDir>/plugins).
	const [confirmUiUninstall, setConfirmUiUninstall] = useState<string | null>(null);
	// "Add to plugin list" form fields (plugin marketplace).
	const [catSource, setCatSource] = useState("");
	const [catId, setCatId] = useState("");
	const [catName, setCatName] = useState("");
	const [catDesc, setCatDesc] = useState("");
	const [catIcon, setCatIcon] = useState("");
	const [showCatAdd, setShowCatAdd] = useState(false);
	// 快捷短语新增输入框草稿（Enter / 添加按钮提交）。
	const [quickNew, setQuickNew] = useState("");
	// 快捷短语行内编辑（null = 未在编辑；输入框受控于 value，回显不打断输入）。
	const [quickEdit, setQuickEdit] = useState<{ index: number; value: string } | null>(null);

	useEffect(() => {
		if (!settings) return;
		if (!templateFocus.current) setPromptTemplateDraft(settings.promptTemplate ?? "");
		setPromptOverridesDraft((prev) => {
			const next: Record<string, string> = {};
			for (const [k, v] of Object.entries(settings.promptOverrides ?? {})) next[k] = v ?? "";
			if (overrideFocus.current) next[overrideFocus.current] = prev[overrideFocus.current] ?? "";
			return next;
		});
		setVbPromptMode(settings.visionBridgePromptMode);
		if (vbPromptFocus.current) return;
		setVbPromptDraft(
			vbPromptMode === "append" || settings.visionBridgePrompt
				? settings.visionBridgePrompt
				: settings.visionBridgeDefaultPrompt || "",
		);
		if (!reviewPromptFocus.current) setReviewPromptDraft(settings.reviewPrompt);
	}, [settings, vbPromptMode]);

	const [idleMsDraft, setIdleMsDraft] = useState<string>(String(settings?.terminalBashIdleMs ?? 15000));
	useEffect(() => {
		setIdleMsDraft(String(settings?.terminalBashIdleMs ?? 15000));
	}, [settings?.terminalBashIdleMs]);

	if (!settings) return null;

	const tabs: {
		id: SettingsTab;
		icon: React.ReactNode;
		label: string;
		/** 有计数徽标（与各区块标题里的 set-count 同源）。 */
		count?: number;
	}[] = [
		{ id: "prompt", icon: <FiFileText />, label: t("settingsSystemPrompt") },
		{
			id: "prompt-history",
			icon: <FiClock />,
			label: t("settingsPromptHistory"),
			count: phCount,
		},
		{ id: "terminal", icon: <FiTerminal />, label: t("settingsTerminalTools") },
		{ id: "question", icon: <FiHelpCircle />, label: t("settingsQuestionnaire") },
		// edit_soft 是 pi SDK 侧的独立编辑工具；DSH 引擎无该工具，隐藏对应分区。
		...(isDsh ? [] : [{ id: "edit" as const, icon: <FiEdit3 />, label: t("settingsEditTools") }]),
		{ id: "display", icon: <FiMessageSquare />, label: t("settingsMessageDisplay") },
		{ id: "quick", icon: <FiSend />, label: t("quickPhrases"), count: settings.quickPhrases.length },
		{ id: "markers", icon: <FiTag />, label: t("settingsMarkers"), count: settings.markers?.length ?? 0 },
		{ id: "skills", icon: <FiCpu />, label: t("settingsSkills"), count: settings.skills.length },
		{ id: "extensions", icon: <FiPackage />, label: t("settingsExtensions"), count: settings.extensions.length },
		{ id: "plugins", icon: <FiBox />, label: t("settingsUiPlugins"), count: chat.plugins.length },
		{ id: "review", icon: <FiZap />, label: t("settingsReview"), count: settings.reviewSkills.length },
		// DSH：无视觉桥概念（真图片直通 vision 模型），隐藏该分区。
		...(isDsh ? [] : [{ id: "vision" as const, icon: <FiEye />, label: t("settingsVisionBridge") }]),
		{ id: "presets", icon: <FiSliders />, label: t("settingsPresets"), count: settings.presets.length },
		// DSH：无子代理概念，隐藏该分区。
		...(isDsh
			? []
			: [
					{
						id: "subagent-templates" as const,
						icon: <FiUsers />,
						label: t("settingsSubagentTemplates"),
						count: settings.subagentTemplates.length,
					},
				]),
	];

	const disabledSkills = new Set(settings.disabledSkills);
	const disabledExts = new Set(settings.disabledExtensions);

	const setPartial = (patch: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		goalModeEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		subagentDefaultModel?: string | null;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		markersEnabled?: boolean;
		disabledMarkers?: string[];
	}) => send({ type: "set_settings", ...patch });

	/** 提交快捷短语行内编辑（空 = 取消；与原值相同 = 无操作；其余走服务端归一化）。 */
	const commitQuickEdit = () => {
		if (!quickEdit || !settings) return;
		const v = quickEdit.value.trim();
		const i = quickEdit.index;
		setQuickEdit(null);
		if (!v || v === settings.quickPhrases[i]) return;
		const next = [...settings.quickPhrases];
		next[i] = v;
		setPartial({ quickPhrases: next });
	};

	const toggleSkill = (s: UiSkillInfo) => {
		const next = new Set(disabledSkills);
		if (next.has(s.name)) next.delete(s.name);
		else next.add(s.name);
		setPartial({ disabledSkills: [...next] });
	};

	const disabledPlugins = new Set(settings.disabledPlugins ?? []);
	const installedPluginIds = new Set(chat.plugins.map((p) => p.id));
	const togglePlugin = (p: UiPluginInfo) => {
		const next = new Set(disabledPlugins);
		if (next.has(p.id)) next.delete(p.id);
		else next.add(p.id);
		setPartial({ disabledPlugins: [...next] });
	};

	const toggleExtension = (e: UiExtensionInfo) => {
		const next = new Set(disabledExts);
		if (next.has(e.id)) next.delete(e.id);
		else next.add(e.id);
		setPartial({ disabledExtensions: [...next] });
	};

	// ---- markers ----
	const markersEnabled = settings.markersEnabled ?? true;
	const disabledMarkers = new Set(settings.disabledMarkers ?? []);
	const toggleMarker = (name: string) => {
		const next = new Set(disabledMarkers);
		const currentlyEnabled = !next.has(name);
		if (currentlyEnabled) next.add(name);
		else next.delete(name);
		setPartial({ disabledMarkers: [...next] });
	};

	/** Run a maintenance command (extension uninstall / UI-plugin install or
	 *  uninstall) in a VISIBLE terminal tab (same reuse pattern as SCM write
	 *  ops) so the user sees exactly what happened. On exit the App watcher
	 *  sends extensions_reload / plugins_reload to re-discover the lists. */
	const runTerminalCommand = (title: string, command: string) => {
		const cmd: CommandDef = {
			name: title,
			command,
			cwd: "${pwd}",
		};
		let targetId: string;
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			terminal.restart(existing.id);
			send({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
			targetId = existing.id;
		} else {
			targetId = randomUuid();
			terminal.create({
				id: targetId,
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		terminal.select(targetId);
		onSwitchToTerminal();
		onClose();
	};

	/** Uninstall a `pi install`-ed package: run `pi remove npm:<pkg>` in a
	 *  visible terminal tab (see runTerminalCommand). */
	const runUninstall = (pkgName: string) => {
		setConfirmUninstall(null);
		runTerminalCommand(`${t("uninstallTitle")} ${pkgName}`, `pi remove npm:${pkgName}`);
	};

	/** Uninstall a UI plugin: delete <dataDir>/plugins/<id>/ via the CLI.
	 *  plugins_reload after the tab exits re-scans the dir. */
	const runUiPluginUninstall = (id: string) => {
		setConfirmUiUninstall(null);
		runTerminalCommand(`${t("uninstallTitle")} ${id}`, `pi-web-ui uninstall ${id}`);
	};

	/** Update a UI plugin from its recorded install source (.pi-source.json):
	 *  re-run the same install command with --force (config.json survives). */
	const runUiPluginUpdate = (id: string, source: string) => {
		runTerminalCommand(`${t("pluginUpdate")} ${id}`, `pi-web-ui install ${source} --name ${id} --force`);
	};

	/** One-click install a plugin from the marketplace list (not installed
	 *  yet). `--name <id>` pins the on-disk dir to the catalog id (drives
	 *  installed-state match). 已装的走 runUiPluginUpdate（--force，即更新）。 */
	const runCatalogInstall = (e: UiPluginCatalogEntry) => {
		runTerminalCommand(`${t("pluginInstall")} ${e.id}`, `pi-web-ui install ${e.source} --name ${e.id}`);
	};

	/** Remove a user-added plugin from the marketplace list. */
	const runCatalogRemove = (id: string) => {
		send({ type: "plugin_catalog_remove", id });
	};

	/** Submit the "add to plugin list" form (server validates + persists). */
	const submitCatalogAdd = () => {
		const source = catSource.trim();
		if (!source) return;
		send({
			type: "plugin_catalog_add",
			entry: {
				source,
				...(catId.trim() ? { id: catId.trim() } : {}),
				...(catName.trim() ? { name: catName.trim() } : {}),
				...(catDesc.trim() ? { description: catDesc.trim() } : {}),
				...(catIcon.trim() ? { icon: catIcon.trim() } : {}),
			},
		});
		setCatSource("");
		setCatId("");
		setCatName("");
		setCatDesc("");
		setCatIcon("");
		setShowCatAdd(false);
	};

	const toggleReviewSkill = (s: UiSkillInfo) => {
		const disabled = new Set(settings.reviewSkills.filter((x) => !x.enabled).map((x) => x.name));
		if (disabled.has(s.name)) disabled.delete(s.name);
		else disabled.add(s.name);
		setPartial({ reviewDisabledSkills: [...disabled] });
	};

	const commitTemplate = () => setPartial({ promptTemplate: promptTemplateDraft });

	const commitOverride = (token: string) => {
		setPartial({ promptOverrides: { [token]: promptOverridesDraft[token] ?? "" } });
	};

	const resetOverride = (token: string) => {
		if (overrideFocus.current === token) overrideFocus.current = null;
		setEditingSource(null);
		setPromptOverridesDraft((p) => {
			const n = { ...p };
			delete n[token];
			return n;
		});
		setPartial({ promptOverrides: { [token]: "" } });
	};

	/** 来源默认内容预览的长文本展开/收起。 */
	const toggleDefault = (tk: string) => setDefaultOpen((p) => ({ ...p, [tk]: !p[tk] }));

	/** 覆盖输入时一键把默认（自动）内容填进覆盖框 —— 只想改一小部分时用它打底（填
	 *  入后该来源内容固定，不再随每次对话自动重新生成）。 */
	const seedFromDefault = (tk: string, def: string) => {
		setPromptOverridesDraft((p) => ({ ...p, [tk]: def }));
		setEditingSource(tk);
	};

	const resetAllPrompt = () => {
		templateFocus.current = false;
		overrideFocus.current = null;
		setPromptTemplateDraft(DEFAULT_PROMPT_TEMPLATE);
		setPromptOverridesDraft({});
		setPartial({ promptTemplate: DEFAULT_PROMPT_TEMPLATE, promptOverrides: {} });
	};

	const appendTokenToTemplate = (token: string) => {
		setPromptTemplateDraft((prev) => (prev.trim() ? `${prev}\n\n{{${token}}}` : `{{${token}}}`));
	};

	const hasPromptCustom =
		(promptTemplateDraft.trim() && promptTemplateDraft.trim() !== DEFAULT_PROMPT_TEMPLATE) ||
		Object.values(promptOverridesDraft).some((v) => v.trim());

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<FiSettings className="modal-head-icon" />
					<h2>{t("settingsTitle")}</h2>
					{/* 长说明收起为「？」悬浮提示，不再平铺占版面 */}
					<HintTip text={t("settingsDesc")} />
				</div>

				{/* Scrollable body — head above and the actions bar below stay
				    fixed; only these sections scroll. */}
				<div className="settings-layout">
					<nav className="settings-rail" aria-label={t("settingsTitle")}>
						{tabs.map((tb) => (
							<button
								key={tb.id}
								type="button"
								className={`settings-tab${tab === tb.id ? " active" : ""}`}
								aria-current={tab === tb.id ? "true" : undefined}
								title={tb.label}
								onClick={() => setTab(tb.id)}
							>
								<span className="settings-tab-icon">{tb.icon}</span>
								<span className="settings-tab-label">{tb.label}</span>
								{tb.count !== undefined && <span className="set-count">{tb.count}</span>}
							</button>
						))}
					</nav>
					<div className="modal-body" ref={bodyRef}>
						{/* ---- system prompt -------------------------------------------- */}
						{tab === "prompt" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiZap className="set-section-icon" />
									{t("settingsSystemPrompt")}
									<HintTip text={t("promptComposeHint")} />
								</div>
								<p className="set-hint">{t("promptComposeDesc")}</p>
								<div className="set-field">
									<label className="set-field-label">{t("promptTemplateLabel")}</label>
									<textarea
										className="set-prompt-input"
										rows={8}
										spellCheck={false}
										placeholder={DEFAULT_PROMPT_TEMPLATE}
										value={promptTemplateDraft}
										onFocus={() => (templateFocus.current = true)}
										onBlur={() => {
											templateFocus.current = false;
											commitTemplate();
										}}
										onChange={(e) => setPromptTemplateDraft(e.target.value)}
									/>
									<div className="compose-toolbar">
										<span className="set-field-label set-muted">{t("promptInsertTokens")}</span>
										{PROMPT_TOKENS.map((tk) => (
											<button
												key={tk}
												type="button"
												className="token-chip"
												title={tt(`promptTok_${tk}_desc`)}
												onClick={() => appendTokenToTemplate(tk)}
											>
												{`{{${tk}}}`}
											</button>
										))}
									</div>
								</div>
								{/* 各来源覆盖：留空 = 用自动内容；未覆盖时行内直接展示该来源当前的默认（自动）内容 */}
								<div className="set-field">
									<label className="set-field-label">{t("promptSourcesLabel")}</label>
									{PROMPT_TOKENS.map((tk) => {
										const v = promptOverridesDraft[tk] ?? "";
										// 该来源当前默认（自动）内容：会话未就绪时为空对象 → def = ""。
										const def = settings.promptSourceDefaults?.[tk] ?? "";
										const editing = editingSource === tk;
										const isLong = def.split("\n").length > 6 || def.length > 480;
										if (isReadonlyPromptSource(tk)) {
											const shown = v.trim() ? v : def;
											return (
												<div className="override-row readonly" key={tk}>
													<div className="override-row-head">
														{`{{${tk}}}`}
														<span className="set-muted">
															{tt(`promptTok_${tk}`)} — {tt(`promptTok_${tk}_desc`)}
														</span>
														{v.trim() ? (
															<button
																type="button"
																className="set-btn-mini"
																title={t("promptReadonlyLockedHint")}
																onClick={() => resetOverride(tk)}
															>
																{t("promptResetSource")}
															</button>
														) : (
															<span className="set-muted">{t("promptReadonlyBadge")}</span>
														)}
													</div>
													<div
														className={`source-default readonly${shown.trim() ? "" : " empty"}`}
														title={t("promptReadonlyTitle")}
													>
														{shown.trim() ? (
															<>
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{shown}
																</pre>
																{isLong && (
																	<span
																		className="source-default-toggle"
																		role="button"
																		tabIndex={0}
																		onClick={(e) => {
																			e.stopPropagation();
																			toggleDefault(tk);
																		}}
																		onKeyDown={(e) => {
																			if (e.key === "Enter" || e.key === " ") {
																				e.preventDefault();
																				e.stopPropagation();
																				toggleDefault(tk);
																			}
																		}}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</span>
																)}
															</>
														) : (
															<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
														)}
													</div>
												</div>
											);
										}
										return (
											<div className="override-row" key={tk}>
												<div className="override-row-head">
													{`{{${tk}}}`}
													<span className="set-muted">
														{tt(`promptTok_${tk}`)} — {tt(`promptTok_${tk}_desc`)}
													</span>
													{v.trim() ? (
														<button type="button" className="set-btn-mini" onClick={() => resetOverride(tk)}>
															{t("promptResetSource")}
														</button>
													) : (
														<span className="set-muted">{t("promptAutoBadge")}</span>
													)}
												</div>
												{v.trim() || editing ? (
													<>
														<textarea
															className="set-prompt-input override-input"
															rows={Math.min(10, Math.max(1, v.split("\n").length))}
															autoFocus={editing}
															placeholder={t("promptOverridePlaceholder")}
															value={v}
															onFocus={(e) => {
																overrideFocus.current = tk;
																setEditingSource(tk);
																// 刚点预览载入默认文本时把光标放到末尾，方便直接接着改。
																const el = e.currentTarget as HTMLTextAreaElement;
																if (el.value && el.value === def)
																	el.setSelectionRange(el.value.length, el.value.length);
															}}
															onBlur={() => {
																if (overrideFocus.current === tk) overrideFocus.current = null;
																const val = promptOverridesDraft[tk] ?? "";
																if (val.trim() && val === def) {
																	// 点击预览载入默认后原样失焦（没改任何字）→ 不产生覆盖，仍用自动内容。
																	resetOverride(tk);
																	return;
																}
																commitOverride(tk);
																if (!val.trim()) setEditingSource(null);
															}}
															onChange={(e) => setPromptOverridesDraft((p) => ({ ...p, [tk]: e.target.value }))}
														/>
														{/* 编辑覆盖内容时，下方始终展示该来源的默认（自动）内容，方便对照/复制/只改一小部分。 */}
														<div className="override-edit-foot">
															<div className="override-edit-foot-head">
																<span className="set-muted">{t("promptSourceRefLabel")}</span>
																{isLong && (
																	<button
																		type="button"
																		className="source-default-toggle"
																		onClick={() => toggleDefault(tk)}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</button>
																)}
															</div>
															{def.trim() ? (
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{def}
																</pre>
															) : (
																<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
															)}
															{!v.trim() && def.trim() && (
																<button
																	type="button"
																	className="override-seed-btn"
																	title={t("promptSourceSeedTip")}
																	onClick={() => seedFromDefault(tk, def)}
																>
																	{t("promptSourceSeedButton")}
																</button>
															)}
														</div>
													</>
												) : (
													// 未覆盖：行内展示默认（自动）内容；点击 = 载入默认文本开始编辑（不改就失焦则回到自动内容）。
													<div
														className="source-default"
														title={t("promptSourceDefaultEditHint")}
														role="button"
														tabIndex={0}
														onClick={() => seedFromDefault(tk, def)}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																seedFromDefault(tk, def);
															}
														}}
													>
														{def.trim() ? (
															<>
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{def}
																</pre>
																{isLong && (
																	<span
																		className="source-default-toggle"
																		role="button"
																		tabIndex={0}
																		onClick={(e) => {
																			e.stopPropagation();
																			toggleDefault(tk);
																		}}
																		onKeyDown={(e) => {
																			if (e.key === "Enter" || e.key === " ") {
																				e.preventDefault();
																				e.stopPropagation();
																				toggleDefault(tk);
																			}
																		}}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</span>
																)}
															</>
														) : (
															<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
														)}
													</div>
												)}
											</div>
										);
									})}
									<div className="compose-toolbar">
										<button type="button" className="set-btn" onClick={resetAllPrompt} disabled={!hasPromptCustom}>
											{t("promptResetAll")}
										</button>
									</div>
								</div>
								<button
									type="button"
									className="set-view-prompt-btn"
									aria-expanded={showFullPrompt}
									onClick={() => setShowFullPrompt((v) => !v)}
								>
									{t("settingsViewPrompt")} {showFullPrompt ? "▴" : "▾"}
								</button>
								{showFullPrompt && (
									<div className="set-prompt-view">
										<div className="set-prompt-view-head">
											<span>{t("settingsViewPromptHint")}</span>
											<CopyButton text={settings.effectiveSystemPrompt} />
										</div>
										{settings.effectiveSystemPrompt ? (
											<pre className="set-prompt-view-text">{settings.effectiveSystemPrompt}</pre>
										) : (
											<p className="set-empty">{t("settingsViewPromptEmpty")}</p>
										)}
										<div className="set-prompt-tools">
											<div className="set-prompt-view-head">
												<span>{t("settingsViewToolsSchema")}</span>
												<CopyButton text={settings.toolsSchema} />
											</div>
											<p className="set-hint">{t("settingsViewToolsSchemaHint")}</p>
											{settings.toolsSchema ? (
												<pre className="set-prompt-view-text">{settings.toolsSchema}</pre>
											) : (
												<p className="set-empty">{t("settingsViewToolsSchemaEmpty")}</p>
											)}
										</div>
									</div>
								)}
							</div>
						)}

						{/* ---- prompt history -------------------------------------------- */}
						{tab === "prompt-history" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiClock className="set-section-icon" />
									{t("settingsPromptHistory")}
									<HintTip text={t("settingsPromptHistoryDesc")} />
									<span className="set-count">{t("promptHistoryCount", { n: String(phCount) })}</span>
								</div>
								{phCount === 0 ? (
									<p className="set-empty">{t("promptHistoryEmpty")}</p>
								) : (
									<p className="set-hint">{t("promptHistoryCount", { n: String(phCount) })}</p>
								)}
								<div className="set-field">
									<label className="set-field-label" htmlFor="ph-max">
										{t("promptHistoryMax")}
									</label>
									<div className="set-mode-row">
										<input
											id="ph-max"
											className="set-input"
											type="number"
											min={1}
											max={500}
											step={1}
											value={String(phSettings.maxEntries)}
											onChange={(e) => {
												const v = Math.floor(Number(e.target.value) || 0);
												const next = { ...phSettings, maxEntries: v };
												setPhSettings(next);
											}}
											onBlur={() => {
												const norm = { ...phSettings };
												if (!Number.isFinite(norm.maxEntries) || norm.maxEntries < 1) norm.maxEntries = 1;
												if (norm.maxEntries > 500) norm.maxEntries = 500;
												norm.maxEntries = Math.floor(norm.maxEntries);
												setPhSettings(norm);
												savePromptHistorySettings(norm);
												refreshPhCount();
											}}
										/>
										<HintTip text={t("promptHistoryMaxHint")} />
									</div>
								</div>
								<ToggleRow
									title={t("promptHistoryCharLimit")}
									tip={t("promptHistoryCharLimitHint")}
									enabled={phSettings.charLimitEnabled}
									onToggle={() => {
										const next = { ...phSettings, charLimitEnabled: !phSettings.charLimitEnabled };
										setPhSettings(next);
										savePromptHistorySettings(next);
										refreshPhCount();
									}}
								/>
								{phSettings.charLimitEnabled && (
									<div className="set-field">
										<label className="set-field-label" htmlFor="ph-char-limit">
											{t("promptHistoryCharLimit")}
										</label>
										<input
											id="ph-char-limit"
											className="set-input"
											type="number"
											min={100}
											max={20000}
											step={100}
											placeholder={t("promptHistoryCharLimitPlaceholder")}
											value={String(phSettings.charLimit)}
											onChange={(e) => {
												const v = Math.floor(Number(e.target.value) || 0);
												setPhSettings({ ...phSettings, charLimit: v });
											}}
											onBlur={() => {
												let v = Math.floor(Number(phSettings.charLimit) || 0);
												if (!Number.isFinite(v) || v < 100) v = 100;
												if (v > 20000) v = 20000;
												const norm = { ...phSettings, charLimit: v };
												setPhSettings(norm);
												savePromptHistorySettings(norm);
												refreshPhCount();
											}}
										/>
									</div>
								)}
								<div className="set-field" style={{ marginTop: 12 }}>
									<button
										type="button"
										className={`set-uninstall${phClearConfirm ? " confirm" : ""}`}
										disabled={phCount === 0}
										title={phCount === 0 ? t("promptHistoryEmpty") : t("promptHistoryClear")}
										onClick={() => {
											if (!phClearConfirm) {
												setPhClearConfirm(true);
												return;
											}
											clearPromptHistory();
											setPhClearConfirm(false);
											refreshPhCount();
										}}
									>
										<FiTrash2 /> {phClearConfirm ? t("promptHistoryClearConfirm") : t("promptHistoryClear")}
									</button>
									{phCount > 0 && (
										<span className="set-hint" style={{ marginLeft: 8 }}>
											{t("promptHistoryCount", { n: String(phCount) })}
										</span>
									)}
								</div>
								<p className="set-hint">
									<FiArchive style={{ verticalAlign: "-2px", marginRight: 4 }} />
									{t("settingsPromptHistoryDesc")}
								</p>
							</div>
						)}

						{/* ---- terminal tools ------------------------------------------ */}
						{tab === "terminal" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiTerminal className="set-section-icon" />
									{t("settingsTerminalTools")}
								</div>
								<ToggleRow
									title={t("terminalToolsEnabled")}
									tip={t("settingsTerminalToolsDesc")}
									enabled={settings.terminalToolsEnabled}
									onToggle={() => setPartial({ terminalToolsEnabled: !settings.terminalToolsEnabled })}
								/>
								{!settings.terminalToolsEnabled && <p className="set-hint">{t("terminalToolsOffHint")}</p>}
								<ToggleRow
									title={t("terminalBashTakeover")}
									tip={t("terminalBashTakeoverDesc")}
									enabled={settings.terminalBash}
									onToggle={() => setPartial({ terminalBash: !settings.terminalBash })}
								/>
								{settings.terminalBash && (
									<div className="set-field">
										<label className="set-field-label" htmlFor="tb-idle-ms">
											{t("terminalBashIdleMs")}
										</label>
										<input
											id="tb-idle-ms"
											className="set-input"
											type="number"
											min={0}
											step={1000}
											value={idleMsDraft}
											onChange={(e) => setIdleMsDraft(e.target.value)}
											onBlur={() => {
												const n = Math.max(0, Math.floor(Number(idleMsDraft) || 0));
												setIdleMsDraft(String(n));
												if (n !== settings.terminalBashIdleMs) {
													setPartial({ terminalBashIdleMs: n });
												}
											}}
										/>
									</div>
								)}
							</div>
						)}

						{/* ---- edit tools ---------------------------------------------- */}
						{tab === "edit" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiEdit3 className="set-section-icon" />
									{t("settingsEditTools")}
								</div>
								<ToggleRow
									title={t("editSoftEnabled")}
									tip={t("editSoftEnabledDesc")}
									enabled={settings.editSoftEnabled}
									onToggle={() => setPartial({ editSoftEnabled: !settings.editSoftEnabled })}
								/>
								{!settings.editSoftEnabled && <p className="set-hint">{t("editSoftOffHint")}</p>}
							</div>
						)}

						{/* ---- questionnaire ------------------------------------------ */}
						{tab === "question" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiHelpCircle className="set-section-icon" />
									{t("settingsQuestionnaire")}
								</div>
								<ToggleRow
									title={t("questionnaireEnabled")}
									tip={t("questionnaireEnabledDesc")}
									enabled={settings.questionnaireEnabled}
									onToggle={() => setPartial({ questionnaireEnabled: !settings.questionnaireEnabled })}
								/>
								{!settings.questionnaireEnabled && <p className="set-hint">{t("questionnaireOffHint")}</p>}
							</div>
						)}

						{/* ---- message display ----------------------------------------- */}
						{tab === "display" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiMessageSquare className="set-section-icon" />
									{t("settingsMessageDisplay")}
								</div>
								<ToggleRow
									title={t("thinkingWrap")}
									tip={t("thinkingWrapDesc")}
									enabled={settings.thinkingWrap ?? true}
									onToggle={() => setPartial({ thinkingWrap: !(settings.thinkingWrap ?? true) })}
								/>
								<ToggleRow
									title={t("toolsWrap")}
									tip={t("toolsWrapDesc")}
									enabled={settings.toolsWrap ?? true}
									onToggle={() => setPartial({ toolsWrap: !(settings.toolsWrap ?? true) })}
								/>
								<hr className="set-sep" />
								<ToggleRow
									title={t("wideChat")}
									tip={t("wideChatDesc")}
									enabled={wideChat}
									onToggle={() => saveChatWidthSettings({ wide: !wideChat })}
								/>
								<ToggleRow
									title={t("projectTitle")}
									tip={t("projectTitleDesc")}
									enabled={projectTitle}
									onToggle={() => saveTitleSettings({ projectName: !projectTitle })}
								/>
								<hr className="set-sep" />
								<div className="set-row">
									<div className="set-row-info">
										<div className="set-row-name">
											{t("wallpaperTitle")}
											<HintTip text={t("wallpaperDesc")} />
										</div>
										<div className="wallpaper-url-row">
											<input
												className="set-input wallpaper-url"
												placeholder={t("wallpaperUrlPh")}
												value={wallpaperDraft}
												maxLength={2000}
												spellCheck={false}
												onFocus={() => {
													wallpaperFocus.current = true;
												}}
												onChange={(e) => setWallpaperDraft(e.target.value)}
												onBlur={() => {
													wallpaperFocus.current = false;
													// 已上传的 data: 图不占输入框：空输入 = 未改动，不断然清空。
													if (!wallpaperDraft.trim() && wallpaper.url.startsWith("data:")) {
														setWallpaperDraft("");
														return;
													}
													const url = sanitizeWallpaperUrl(wallpaperDraft);
													setWallpaperDraft(url);
													if (url !== wallpaper.url) saveWallpaperSettings({ ...wallpaper, url });
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter") (e.target as HTMLInputElement).blur();
													else if (e.key === "Escape") {
														setWallpaperDraft(wallpaper.url.startsWith("data:") ? "" : wallpaper.url);
														(e.target as HTMLInputElement).blur();
													}
												}}
											/>
											<button
												type="button"
												className="set-save-btn"
												disabled={wallpaperUploading}
												onClick={() => wallpaperFileRef.current?.click()}
											>
												<FiUpload /> {t("wallpaperUpload")}
											</button>
											<input
												ref={wallpaperFileRef}
												type="file"
												accept="image/*"
												hidden
												onChange={onPickWallpaperFile}
											/>
										</div>
										{wallpaperUploadError && <p className="set-hint">{t("wallpaperUploadFailed")}</p>}
										<div className="wallpaper-sliders">
											<label className="wallpaper-slider">
												<span>{t("wallpaperDim")}</span>
												<input
													type="range"
													min={0}
													max={95}
													step={1}
													value={wallpaper.dim}
													onChange={(e) => saveWallpaperSettings({ ...wallpaper, dim: Number(e.target.value) })}
												/>
												<output>{wallpaper.dim}%</output>
											</label>
											<label className="wallpaper-slider">
												<span>{t("wallpaperBlur")}</span>
												<input
													type="range"
													min={0}
													max={24}
													step={1}
													value={wallpaper.blur}
													onChange={(e) => saveWallpaperSettings({ ...wallpaper, blur: Number(e.target.value) })}
												/>
												<output>{wallpaper.blur}px</output>
											</label>
										</div>
									</div>
									{wallpaper.url && (
										<div className="wallpaper-current">
											<img className="wallpaper-preview" src={wallpaper.url} alt="" />
											<button
												type="button"
												className="wallpaper-clear"
												onClick={() => {
													setWallpaperDraft("");
													saveWallpaperSettings({ ...wallpaper, url: "" });
												}}
											>
												{t("wallpaperClear")}
											</button>
										</div>
									)}
								</div>
							</div>
						)}

						{/* ---- 快捷短语（输入框上方一键发送） ------------------------------ */}
						{tab === "quick" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSend className="set-section-icon" />
									{t("quickPhrases")}
									<HintTip text={t("quickPhrasesDesc")} />
									<span className="set-count">{settings.quickPhrases.length}</span>
								</div>
								<ToggleRow
									title={t("quickPhrasesEnabled")}
									tip={t("quickPhrasesDesc")}
									enabled={settings.quickPhrasesEnabled}
									onToggle={() => setPartial({ quickPhrasesEnabled: !settings.quickPhrasesEnabled })}
								/>
								{!settings.quickPhrasesEnabled && <p className="set-hint">{t("quickPhrasesOffHint")}</p>}
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("quickPhrasesPlaceholder")}
										value={quickNew}
										maxLength={200}
										onChange={(e) => setQuickNew(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && quickNew.trim()) {
												setPartial({ quickPhrases: [...settings.quickPhrases, quickNew.trim()] });
												setQuickNew("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!quickNew.trim()}
										onClick={() => {
											setPartial({ quickPhrases: [...settings.quickPhrases, quickNew.trim()] });
											setQuickNew("");
										}}
									>
										<FiPlus /> {t("quickPhrasesAdd")}
									</button>
								</div>
								{settings.quickPhrases.length === 0 ? (
									<p className="set-empty">{t("quickPhrasesEmpty")}</p>
								) : (
									<div className="set-list">
										{settings.quickPhrases.map((p, i) => (
											<div className="set-row" key={`${i}:${p}`}>
												{quickEdit?.index === i ? (
													<div className="set-row-info">
														<input
															className="set-input"
															autoFocus
															value={quickEdit.value}
															maxLength={200}
															placeholder={t("quickPhrasesEditPh")}
															onChange={(e) => setQuickEdit({ index: i, value: e.target.value })}
															onKeyDown={(e) => {
																if (e.key === "Enter") commitQuickEdit();
																else if (e.key === "Escape") setQuickEdit(null);
															}}
															onBlur={commitQuickEdit}
														/>
													</div>
												) : (
													<>
														<div className="set-row-info">
															<div className="set-row-name" title={p}>
																{p}
															</div>
														</div>
														<div className="set-row-actions">
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesEdit")}
																onClick={() => setQuickEdit({ index: i, value: p })}
															>
																<FiEdit3 />
															</button>
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesMoveUp")}
																disabled={i === 0}
																onClick={() => {
																	const next = [...settings.quickPhrases];
																	[next[i - 1], next[i]] = [next[i], next[i - 1]];
																	setPartial({ quickPhrases: next });
																}}
															>
																↑
															</button>
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesMoveDown")}
																disabled={i === settings.quickPhrases.length - 1}
																onClick={() => {
																	const next = [...settings.quickPhrases];
																	[next[i], next[i + 1]] = [next[i + 1], next[i]];
																	setPartial({ quickPhrases: next });
																}}
															>
																↓
															</button>
															<button
																type="button"
																className="set-icon-btn danger"
																title={t("quickPhrasesDelete")}
																onClick={() =>
																	setPartial({ quickPhrases: settings.quickPhrases.filter((_, j) => j !== i) })
																}
															>
																<FiTrash2 />
															</button>
														</div>
													</>
												)}
											</div>
										))}
									</div>
								)}
								<div className="compose-toolbar">
									<button
										type="button"
										className="dd-refresh"
										onClick={() => {
											setQuickEdit(null);
											setPartial({ quickPhrases: QUICK_PHRASE_DEFAULTS[locale] ?? QUICK_PHRASE_DEFAULTS.en });
										}}
									>
										{t("quickPhrasesReset")}
									</button>
								</div>
							</div>
						)}

						{/* ---- markers (内置标记工具) --------------------------------------- */}
						{tab === "markers" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiTag className="set-section-icon" />
									{t("settingsMarkers")}
									<HintTip text={t("settingsMarkersDesc")} />
									<span className="set-count">{settings.markers?.length ?? 0}</span>
								</div>
								<ToggleRow
									title={t("markersEnabled")}
									tip={t("markersEnabledDesc")}
									enabled={markersEnabled}
									onToggle={() => setPartial({ markersEnabled: !markersEnabled })}
								/>
								{!markersEnabled && <p className="set-hint">{t("markersOffHint")}</p>}
								{markersEnabled && (settings.markers?.length ?? 0) === 0 && (
									<p className="set-empty">{t("loading")}...</p>
								)}
								{markersEnabled && settings.markers && settings.markers.length > 0 && (
									<div className="set-list">
										{settings.markers.map((m) => (
											<ToggleRow
												key={m.name}
												title={
													m.name === "todo"
														? t("markerGroupTodo")
														: m.name === "notify"
															? t("markerGroupNotify")
															: m.name === "conv"
																? t("markerGroupRename")
																: m.name
												}
												subtitle={(m.guidance[0] ?? "").slice(0, 120)}
												tip={m.guidance.join("\n")}
												enabled={m.enabled}
												onToggle={() => toggleMarker(m.name)}
											/>
										))}
									</div>
								)}
								{markersEnabled && <p className="set-hint">{t("markerRenameTip")}</p>}
							</div>
						)}

						{/* ---- skills --------------------------------------------------- */}
						{tab === "skills" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiCpu className="set-section-icon" />
									{t("settingsSkills")}
									<span className="set-count">{settings.skills.length}</span>
								</div>
								{settings.skills.length === 0 ? (
									<p className="set-empty">{isDsh ? t("dshSkillsNote") : t("noSkills")}</p>
								) : (
									<div className="set-list">
										{settings.skills.map((s) => (
											<ToggleRow
												key={s.name}
												title={s.name}
												subtitle={s.description}
												enabled={s.enabled}
												onToggle={() => toggleSkill(s)}
											/>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- extensions ------------------------------------------------ */}
						{tab === "extensions" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiPackage className="set-section-icon" />
									{t("settingsExtensions")}
									<span className="set-count">{settings.extensions.length}</span>
								</div>
								{settings.extensions.length === 0 ? (
									<p className="set-empty">{isDsh ? t("dshExtensionsNote") : t("noExtensions")}</p>
								) : (
									<div className="set-list">
										{settings.extensions.map((e) => {
											const pkgName = e.id.startsWith("npm:") ? e.id.slice(4) : null;
											return (
												<ToggleRow
													key={e.id}
													title={e.name}
													subtitle={e.path}
													enabled={e.enabled}
													onToggle={() => toggleExtension(e)}
													action={
														pkgName ? (
															confirmUninstall === e.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	title={t("uninstallConfirmHint")}
																	onClick={() => runUninstall(pkgName)}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("uninstallHint")}
																	onClick={() => setConfirmUninstall(e.id)}
																>
																	<FiTrash2 />
																	{t("uninstallExt")}
																</button>
															)
														) : undefined
													}
												/>
											);
										})}
									</div>
								)}
							</div>
						)}

						{/* ---- 插件市场（可一键安装的插件列表） ------------------------ */}
						{/* A managed instance installs software through its deploy, not
						    through this page: the market would only offer an action the
						    server refuses (server/managed.ts). Plugins already installed
						    keep working and stay listed above. */}
						{tab === "plugins" && chat.managed && (
							<div className="set-section">
								<div className="set-note">{t("updatesManaged")}</div>
							</div>
						)}
						{tab === "plugins" && !chat.managed && (
							<div className="set-section">
								<div className="set-section-title">
									<FiPackage className="set-section-icon" />
									{t("pluginMarket")}
									<span className="set-count">{chat.pluginCatalog.length}</span>
									<button
										type="button"
										className="set-uninstall"
										title={t("pluginCatalogAddHint")}
										onClick={() => setShowCatAdd((v) => !v)}
									>
										<FiPlus />
										{t("pluginCatalogAdd")}
									</button>
								</div>
								{showCatAdd && (
									<div className="set-catalog-add">
										<input
											className="set-input"
											placeholder={t("pluginCatalogSource")}
											value={catSource}
											onChange={(ev) => setCatSource(ev.target.value)}
										/>
										<input
											className="set-input"
											placeholder={t("pluginCatalogId")}
											value={catId}
											onChange={(ev) => setCatId(ev.target.value)}
										/>
										<input
											className="set-input"
											placeholder={t("pluginCatalogName")}
											value={catName}
											onChange={(ev) => setCatName(ev.target.value)}
										/>
										<input
											className="set-input"
											placeholder={t("pluginCatalogIcon")}
											value={catIcon}
											onChange={(ev) => setCatIcon(ev.target.value)}
										/>
										<textarea
											className="set-input"
											rows={2}
											placeholder={t("pluginCatalogDesc")}
											value={catDesc}
											onChange={(ev) => setCatDesc(ev.target.value)}
										/>
										<div className="set-catalog-add-actions">
											<button
												type="button"
												className="set-uninstall confirm"
												disabled={!catSource.trim()}
												onClick={submitCatalogAdd}
											>
												{t("pluginCatalogAddSubmit")}
											</button>
											<button type="button" className="set-uninstall" onClick={() => setShowCatAdd(false)}>
												{t("cancel")}
											</button>
										</div>
									</div>
								)}
								{chat.pluginCatalog.length === 0 ? (
									<p className="set-empty">{t("noPluginCatalog")}</p>
								) : (
									<div className="set-list">
										{chat.pluginCatalog.map((e) => {
											const installed = installedPluginIds.has(e.id);
											return (
												<div key={e.id} className="set-catalog-row">
													<div className="set-catalog-main">
														<div className="set-catalog-title">
															<span>
																{e.icon ? `${e.icon} ` : ""}
																{e.name}
															</span>
															{installed && <span className="set-catalog-installed">{t("pluginInstalled")}</span>}
															{!e.builtin && <span className="set-catalog-custom">{t("pluginCatalogCustom")}</span>}
														</div>
														{e.description && <div className="set-catalog-desc">{e.description}</div>}
														<div className="set-catalog-source">{e.source}</div>
													</div>
													<div className="set-row-actions">
														{installed ? (
															<>
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("pluginUpdateHint")}
																	onClick={() => runUiPluginUpdate(e.id, e.source)}
																>
																	<FiRefreshCw />
																	{t("pluginUpdate")}
																</button>
																{confirmUiUninstall === e.id ? (
																	<button
																		type="button"
																		className="set-uninstall confirm"
																		title={t("pluginUninstallHint")}
																		onClick={() => runUiPluginUninstall(e.id)}
																	>
																		{t("uninstallConfirm")}
																	</button>
																) : (
																	<button
																		type="button"
																		className="set-uninstall"
																		title={t("pluginUninstallHint")}
																		onClick={() => setConfirmUiUninstall(e.id)}
																	>
																		<FiTrash2 />
																		{t("uninstallExt")}
																	</button>
																)}
															</>
														) : (
															<button
																type="button"
																className="set-uninstall"
																title={t("pluginInstallHint")}
																onClick={() => runCatalogInstall(e)}
															>
																<FiDownload />
																{t("pluginInstall")}
															</button>
														)}
														{!e.builtin && (
															<button
																type="button"
																className="set-uninstall"
																title={t("pluginCatalogRemoveHint")}
																onClick={() => runCatalogRemove(e.id)}
															>
																<FiX />
															</button>
														)}
													</div>
												</div>
											);
										})}
									</div>
								)}
							</div>
						)}

						{/* ---- UI plugins（<dataDir>/plugins，纯 UI 隐藏） ----------------- */}
						{tab === "plugins" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiBox className="set-section-icon" />
									{t("settingsUiPlugins")}
									<span className="set-count">{chat.plugins.length}</span>
								</div>
								{chat.plugins.length === 0 ? (
									<p className="set-empty">{t("noUiPlugins")}</p>
								) : (
									<div className="set-list">
										{chat.plugins.map((p) => (
											<>
												<ToggleRow
													key={p.id}
													title={`${p.icon ? `${p.icon} ` : ""}${p.name}`}
													subtitle={
														(p.error
															? `${p.id} · ${p.error}`
															: p.source
																? `${p.id} · ${p.source}`
																: `${p.id} · ${t("uiPluginNoSource")}`) +
														(p.permissions?.length ? ` · ${t("uiPluginPerms")}: ${p.permissions.join(", ")}` : "")
													}
													enabled={!disabledPlugins.has(p.id) && !p.error}
													onToggle={() => !p.error && togglePlugin(p)}
													action={
														<div className="set-row-actions">
															{p.source && (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("pluginUpdateHint")}
																	onClick={() => runUiPluginUpdate(p.id, p.source!)}
																>
																	<FiRefreshCw />
																	{t("pluginUpdate")}
																</button>
															)}
															{confirmUiUninstall === p.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	title={t("pluginUninstallHint")}
																	onClick={() => runUiPluginUninstall(p.id)}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("pluginUninstallHint")}
																	onClick={() => setConfirmUiUninstall(p.id)}
																>
																	<FiTrash2 />
																	{t("uninstallExt")}
																</button>
															)}
														</div>
													}
												/>
												{/* 声明式设置：manifest settings schema → 自动渲染表单 */}
												{p.settingsSchema && p.settingsSchema.length > 0 && (
													<PluginSettingsForm plugin={p} send={send} />
												)}
											</>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- DSH 用户补丁（<dataDir>/dsh-patches，仅 dsh 引擎） ---------- */}
						{tab === "plugins" && chat.engine === "dsh" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiBox className="set-section-icon" />
									{t("dshPatches")}
									<HintTip text={t("dshPatchesDesc")} />
									<span className="set-count">{chat.dshPatches?.files.length ?? 0}</span>
									<button
										type="button"
										className="set-uninstall"
										title={t("dshPatchesRescanHint")}
										onClick={() => send({ type: "dsh_patches_rescan" })}
									>
										<FiRefreshCw />
										{t("dshPatchesRescan")}
									</button>
								</div>
								{(chat.dshPatches?.files.length ?? 0) === 0 ? (
									<p className="set-empty">{t("dshPatchesEmpty")}</p>
								) : (
									<div className="set-list">
										{chat.dshPatches!.files.map((f) => (
											<div className="set-row" key={f.name}>
												<div className="set-row-info">
													<div className="set-row-name">{f.name}</div>
													<div className="set-row-desc">
														{formatBytes(f.size)} · {new Date(f.mtimeMs).toLocaleString()}
													</div>
												</div>
											</div>
										))}
									</div>
								)}
								<p className="set-hint">
									{t("dshPatchesPath")} {chat.dshPatches?.patchDir ?? ""}
								</p>
							</div>
						)}

						{/* ---- goal review ----------------------------------------------- */}
						{tab === "review" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiZap className="set-section-icon" />
									{t("settingsReview")}
									<HintTip text={t("settingsReviewDesc")} />
									<span className="set-count">{settings.reviewSkills.length}</span>
								</div>
								<ToggleRow
									title={t("goalModeEnabled")}
									tip={t("goalModeEnabledDesc")}
									enabled={settings.goalModeEnabled}
									onToggle={() => setPartial({ goalModeEnabled: !settings.goalModeEnabled })}
								/>
								{!settings.goalModeEnabled && <p className="set-hint">{t("goalModeOffHint")}</p>}
								{isDsh && <p className="set-hint">{t("dshReviewPromptNote")}</p>}
								<textarea
									className="set-prompt-input"
									rows={5}
									placeholder={t("reviewPromptPlaceholder")}
									value={reviewPromptDraft}
									onFocus={() => (reviewPromptFocus.current = true)}
									onBlur={() => {
										reviewPromptFocus.current = false;
										setPartial({ reviewPrompt: reviewPromptDraft });
									}}
									onChange={(e) => setReviewPromptDraft(e.target.value)}
								/>
								<div className="set-field-label">{t("settingsReviewSkills")}</div>
								{settings.reviewSkills.length === 0 ? (
									<p className="set-empty">{t("noSkills")}</p>
								) : (
									<div className="set-list">
										{settings.reviewSkills.map((s) => (
											<ToggleRow
												key={`review-${s.name}`}
												title={s.name}
												subtitle={s.description}
												enabled={s.enabled}
												onToggle={() => toggleReviewSkill(s)}
											/>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- vision bridge ---------------------------------------------- */}
						{tab === "vision" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiEye className="set-section-icon" />
									{t("settingsVisionBridge")}
								</div>
								<ToggleRow
									title={t("visionBridgeEnabled")}
									tip={t("settingsVisionBridgeDesc")}
									enabled={settings.visionBridgeEnabled}
									onToggle={() => setPartial({ visionBridgeEnabled: !settings.visionBridgeEnabled })}
								/>
								{!settings.visionBridgeEnabled && <p className="set-hint">{t("visionBridgeOffHint")}</p>}
								{settings.visionBridgeEnabled && (
									<div className="set-mode-row">
										<label className="set-field-label">{t("visionBridgeModel")}</label>
										<select
											className="set-select"
											value={settings.visionBridgeModel ?? ""}
											onChange={(e) => setPartial({ visionBridgeModel: e.target.value || null })}
										>
											<option value="">{t("visionBridgeAuto")}</option>
											{settings.visionModels.map((m) => (
												<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
													{m.label}
												</option>
											))}
										</select>
									</div>
								)}
								{settings.visionBridgeEnabled && (
									<div className="set-mode-row">
										<label className="set-field-label">{t("visionBridgePromptMode")}</label>
										<select
											className="set-select"
											value={vbPromptMode}
											onChange={(e) => {
												const mode = e.target.value as "append" | "replace";
												setVbPromptMode(mode);
												setPartial({ visionBridgePromptMode: mode });
											}}
										>
											<option value="append">{t("promptModeAppend")}</option>
											<option value="replace">{t("promptModeReplace")}</option>
										</select>
									</div>
								)}
								{settings.visionBridgeEnabled && (
									<textarea
										className="set-prompt-input"
										rows={4}
										placeholder={t("visionBridgePromptPlaceholder")}
										value={vbPromptDraft}
										onFocus={() => (vbPromptFocus.current = true)}
										onBlur={() => {
											vbPromptFocus.current = false;
											// Same contract as the system prompt: an unmodified copy of
											// the built-in default is stored as empty (use default).
											const text =
												vbPromptMode === "replace" &&
												settings.visionBridgeDefaultPrompt &&
												vbPromptDraft === settings.visionBridgeDefaultPrompt
													? ""
													: vbPromptDraft;
											setPartial({
												visionBridgePromptMode: vbPromptMode,
												visionBridgePrompt: text,
											});
										}}
										onChange={(e) => setVbPromptDraft(e.target.value)}
									/>
								)}
								{settings.visionBridgeEnabled &&
									(settings.visionModels.length === 0 ? (
										<p className="set-hint">{t("visionBridgeNoModels")}</p>
									) : (
										<p className="set-hint">
											{t("visionBridgeCurrent", {
												model: settings.visionBridgeModel ?? t("visionBridgeAuto"),
											})}
										</p>
									))}
							</div>
						)}

						{tab === "presets" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSettings className="set-section-icon" />
									{t("settingsPresets")}
									<span className="set-count">{settings.presets.length}</span>
								</div>
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("presetNamePlaceholder")}
										value={presetName}
										onChange={(e) => setPresetName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && presetName.trim()) {
												send({ type: "save_preset", name: presetName.trim() });
												setPresetName("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!presetName.trim()}
										onClick={() => {
											send({ type: "save_preset", name: presetName.trim() });
											setPresetName("");
										}}
									>
										<FiPlus /> {t("saveAsPreset")}
									</button>
								</div>
								{settings.presets.length === 0 ? (
									<p className="set-empty">{t("noPresets")}</p>
								) : (
									<div className="set-list">
										{settings.presets.map((p) => (
											<div className="set-row" key={p.name}>
												<div className="set-row-info">
													<div className="set-row-name">{p.name}</div>
													<div className="set-row-desc">
														{p.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}
														{p.disabledSkills.length > 0 && ` · ${t("settingsSkills")} ${p.disabledSkills.length}`}
														{p.disabledExtensions.length > 0 &&
															` · ${t("settingsExtensions")} ${p.disabledExtensions.length}`}
													</div>
												</div>
												<div className="set-row-actions">
													<button
														type="button"
														className="dd-refresh"
														onClick={() => send({ type: "apply_preset", name: p.name })}
													>
														{t("applyPreset")}
													</button>
													<button
														type="button"
														className="set-icon-btn danger"
														title={t("deletePreset")}
														onClick={() => send({ type: "delete_preset", name: p.name })}
													>
														<FiTrash2 />
													</button>
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- subagent templates（全局共享；DSH 引擎隐藏该分区） ---------- */}
						{tab === "subagent-templates" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiUsers className="set-section-icon" />
									{t("settingsSubagentTemplates")}
									<HintTip text={t("settingsSubagentTemplatesDesc")} />
									<span className="set-count">{settings.subagentTemplates.length}</span>
									<button
										type="button"
										className="set-save-btn"
										title={t("subagentTemplateNew")}
										onClick={() =>
											setTplDraft({
												name: "",
												description: "",
												promptMode: "replace",
												systemPrompt: "",
												enabledSkills: [],
												enabledExtensions: [],
												model: "",
												enabled: true,
											})
										}
									>
										<FiPlus /> {t("subagentTemplateNew")}
									</button>
								</div>

								{/* ---- 默认模型：全部子代理的兜底（模板/显式 model 参数优先） ---------- */}
								<div className="set-mode-row">
									<label className="set-field-label">{t("subagentDefaultModelLabel")}</label>
									<select
										className="set-select"
										value={settings.subagentDefaultModel ?? ""}
										onChange={(e) => setPartial({ subagentDefaultModel: e.target.value || null })}
									>
										<option value="">{t("subagentFollowMain")}</option>
										{settings.subagentModels.map((m) => (
											<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
												{m.label}
											</option>
										))}
									</select>
								</div>
								{settings.subagentModels.length === 0 ? (
									<p className="set-hint">{t("subagentNoModels")}</p>
								) : (
									<p className="set-hint">{t("subagentDefaultModelHint")}</p>
								)}

								{/* ---- 编辑器（新建 / 编辑同表单） ------------------------------ */}
								{tplDraft && (
									<div className="tpl-editor">
										<div className="tpl-fields">
											<input
												className="set-input"
												placeholder={t("tplNamePlaceholder")}
												value={tplDraft.name}
												onChange={(e) => setTplDraft({ ...tplDraft, name: e.target.value })}
											/>
											<input
												className="set-input"
												placeholder={t("tplDescriptionPlaceholder")}
												value={tplDraft.description}
												onChange={(e) => setTplDraft({ ...tplDraft, description: e.target.value })}
											/>
											<input
												className="set-input"
												placeholder={t("tplDescriptionEnPlaceholder")}
												value={tplDraft.descriptionEn ?? ""}
												onChange={(e) => setTplDraft({ ...tplDraft, descriptionEn: e.target.value })}
											/>
										</div>
										<div className="set-mode-row">
											<label className="set-field-label">{t("tplPromptModeLabel")}</label>
											<select
												className="set-select"
												value={tplDraft.promptMode}
												onChange={(e) =>
													setTplDraft({ ...tplDraft, promptMode: e.target.value as "append" | "replace" })
												}
											>
												<option value="replace">{t("promptModeReplace")}</option>
												<option value="append">{t("promptModeAppend")}</option>
											</select>
										</div>
										<div className="set-mode-row">
											<label className="set-field-label">{t("tplModelLabel")}</label>
											<select
												className="set-select"
												value={tplDraft.model ?? ""}
												onChange={(e) => setTplDraft({ ...tplDraft, model: e.target.value })}
											>
												<option value="">{t("subagentFollowMain")}</option>
												{settings.subagentModels.map((m) => (
													<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
														{m.label}
													</option>
												))}
											</select>
										</div>
										<textarea
											className="set-prompt-input"
											rows={4}
											placeholder={`${t("tplSystemPromptLabel")}：${t("tplSystemPromptPlaceholder")}`}
											value={tplDraft.systemPrompt}
											onChange={(e) => setTplDraft({ ...tplDraft, systemPrompt: e.target.value })}
										/>
										<textarea
											className="set-prompt-input"
											rows={4}
											placeholder={`${t("tplSystemPromptLabel")}: ${t("tplSystemPromptEnPlaceholder")}`}
											value={tplDraft.systemPromptEn ?? ""}
											onChange={(e) => setTplDraft({ ...tplDraft, systemPromptEn: e.target.value })}
										/>
										<div className="tpl-pick-block">
											<div className="tpl-pick-head">
												<span>
													{t("tplSkillsLabel")} · {t("tplWhitelistHint")}
												</span>
											</div>
											{settings.skills.length === 0 ? (
												<p className="set-hint">{t("noSkills")}</p>
											) : (
												<div className="tpl-pick">
													{settings.skills.map((s) => (
														<label
															key={s.name}
															className={`tpl-chip${tplDraft.enabledSkills.includes(s.name) ? " on" : ""}`}
														>
															<input
																type="checkbox"
																checked={tplDraft.enabledSkills.includes(s.name)}
																onChange={(e) => {
																	const on = e.target.checked;
																	setTplDraft({
																		...tplDraft,
																		enabledSkills: on
																			? [...tplDraft.enabledSkills, s.name]
																			: tplDraft.enabledSkills.filter((n) => n !== s.name),
																	});
																}}
															/>
															{s.name}
														</label>
													))}
												</div>
											)}
										</div>
										<div className="tpl-pick-block">
											<div className="tpl-pick-head">
												<span>
													{t("tplExtensionsLabel")} · {t("tplWhitelistHint")}
												</span>
											</div>
											{settings.extensions.length === 0 ? (
												<p className="set-hint">{t("noExtensions")}</p>
											) : (
												<div className="tpl-pick">
													{settings.extensions.map((x) => (
														<label
															key={x.id}
															className={`tpl-chip${tplDraft.enabledExtensions.includes(x.id) ? " on" : ""}`}
														>
															<input
																type="checkbox"
																checked={tplDraft.enabledExtensions.includes(x.id)}
																onChange={(e) => {
																	const on = e.target.checked;
																	setTplDraft({
																		...tplDraft,
																		enabledExtensions: on
																			? [...tplDraft.enabledExtensions, x.id]
																			: tplDraft.enabledExtensions.filter((id) => id !== x.id),
																	});
																}}
															/>
															{x.name}
														</label>
													))}
												</div>
											)}
										</div>
										<div className="tpl-actions">
											<button
												type="button"
												className="set-save-btn"
												disabled={!tplDraft.name.trim()}
												onClick={() => {
													send({
														type: "save_subagent_template",
														template: { ...tplDraft, name: tplDraft.name.trim() },
													});
													setTplDraft(null);
												}}
											>
												{t("tplSave")}
											</button>
											<button type="button" className="dd-refresh" onClick={() => setTplDraft(null)}>
												{t("tplCancel")}
											</button>
										</div>
									</div>
								)}

								{/* ---- 模板列表 ------------------------------------------------ */}
								{settings.subagentTemplates.length === 0 ? (
									<p className="set-empty">{t("noSubagentTemplates")}</p>
								) : (
									<div className="set-list">
										{settings.subagentTemplates.map((tp) => (
											<div className="set-row" key={tp.name}>
												<div className="set-row-info">
													<div className="set-row-name">
														{tp.name}
														{settings.subagentDefaultTemplates.includes(tp.name) && (
															<span className="tpl-badge default">{t("tplDefaultBadge")}</span>
														)}
														{!tp.enabled && <span className="tpl-badge">{t("subagentTemplateClosed")}</span>}
													</div>
													<div className="set-row-desc">
														{(locale !== "zh" && tp.descriptionEn ? tp.descriptionEn : tp.description) ||
															`${tp.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}`}
														{tp.model ? ` · ${t("tplModelLabel")} ${tp.model}` : ` · ${t("subagentFollowMain")}`}
														{tp.enabledSkills.length > 0 && ` · ${t("tplSkillsLabel")} ${tp.enabledSkills.length}`}
														{tp.enabledExtensions.length > 0 &&
															` · ${t("tplExtensionsLabel")} ${tp.enabledExtensions.length}`}
														{!tp.description &&
															tp.enabledSkills.length === 0 &&
															tp.enabledExtensions.length === 0 &&
															` · ${t("tplInherit")}`}
													</div>
												</div>
												<div className="set-row-actions">
													<button
														type="button"
														className={`set-switch${tp.enabled ? " on" : ""}`}
														role="switch"
														aria-checked={tp.enabled}
														title={`${tp.enabled ? t("subagentTemplateDisable") : t("subagentTemplateEnable")} · ${t("subagentTemplateOffHint")}`}
														onClick={() =>
															send({ type: "save_subagent_template", template: { ...tp, enabled: !tp.enabled } })
														}
													>
														<span className="set-switch-knob" />
													</button>
													<button
														type="button"
														className="dd-refresh"
														title={t("subagentTemplateEdit")}
														onClick={() => setTplDraft({ ...tp })}
													>
														{t("subagentTemplateEdit")}
													</button>
													{confirmTplDelete === tp.name ? (
														<button
															type="button"
															className="set-uninstall confirm"
															title={t("uninstallConfirmHint")}
															onClick={() => {
																send({ type: "delete_subagent_template", name: tp.name });
																setConfirmTplDelete(null);
															}}
														>
															{t("uninstallConfirm")}
														</button>
													) : (
														<button
															type="button"
															className="set-icon-btn danger"
															title={t("tplDelete")}
															onClick={() => setConfirmTplDelete(tp.name)}
														>
															<FiTrash2 />
														</button>
													)}
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				<div className="modal-actions">
					<button type="button" className="dd-refresh" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		</div>
	);
}
