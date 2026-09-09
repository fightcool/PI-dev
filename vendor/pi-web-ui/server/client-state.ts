/**
 * client-state — 每浏览器客户端的持久化 UI 状态（<dataDir>/client-state.json）：
 * 最近项目/工作目录、目标审查偏好、设置面板状态（提示词模式 + 技能/插件开关 +
 * 视觉桥偏好）、命名预设。文件 I/O 一律 best-effort：持久化故障绝不能
 * 弄崩 server 或阻塞会话。
 *
 * 从 agent-service.ts 抽出，行为保持不变。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** System-prompt mode: append the custom text to the built prompt, or replace
 *  the whole system prompt with it. (遗留字段：主会话已迁移到 compose 模板，
 *  仅 DSH 子系统与旧存档仍读写它。) */
export type PromptMode = "append" | "replace";

/** 大模型 API 出错自动重试次数的默认值（SDK 默认 3）。 */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 6;

/** 归一化重试次数：非数值回落默认，钳制到 [0, 100] 整数。 */
export function normalizeRetryMaxAttempts(v: unknown): number {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return DEFAULT_RETRY_MAX_ATTEMPTS;
	return Math.min(100, Math.max(0, n));
}

/** Settings-panel state (system prompt + disabled skills/extensions). */
export interface ClientSettings {
	promptMode: PromptMode;
	customSystemPrompt: string;
	/** 组合模板（主会话系统提示词 = 自由拼装 {{token}}，见 server/prompt-composer.ts）。
	 *  空 = 默认模板（全部自动段按自然顺序）；promptMode/customSystemPrompt 为
	 *  遗留字段（旧存档迁移到 overrides，DSH 仍共用存储）。 */
	promptTemplate: string;
	/** 每个来源 token 的独立覆盖文本（空串/缺省 = 用该来源的自动内容）。 */
	promptOverrides: Record<string, string>;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Persistent-terminal tools on/off (default off). Off → terminal_* tools are
	 *  removed from the agent's active tool set and no usage guidance is injected. */
	terminalToolsEnabled: boolean;
	/** 终端接管 bash（默认关）。开 → bash 工具的执行体改为持久终端：命令在可见
	 *  PTY 里跑、跨调用保留 shell 状态（cd/venv/ssh），静默超阈值自动转后台。 */
	terminalBash: boolean;
	/** 接管模式下 bash 的静默解阻阈值（毫秒，默认 15000；0 = 一直等到结束）。 */
	terminalBashIdleMs: number;
	/** edit_soft 工具开关（默认关）。开 → AI 可用「不严格要求缩进」的 edit_soft 工具。 */
	editSoftEnabled: boolean;
	/** 问卷提问（ask_user_question）开关（默认开）。关 → 模型不再弹问卷对话框，
	 *  调用亦会立即返回「已关闭」错误。不进预设。 */
	questionnaireEnabled: boolean;
	/** 目标模式（目标条 + 调研向导 + 审查循环）总开关（默认开）。关 → 目标条
	 *  隐藏、无法设目标/启动调研/触发审查。纯运行开关，不进预设、不需 reload。 */
	goalModeEnabled: boolean;
	/** Vision bridge on/off (default on). Off → images are sent as-is. */
	visionBridgeEnabled: boolean;
	/** Preferred vision model as "provider/id", or null = auto-detect first. */
	visionBridgeModel: string | null;
	/** Vision-bridge transcription prompt mode: append to the built-in default
	 *  prompt, or replace it entirely (same semantics as promptMode). */
	visionBridgePromptMode: PromptMode;
	/** Custom vision-bridge transcription prompt text (empty = built-in default). */
	visionBridgePrompt: string;
	/** Extra instructions appended to the built-in goal-review prompt. */
	reviewPrompt: string;
	/** Skills disabled only for the isolated goal-reviewer. */
	reviewDisabledSkills: string[];
	/** Installed UI plugins hidden in the settings panel (UI-only toggle).
	 *  Optional: presets deliberately do NOT capture it (same as the
	 *  vision-bridge prefs) — applying a preset keeps the current toggles. */
	disabledPlugins?: string[];
	/** 思考块默认折叠与否（默认关 = 折叠；开 = 始终完整展开并自动换行，流式推理
	 *  也实时可见）。纯 UI 偏好，与视觉桥 / disabledPlugins 一样不进预设。 */
	thinkingWrap: boolean;
	/** 工具调用是否默认展开（默认开 = 展开；关 = 折叠）。纯 UI 偏好，不进预设。 */
	toolsWrap: boolean;
	/** 子代理默认模型 ("provider/id")；null/未设 = 跟随主对话当前模型。不改会话右侧栏的模型。 */
	subagentDefaultModel?: string | null;
	/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。SDK
	 *  settings.retry.maxRetries 的按客户端覆盖（SDK 默认 3），经
	 *  applyOverrides 注入各会话的 SettingsManager（session.reload()
	 *  会重读磁盘，需重放）。 */
	retryMaxAttempts: number;
	/** 输入框上方的快捷短语（点击即发送）。纯 UI 偏好，不进预设、不需 reload。 */
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
}

/** A named combo of prompt + skill/extension toggles the user can re-apply.
 *  Vision-bridge prefs are intentionally NOT part of a preset — they stay
 *  whatever the user currently has set when a preset is applied. */
export interface SettingsPreset extends Omit<
	ClientSettings,
	| "visionBridgeEnabled"
	| "visionBridgeModel"
	| "visionBridgePromptMode"
	| "visionBridgePrompt"
	| "questionnaireEnabled"
	| "goalModeEnabled"
	| "thinkingWrap"
	| "toolsWrap"
	| "subagentDefaultModel"
	| "quickPhrases"
	| "quickPhrasesEnabled"
> {
	name: string;
}

/** Stable identity of an extension for the enable/disable toggle: the npm
 *  spec for packages (survives version bumps), the resolved entry path
 *  otherwise. */
export function extensionKey(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string {
	const src = e.sourceInfo;
	if (src?.origin === "package" && src.source) return src.source;
	return src?.path ?? e.path;
}

/** All identities an extension may be disabled by. The SDK applies
 *  `sourceInfo` only AFTER extensionsOverride runs (resource-loader reload():
 *  override first, applyExtensionSourceInfo second), so inside the override a
 *  package extension still has no sourceInfo and extensionKey() falls back to
 *  the raw entry path — which never matches the "npm:<pkg>" id the settings
 *  panel stores. Derive the package name from the entry path
 *  (.../node_modules/<pkg>/... or .../node_modules/@scope/<pkg>/...) so both
 *  sides agree. */
export function extensionKeyCandidates(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string[] {
	const keys = new Set<string>([extensionKey(e)]);
	const norm = e.path.replace(/\\/g, "/");
	const marker = "/node_modules/";
	const idx = norm.lastIndexOf(marker);
	if (idx !== -1) {
		const segs = norm.slice(idx + marker.length).split("/");
		// Scoped package @scope/name spans two segments.
		const name = segs[0]?.startsWith("@") && segs[1] ? `${segs[0]}/${segs[1]}` : segs[0];
		if (name) keys.add(`npm:${name}`);
	}
	return [...keys];
}

/** Whether an extension is covered by the disabled list (any identity match). */
export function isExtensionDisabled(
	e: {
		sourceInfo?: { origin?: string; source?: string; path?: string };
		path: string;
	},
	disabled: readonly string[],
): boolean {
	if (disabled.length === 0) return false;
	const keys = extensionKeyCandidates(e);
	return disabled.some((d) => keys.includes(d));
}

/** Whether an extension is covered by an ENABLED whitelist (any identity
 *  match). Empty whitelist = not whitelisting = everything allowed. Used by
 *  subagent templates（白名单语义：模板勾选 = 子代理只加载这些扩展）。 */
export function isExtensionEnabled(
	e: {
		sourceInfo?: { origin?: string; source?: string; path?: string };
		path: string;
	},
	enabled: readonly string[],
): boolean {
	if (enabled.length === 0) return true;
	const keys = extensionKeyCandidates(e);
	return enabled.some((d) => keys.includes(d));
}

export interface MarkerSettings {
	markersEnabled: boolean;
	disabledMarkers: string[];
}

export interface ClientState {
	/** Absolute path of the workspace this client last used. */
	lastCwd?: string;
	/** Workspaces this client opened before, most recent first (capped at 30). */
	projects: { path: string; lastUsed: number }[];
	/** Last-used goal / review preferences (model choice, max rounds, locked) so
	 *  they survive a reload — "全局记忆". maxRounds: 0 means unlimited. The model
	 *  choice is shared by both the goal-reviewer and the goal-wizard. */
	goalPrefs?: {
		reviewModel: string | null;
		maxRounds: number;
		locked: boolean;
	};
	/** Settings-panel state (system prompt mode/text + disabled skills/
	 *  extensions) so toggles survive a reload. */
	settings?: ClientSettings;
	/** Named settings presets (prompt + skill/extension toggles combos). */
	presets?: SettingsPreset[];
	/** Conversations that were STILL STREAMING when the server last shut down
	 *  (SIGTERM / self-update restart). Consumed once on the next attach so
	 *  the user learns a run was lost instead of wondering where it went. */
	interrupted?: { title: string; cwd: string; at: number }[];
	/** Workspaces the user explicitly removed from the recent list. Kept as
	 *  tombstones so cwds re-discovered from session files stay hidden until
	 *  the workspace is opened again. */
	removedProjects?: string[];
	/** Per-project provider key preference: cwd -> provider -> keyName.
	 *  Remember which key was last used for each provider in each project,
	 *  so switching projects restores the correct key (model is already
	 *  per-conversation, but key was global). */
	projectProviderKeys?: Record<string, Record<string, string>>;
	/** Per-project model preference: cwd -> "provider/id". Saved IMMEDIATELY when
	 *  the user selects a model (not only after a turn — the SDK only flushes a
	 *  model_change entry to disk once an assistant message exists, so a fresh
	 *  conversation's model choice would otherwise be lost on project switch).
	 *  Together with projectProviderKeys it makes the whole {model, key} pair
	 *  project-bound, so switching back restores both right away. */
	projectModels?: Record<string, string>;
	/** 内置标记工具开关（全局 + 按 marker 禁用）。 */
	markers?: MarkerSettings;
	/** Browser UI locale code as reported by hello/set_locale (e.g. "zh",
	 *  "en", "ja"). Server resolves it via resolveServerLang (non-zh →
	 *  English default, issue #91) for tool return values / AI prompts.
	 *  Missing = never reported → English. */
	locale?: string;
}

/**
 * Persists which workspace each browser client last used + which workspaces it
 * has opened, so a server restart / page reload restores the same project and
 * the UI can offer a one-click recent-project list. File I/O is best-effort:
 * persistence problems must never crash the server or block a session.
 */
export class ClientStateStore {
	private cache: Record<string, ClientState> | null = null;

	constructor(private filePath: string) {}

	/** 长期设置（设置面板 config + 预设 + 标记开关）的固定存储键。
	 *
	 * 为什么用固定全局键而非 per-clientId：clientId 存 sessionStorage（每标签页独立、
	 * 关浏览器即失），按 clientId 存设置会在每次新会话/重启后生成新 id → 设置全部重置、
	 * 且各标签页/浏览器各有一套互不同步。改为全局共享后：所有客户端（标签页/浏览器）
	 * 使用同一套配置，且持久化在服务端，重启不丢（「同一套配置」）。会话级状态
	 * （最近项目 / lastCwd / 项目模型与密钥等）仍按 clientId 各自保留。 */
	private static readonly GLOBAL_SETTINGS_KEY = "__settings__";

	/** <dataDir>（client-state.json 的上一级）——共享配置（子代理模板库等）落在这里。 */
	get dataDir(): string {
		return dirname(this.filePath);
	}

	private load(): Record<string, ClientState> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, ClientState>;
			this.cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			// Atomic write (tmp + rename): a crash mid-write must never leave a
			// half-written JSON — that would wipe ALL persisted state (recent
			// projects / presets / settings / goal prefs) on next load.
			const tmp = `${this.filePath}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.cache, null, 2) + "\n");
			renameSync(tmp, this.filePath);
		} catch {
			// best effort
		}
	}

	get(clientId: string): ClientState {
		return this.load()[clientId] ?? { projects: [] };
	}

	/** Remember which workspace a client last used; bumps its project entry. */
	remember(clientId: string, cwd: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.lastCwd = cwd;
		const now = Date.now();
		state.projects = [{ path: cwd, lastUsed: now }, ...state.projects.filter((p) => p.path !== cwd)].slice(0, 30);
		// Opening the workspace again clears its removal tombstone.
		if (state.removedProjects?.length) {
			state.removedProjects = state.removedProjects.filter((p) => p !== cwd);
		}
		this.save();
	}

	/** Drop one workspace from the recent-project list (user-requested removal).
	 *  Records a tombstone too: pushProjects() re-discovers cwds from session
	 *  files on every listing, so without it the entry would instantly reappear. */
	removeProject(clientId: string, cwd: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.projects = state.projects.filter((p) => p.path !== cwd);
		if (state.lastCwd === cwd) delete state.lastCwd;
		const removed = new Set(state.removedProjects ?? []);
		removed.add(cwd);
		state.removedProjects = [...removed];
		this.save();
	}

	/** Tombstoned projects (explicitly removed by the user) for filtering the
	 *  merged recent-project list. */
	getRemovedProjects(clientId: string): string[] {
		return this.load()[clientId]?.removedProjects ?? [];
	}

	/** Last-used goal/review prefs for a client, or undefined if never set. */
	getGoalPrefs(clientId: string): ClientState["goalPrefs"] {
		const s = this.load()[clientId];
		if (!s?.goalPrefs) return undefined;
		return {
			reviewModel: s.goalPrefs.reviewModel ?? null,
			maxRounds: s.goalPrefs.maxRounds ?? 0,
			locked: s.goalPrefs.locked ?? true,
		};
	}

	/** Persist the client's UI locale code (hello/set_locale; best-effort). */
	saveLocale(clientId: string, locale: string): void {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		if (state.locale === code) return;
		state.locale = code;
		this.save();
	}

	/** Persist the client's goal/review preferences (model choice, rounds, lock). */
	saveGoalPrefs(clientId: string, prefs: ClientState["goalPrefs"]): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.goalPrefs = {
			reviewModel: prefs?.reviewModel ?? null,
			maxRounds: prefs?.maxRounds ?? 0,
			locked: prefs?.locked ?? true,
		};
		this.save();
	}

	/** Remember conversations that were still streaming at shutdown (best-
	 *  effort; called during the graceful-shutdown path). */
	saveInterrupted(clientId: string, list: { title: string; cwd: string; at: number }[]): void {
		if (list.length === 0) return;
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.interrupted = list.slice(0, 8);
		this.save();
	}

	/** Consume the interrupted-conversation record (returns and clears it) —
	 *  called once on the client's first attach after a restart. */
	takeInterrupted(clientId: string): ClientState["interrupted"] {
		const all = this.load();
		const state = all[clientId];
		const list = state?.interrupted;
		if (list?.length && state) {
			delete state.interrupted;
			this.save();
		}
		return list;
	}

	/** 设置面板状态（系统提示词模式/文字 + 禁用技能/扩展）——全局共享同一套配置。 */
	getSettings(_clientId: string): ClientSettings {
		const s = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY];
		const stored = s?.settings;
		// 旧存档（promptMode/customSystemPrompt）迁移到 compose：追加文字成为独立
		// {{append}} 覆盖、替换文字成为 {{soul}} 覆盖；无自定义则用默认模板。
		let promptTemplate = "";
		let promptOverrides: Record<string, string> = {};
		if (stored?.promptTemplate !== undefined) {
			promptTemplate = stored.promptTemplate ?? "";
			promptOverrides = { ...stored?.promptOverrides };
		} else if (stored && typeof stored.customSystemPrompt === "string" && stored.customSystemPrompt.trim()) {
			promptOverrides = {
				[stored.promptMode === "replace" ? "soul" : "append"]: stored.customSystemPrompt,
			};
		}
		return {
			promptMode: stored?.promptMode === "replace" ? "replace" : "append",
			customSystemPrompt: stored?.customSystemPrompt ?? "",
			promptTemplate,
			promptOverrides,
			disabledSkills: stored?.disabledSkills ?? [],
			disabledExtensions: stored?.disabledExtensions ?? [],
			terminalToolsEnabled: stored?.terminalToolsEnabled ?? false,
			terminalBash: stored?.terminalBash ?? false,
			terminalBashIdleMs: stored?.terminalBashIdleMs ?? 15_000,
			editSoftEnabled: stored?.editSoftEnabled ?? false,
			questionnaireEnabled: stored?.questionnaireEnabled ?? true,
			goalModeEnabled: stored?.goalModeEnabled ?? true,
			thinkingWrap: stored?.thinkingWrap ?? false,
			toolsWrap: stored?.toolsWrap ?? true,
			visionBridgeEnabled: stored?.visionBridgeEnabled ?? true,
			visionBridgeModel: stored?.visionBridgeModel ?? null,
			visionBridgePromptMode: stored?.visionBridgePromptMode === "replace" ? "replace" : "append",
			visionBridgePrompt: stored?.visionBridgePrompt ?? "",
			subagentDefaultModel: stored?.subagentDefaultModel ?? null,
			retryMaxAttempts: normalizeRetryMaxAttempts(stored?.retryMaxAttempts),
			quickPhrases: stored?.quickPhrases ?? [],
			quickPhrasesEnabled: stored?.quickPhrasesEnabled ?? true,
			reviewPrompt: stored?.reviewPrompt ?? "",
			reviewDisabledSkills: stored?.reviewDisabledSkills ?? [],
			disabledPlugins: stored?.disabledPlugins ?? [],
		};
	}

	/** Persist the settings-panel state (partial merge) — global shared config. */
	saveSettings(_clientId: string, settings: Partial<ClientSettings>): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const cur = state.settings ?? ({} as ClientSettings);
		state.settings = {
			promptMode: settings.promptMode ?? cur.promptMode ?? "append",
			customSystemPrompt: settings.customSystemPrompt ?? cur.customSystemPrompt ?? "",
			promptTemplate: settings.promptTemplate ?? cur.promptTemplate ?? "",
			promptOverrides: { ...(settings.promptOverrides ?? cur.promptOverrides) },
			disabledSkills: settings.disabledSkills ?? cur.disabledSkills ?? [],
			disabledExtensions: settings.disabledExtensions ?? cur.disabledExtensions ?? [],
			terminalToolsEnabled: settings.terminalToolsEnabled ?? cur.terminalToolsEnabled ?? false,
			terminalBash: settings.terminalBash ?? cur.terminalBash ?? false,
			terminalBashIdleMs: settings.terminalBashIdleMs ?? cur.terminalBashIdleMs ?? 15_000,
			editSoftEnabled: settings.editSoftEnabled ?? cur.editSoftEnabled ?? false,
			questionnaireEnabled: settings.questionnaireEnabled ?? cur.questionnaireEnabled ?? true,
			goalModeEnabled: settings.goalModeEnabled ?? cur.goalModeEnabled ?? true,
			thinkingWrap: settings.thinkingWrap ?? cur.thinkingWrap ?? false,
			toolsWrap: settings.toolsWrap ?? cur.toolsWrap ?? true,
			visionBridgeEnabled: settings.visionBridgeEnabled ?? cur.visionBridgeEnabled ?? true,
			visionBridgeModel: settings.visionBridgeModel ?? cur.visionBridgeModel ?? null,
			subagentDefaultModel: settings.subagentDefaultModel ?? cur.subagentDefaultModel ?? null,
			retryMaxAttempts: normalizeRetryMaxAttempts(
				settings.retryMaxAttempts ?? cur.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
			),
			visionBridgePromptMode: settings.visionBridgePromptMode ?? cur.visionBridgePromptMode ?? "append",
			visionBridgePrompt: settings.visionBridgePrompt ?? cur.visionBridgePrompt ?? "",
			reviewPrompt: settings.reviewPrompt ?? cur.reviewPrompt ?? "",
			reviewDisabledSkills: settings.reviewDisabledSkills ?? cur.reviewDisabledSkills ?? [],
			disabledPlugins: settings.disabledPlugins ?? cur.disabledPlugins ?? [],
			quickPhrases: settings.quickPhrases ?? cur.quickPhrases ?? [],
			quickPhrasesEnabled: settings.quickPhrasesEnabled ?? cur.quickPhrasesEnabled ?? true,
		};
		this.save();
	}

	/** Named settings presets for a client (empty if never saved) — global shared. */
	getPresets(_clientId: string): SettingsPreset[] {
		return (this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.presets ?? []).map((p) => ({
			...p,
			// Older client-state files predate review settings.
			reviewPrompt: p.reviewPrompt ?? "",
			reviewDisabledSkills: p.reviewDisabledSkills ?? [],
			// Older presets predate the configurable retry count.
			retryMaxAttempts: normalizeRetryMaxAttempts(p.retryMaxAttempts),
		}));
	}

	/** Persist the named settings presets — global shared config. */
	savePresets(_clientId: string, presets: SettingsPreset[]): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		state.presets = presets;
		this.save();
	}

	/** Get per-project provider keys for a cwd, or undefined. */
	getProjectProviderKeys(clientId: string, cwd: string): Record<string, string> | undefined {
		return this.load()[clientId]?.projectProviderKeys?.[cwd];
	}

	/** Get a single provider's saved key for a project. */
	getProjectProviderKey(clientId: string, cwd: string, provider: string): string | undefined {
		return this.load()[clientId]?.projectProviderKeys?.[cwd]?.[provider];
	}

	/** Remember which key was last used for a provider in a project. */
	saveProjectProviderKey(clientId: string, cwd: string, provider: string, keyName: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		const map = (state.projectProviderKeys ??= {});
		const inner = (map[cwd] ??= {});
		inner[provider] = keyName;
		this.save();
	}

	/** Delete a per-project provider key (e.g. when the key is removed). */
	deleteProjectProviderKey(clientId: string, cwd: string, provider: string): void {
		const all = this.load();
		const inner = all[clientId]?.projectProviderKeys?.[cwd];
		if (!inner || !(provider in inner)) return;
		delete inner[provider];
		if (Object.keys(inner).length === 0) {
			delete all[clientId]!.projectProviderKeys![cwd];
		}
		this.save();
	}

	/** Get the model the user last selected in a project, or undefined. */
	getProjectModel(clientId: string, cwd: string): string | undefined {
		return this.load()[clientId]?.projectModels?.[cwd];
	}

	/** Remember the model last selected in a project (immediate, not after a turn). */
	saveProjectModel(clientId: string, cwd: string, modelId: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		(state.projectModels ??= {})[cwd] = modelId;
		this.save();
	}

	/** Drop the per-project model memory for a project (e.g. when the model is
	 *  removed from the catalog). */
	deleteProjectModel(clientId: string, cwd: string): void {
		const all = this.load();
		const map = all[clientId]?.projectModels;
		if (!map || !(cwd in map)) return;
		delete map[cwd];
		if (Object.keys(map).length === 0) delete all[clientId]!.projectModels;
		this.save();
	}

	/** 全局「快捷短语已 seed」标记（非 per-clientId）。
	 *
	 * 为什么全局：clientId 存 sessionStorage（每标签页独立、关浏览器即失），按
	 * clientId 记 seed 会在每次新会话生成新 clientId 时误判为「从未 seed」，导致
	 * 用户删掉的默认短语又被填回默认。seed 只需一次（首次见空列表），之后即为用户
	 * 数据，增删改/恢复默认/关闭都走设置面板。存服务端而非浏览器 localStorage，
	 * 任何浏览器/标签页/清缓存都不受影响。 */
	getQuickPhrasesSeeded(): boolean {
		const meta = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY] as { quickPhrasesSeeded?: boolean } | undefined;
		return !!meta?.quickPhrasesSeeded;
	}

	markQuickPhrasesSeeded(): void {
		const all = this.load();
		const meta = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] }) as {
			projects: unknown[];
			quickPhrasesSeeded?: boolean;
		};
		if (meta.quickPhrasesSeeded) return;
		meta.quickPhrasesSeeded = true;
		this.save();
	}

	/** 内置标记工具开关（全局共享同一套 + 按 marker 禁用）。 */
	getMarkerSettings(_clientId: string): MarkerSettings {
		const s = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.markers;
		return {
			markersEnabled: s?.markersEnabled ?? true,
			disabledMarkers: s?.disabledMarkers ?? [],
		};
	}

	saveMarkerSettings(_clientId: string, settings: Partial<MarkerSettings>): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const cur = state.markers ?? { markersEnabled: true, disabledMarkers: [] };
		state.markers = {
			markersEnabled: settings.markersEnabled ?? cur.markersEnabled ?? true,
			disabledMarkers: settings.disabledMarkers ?? cur.disabledMarkers ?? [],
		};
		this.save();
	}
}
