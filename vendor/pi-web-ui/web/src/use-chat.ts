// 🍞 @COUPLED server/index.ts / initial-snapshot-gate.ts: pi hello owns the baseline;
// rev/seq gaps below still request get_state (docs/architecture-core.md).
// @COUPLED server/protocol.ts (query_gateway_usage / gateway_usage / usage_history_query …),
// components/FooterBar.tsx + components/UsageDetail.tsx (网关用量展示),
// components/SettingsModal.tsx (P4 运维只读查询).
// @CONTRACT opsApi 的只读方法各自返回自增 reqId，回包按 reqId 匹配（socket 未开 = 请求丢弃）。
//   网关用量回包落在 state.gatewayUsage，由 gatewayUsageReqIdRef 认自己发出的那一次。
// @ASSUME Jev 决策门禁（jev_status / jev_config_result / jev_probe_result）回包存在 ChatState.jev 里，
//   按 reqId 与提交匹配（与用量历史同一口径）。
import { useCallback, useEffect, useReducer, useRef } from "react";
import { randomUuid } from "./uuid";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";
import type {
	ClientMessage,
	BgServer,
	CommandDef,
	ConversationSummary,
	FileContent,
	FileListing,
	FileSearchResult,
	GoalStatus,
	ModelInfo,
	ProjectSummary,
	ProviderKeyInfo,
	ProviderStatus,
	ServerMessage,
	SessionSearchResult,
	SessionSummary,
	SlashCommandInfo,
	ToolStatus,
	TerminalInfo,
	UiGatewayConfig,
	UiGatewayDuplicate,
	UiGatewayUsage,
	UiModelConfigEntry,
	UiPluginCatalogEntry,
	UiPluginInfo,
	UiProviderConfig,
	UiSettingsState,
	UiState,
} from "./types";

import { applyMessageDelta, type MessageDeltaMsg } from "./message-delta";
import { emitPluginData } from "./plugin-loader";
import { PROTOCOL_VERSION } from "./protocol-version";
import { perfMark, perfMarkSwitch } from "./perf-trace";

export type ConnStatus = "connecting" | "open" | "closed";

/** localStorage key for the UI language (mirrors i18n.tsx STORAGE_KEY). */
const UI_LANG_KEY = "pi-web-ui:lang";

/** Browser UI locale for the hello/set_locale server report (issue #91).
 *  Read straight from localStorage so the socket layer never depends on
 *  React context. Missing → "" (server treats it as English default). */
function readUiLocale(): string {
	try {
		return (localStorage.getItem(UI_LANG_KEY) ?? "").trim();
	} catch {
		return "";
	}
}

/** Event fired by i18n.tsx setLocale when the user switches UI language. */
export const UI_LOCALE_EVENT = "pi-web-ui:locale";

/** One component in an all-source update check (update_status_all). */
export interface UpdateAllItem {
	name: string;
	kind: "webui" | "pi-core" | "package";
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
	textEn?: string;
}

/** Jev 决策门禁回包：状态（`jev_status`）、配置保存回执（`jev_config_result`）、自检（`jev_probe_result`）。 */
export type JevStatusMsg = Extract<ServerMessage, { type: "jev_status" }>;
export type JevConfigResultMsg = Extract<ServerMessage, { type: "jev_config_result" }>;
export type JevProbeResultMsg = Extract<ServerMessage, { type: "jev_probe_result" }>;

/** Jev 门禁的最近一次 status / 配置保存 / 自检结果（按 reqId 与提交匹配）。 */
export interface JevUiState {
	status: JevStatusMsg | null;
	config: JevConfigResultMsg | null;
	probe: JevProbeResultMsg | null;
}

export type UsageHistoryMsg = Extract<ServerMessage, { type: "usage_history" }>;
/** 网关（NewAPI 一类）自报用量（`gateway_usage`）—— 按 reqId 与查询匹配。 */
export type GatewayUsageMsg = Extract<ServerMessage, { type: "gateway_usage" }>;
/** 网关配置读取回执（`gateway`）—— 按 reqId 匹配。 */
export type GatewayMsg = Extract<ServerMessage, { type: "gateway" }>;
/** 网关配置保存回执（`gateway_saved`）。 */
export type GatewaySavedMsg = Extract<ServerMessage, { type: "gateway_saved" }>;
export type ResourcesMsg = Extract<ServerMessage, { type: "resources" }>;
export type StorageMsg = Extract<ServerMessage, { type: "storage" }>;
export type DiagnosticsMsg = Extract<ServerMessage, { type: "diagnostics" }>;
/** 用量历史的时间窗（今天按 UTC 切分，与聚合口径一致）。 */
export type UsageHistoryWindow = "all" | "today" | "7d" | "30d";
const startOfUtcDay = (ms: number) =>
	Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());

/**
 * P4 运维 / 网关用量的只读查询 API（use-chat 返回值之一），外加只读的用量历史。
 *
 * @CONTRACT 每个方法自带自增 reqId 并把它返回给调用方；回包落在对应 state 字段里，
 *   调用方按 reqId 认自己那一次（旧 reqId 的回包不参与渲染）。不发送任何配置写入。
 */
export interface OpsApi {
	/** P4 首个切片：用量历史查询（只读聚合）。返回 reqId，结果在 state.usageHistory。 */
	queryUsageHistory: (groupBy: UsageHistoryMsg["groupBy"], window: UsageHistoryWindow) => number;
	/**
	 * 网关（NewAPI 一类）自报用量（只读）。providerId 省略 = 当前生效模型的服务商。
	 * force=true 绕过服务端 60s 缓存（用户点刷新）；省略 = 命中缓存就直接复用（自动轮询）。
	 * @CONTRACT 返回 reqId；**连接未就绪时不发请求**，直接把 busy 落回并写 error，
	 *   否则调用方会永远停在「查询中」（旧实现丢掉了 send 的返回值）。
	 */
	queryGatewayUsage: (providerId?: string, force?: boolean) => number;
	/** 单网关接入：读网关配置（baseUrl / 协议 / 是否已有密钥 / 模型清单 + 重复接入提示）。 */
	getGateway: () => number;
	/** 单网关接入：写网关配置。省略的字段不动；apiKey 留空 = 保留已存密钥，"" = 显式清除。 */
	saveGateway: (input: {
		baseUrl?: string;
		api?: string;
		apiKey?: string | null;
		models?: UiModelConfigEntry[];
	}) => number;
	/**
	 * 从网关**服务端**读取模型清单并入 models.json（密钥不出服务端，顺带绕开 CORS）。
	 * 返回 reqId；结果在 state.refreshProviderResult（added/total）。
	 */
	refreshProviderModels: (providerId: string) => number;
	/** P4 候选：请求一次系统资源快照（只读）。返回 reqId，结果在 state.resources。 */
	listResources: () => number;
	/** P4 运维：请求存储占用明细（只读、有界遍历）。返回 reqId，结果在 state.storage。 */
	listStorage: () => number;
	/** P4 运维：设置用量历史保留天数（0 = 只按大小轮转）。 */
	setUsageRetention: (maxAgeDays: number) => boolean;
	/** P4 运维：请求诊断包（只读元数据）。返回 reqId，结果在 state.diagnostics。 */
	listDiagnostics: () => number;
	/** P4 运维：开关资源告警通知。 */
	setOpsAlerts: (enabled: boolean) => boolean;
}

/** A terminal tab. The output stream itself lives in the xterm instance
 * (via the terminal bridge) — this is just the tab metadata. */
export interface TerminalMeta extends TerminalInfo {
	conversationId: string;
}

export interface ChatState {
	status: ConnStatus;
	/** True once the server confirmed the agent session is ready (hello processed). */
	ready: boolean;
	state: UiState | null;
	/** Live tool output accumulated from tool_delta messages, keyed by toolCallId. */
	liveOutputs: Map<string, { toolName: string; text: string }>;
	/**
	 * Tools that FINISHED executing (tool_status from tool_execution_end), keyed
	 * by toolCallId. Lets the card show "done · waiting for the model" even
	 * while the session is still streaming. Cleared once the toolResult message
	 * lands in the snapshot (it carries the authoritative result).
	 */
	toolStatuses: Map<string, ToolStatus>;
	notices: Notice[];
	serverVersion?: string;
	/** 引擎标识（pi | dsh）—— ready 消息携带，底栏显示徽标。 */
	engine?: string;
	/** PI_WEB_MANAGED=1 on the server: updates and plugin installs come from
	 *  whoever deploys this instance, so the interface does not offer them.
	 *  The server refuses those messages regardless (server/managed.ts). */
	/** pi-web-ui's own version, from `ready`. `serverVersion` is the pi SDK's,
	 *  and the update check — the client's other source — does not run on a
	 *  managed instance. */
	appVersion?: string;
	managed?: boolean;
	/** PI_WEB_TABS on the server: the tabs this instance offers. Undefined
	 *  means all of them, which is the default. */
	tabs?: string[];
	/** Persisted session list for the left panel. */
	sessions: SessionSummary[];
	/** Open conversations (each runs its own session in parallel). */
	conversations: ConversationSummary[];
	/** Id of the conversation the current snapshot belongs to. */
	activeConversationId: string;
	/** Title supplied for the active conversation even when it is absent from the listed rows. */
	activeConversationTitle: { id: string; title: string } | null;
	/** 乐观切换：用户已点开的会话，其首份快照还没到。true 时对话面板显示加载
	 *  占位而不是上一个会话的内容（否则用户看到的是「点了没反应，然后跳一下」）。
	 *  结束条件就是「快照里的 conversationId 变了」——switch_conversation 与
	 *  switch_session（按磁盘文件打开）都适用，无需记住目标 id。 */
	switching: boolean;
	/** Recent workspaces this client opened (left panel project picker). */
	projects: ProjectSummary[];
	/** Workspace file listing for the right panel. */
	files: FileListing | null;
	/** Latest file content fetched for the preview panel (path-matched in the modal). */
	fileContent: FileContent | null;

	/** Last dir-changed push from the server fs.watch (path = listed directory). */
	fileChanged: { path: string } | null;
	/** Models with valid auth, for the model dropdown. */
	models: ModelInfo[];
	/** True while a model list request is in flight. */
	modelsLoading: boolean;
	/** Custom providers from agentDir/models.json (model config panel). */
	modelsConfig: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providers: ProviderStatus[];
	/** Stored API keys per built-in provider (masked), for multi-key grouping. */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** 网关（NewAPI 一类）自报用量：最近一次查询的状态与结果（按 reqId 匹配）。
	 *  @CONTRACT 这是**网关自报**，与 stats.cost（本地按 token 估算）是两回事，二者不得相加。
	 *  unlimited / usedUsd=null 只影响展示措辞，不影响真实性：拿不到就说拿不到。 */
	gatewayUsage: {
		/** 查询进行中（状态栏 chip / 用量面板的刷新按钮）。 */
		busy: boolean;
		/** null = 尚未有过结果。 */
		ok: boolean | null;
		usage?: UiGatewayUsage;
		error?: string;
		/** true = 该服务商没有账单接口（直连上游），**不是**故障：界面停止自动重试、也不显示错误。
		 *  由服务端分情况给出（见 server/dev-con/gateway-usage.ts 的 @WHY），不靠文案字符串匹配。 */
		unsupported?: boolean;
	};
	/** 单网关接入：网关配置（baseUrl / 协议 / 密钥有无 / 模型清单）与重复接入提示。
	 *  @CONTRACT config 缺省 = 还没配过网关（不是错误）；duplicates 非空 = 另有配置指向同一地址，
	 *  界面提示清理但不自动删（见 server/dev-con/gateway-config.ts 的 @WHY）。 */
	gateway: {
		/** null = 尚未请求过。 */
		ok: boolean | null;
		error?: string;
		config?: UiGatewayConfig;
		duplicates: UiGatewayDuplicate[];
		/** 最近一次保存结果（null = 本次会话还没保存过）。 */
		saveOk: boolean | null;
		saveError?: string;
		/** 非空 = SDK 拒绝了 models.json（整个文件不生效、运行时里没有这个服务商）。
		 *  界面必须显著提示：配置看着正常但什么都调不通，正是 2026-09-21 那次事故的形态。 */
		runtimeError?: string;
	};
	/** P4 首个切片：最近一次用量历史查询结果（只读聚合）。 */
	usageHistory: UsageHistoryMsg | null;
	/** P4 候选：最近一次系统资源快照（只读）。 */
	resources: ResourcesMsg | null;
	/** P4 运维：最近一次存储占用明细（只读）。 */
	storage: StorageMsg | null;
	/** P4 运维：最近一次诊断包（只读元数据）。 */
	diagnostics: DiagnosticsMsg | null;
	/** Jev 门禁：最近一次 status / 配置保存 / 自检结果（按 reqId 与提交匹配）。 */
	jev: JevUiState;
	/** Result of the last install_pi_agent run (null while not started/running). */
	installResult: { ok: boolean; detail: string } | null;
	/** Path completions for the cwd input. */
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	/** Self-update status (result of check_update). */
	update: {
		current: string;
		latest: string | null;
		latestPublishedAt: string | null;
		upToDate: boolean;
		error?: string;
	} | null;
	/** All-source update check (webui + pi core + installed packages). */
	updatesAll: UpdateAllItem[] | null;
	/** Extension widgets (TUI overlays bridged to the web UI). */
	widgets: { key: string; lines: string[] }[];
	/** Extension footer statuses (setStatus bridge). */
	statuses: { key: string; text: string | undefined }[];
	/** Active extension dialog (select/confirm/input) awaiting a response. */
	dialog: {
		id: number;
		kind: "select" | "confirm" | "input";
		title: string;
		args: unknown[];
	} | null;
	/** DSH engine: pending model question(s) (ask_user_question tool). */
	question: {
		id: string;
		questions: {
			id: string;
			question: string;
			detail?: string;
			header?: string;
			options?: { label: string; description?: string }[];
			multiSelect?: boolean;
		}[];
	} | null;
	/** User command list from .pi/commands.json (terminal left panel). */
	commands: CommandDef[];
	commandsPath: string;
	/** Slash-command catalog for the chat input (builtin + extension +
	 *  template + skill). */
	slashCommands: SlashCommandInfo[];
	/** Open terminal tabs (metadata only; streams go through the bridge). */
	terminals: TerminalMeta[];
	/** Terminal the SCM/settings panel asked to focus (auto-switch on write ops). */
	terminalActiveId: string | null;
	/** Goal / review status (set via the goal bar). */
	goal: GoalStatus;
	/** Settings-panel state (system prompt, skill/extension toggles, presets). */
	settings: UiSettingsState | null;
	/** AI-started background servers (managed from the 后台任务 panel). The
	 *  list lives on the client session, so it survives conversation ends. */
	bgServers: BgServer[];
	/** Last fetch_models probe result (custom-provider model list), matched by
	 *  reqId in the model config modal. */
	fetchModelsResult: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	/** Last refresh_provider_models result (saved-provider list refresh). */
	refreshProviderResult: {
		reqId: number;
		ok: boolean;
		added?: number;
		total?: number;
		error?: string;
	} | null;
	/** Last clone_provider result (built-in → custom draft for the model
	 *  config modal to open pre-filled). */
	cloneProviderResult: {
		reqId: number;
		ok: boolean;
		config?: UiProviderConfig;
		configs?: UiProviderConfig[];
		error?: string;
	} | null;
	/** Last source-control query result (scm_status / scm_filediff /
	 *  scm_commit), matched by reqId in the SCM panel. */
	scmData: ServerMessage | null;
	/** Last global-search file query result, matched by reqId in the
	 *  global search panel (stale results with older reqIds are ignored). */
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	/** Last global-search conversation-content query result (server-side
	 *  transcript match, AI output included) — same reqId discipline. */
	sessionSearch: {
		reqId: number;
		ok: boolean;
		results: SessionSearchResult[];
	} | null;
	/** Installed optional plugins (<dataDir>/plugins). Empty = none installed. */
	plugins: UiPluginInfo[];
	/** Server-side plugin reload counter (import-cache buster, see plugins msg). */
	pluginsEpoch: number;
	/** Installable-plugin list (marketplace): shipped catalog + user-added
	 *  entries, each a one-click install candidate (see plugin_catalog msg). */
	pluginCatalog: UiPluginCatalogEntry[];
	/** Catalog epoch (increments on every add/remove — re-render trigger). */
	pluginCatalogEpoch: number;
	/** DSH engine: <dataDir>/dsh-patches user patch files (list + dir). */
	dshPatches: { patchDir: string; files: { name: string; path: string; size: number; mtimeMs: number }[] } | null;
	/** Increments when the server reports the watched git dir changed
	 *  outside the panel — SCMPanel refreshes on change while visible. */
	scmDirty: number;
	/** Server wire-protocol version differs from ours — the page was loaded
	 *  before/after an app update; show a persistent refresh banner. */
	protocolMismatch: boolean;
}

type Action =
	| { type: "status"; status: ConnStatus }
	| { type: "switching"; on: boolean }
	| { type: "snapshot"; state: UiState }
	| { type: "snapshot_delta"; msg: Extract<ServerMessage, { type: "snapshot_delta" }> }
	| { type: "message_page"; msg: Extract<ServerMessage, { type: "message_page" }> }
	| { type: "protocol_mismatch" }
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string }
	| { type: "message_delta"; msg: MessageDeltaMsg }
	| { type: "tool_status"; status: ToolStatus }
	| { type: "notice"; notice: Notice }
	| { type: "dismiss_notice"; id: number }
	| { type: "jev_status"; msg: JevStatusMsg }
	| { type: "jev_config_result"; msg: JevConfigResultMsg }
	| { type: "jev_probe_result"; msg: JevProbeResultMsg }
	| {
			type: "ready";
			serverVersion: string;
			protocolVersion?: number;
			engine?: string;
			appVersion?: string;
			managed?: boolean;
			tabs?: string[];
	  }
	| { type: "sessions"; sessions: SessionSummary[] }
	| {
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
			activeTitle?: string;
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	| { type: "files"; files: FileListing }
	| { type: "file_changed"; path: string }
	| { type: "file_content"; content: FileContent }
	| { type: "models"; models: ModelInfo[]; loading: boolean }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
	| { type: "usage_history"; history: UsageHistoryMsg }
	| { type: "resources"; resources: ResourcesMsg }
	| { type: "storage"; storage: StorageMsg }
	| { type: "diagnostics"; diagnostics: DiagnosticsMsg }
	| { type: "gateway_usage_start" }
	| { type: "gateway_usage"; msg: GatewayUsageMsg }
	| { type: "gateway"; msg: GatewayMsg }
	| { type: "gateway_saved"; result: GatewaySavedMsg }
	| {
			type: "fetch_models_result";
			result: { reqId: number; ok: boolean; models?: UiModelConfigEntry[]; error?: string };
	  }
	| {
			type: "refresh_provider_result";
			result: { reqId: number; ok: boolean; added?: number; total?: number; error?: string };
	  }
	| {
			type: "clone_provider_result";
			result: { reqId: number; ok: boolean; config?: UiProviderConfig; configs?: UiProviderConfig[]; error?: string };
	  }
	| { type: "scm_data"; data: ServerMessage }
	| {
			type: "file_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: FileSearchResult[];
				truncated?: boolean;
			};
	  }
	| {
			type: "session_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: SessionSearchResult[];
			};
	  }
	| { type: "scm_changed" }
	| { type: "install_result"; result: { ok: boolean; detail: string } }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| {
			type: "update_status";
			status: {
				current: string;
				latest: string | null;
				latestPublishedAt: string | null;
				upToDate: boolean;
				error?: string;
			};
	  }
	| { type: "update_status_all"; items: UpdateAllItem[] }
	| { type: "updates_check_started" }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			dialog: {
				id: number;
				kind: "select" | "confirm" | "input";
				title: string;
				args: unknown[];
			} | null;
	  }
	| {
			type: "question";
			question: {
				id: string;
				questions: {
					id: string;
					question: string;
					detail?: string;
					header?: string;
					options?: { label: string; description?: string }[];
					multiSelect?: boolean;
				}[];
			} | null;
	  }
	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "terminal_add"; meta: TerminalMeta }
	| { type: "terminal_remove"; id: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_restart"; terminalId: string }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	| { type: "terminal_active"; id: string }
	| { type: "goal_status"; status: GoalStatus }
	| { type: "settings"; settings: UiSettingsState }
	| { type: "bg_servers"; servers: BgServer[] }
	| { type: "plugins"; plugins: UiPluginInfo[]; epoch: number }
	| { type: "plugin_catalog"; entries: UiPluginCatalogEntry[]; epoch: number }
	| {
			type: "dsh_patches";
			patchDir: string;
			files: { name: string; path: string; size: number; mtimeMs: number }[];
	  };

const MAX_LIVE_OUTPUT = 200_000;
const MAX_TERM_BUFFER = 200_000;
/** Marker for truncated live output (was "…[前 N 字符已省略]…" / "…[N chars omitted above]…").
 *  ToolCallBlock maps it through the liveOutputOmitted i18n key so only one language shows. */
const LIVE_OMIT_MARK = "LIVE_OMIT";

/** Initial (inactive) goal status before the server pushes the first one. */
const DEFAULT_GOAL: GoalStatus = {
	conversationId: null,
	goal: null,
	reviewModel: null,
	maxRounds: 3,
	locked: true,
	reviewing: false,
	round: 0,
	status: "",
	verdict: "pending",
	wizard: {
		active: false,
		draft: "",
		model: null,
		step: 0,
		maxSteps: 6,
		status: "",
	},
};

/**
 * Bridges terminal output from the socket to live xterm instances. Output for
 * a terminal whose component isn't mounted yet (or that this tab doesn't know
 * about) is buffered (capped) so nothing is lost during mount/reconnect.
 */
interface TerminalWriter {
	write: (data: string) => void;
	dispose: () => void;
}

function makeTerminalBridge() {
	/** Multiple writers may subscribe to the same (conversation, terminal) pair —
	 *  e.g. the SCM panel's hidden query terminal parses output through its own
	 *  writer while a (hidden) xterm instance may also be registered for it.
	 *  A Set keeps them all: later registrations no longer shadow earlier ones. */
	const writers = new Map<string, Set<TerminalWriter>>();
	const buffers = new Map<string, string>();
	const key = (conversationId: string, terminalId: string) => `${conversationId}:${terminalId}`;
	return {
		write(conversationId: string, terminalId: string, data: string): void {
			const writerKey = key(conversationId, terminalId);
			const set = writers.get(writerKey);
			if (set && set.size > 0) {
				for (const w of set) {
					try {
						w.write(data);
					} catch {
						// best effort
					}
				}
				return;
			}
			const prev = buffers.get(writerKey) ?? "";
			const next = prev.length + data.length > MAX_TERM_BUFFER ? data : prev + data;
			buffers.set(writerKey, next);
		},
		/** Register a writer (xterm instance / output parser); flushes buffered
		 *  output to the new subscriber. Returns an unregister fn. */
		register(conversationId: string, terminalId: string, writer: TerminalWriter): () => void {
			const writerKey = key(conversationId, terminalId);
			let set = writers.get(writerKey);
			if (!set) {
				set = new Set();
				writers.set(writerKey, set);
			}
			set.add(writer);
			const buffered = buffers.get(writerKey);
			if (buffered) {
				try {
					writer.write(buffered);
				} catch {
					// best effort
				}
				buffers.delete(writerKey);
			}
			return () => {
				const s = writers.get(writerKey);
				if (s) {
					s.delete(writer);
					if (s.size === 0) writers.delete(writerKey);
				}
				buffers.delete(writerKey);
			};
		},
		clear(): void {
			writers.clear();
			buffers.clear();
		},
	};
}

function pruneLiveOutputs(
	live: Map<string, { toolName: string; text: string }>,
	state: UiState,
): Map<string, { toolName: string; text: string }> {
	const completed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) completed.add(m.toolCallId);
		// bashExecution transcript messages supersede live bash deltas
		if (m.role === "bashExecution") completed.add(`bash-${m.id}`);
	}
	let changed = false;
	for (const id of live.keys()) {
		if (completed.has(id)) {
			live.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(live) : live;
}

/** Drop tool_status entries once the authoritative toolResult message lands.
 *  Builds the landed-id Set once (O(messages)) instead of scanning all
 *  messages per status entry (was O(statuses × messages) every snapshot). */
function pruneToolStatuses(statuses: Map<string, ToolStatus>, state: UiState): Map<string, ToolStatus> {
	if (statuses.size === 0) return statuses;
	const landed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) landed.add(m.toolCallId);
	}
	let changed = false;
	for (const id of statuses.keys()) {
		if (landed.has(id)) {
			statuses.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(statuses) : statuses;
}

function reducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "switching":
			return { ...state, switching: action.on };
		case "status":
			return {
				...state,
				status: action.status,
				// A new socket is not ready until its hello/ready round-trip completes.
				ready: action.status === "open" ? state.ready : false,
				// PTYs are conversation-owned and survive socket reconnects. Clear only
				// the browser views so xterm writers remount when the server replays them.
				terminals: action.status === "closed" ? [] : state.terminals,
			};
		case "ready":
			return {
				...state,
				serverVersion: action.serverVersion,
				engine: action.engine,
				appVersion: action.appVersion,
				managed: action.managed === true,
				tabs: action.tabs,
				ready: true,
				// Old page + new server (or the reverse) after an in-place update:
				// WS handling on either side may be stale — banner asks for refresh.
				protocolMismatch: action.protocolVersion !== undefined && action.protocolVersion !== PROTOCOL_VERSION,
			};
		case "snapshot":
			return {
				...state,
				ready: true,
				state: action.state,
				activeConversationId: action.state.conversationId,
				activeConversationTitle:
					state.activeConversationTitle?.id === action.state.conversationId ? state.activeConversationTitle : null,
				// 乐观切换的收尾：只有「活动会话真的换了」才算切换完成——这样切换期间
				// 旧会话的定时快照/后台统计更新不会提前把占位揭掉。
				switching: action.state.conversationId === state.state?.conversationId && state.switching,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, action.state),
				toolStatuses: pruneToolStatuses(state.toolStatuses, action.state),
			};
		case "snapshot_delta": {
			// Incremental checkpoint from the server. Apply ONLY when it chains
			// cleanly onto our current rev; a mismatch (dropped message under
			// backpressure, stale tab) is ignored here — the ws handler schedules
			// a get_state resync. Immutable merge: appended messages extend the
			// array (element references preserved → React memo keeps working);
			// light fields replace wholesale.
			const ui = state.state;
			const d = action.msg;
			if (!ui || ui.conversationId !== d.conversationId || ui.rev !== d.baseRev) return state;
			const merged: UiState = {
				...ui,
				...d.state,
				messages: d.appended.length > 0 ? [...ui.messages, ...d.appended] : ui.messages,
			};
			return {
				...state,
				ready: true,
				state: merged,
				activeConversationId: merged.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, merged),
				toolStatuses: pruneToolStatuses(state.toolStatuses, merged),
			};
		}
		case "message_page": {
			// 尾部优先历史的「更早一页」：前置到现有数组之前（按 id 去重——重连或
			// 补全后服务端可能重复给出已持有的消息）。omittedBefore 成为新的计数。
			const ui = state.state;
			const d = action.msg;
			if (!ui || ui.conversationId !== d.conversationId) return state;
			const known = new Set(ui.messages.map((m) => m.id));
			const older = d.messages.filter((m) => !known.has(m.id));
			return {
				...state,
				state: {
					...ui,
					messages: older.length > 0 ? [...older, ...ui.messages] : ui.messages,
					messagesOmitted: d.omittedBefore,
				},
			};
		}
		case "tool_delta": {
			const prev = state.liveOutputs.get(action.toolCallId);
			// Keep the TAIL when over the cap (not the head): for a long-running
			// tool what matters is the LATEST output — keeping the head would show
			// only the earliest 200K chars and freeze visually while the tool is
			// still streaming. The terminal-bridge buffer below already keeps the
			// newest data; this unifies the semantics.
			const text = (prev?.text ?? "") + action.delta;
			const capped =
				text.length > MAX_LIVE_OUTPUT
					? `…[${LIVE_OMIT_MARK}:${text.length - MAX_LIVE_OUTPUT}]…\n` + text.slice(text.length - MAX_LIVE_OUTPUT)
					: text;
			const liveOutputs = new Map(state.liveOutputs);
			liveOutputs.set(action.toolCallId, {
				toolName: action.toolName,
				text: capped,
			});
			return { ...state, liveOutputs };
		}
		case "message_delta": {
			const ui = state.state;
			// Server only streams the active conversation, but filter defensively:
			// a late delta for another conversation must not clobber this view.
			if (!ui || ui.conversationId !== action.msg.conversationId) return state;
			// applyMessageDelta is pure/immutable (StrictMode double-invokes reducers).
			return { ...state, state: applyMessageDelta(ui, action.msg) };
		}
		case "tool_status":
			return {
				...state,
				toolStatuses: new Map(state.toolStatuses).set(action.status.toolCallId, action.status),
			};
		case "notice":
			// 切换失败只发 notice（会话不存在/切换抛错），不会再有快照到来：
			// 立刻揭掉占位，不必等 8s 安全网。
			if (state.switching && action.notice.level === "error")
				return { ...state, switching: false, notices: [...state.notices, action.notice] };
			return { ...state, notices: [...state.notices, action.notice].slice(-6) };
		case "dismiss_notice":
			return {
				...state,
				notices: state.notices.filter((n) => n.id !== action.id),
			};
		case "sessions":
			return { ...state, sessions: action.sessions };
		case "conversations":
			return {
				...state,
				conversations: action.conversations,
				activeConversationId: action.activeId,
				activeConversationTitle: action.activeTitle
					? { id: action.activeId, title: action.activeTitle }
					: null,
			};
		case "projects":
			return { ...state, projects: action.projects };
		case "files":
			return { ...state, files: action.files };
		case "file_changed":
			return { ...state, fileChanged: { path: action.path } };
		case "file_content":
			return { ...state, fileContent: action.content };
		case "models":
			return { ...state, models: action.models, modelsLoading: action.loading };
		case "models_config":
			return { ...state, modelsConfig: action.providers };
		case "providers_status":
			return { ...state, providers: action.providers };
		case "provider_keys":
			return { ...state, providerKeys: action.keys };
		case "usage_history":
			return { ...state, usageHistory: action.history };
		case "resources":
			return { ...state, resources: action.resources };
		case "storage":
			return { ...state, storage: action.storage };
		case "diagnostics":
			return { ...state, diagnostics: action.diagnostics };
		case "gateway_usage_start":
			// 刷新期间保留上一次结果：不要把已有数字先清成空再填（会闪一下）。
			return { ...state, gatewayUsage: { ...state.gatewayUsage, busy: true, ok: null, error: undefined } };
		case "gateway_usage":
			return {
				...state,
				gatewayUsage: {
					busy: false,
					ok: action.msg.ok,
					usage: action.msg.usage,
					error: action.msg.error,
					/** true = 该服务商没有账单接口（永久事实，不是故障）：界面据此停止自动重试。 */
					unsupported: action.msg.unsupported === true,
				},
			};
		case "gateway":
			return {
				...state,
				gateway: {
					...state.gateway,
					ok: action.msg.ok,
					error: action.msg.error,
					config: action.msg.config,
					duplicates: action.msg.duplicates ?? [],
					runtimeError: action.msg.runtimeError,
				},
			};
		case "gateway_saved":
			// 保存回执只记结果，**不**乐观改写 config：服务端会做归一化/能力回填
			// （见 writeModelConfig），界面自己猜会与服务端的实际落盘不一致；
			// 保存成功后由调用方重新 get_gateway。
			return { ...state, gateway: { ...state.gateway, saveOk: action.result.ok, saveError: action.result.error } };
		case "jev_status":
			return { ...state, jev: { ...state.jev, status: action.msg } };
		case "jev_config_result":
			return { ...state, jev: { ...state.jev, config: action.msg } };
		case "jev_probe_result":
			return { ...state, jev: { ...state.jev, probe: action.msg } };
		case "fetch_models_result":
			return { ...state, fetchModelsResult: action.result };
		case "refresh_provider_result":
			return { ...state, refreshProviderResult: action.result };
		case "clone_provider_result":
			return { ...state, cloneProviderResult: action.result };
		case "install_result":
			return { ...state, installResult: action.result };
		case "scm_data":
			return { ...state, scmData: action.data };
		case "file_search_result":
			return { ...state, fileSearch: action.result };
		case "session_search_result":
			return { ...state, sessionSearch: action.result };
		case "scm_changed":
			return { ...state, scmDirty: state.scmDirty + 1 };
		case "path_completions":
			return { ...state, pathCompletions: action.completions };
		case "update_status":
			return { ...state, update: action.status };
		case "update_status_all":
			return { ...state, updatesAll: action.items };
		case "updates_check_started":
			// Forced re-check: clear stale rows so the "checking" state renders.
			return { ...state, updatesAll: null };
		case "widgets":
			return { ...state, widgets: action.widgets };
		case "statuses":
			return { ...state, statuses: action.statuses };
		case "dialog":
			return { ...state, dialog: action.dialog };
		case "question":
			return { ...state, question: action.question };
		case "commands":
			return {
				...state,
				commands: action.commands,
				commandsPath: action.path,
			};
		case "slash_commands":
			return { ...state, slashCommands: action.commands };
		case "goal_status":
			return { ...state, goal: action.status };
		case "settings":
			return { ...state, settings: action.settings };
		case "bg_servers":
			return { ...state, bgServers: action.servers };
		case "plugins":
			return { ...state, plugins: action.plugins, pluginsEpoch: action.epoch };
		case "plugin_catalog":
			return { ...state, pluginCatalog: action.entries, pluginCatalogEpoch: action.epoch };
		case "dsh_patches":
			return { ...state, dshPatches: { patchDir: action.patchDir, files: action.files } };
		case "terminal_add":
			return { ...state, terminals: [...state.terminals, action.meta] };
		case "terminal_remove":
			return {
				...state,
				terminals: state.terminals.filter((t) => t.id !== action.id),
			};
		case "terminal_exit":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			)
				return state;
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId ? { ...t, running: false, exitCode: action.exitCode } : t,
				),
			};
		case "terminal_restart":
			// The command is re-running in the same tab (server restarted the PTY).
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId ? { ...t, running: true, exitCode: null } : t,
				),
			};
		case "terminal_list":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			) {
				return state;
			}
			return {
				...state,
				terminals: action.terminals.map((terminal) => ({
					...terminal,
					conversationId: action.conversationId ?? state.state?.conversationId ?? "",
				})),
			};
		case "terminal_active":
			return { ...state, terminalActiveId: action.id };
		default:
			return state;
	}
}

const CLIENT_ID_KEY = "pi-web-client-id";
let cachedClientId: string | null = null;

/**
 * 客户端标识 —— **每标签页独立**（sessionStorage 而非 localStorage）。
 *
 * 曾用 localStorage：同源所有标签页共享同一 clientId，后端把它们挂到同一个
 * ClientSession 上互为镜像——B 标签页切换对话会同步切走 A 页、甚至把 A 页
 * 正在输出的 agent 强制中断且状态持久化（issue #10）。改为 sessionStorage 后
 * 新开标签页即新客户端；刷新本页仍保留同一 id，client-state（最近项目等）不丢。
 */
export function getClientId(): string {
	if (cachedClientId) return cachedClientId;
	let id: string | null = null;
	try {
		id = sessionStorage.getItem(CLIENT_ID_KEY);
		if (!id) {
			id = randomUuid();
			sessionStorage.setItem(CLIENT_ID_KEY, id);
		}
	} catch {
		// storage 不可用（隐私模式等）：退化为页面生命周期内的一次性 id
		id = id ?? randomUuid();
	}
	cachedClientId = id;
	return id;
}

/**
 * 上次成功工作目录（localStorage，跨浏览器重启记忆）——解决「每次打开浏览器都
 * 回默认目录」：clientId 在 sessionStorage（每标签页独立，issue #10），浏览器
 * 整个关闭后 sessionStorage 清空 → 新 clientId 在服务端 client-state 里查不到
 *  lastCwd → 落回默认目录。这里用 localStorage 单独记住最近一次成功的工作目录
 * （只存一个路径字符串，不涉及客户端身份），首帧快照时若服务端落在其他目录则
 * 补发 set_cwd 切回。
 */
const LAST_CWD_KEY = "pi-web-last-cwd";

/** Read the last-used working directory remembered across browser restarts. */
export function readLastCwd(): string | null {
	try {
		return localStorage.getItem(LAST_CWD_KEY);
	} catch {
		return null;
	}
}

function writeLastCwd(cwd: string): void {
	try {
		localStorage.setItem(LAST_CWD_KEY, cwd);
	} catch {
		/* storage 不可用（隐私模式等）：忽略，仅本次会话生效 */
	}
}

/** Resolve the WebSocket URL: same host when served by the backend, or the Vite proxy in dev. */
function wsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	// appUrl 补应用根前缀：子路径反代（/pi/）下 WS 也必须走 /pi/ws。
	return withToken(`${proto}//${location.host}${appUrl("/ws")}`);
}

export function useChat() {
	const [chat, dispatch] = useReducer(reducer, {
		status: "connecting",
		ready: false,
		state: null,
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		notices: [],
		sessions: [],
		conversations: [],
		activeConversationId: "",
		activeConversationTitle: null,
		switching: false,
		projects: [],
		files: null,

		fileChanged: null,
		fileContent: null,
		models: [],
		modelsLoading: false,
		modelsConfig: [],
		providers: [],
		providerKeys: {},
		gatewayUsage: { busy: false, ok: null },
		gateway: { ok: null, saveOk: null, duplicates: [] },
		usageHistory: null,
		resources: null,
		storage: null,
		diagnostics: null,
		installResult: null,
		pathCompletions: [],
		update: null,
		updatesAll: null,
		widgets: [],
		statuses: [],
		dialog: null,
		question: null,
		commands: [],
		commandsPath: "",
		slashCommands: [],
		terminals: [],
		terminalActiveId: null,
		goal: DEFAULT_GOAL,
		bgServers: [],
		settings: null,
		fetchModelsResult: null,
		jev: { status: null, config: null, probe: null },
		refreshProviderResult: null,
		cloneProviderResult: null,
		scmData: null,
		fileSearch: null,
		sessionSearch: null,
		scmDirty: 0,
		plugins: [],
		pluginsEpoch: 0,
		pluginCatalog: [],
		pluginCatalogEpoch: 0,
		dshPatches: null,
		protocolMismatch: false,
	});
	const wsRef = useRef<WebSocket | null>(null);
	/** Terminal output bridge (writers keyed by terminalId). */
	const bridgeRef = useRef(makeTerminalBridge());
	/** Reconnect backoff counter — ref so it never causes re-renders. */
	const retryRef = useRef(0);
	/** Pending reconnect timer. */
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** False once the hook is unmounted/cleaned up — stops stale onclose handlers from reconnecting. */
	const aliveRef = useRef(true);
	/** Last time any server message arrived — used to detect half-open connections. */
	const lastBeatRef = useRef(0);
	const noticeId = useRef(0);
	/** Last delta seq seen per conversation (message_delta + tool_delta share
	 *  one per-conversation sequence) — a gap on the ACTIVE conversation
	 *  triggers a one-shot get_state resync; background conversations converge
	 *  via snapshot when switched to. */
	const lastDeltaSeqRef = useRef<Map<string, number>>(new Map());
	const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** 跨重启工作目录记忆：restoreRef 只允许首帧快照发起一次恢复；lastCwdRef
	 *  避免对同一目录重复写 localStorage。 */
	const restoreRef = useRef(false);
	const lastCwdRef = useRef<string | null>(null);

	/** Debounced authoritative resync: get_state always returns a FULL snapshot.
	 *  Shared by delta-seq gap detection and snapshot_delta rev mismatch. */
	const scheduleResync = (): void => {
		if (resyncTimerRef.current) return;
		resyncTimerRef.current = setTimeout(() => {
			resyncTimerRef.current = null;
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN)
				ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
		}, 300);
	};

	const noteDeltaSeq = (conversationId: string, seq: number): void => {
		const map = lastDeltaSeqRef.current;
		const last = map.get(conversationId);
		if (last !== undefined && seq !== last + 1) {
			const c = chatApi.current.chat;
			const active = c.activeConversationId || c.state?.conversationId;
			if (conversationId === active) {
				// Missed deltas (should not happen on a healthy WS) — resync via a
				// debounced get_state; keep patching meanwhile (the next snapshot
				// reconciles any drift).
				scheduleResync();
			}
		}
		map.set(conversationId, seq);
	};

	const pushNotice = useCallback((level: Notice["level"], text: string) => {
		const id = ++noticeId.current;
		dispatch({ type: "notice", notice: { id, level, text } });
		// 自动消失计时由通知组件（NoticeToast）管理：悬浮暂停、移开继续。
	}, []);

	const send = useCallback((msg: ClientMessage) => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			// 会话切换的「点击时刻」——paint 打点会把它配对成端到端延迟。
			// 同时进入乐观切换态：目标快照未到前，对话面板显示加载占位而不是
			// 上一个会话（否则用户看到的是「点了没反应，然后整页跳一下」）。
			// 切到当前已打开/已显示的会话是 no-op，不进占位态。
			if (msg.type === "switch_conversation") {
				perfMarkSwitch(msg.type);
				if (msg.id !== chatApi.current.chat.activeConversationId) dispatch({ type: "switching", on: true });
			} else if (msg.type === "switch_session") {
				perfMarkSwitch(msg.type);
				if (msg.path !== chatApi.current.chat.state?.sessionFile) dispatch({ type: "switching", on: true });
			}
			// Forced re-check: drop stale rows immediately so the "checking"
			// state renders instead of the cached list.
			if (msg.type === "check_updates_all" && msg.force === true) {
				dispatch({ type: "updates_check_started" });
			}
			ws.send(JSON.stringify(msg));
			// 提交/取消模型提问后立即收起对话框：服务端只 resolve 模型侧 Promise，
			// 不会发任何回执清除前端面板（否则会出现“回答后不消失、取消无效”）。
			// 模型再次 ask_user_question 时会重新 question_pending，面板自动回来。
			if (msg.type === "question_answer") {
				dispatch({ type: "question", question: null });
			}
			return true;
		}
		return false;
	}, []);

	/** 乐观切换的安全网：服务端总会对切换请求回一份快照，但会话不存在/切换失败的
	 *  分支只会发 notice。超时后揭掉占位，避免占位永远留在屏幕上。
	 *  @MAGIC 8s —— 比实测最慢的切历史会话（含扩展重建，数秒级）再宽一些。 */
	useEffect(() => {
		if (!chat.switching) return;
		const timer = setTimeout(() => dispatch({ type: "switching", on: false }), 8000);
		return () => clearTimeout(timer);
	}, [chat.switching]);

	/** Stable across renders — the reconnect loop lives entirely inside this closure. */
	const connect = useCallback(() => {
		if (!aliveRef.current) return;
		dispatch({ type: "status", status: "connecting" });
		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;

		ws.onopen = () => {
			if (wsRef.current !== ws) return; // stale socket
			perfMark("ws:open");
			dispatch({ type: "status", status: "open" });
			retryRef.current = 0;
			lastBeatRef.current = Date.now();
			ws.send(
				JSON.stringify({
					type: "hello",
					clientId: getClientId(),
					// UI language report (issue #91): server persists it per
					// client and uses it for tool return values / AI prompts.
					locale: readUiLocale(),
				} satisfies ClientMessage),
			);
		};

		ws.onmessage = (ev) => {
			if (wsRef.current !== ws) return; // stale socket
			lastBeatRef.current = Date.now(); // any traffic proves the connection is alive
			let msg: ServerMessage;
			try {
				msg = JSON.parse(ev.data as string) as ServerMessage;
			} catch {
				return;
			}
			switch (msg.type) {
				case "ready":
					perfMark("ws:ready");
					dispatch({
						type: "ready",
						serverVersion: msg.serverVersion,
						protocolVersion: msg.protocolVersion,
						engine: msg.engine,
						appVersion: msg.appVersion,
						managed: msg.managed,
						tabs: msg.tabs,
					});
					// pi sends its initial full state after the plugin renderer catalog.
					// Keep DSH's existing request path; rev/seq-gap resyncs are separate.
					if (msg.engine === "dsh") ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
					// Sessions + recent projects are LAZY: LeftPanel requests them
					// when it is actually shown — listing scans every session file
					// on disk (listAll scans ALL projects), too heavy for the
					// connect critical path.
					ws.send(JSON.stringify({ type: "list_files" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_models" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_commands" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "get_commands" } satisfies ClientMessage));
					// A managed instance refuses both (server/managed.ts): asking
					// anyway would greet every visitor with two red toasts about a
					// thing the interface does not even offer.
					if (!msg.managed) {
						ws.send(JSON.stringify({ type: "check_update" } satisfies ClientMessage));
						ws.send(JSON.stringify({ type: "check_updates_all" } satisfies ClientMessage));
					}
					break;
				case "snapshot":
					// Snapshot is authoritative — delta sequence tracking restarts.
					perfMark("ws:snapshot", `${msg.state.messages.length} msgs rev=${msg.state.rev}`);
					lastDeltaSeqRef.current = new Map();
					dispatch({ type: "snapshot", state: msg.state });
					break;
				case "message_page":
					dispatch({ type: "message_page", msg });
					break;
				case "snapshot_delta": {
					// Gap detection BEFORE dispatch: if this incremental checkpoint
					// doesn't chain onto our current rev (a message was dropped under
					// backpressure, or we're stale), schedule one debounced full resync.
					const cur = chatApi.current.chat.state;
					if (!cur || cur.conversationId !== msg.conversationId || cur.rev !== msg.baseRev) scheduleResync();
					dispatch({ type: "snapshot_delta", msg });
					break;
				}
				case "tool_delta":
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({
						type: "tool_delta",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						delta: msg.delta,
					});
					break;
				case "tool_status":
					dispatch({ type: "tool_status", status: msg });
					break;
				case "message_delta": {
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({ type: "message_delta", msg });
					break;
				}
				case "notice": {
					const id = ++noticeId.current;
					dispatch({
						type: "notice",
						notice: { id, level: msg.level, text: msg.text, textEn: msg.textEn },
					});
					break;
				}
				case "sessions":
					dispatch({ type: "sessions", sessions: msg.sessions });
					break;
				case "conversations":
					dispatch({
						type: "conversations",
						conversations: msg.conversations,
						activeId: msg.activeId,
						activeTitle: msg.activeTitle,
					});
					break;
				case "projects":
					dispatch({ type: "projects", projects: msg.projects });
					break;
				case "files":
					dispatch({ type: "files", files: msg });
					break;
				case "file_changed":
					dispatch({ type: "file_changed", path: msg.path });
					break;
				case "file_content":
					dispatch({ type: "file_content", content: msg });
					break;
				case "models":
					dispatch({ type: "models", models: msg.models, loading: false });
					break;
				case "models_config":
					dispatch({ type: "models_config", providers: msg.providers });
					break;
				case "providers_status":
					dispatch({ type: "providers_status", providers: msg.providers });
					break;
				case "provider_keys":
					dispatch({ type: "provider_keys", keys: msg.keys });
					break;
				case "gateway_usage":
					// 只认自己发出的那一次（reqId 自增）：过期的/未知的回包直接丢弃。
					if (msg.reqId !== gatewayUsageReqIdRef.current) break;
					dispatch({ type: "gateway_usage", msg });
					break;
				case "gateway":
					if (msg.reqId !== gatewayReqIdRef.current) break;
					dispatch({ type: "gateway", msg });
					break;
				case "gateway_saved":
					if (msg.reqId !== gatewayReqIdRef.current) break;
					dispatch({ type: "gateway_saved", result: msg });
					break;
				case "usage_history":
					dispatch({ type: "usage_history", history: msg });
					break;
				case "resources":
					dispatch({ type: "resources", resources: msg });
					break;
				case "storage":
					dispatch({ type: "storage", storage: msg });
					break;
				case "diagnostics":
					dispatch({ type: "diagnostics", diagnostics: msg });
					break;
				case "jev_status":
					dispatch({ type: "jev_status", msg });
					break;
				case "jev_config_result":
					dispatch({ type: "jev_config_result", msg });
					break;
				case "jev_probe_result":
					dispatch({ type: "jev_probe_result", msg });
					break;
				case "fetch_models_result":
					dispatch({
						type: "fetch_models_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							models: msg.models,
							error: msg.error,
						},
					});
					break;
				case "refresh_provider_result":
					dispatch({
						type: "refresh_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							added: msg.added,
							total: msg.total,
							error: msg.error,
						},
					});
					break;
				case "clone_provider_result":
					dispatch({
						type: "clone_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							config: msg.config,
							configs: (msg as { configs?: UiProviderConfig[] }).configs,
							error: msg.error,
						},
					});
					break;
				case "scm_data":
					dispatch({ type: "scm_data", data: msg });
					break;
				case "search_files_result":
					dispatch({
						type: "file_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
							truncated: msg.truncated,
						},
					});
					break;
				case "session_search_results":
					dispatch({
						type: "session_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
						},
					});
					break;
				case "scm_changed":
					dispatch({ type: "scm_changed" });
					break;
				case "install_result":
					dispatch({ type: "install_result", result: msg });
					break;
				case "path_completions":
					dispatch({ type: "path_completions", completions: msg.completions });
					break;
				case "update_status":
					dispatch({ type: "update_status", status: msg });
					break;
				case "update_status_all":
					dispatch({ type: "update_status_all", items: msg.items });
					break;
				case "widgets":
					dispatch({ type: "widgets", widgets: msg.widgets });
					break;
				case "statuses":
					dispatch({ type: "statuses", statuses: msg.statuses });
					break;
				case "dialog":
					dispatch({
						type: "dialog",
						dialog: {
							id: msg.id,
							kind: msg.kind,
							title: msg.title,
							args: msg.args,
						},
					});
					break;
				case "dialog_closed":
					dispatch({ type: "dialog", dialog: null });
					break;
				case "question_pending":
					dispatch({
						type: "question",
						question: { id: msg.id, questions: msg.questions },
					});
					break;
				case "terminal_output":
					bridgeRef.current.write(
						msg.conversationId ?? chatApi.current.chat.activeConversationId,
						msg.terminalId,
						msg.data,
					);
					break;
				case "terminal_exit":
					dispatch({
						type: "terminal_exit",
						conversationId: msg.conversationId,
						terminalId: msg.terminalId,
						exitCode: msg.exitCode,
					});
					break;
				case "terminal_list":
					dispatch({
						type: "terminal_list",
						conversationId: msg.conversationId,
						terminals: msg.terminals,
					});
					break;
				case "commands":
					dispatch({
						type: "commands",
						commands: msg.commands,
						path: msg.path,
					});
					break;
				case "slash_commands":
					dispatch({ type: "slash_commands", commands: msg.commands });
					break;
				case "goal_status":
					dispatch({ type: "goal_status", status: msg.status });
					break;
				case "settings_state":
					dispatch({ type: "settings", settings: msg.settings });
					break;
				case "bg_servers":
					dispatch({ type: "bg_servers", servers: msg.servers });
					break;
				case "plugins":
					dispatch({ type: "plugins", plugins: msg.plugins, epoch: msg.epoch });
					break;
				case "plugin_catalog":
					dispatch({ type: "plugin_catalog", entries: msg.entries, epoch: msg.epoch });
					break;
				case "dsh_patches":
					dispatch({ type: "dsh_patches", patchDir: msg.patchDir, files: msg.files });
					break;
				case "plugin_data":
					emitPluginData(msg.pluginId, msg.payload);
					break;
				default:
					break;
			}
		};

		ws.onclose = () => {
			if (wsRef.current === ws) wsRef.current = null;
			// Terminals died with the server-side PTYs — drop writers/buffers.
			bridgeRef.current.clear();
			// Cleanup closed this socket on purpose — do not reconnect.
			if (!aliveRef.current) return;
			// A newer socket already took over (e.g. a StrictMode remount raced
			// this socket's close) — do not spawn a third connection that would
			// shadow the live one and drop its incoming messages.
			if (wsRef.current && wsRef.current !== ws) return;
			dispatch({ type: "status", status: "closed" });
			// Reconnect with exponential backoff (1s → 2s → 4s → … capped at 10s).
			const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
			retryRef.current += 1;
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				connect();
			}, delay);
		};

		ws.onerror = () => {
			// onclose fires after onerror, triggering reconnect.
			// Do NOT call ws.close() here: it's redundant and causes a browser
			// warning "WebSocket is closed before the connection is established"
			// when the connection is still in CONNECTING state.
		};
	}, []);

	// UI language changes (i18n.tsx setLocale) → report to the server so tool
	// return values / AI prompts follow the UI locale (issue #91). Socket may
	// be mid-reconnect — hello already carries the fresh code on re-open.
	useEffect(() => {
		const onLocale = (ev: Event) => {
			const locale = (ev as CustomEvent<string>).detail ?? readUiLocale();
			if (locale) send({ type: "set_locale", locale });
		};
		window.addEventListener(UI_LOCALE_EVENT, onLocale);
		return () => window.removeEventListener(UI_LOCALE_EVENT, onLocale);
	}, [send]);

	// Mount once; all reconnection is self-contained in `connect`.
	useEffect(() => {
		aliveRef.current = true;
		connect();
		// Watchdog: if no server message arrives for 30s, assume the connection is
		// half-open and force a close, which triggers the normal reconnect path.
		const watchdog = setInterval(() => {
			if (!aliveRef.current) return;
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastBeatRef.current > 30_000) {
				ws.close();
			}
		}, 5_000);
		return () => {
			aliveRef.current = false;
			clearInterval(watchdog);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [connect]);

	// -- 跨浏览器重启：恢复上次工作目录（localStorage 记忆） ---------------------
	// 服务端按 clientId 记 lastCwd，而 clientId 在 sessionStorage（关浏览器即失），
	// 重启后新 clientId 查不到记录 → 落回默认目录。这里在首帧快照上：若服务端
	// 当前目录 ≠ 记忆目录，补发 set_cwd 切回；此后每次 cwd 变化都写回记忆。
	useEffect(() => {
		const cwd = chat.state?.cwd;
		if (!cwd) return;
		if (!restoreRef.current) {
			restoreRef.current = true;
			const remembered = readLastCwd();
			if (remembered && remembered !== cwd) {
				// 记忆目录存在则服务端切换后会推新快照；不存在则服务端报错通知，
				// 保持默认目录——两种结果都不回写记忆，等用户下次操作再更新。
				send({ type: "set_cwd", path: remembered });
				return;
			}
		}
		if (lastCwdRef.current !== cwd) {
			lastCwdRef.current = cwd;
			writeLastCwd(cwd);
		}
	}, [chat.state?.cwd, send]);

	const dismissNotice = useCallback((id: number) => dispatch({ type: "dismiss_notice", id }), []);

	// -- terminal tab management ----------------------------------------------

	const terminalCreate = useCallback((meta: TerminalMeta) => dispatch({ type: "terminal_add", meta }), []);
	const terminalClose = useCallback((id: string) => dispatch({ type: "terminal_remove", id }), []);
	const terminalRestart = useCallback((id: string) => dispatch({ type: "terminal_restart", terminalId: id }), []);

	const terminalSelect = useCallback((id: string) => dispatch({ type: "terminal_active", id }), []);
	const terminalRegister = useCallback(
		(conversationId: string, id: string, writer: TerminalWriter) =>
			bridgeRef.current.register(conversationId, id, writer),
		[],
	);

	// -- P4 运维 / 网关用量（只读查询） ------------------------------------------
	// 每个方法发一帧只读请求并返回自增 reqId；回包按 reqId 匹配（网关用量还要认
	// 「是不是我发出那一次」，见 ws.onmessage 里的 gateway_usage 分支）。
	const opsSendRef = useRef(send);
	opsSendRef.current = send;
	const opsApiRef = useRef<OpsApi | null>(null);
	const usageReqIdRef = useRef(0);
	const resourcesReqIdRef = useRef(0);
	const storageReqIdRef = useRef(0);
	const diagnosticsReqIdRef = useRef(0);
	const gatewayUsageReqIdRef = useRef(0);
	/** 网关配置读写的 reqId（与用量查询分开计数：两者是不同请求，不能互相作废）。 */
	const gatewayReqIdRef = useRef(0);
	/** 「从网关读取模型清单」的 reqId。 */
	const providerModelsReqIdRef = useRef(0);
	if (!opsApiRef.current) {
		opsApiRef.current = {
			// P4 候选：系统资源快照（只读）。reqId 自增，结果按 reqId 匹配。
			listResources: () => {
				resourcesReqIdRef.current += 1;
				opsSendRef.current({ type: "list_resources", reqId: resourcesReqIdRef.current });
				return resourcesReqIdRef.current;
			},
			// P4 运维：存储占用明细（只读，有界遍历；不要放进轮询）。
			listStorage: () => {
				storageReqIdRef.current += 1;
				opsSendRef.current({ type: "list_storage", reqId: storageReqIdRef.current });
				return storageReqIdRef.current;
			},
			// P4 运维：诊断包（只读元数据）。
			listDiagnostics: () => {
				diagnosticsReqIdRef.current += 1;
				opsSendRef.current({ type: "list_diagnostics", reqId: diagnosticsReqIdRef.current });
				return diagnosticsReqIdRef.current;
			},
			// P4 运维：开关资源告警。
			setOpsAlerts: (enabled) => opsSendRef.current({ type: "set_ops_alerts", enabled }),
			// P4 运维：设置用量历史保留天数（仅 0/7/30/90/365）。
			setUsageRetention: (maxAgeDays) => opsSendRef.current({ type: "set_usage_retention", maxAgeDays }),
			// P4 首个切片：用量历史查询（只读）。reqId 自增，结果按 reqId 匹配。
			queryUsageHistory: (groupBy, window) => {
				usageReqIdRef.current += 1;
				const reqId = usageReqIdRef.current;
				const now = Date.now();
				const from =
					window === "all"
						? undefined
						: window === "today"
							? startOfUtcDay(now)
							: now - (window === "7d" ? 7 : 30) * 86_400_000;
				opsSendRef.current({ type: "usage_history_query", reqId, groupBy, ...(from === undefined ? {} : { from }) });
				return reqId;
			},
			// 单网关接入：读/写网关配置。与用量查询共用同一个自增序号（都是网关域的往返）。
			getGateway: () => {
				gatewayReqIdRef.current += 1;
				const reqId = gatewayReqIdRef.current;
				const sent = opsSendRef.current({ type: "get_gateway", reqId });
				if (!sent)
					dispatch({
						type: "gateway",
						msg: { type: "gateway", reqId, ok: false, error: "连接未就绪，未能读取网关配置" },
					});
				return reqId;
			},
			refreshProviderModels: (providerId) => {
				providerModelsReqIdRef.current += 1;
				const reqId = providerModelsReqIdRef.current;
				opsSendRef.current({ type: "refresh_provider_models", providerId, reqId });
				return reqId;
			},
			saveGateway: (input) => {
				gatewayReqIdRef.current += 1;
				const reqId = gatewayReqIdRef.current;
				const sent = opsSendRef.current({ type: "save_gateway", reqId, ...input });
				if (!sent)
					dispatch({ type: "gateway_saved", result: { type: "gateway_saved", reqId, ok: false, error: "连接未就绪" } });
				return reqId;
			},
			// 网关（NewAPI 一类）自报用量（只读）。providerId 省略 = 服务端用当前生效模型的服务商。
			queryGatewayUsage: (providerId, force) => {
				gatewayUsageReqIdRef.current += 1;
				const reqId = gatewayUsageReqIdRef.current;
				dispatch({ type: "gateway_usage_start" });
				const sent = opsSendRef.current({
					type: "query_gateway_usage",
					reqId,
					...(providerId ? { providerId } : {}),
					...(force ? { force: true } : {}),
				});
				// 连接没开 = 请求根本没发出去：必须自己把 busy 收回来，否则界面永远停在「查询中」。
				if (!sent)
					dispatch({
						type: "gateway_usage",
						msg: { type: "gateway_usage", reqId, ok: false, error: "连接未就绪，未能查询网关用量" },
					});
				return reqId;
			},
		};
	}

	const chatApi = useRef({
		chat,
		send,
		pushNotice,
		dismissNotice,
		opsApi: opsApiRef.current,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
			select: terminalSelect,
		},
	});
	chatApi.current = {
		chat,
		send,
		pushNotice,
		dismissNotice,
		opsApi: opsApiRef.current,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
			select: terminalSelect,
		},
	};
	return chatApi.current;
}
