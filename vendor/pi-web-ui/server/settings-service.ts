/**
 * Settings service — 从 agent-service.ts 抽出（系统提示词 / 技能插件开关 /
 * 目标审查提示词 / 预设 / 视觉桥偏好）。设置持久化在 client-state.json 按客户端隔离。
 *
 * 经 SettingsHost 回调与 ClientSession 解耦：本模块只管「设置状态 + 面板推送 +
 * 预设存取 + 何时需要 reload」，真正动 runtime 的 session.reload() 走宿主回调
 * （reloadSession 里还会刷新斜杠命令目录）。
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, UiExtensionInfo, UiSettingsState, UiSkillInfo, UiVisionBridgeModel } from "./protocol.js";
import {
	extensionKey,
	normalizeRetryMaxAttempts,
	type ClientStateStore,
	type ClientSettings,
	type PromptMode,
} from "./client-state.js";
import { findVisionModels, SYSTEM_PROMPT } from "./vision-bridge.js";
import { DEFAULT_TEMPLATES, type SubagentTemplatesStore } from "./subagent-templates.js";

/** ClientSession 提供给本服务的宿主能力（窄接口，便于独立测试）。 */
export interface MarkerStateForSettings {
	markersEnabled: boolean;
	disabledMarkers: string[];
	markers: import("./protocol.js").UiMarkerInfo[];
}

export interface SettingsHost {
	clientId: string;
	stateStore: ClientStateStore;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	/** 当前活动对话的 session（未就绪时调用方自行 try/catch）。 */
	getSession: () => AgentSession;
	/** 会话工作区（磁盘校验“已删除的 skill”用）。 */
	cwd: () => string;
	/** pi 配置目录（<agentDir>/skills 是技能来源之一）。 */
	agentDir: () => string;
	isStreaming: () => boolean;
	/** session.reload() + 刷新斜杠命令目录。 */
	reloadSession: () => Promise<void>;
	/** 把设置面板的出错重试次数即时注入各会话（无需 reload；reload 后由
	 *  调用方重放，见 agent-service applyRetryOverrides）。 */
	applyRetryOverrides: () => void;
	/** 当前会话提示词快照（设置面板预览用；会话未就绪时 full="" 且 texts={}）。
	 *  full = 实际生效的完整系统提示词（组合模式 = 模板 + 各来源自动/覆盖内容渲染结果）；
	 *  texts = 各来源 token 当前的默认（自动）内容（未覆盖时 {{token}} 展开值）；
	 *  toolsSchema = 发给模型的 function-calling 工具定义（name/description/parameters）只读文本。 */
	promptSnapshot: () => { full: string; texts: Record<string, string>; toolsSchema: string };
	/** 可选：内置标记状态（设置面板展示用）。 */
	getMarkerState?: () => MarkerStateForSettings;
}

export class SettingsService {
	private settings: ClientSettings;
	private presets: SettingsPreset[];
	private knownSkills = new Map<string, UiSkillInfo>();
	private knownExtensions = new Map<string, UiExtensionInfo>();
	/** 流式中改了需要 reload 的设置 → agent_end 后延迟应用（防拆毁运行中 run）。 */
	private pendingReload = false;

	constructor(
		private readonly host: SettingsHost,
		/** 全局子代理模板库（所有客户端共享；模板改动无需 reload runtime）。 */
		private readonly templates: SubagentTemplatesStore,
	) {
		this.settings = host.stateStore.getSettings(host.clientId);
		this.presets = host.stateStore.getPresets(host.clientId);
	}

	get current(): ClientSettings {
		return this.settings;
	}

	get reviewPrefs(): Pick<ClientSettings, "reviewPrompt" | "reviewDisabledSkills"> {
		return {
			reviewPrompt: this.settings.reviewPrompt,
			reviewDisabledSkills: this.settings.reviewDisabledSkills,
		};
	}

	hasPendingReload(): boolean {
		return this.pendingReload;
	}

	consumePendingReload(): boolean {
		const v = this.pendingReload;
		this.pendingReload = false;
		return v;
	}

	/** 判断某个 skill 名是否仍存在于磁盘任何来源（agent 区 / 项目 .pi / 祖先
	 *  .agents/skills / npm 包内 skills）。被禁用且文件已删除的名字不应再
	 *  出现在设置面板，也不应留在持久化记录里。 */
	private skillStillOnDisk(name: string): boolean {
		const cwd = this.host.cwd();
		const agentDir = this.host.agentDir();
		const check = (base: string) => existsSync(join(base, name)) || existsSync(join(base, `${name}.md`));
		// ① 用户区 <agentDir>/skills ② 项目 .pi/skills
		if (check(join(agentDir, "skills"))) return true;
		if (check(join(cwd, ".pi", "skills"))) return true;
		// ③ 祖先链 .agents/skills（SDK collectAncestorAgentsSkillDirs 语义，最多上溯 6 层）
		let dir: string = cwd;
		for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
			if (check(join(dir, ".agents", "skills"))) return true;
		}
		// ④ npm 包内 skills（agent 级 + 项目级，含 @scope 两级子包）
		for (const npmRoot of [join(agentDir, "npm", "node_modules"), join(cwd, ".pi", "npm", "node_modules")]) {
			try {
				for (const entry of readdirSync(npmRoot, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					if (!entry.name.startsWith("@")) {
						if (check(join(npmRoot, entry.name, "skills"))) return true;
					} else {
						for (const sub of readdirSync(join(npmRoot, entry.name), { withFileTypes: true })) {
							if (sub.isDirectory() && check(join(npmRoot, entry.name, sub.name, "skills"))) {
								return true;
							}
						}
					}
				}
			} catch {
				// npm 目录不存在/不可读 → 不是来源
			}
		}
		return false;
	}

	push(): void {
		const disabledSkills = new Set(this.settings.disabledSkills);
		const reviewDisabledSkills = new Set(this.settings.reviewDisabledSkills);
		const disabledExts = new Set(this.settings.disabledExtensions);
		let loadedSkillNames: Set<string> | null = null;
		try {
			const loadedSkills = this.host.getSession().resourceLoader.getSkills().skills;
			const loadedExts = this.host.getSession().resourceLoader.getExtensions().extensions;
			loadedSkillNames = new Set(loadedSkills.map((s) => s.name));
			// Prune entries that no longer exist on disk AND aren't disabled
			// (e.g. a skill/extension file was deleted). Disabled entries are
			// kept so they can be re-enabled even when filtered out of the loader.
			const keepSkills = new Set<string>([...loadedSkills.map((s) => s.name), ...this.settings.disabledSkills]);
			const keepExts = new Set<string>([
				...loadedExts.map((e) => extensionKey(e)),
				...this.settings.disabledExtensions,
			]);
			// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
			for (const name of [...this.knownSkills.keys()]) {
				if (!keepSkills.has(name)) this.knownSkills.delete(name);
			}
			// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
			for (const id of [...this.knownExtensions.keys()]) {
				if (!keepExts.has(id)) this.knownExtensions.delete(id);
			}
			for (const s of loadedSkills) {
				this.knownSkills.set(s.name, {
					name: s.name,
					description: s.description,
					enabled: true,
				});
			}
			for (const e of loadedExts) {
				const id = extensionKey(e);
				const p = e.sourceInfo?.path ?? e.path;
				this.knownExtensions.set(id, {
					id,
					name: e.sourceInfo?.origin === "package" && e.sourceInfo.source ? e.sourceInfo.source : basename(p),
					path: p,
					enabled: true,
				});
			}
		} catch {
			// Session not ready yet — keep whatever we already know.
		}
		// 清理“源文件已删除”的禁用残留记录：磁盘上已不存在的技能名从
		// disabledSkills / reviewDisabledSkills 持久化记录中移除——否则每次
		// 推送都会把已删除的 skill 以灰条形式永恒地补回面板（“关闭过的
		// skill 被一直记录”）。session 未就绪时保守跳过。
		if (loadedSkillNames !== null) {
			const stale = [...new Set([...this.settings.disabledSkills, ...this.settings.reviewDisabledSkills])].filter(
				(name) => !loadedSkillNames!.has(name) && !this.skillStillOnDisk(name),
			);
			if (stale.length > 0) {
				this.settings.disabledSkills = this.settings.disabledSkills.filter((n) => !stale.includes(n));
				this.settings.reviewDisabledSkills = this.settings.reviewDisabledSkills.filter((n) => !stale.includes(n));
				this.host.stateStore.saveSettings(this.host.clientId, {
					disabledSkills: this.settings.disabledSkills,
					reviewDisabledSkills: this.settings.reviewDisabledSkills,
				});
			}
		}
		// Disabled entries that still exist on disk are re-added (with the
		// last-known description) so they can be re-enabled; entries whose
		// source file was deleted are dropped instead of being resurrected.
		for (const name of this.settings.disabledSkills) {
			if (this.knownSkills.has(name)) continue;
			if (!this.skillStillOnDisk(name)) continue;
			this.knownSkills.set(name, { name, description: "", enabled: false });
		}
		for (const id of this.settings.disabledExtensions) {
			if (!this.knownExtensions.has(id)) {
				this.knownExtensions.set(id, {
					id,
					name: id.startsWith("npm:") ? id : basename(id),
					path: "",
					enabled: false,
				});
			}
		}
		const skills = [...this.knownSkills.values()]
			.map((s) => ({ ...s, enabled: !disabledSkills.has(s.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const reviewSkills = [...this.knownSkills.values()]
			.map((s) => ({ ...s, enabled: !reviewDisabledSkills.has(s.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const extensions = [...this.knownExtensions.values()]
			.map((e) => ({ ...e, enabled: !disabledExts.has(e.id) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		// 当前会话提示词快照：完整生效文本 + 各来源默认（自动）内容（只读预览）。
		const promptSnap = this.host.promptSnapshot();
		this.host.emit({
			type: "settings_state",
			settings: {
				promptMode: this.settings.promptMode,
				customSystemPrompt: this.settings.customSystemPrompt,
				promptTemplate: this.settings.promptTemplate ?? "",
				promptOverrides: { ...this.settings.promptOverrides },
				terminalToolsEnabled: this.settings.terminalToolsEnabled,
				terminalBash: this.settings.terminalBash,
				terminalBashIdleMs: this.settings.terminalBashIdleMs,
				editSoftEnabled: this.settings.editSoftEnabled,
				questionnaireEnabled: this.settings.questionnaireEnabled,
				goalModeEnabled: this.settings.goalModeEnabled,
				thinkingWrap: this.settings.thinkingWrap,
				toolsWrap: this.settings.toolsWrap,
				visionBridgeEnabled: this.settings.visionBridgeEnabled,
				visionBridgeModel: this.settings.visionBridgeModel,
				visionBridgePromptMode: this.settings.visionBridgePromptMode,
				visionBridgePrompt: this.settings.visionBridgePrompt,
				reviewPrompt: this.settings.reviewPrompt,
				reviewDisabledSkills: [...this.settings.reviewDisabledSkills],
				disabledPlugins: [...(this.settings.disabledPlugins ?? [])],
				// The composed system prompt actually in effect (read-only view).
				effectiveSystemPrompt: promptSnap.full,
				// 每个来源未覆盖时的默认（自动）内容（「各来源」行预览用）。
				promptSourceDefaults: promptSnap.texts,
				// 发给模型的工具 schema（name/description/parameters）—— 只读预览。
				toolsSchema: promptSnap.toolsSchema,
				visionBridgeDefaultPrompt: SYSTEM_PROMPT,
				visionModels: this.collectVisionModels(),
				disabledSkills: [...this.settings.disabledSkills],
				disabledExtensions: [...this.settings.disabledExtensions],
				skills,
				reviewSkills,
				extensions,
				presets: this.presets.map((p) => ({ ...p })),
				...(this.host.getMarkerState
					? this.host.getMarkerState()
					: {
							markersEnabled: true,
							disabledMarkers: [] as string[],
							markers: [] as import("./protocol.js").UiMarkerInfo[],
						}),
				subagentTemplates: this.templates.list(),
				subagentDefaultTemplates: DEFAULT_TEMPLATES.map((t) => t.name),
				subagentDefaultModel: this.settings.subagentDefaultModel ?? null,
				retryMaxAttempts: this.settings.retryMaxAttempts,
				subagentModels: this.collectSubagentModels(),
				quickPhrases: [...this.settings.quickPhrases],
				quickPhrasesEnabled: this.settings.quickPhrasesEnabled,
				quickPhrasesSeeded: this.host.stateStore.getQuickPhrasesSeeded(),
			} satisfies UiSettingsState,
		});
	}

	/** Vision-capable configured models, for the settings-panel picker. */
	private collectVisionModels(): UiVisionBridgeModel[] {
		try {
			return findVisionModels(this.host.getSession().modelRuntime).map((m) => ({
				provider: m.provider,
				id: m.id,
				label: m.label,
			}));
		} catch {
			// Session not ready yet — the picker stays empty until next push.
			return [];
		}
	}

	/** 已配置鉴权的全部模型（子代理模型选择器用；跟随视觉桥的收集方式但不限视觉）。 */
	private collectSubagentModels(): UiVisionBridgeModel[] {
		try {
			const runtime = this.host.getSession().modelRuntime;
			const out: UiVisionBridgeModel[] = [];
			for (const p of runtime.getProviders()) {
				if (!runtime.hasConfiguredAuth(p.id)) continue;
				for (const m of runtime.getModels(p.id)) {
					out.push({
						provider: p.id,
						id: m.id,
						label: `${m.name ?? m.id} (${p.id})`,
					});
				}
			}
			// 稳定排序：provider 名 → 模型名。
			return out.sort((a, b) =>
				a.provider === b.provider ? a.label.localeCompare(b.label) : a.provider.localeCompare(b.provider),
			);
		} catch {
			// Session not ready yet — the picker stays empty until next push.
			return [];
		}
	}

	/** Persist + apply a partial settings update (compose template / per-source
	 *  overrides, skill/extension toggles). */
	async set(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		goalModeEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		disabledPlugins?: string[];
		subagentDefaultModel?: string | null;
		retryMaxAttempts?: number;
		markersEnabled?: boolean;
		disabledMarkers?: string[];
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
	}): Promise<void> {
		const needsReload =
			partial.promptMode !== undefined ||
			partial.customSystemPrompt !== undefined ||
			partial.promptTemplate !== undefined ||
			partial.promptOverrides !== undefined ||
			partial.disabledSkills !== undefined ||
			partial.disabledExtensions !== undefined ||
			partial.terminalToolsEnabled !== undefined ||
			partial.editSoftEnabled !== undefined;
		if (partial.promptMode !== undefined) this.settings.promptMode = partial.promptMode;
		if (partial.customSystemPrompt !== undefined) {
			this.settings.customSystemPrompt = partial.customSystemPrompt;
		}
		if (partial.promptTemplate !== undefined) {
			this.settings.promptTemplate = partial.promptTemplate;
		}
		if (partial.promptOverrides !== undefined) {
			// 只合并给出的 key；空串 = 清除该来源覆盖。
			const next = { ...this.settings.promptOverrides };
			for (const [k, v] of Object.entries(partial.promptOverrides)) {
				if (v && v.trim()) next[k] = v;
				else delete next[k];
			}
			this.settings.promptOverrides = next;
		}
		if (partial.disabledSkills !== undefined) {
			this.settings.disabledSkills = partial.disabledSkills;
		}
		if (partial.disabledExtensions !== undefined) {
			this.settings.disabledExtensions = partial.disabledExtensions;
		}
		// 插件开关是纯 UI 隐藏（不进 needsReload——运行时无需重载）。
		if (partial.disabledPlugins !== undefined) {
			this.settings.disabledPlugins = partial.disabledPlugins;
		}
		if (partial.terminalToolsEnabled !== undefined) {
			this.settings.terminalToolsEnabled = partial.terminalToolsEnabled;
		}
		if (partial.terminalBash !== undefined) {
			this.settings.terminalBash = partial.terminalBash;
		}
		if (partial.terminalBashIdleMs !== undefined) {
			this.settings.terminalBashIdleMs = Math.max(0, Math.floor(partial.terminalBashIdleMs) || 0);
		}
		if (partial.editSoftEnabled !== undefined) {
			this.settings.editSoftEnabled = partial.editSoftEnabled;
		}
		// 问卷开关：运行时无需重载（bridge 处实时读取）。
		if (partial.questionnaireEnabled !== undefined) {
			this.settings.questionnaireEnabled = partial.questionnaireEnabled;
		}
		// 目标模式总开关：运行时无需重载（goal bar / 服务端入口实时读取）。
		if (partial.goalModeEnabled !== undefined) {
			this.settings.goalModeEnabled = partial.goalModeEnabled;
		}
		if (partial.thinkingWrap !== undefined) {
			this.settings.thinkingWrap = partial.thinkingWrap;
		}
		if (partial.toolsWrap !== undefined) {
			this.settings.toolsWrap = partial.toolsWrap;
		}
		if (partial.visionBridgeEnabled !== undefined) {
			this.settings.visionBridgeEnabled = partial.visionBridgeEnabled;
		}
		if (partial.visionBridgeModel !== undefined) {
			this.settings.visionBridgeModel = partial.visionBridgeModel ?? null;
		}
		if (partial.visionBridgePromptMode !== undefined) {
			this.settings.visionBridgePromptMode = partial.visionBridgePromptMode;
		}
		if (partial.visionBridgePrompt !== undefined) {
			this.settings.visionBridgePrompt = partial.visionBridgePrompt;
		}
		if (partial.reviewPrompt !== undefined) {
			this.settings.reviewPrompt = partial.reviewPrompt;
		}
		if (partial.reviewDisabledSkills !== undefined) {
			this.settings.reviewDisabledSkills = partial.reviewDisabledSkills;
		}
		if (partial.subagentDefaultModel !== undefined) {
			// 空串归一为 null（跟随主对话）；其余剥空白后存格式 provider/id。
			const m = partial.subagentDefaultModel?.trim() ?? "";
			this.settings.subagentDefaultModel = m ? m : null;
		}
		if (partial.retryMaxAttempts !== undefined) {
			// 出错重试次数：持久化 + 即时注入各会话（SDK 在每次退避前都重读
			// getRetrySettings，无需 reload runtime；见宿主 applyRetryOverrides）。
			this.settings.retryMaxAttempts = normalizeRetryMaxAttempts(partial.retryMaxAttempts);
			this.host.applyRetryOverrides();
		}
		if (partial.quickPhrases !== undefined) {
			// 归一化：去空白/空项/重名，单条 ≤200 字，最多 30 条。纯 UI 偏好，不 reload。
			const seen = new Set<string>();
			this.settings.quickPhrases = (Array.isArray(partial.quickPhrases) ? partial.quickPhrases : [])
				.map((p) => String(p).trim().slice(0, 200))
				.filter((p) => p && !seen.has(p) && (seen.add(p), true))
				.slice(0, 30);
		}
		if (partial.quickPhrasesEnabled !== undefined) {
			this.settings.quickPhrasesEnabled = partial.quickPhrasesEnabled;
		}
		this.host.stateStore.saveSettings(this.host.clientId, this.settings);
		this.push();
		if (needsReload) await this.applyRuntime();
	}

	/** Save the CURRENT settings as a named preset (overwrites if exists). */
	async savePreset(name: string): Promise<void> {
		const n = name.trim();
		if (!n) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "预设名称不能为空",
				textEn: "Preset name cannot be empty",
			});
			return;
		}
		const preset = {
			name: n,
			promptMode: this.settings.promptMode,
			customSystemPrompt: this.settings.customSystemPrompt,
			promptTemplate: this.settings.promptTemplate ?? "",
			promptOverrides: { ...this.settings.promptOverrides },
			disabledSkills: [...this.settings.disabledSkills],
			disabledExtensions: [...this.settings.disabledExtensions],
			terminalToolsEnabled: this.settings.terminalToolsEnabled,
			terminalBash: this.settings.terminalBash,
			terminalBashIdleMs: this.settings.terminalBashIdleMs,
			editSoftEnabled: this.settings.editSoftEnabled,
			retryMaxAttempts: this.settings.retryMaxAttempts,
			reviewPrompt: this.settings.reviewPrompt,
			reviewDisabledSkills: [...this.settings.reviewDisabledSkills],
		};
		const existing = this.presets.findIndex((p) => p.name === n);
		if (existing >= 0) this.presets[existing] = preset;
		else this.presets.push(preset);
		this.host.stateStore.savePresets(this.host.clientId, this.presets);
		this.push();
	}

	/** Replace the current settings with the named preset and apply it. */
	async applyPreset(name: string): Promise<void> {
		const p = this.presets.find((x) => x.name === name);
		if (!p) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `预设不存在：${name}`,
				textEn: `Preset does not exist: ${name}`,
			});
			return;
		}
		this.settings = {
			promptMode: p.promptMode,
			customSystemPrompt: p.customSystemPrompt,
			promptTemplate: p.promptTemplate ?? this.settings.promptTemplate ?? "",
			promptOverrides: { ...(p.promptOverrides ?? this.settings.promptOverrides) },
			disabledSkills: [...p.disabledSkills],
			disabledExtensions: [...p.disabledExtensions],
			// 旧版持久化的预设可能没有该字段——保留当前值。
			terminalToolsEnabled: p.terminalToolsEnabled ?? this.settings.terminalToolsEnabled,
			// 终端接管偏好随预设走；旧预设缺字段时保留当前值。
			terminalBash: p.terminalBash ?? this.settings.terminalBash,
			terminalBashIdleMs: p.terminalBashIdleMs ?? this.settings.terminalBashIdleMs,
			editSoftEnabled: p.editSoftEnabled ?? this.settings.editSoftEnabled,
			// 重试次数随预设走；旧预设缺字段时保留当前值，应用后即时注入各会话。
			retryMaxAttempts: p.retryMaxAttempts ?? this.settings.retryMaxAttempts,
			// 问卷开关不进预设——保留当前值。
			questionnaireEnabled: this.settings.questionnaireEnabled,
			// 目标模式总开关不进预设——保留当前值。
			goalModeEnabled: this.settings.goalModeEnabled,
			reviewPrompt: p.reviewPrompt ?? this.settings.reviewPrompt,
			reviewDisabledSkills: [...(p.reviewDisabledSkills ?? this.settings.reviewDisabledSkills)],
			// 纯 UI 偏好不进预设——保留当前值。
			thinkingWrap: this.settings.thinkingWrap,
			toolsWrap: this.settings.toolsWrap,
			// Presets don't capture vision-bridge prefs — keep the current ones.
			visionBridgeEnabled: this.settings.visionBridgeEnabled,
			visionBridgeModel: this.settings.visionBridgeModel,
			visionBridgePromptMode: this.settings.visionBridgePromptMode,
			visionBridgePrompt: this.settings.visionBridgePrompt,
			// 子代理默认模型也不进预设——保留当前值。
			subagentDefaultModel: this.settings.subagentDefaultModel,
			// 快捷短语是纯 UI 偏好，不进预设——保留当前值。
			quickPhrases: [...this.settings.quickPhrases],
			quickPhrasesEnabled: this.settings.quickPhrasesEnabled,
		};
		this.host.stateStore.saveSettings(this.host.clientId, this.settings);
		// 预设可能改了重试次数：即时注入（流式中延迟的 reload 之后还会由调用方重放）。
		this.host.applyRetryOverrides();
		this.push();
		await this.applyRuntime();
	}

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		this.presets = this.presets.filter((p) => p.name !== name);
		this.host.stateStore.savePresets(this.host.clientId, this.presets);
		this.push();
	}

	/** Upsert 一个子代理模板（全局共享）。模板只影响未来派生的子代理，
	 *  不需要 reload runtime —— 直接推送新设置状态即可。 */
	async saveTemplate(template: Parameters<SubagentTemplatesStore["upsert"]>[0]): Promise<void> {
		const err = this.templates.upsert(template);
		if (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `子代理模板保存失败：${err}`,
				textEn: `Failed to save subagent template: ${err}`,
			});
			return;
		}
		this.push();
		const n = (template as { name?: string })?.name?.trim() ?? "";
		this.host.emit({
			type: "notice",
			level: "info",
			text: `子代理模板已保存：${n}`,
			textEn: `Subagent template saved: ${n}`,
		});
	}

	/** 删除一个子代理模板。 */
	async deleteTemplate(name: string): Promise<void> {
		this.templates.remove(name);
		this.push();
		this.host.emit({
			type: "notice",
			level: "info",
			text: `子代理模板已删除：${name}`,
			textEn: `Subagent template deleted: ${name}`,
		});
	}

	/**
	 * Make settings changes effective in the running runtime. The resource-loader
	 * overrides read this.settings at call time, so a reload re-applies them.
	 * Reloading mid-stream would tear down the in-flight run — defer instead.
	 */
	async applyRuntime(): Promise<void> {
		if (this.host.isDisposed()) return;
		if (this.host.isStreaming()) {
			this.pendingReload = true;
			this.host.emit({
				type: "notice",
				level: "info",
				text: "当前回复进行中，设置将在回复结束后自动应用",
				textEn: "A reply is in progress; settings will apply when it finishes",
			});
			return;
		}
		await this.applyReload();
	}

	/** session.reload() + refresh the slash-command catalog + push state. */
	private async applyReload(): Promise<void> {
		try {
			await this.host.reloadSession();
			this.push();
			this.host.flushSnapshot();
			this.host.emit({ type: "notice", level: "info", text: "设置已应用", textEn: "Settings applied" });
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `设置应用失败：${(err as Error).message}`,
				textEn: `Failed to apply settings: ${(err as Error).message}`,
			});
		}
	}
}

type SettingsPreset = ReturnType<ClientStateStore["getPresets"]>[number];
