/**
 * AgentService — wraps the pi SDK (@earendil-works/pi-coding-agent) for the web
 * frontend. Each browser client (identified by a persistent clientId) gets its
 * own AgentSessionRuntime, but sessions live in the SDK default per-project
 * directory (<agentDir>/sessions/--<cwd>--/) — the same transcript files the
 * pi CLI/TUI use — so every conversation of a folder shows up everywhere.
 *
 * Streaming model: the SDK emits AgentSessionEvents; we forward lightweight
 * `tool_delta` messages for live tool output and schedule throttled full-state
 * snapshots. The frontend is snapshot-driven (server is the source of truth),
 * so reconnects just re-request a snapshot.
 * 🍞 @COUPLED session-history-cache.ts / session-search.ts own history reads;
 * initial-snapshot-gate.ts / index.ts own the initial baseline (see docs/architecture-core.md).
 * @COUPLED conversation-maintenance.ts / subagent-archive.ts: idle retirement and result restoration.
 * 📖 docs/conversation-lifecycle.md
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync, statSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
// @ts-expect-error Host runtime module is JavaScript by design.
import { isFailedStopReason, normalizeUsageEvent, TokenUsageTracker } from "#usage";
import { PROTOCOL_VERSION } from "./protocol-version.js";
import { JevGate, type JevDecision } from "./dev-con/jev-gate.js";
import { jevCachePath } from "./dev-con/jev-cache.js";
import { jevSamplesPath } from "./dev-con/jev-samples.js";
import {
	JEV_PROBE_PROPOSITION_ID,
	JEV_PROPOSITIONS,
	formatJevProse,
	JEV_PROVIDER_ID,
	buildJevQuestions,
	redactJevGateConfigForEcho,
} from "./dev-con/jev-model.js";
import { loadJevSettings, saveJevSettings } from "./dev-con/jev-settings.js";
import { UsageHistoryStore, type UsageHistoryRecord } from "./dev-con/usage-history.js";
import { collectResources } from "./dev-con/system-resources.js";
import { modelCatalogStale, modelConfigStamp, modelsConfigPathOf } from "./model-catalog-freshness.js";
import { measureAreas } from "./dev-con/storage-usage.js";
import { buildDiagnostics, usageSummaryOf } from "./dev-con/ops-diagnostics.js";
import { capabilityFixHint, runCapabilityProbe, type CapabilityVerdict } from "./dev-con/endpoint-capability.js";
import { evaluateAlerts, ALERT_COOLDOWN_MS, ALERT_CRITICAL_PERCENT, ALERT_WARN_PERCENT, type OpsAlert } from "./dev-con/ops-alerts.js";
import { GatewayUsageService } from "./dev-con/gateway-usage.js";
import { filterCatalogToProviders } from "./dev-con/gateway-config.js";
import { evaluateFailureAlerts, FAILURE_WINDOW_MS, type FailureAlert, type FailureSample } from "./dev-con/failure-alert.js";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashTool,
	createLocalBashOperations,
	getAgentDir,
	SessionManager,
	VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type SessionInfo,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ConversationMaintenance, conversationBusy } from "./conversation-maintenance.js";
import { SUBAGENT_CONCURRENCY } from "./conversation-retention.js";
import { SubagentArchive, type ArchivedSubagent } from "./subagent-archive.js";
import { toSubagentSnapshot, subagentRunOutcome } from "./subagent-state.js";
import { SessionHistoryCache } from "./session-history-cache.js";
import { startTrace, traceStep, type TimingTrace } from "./timing.js";
import { historyPage, snapshotWindow, SNAPSHOT_TAIL_MESSAGES } from "./history-window.js";
import { searchSessionInfos } from "./session-search.js";
import { BgServerTracker } from "./bg-servers.js";
import {
	checkAll as checkAllUpdates,
	collectTargets,
	compareVersions as compareSemver,
	type UpdateItem,
} from "./update-check.js";
import { hasActiveSubagentRun, hasPendingWaitSubscription, shouldRetainActive } from "./wait-subscription-scan.js";
import type {
	PluginAgentTool,
	PluginCommandDef,
	PluginConversationSnapshot,
	PluginRunEvent,
	PluginToolEvent,
} from "./plugins.js";
import { syncPluginToolsIntoSession } from "./plugins.js";
import { SettingsService } from "./settings-service.js";
import { makeContextPolicyLoader, resolveContextBudget, type ContextPolicy } from "./context-policy.js";
import { scanSessionStamps, sessionsRootDir } from "./session-signature.js";
import { GoalService } from "./goal-service.js";
import { MarkerService } from "./marker-service.js";
import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { filterRoutableModels } from "./model-routing.js";
import { FilesService, MACHINE_ROOT, workspacePath } from "./files-service.js";
import {
	isExtensionDisabled,
	isExtensionEnabled,
	normalizeRetryMaxAttempts,
	type PromptMode,
	ClientStateStore,
} from "./client-state.js";
import { pick, resolveServerLang, type ServerLang } from "./i18n.js";
import { SubagentTemplatesStore, pickTemplatePrompt, type SubagentTemplate } from "./subagent-templates.js";

import {
	applyHeadTail,
	makePersistentTerminalTools,
	makeTerminalBashTool,
	stripAnsi,
	TERMINAL_TOOLS_GUIDANCE,
	TERMINAL_TOOL_NAMES,
} from "./terminals.js";
import { WebUIContext, mockThemeProxy } from "./webui-context.js";
import { makeEditSoftTool, SOFT_EDIT_TOOL_NAME } from "./edit-soft-tool.js";
import {
	makeSubagentTools,
	subagentTitle,
	withSubagentOwner,
	type SubagentSnapshot,
	type SubagentToolHost,
} from "./subagents.js";
import { buildAttachmentMessages } from "./attachments.js";
import {
	BUILTIN_SOUL,
	DEFAULT_PROMPT_TEMPLATE,
	buildToolsSchemaText,
	renderPromptTemplate,
	resolveSectionTexts,
	type PromptComposerInputs,
} from "./prompt-composer.js";
import type {
	BgServer,
	ClientMessage,
	CommandDef,
	ConversationSummary,
	GoalStatus,
	ProjectSummary,
	QuestionAnswer,
	ServerMessage,
	SessionSummary,
	UiMessage,
	UiModelConfigEntry,
	UiQuestion,
	UiState,
	UiSubagentTemplate,
} from "./protocol.js";
import {
	serializeMessage,
	serializeStreamingMessage,
	stripTransientRetryErrors,
	type AgentMessage,
} from "./serialize.js";
import { loadCommands, saveCommandsFile, TerminalManager } from "./terminals.js";

const SNAPSHOT_INTERVAL_MS = 60;
/** While assistant deltas are flowing, live rendering is carried by
 *  message_delta — full snapshots become pure reconciliation checkpoints, so
 *  send them on a slow event-driven cadence (see flushSnapshot call-sites:
 *  agent_end / tool_execution_end always checkpoint immediately). */
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
/** Deltas newer than this keep the streaming (low-frequency) snapshot cadence. */
const DELTA_ACTIVE_WINDOW_MS = 1500;
const WIDGET_REFRESH_MS = 2000;
/** Model-stall watchdog: warn (don't abort — deep thinking can be legitimately
 *  quiet for minutes) when a streaming run produced NO SDK events for this long.
 *  Covers the failure class the per-tool watchdog cannot see: half-open API
 *  connections / hung proxies where no tool is running and no error is thrown.
 *  Override: PI_WEB_STALL_NOTIFY_MS (milliseconds; 0 disables). */
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
/** Serialization-cache cap per conversation (see serializeCached): cached
 *  UiMessage objects are pure-function results, so eviction only costs a
 *  recompute on next access. Bounds memory for marathon sessions. */
const UI_MESSAGE_CACHE_CAP = 4096;
/** P4 运维告警（资源越线 + 渠道失败白烧）的检查周期。默认 60 秒。
 *  Override: PI_WEB_OPS_ALERT_MS（毫秒；下限 1000 —— 更小就是把定时器变成热循环）。
 *  @WHY 需要这个旋钮是因为告警的**窗口与冷却**是分钟级常量，而检查周期只决定
 *  「多久发现」。端到端用例要证明的是整条链路（采样 → 判定 → 发通知），不是那 60 秒，
 *  没有旋钮就只能靠等一个 tick，单条用例多花一分钟且必然脆。 */
const OPS_ALERT_CHECK_MS = (() => {
	const v = Number(process.env.PI_WEB_OPS_ALERT_MS);
	return Number.isFinite(v) && v >= 1000 ? v : 60_000;
})();
/**
 * Jev 自检（jev_probe）的内置合成样本：一段极小的代码改动描述。
 * @WHY 自检的目的是证明「key / 路由 / 模型可用」，不能依赖用户仓库内容：
 *   固定样本不进磁盘、不含任何真实代码，也保证同一部署下自检结果可对比。
 *   内容写英文：state 也是送进模型的文本，官方明确 Jev 英文准确率最优。
 */
const JEV_PROBE_STATE: Record<string, unknown> = {
	note: "Built-in self-check sample (not real code)",
	diff: [
		"--- a/src/api.ts",
		"+++ b/src/api.ts",
		"@@ -1,3 +1,3 @@",
		"-export function parse(input: string): Result { return parseStrict(input); }",
		"+export function parse(input: string, opts?: { lenient?: boolean }): Result { return parseStrict(input, opts); }",
	].join("\n"),
};
/** Preview panel cap: only the first 512KB of a file is ever read/sent. */

/** Thrown when the service is quiesced (draining) and the request is NEW work
 *  the admission controller refuses: a brand-new client attach, a prompt,
 *  a fork, a session resume, or a goal wizard start. index.ts closes the
 *  WebSocket with 4403 so the browser reconnect loop can retry after the
 *  server reopens admission (see AgentService.quiesce). */
export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";
	constructor(detail: string) {
		super(`服务器正在排空存量工作（quiesce）——${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

// ---------------------------------------------------------------------------
// Preview kind classification. The preview panel only opens image / video /
// text-editable files; everything else (exe, jar, archives, …) is refused so
// it is never read or sent to the browser. Media files are served over the
// /api/file HTTP endpoint instead of the WebSocket, so they are classified
// here but never read into the snapshot path.
// ---------------------------------------------------------------------------

/** 自家内联扩展名（组合模板渲染，见 prompt-composer.ts）。SDK 以其
 *  "<inline:<name>>" 作为 path；扩展白名单/禁用过滤必须放行它。 */
const INLINE_PERSONA_EXT = "<inline:pi-webui-persona>";

/** Pi 包文档路径（composer 的 {{pi_docs}} 自动内容用）。随安装位置解析一次。 */
const PI_DOC_PATHS = (() => {
	try {
		const requireLocal = createRequire(import.meta.url);
		const root = dirname(requireLocal.resolve("@earendil-works/pi-coding-agent/package.json"));
		return { readme: join(root, "README.md"), docs: join(root, "docs"), examples: join(root, "examples") };
	} catch {
		return { readme: "", docs: "", examples: "" };
	}
})();

/** Windows persona appendix — appended to the SDK system prompt on win32 only.
 *  Two failure modes it guards against: (1) the SDK bash tool has NO default
 *  timeout, so a long-running command hangs the whole conversation forever;
 *  (2) the in-app terminal is an interactive TTY where heredocs / interactive
 *  programs wait for input that never comes. Legacy Chinese files are often
 *  GBK/GB2312 — read them with the right encoding, never paste mojibake into
 *  reasoning/answers. */
const WINDOWS_PERSONA = `You are a coding agent running on Windows. The bash tool runs Git Bash (bash.exe), not PowerShell. Follow these rules to avoid hanging the session:



- ALWAYS pass a timeout parameter to the bash tool (in seconds). There is NO default timeout — a command that never finishes (servers, watchers, infinite loops, slow downloads/installs) will hang the entire conversation indefinitely. Pick a generous timeout for long-running work, but never omit it.
- NEVER run interactive or foreground long-running commands through the bash tool (vi, less, top, python -, node -, npm run dev, sleep 10000). For servers/daemons use background execution with output redirected to a log file, then poll the log; stop them when done.
- In the interactive terminal (TTY) — which is Git Bash too, not PowerShell — NEVER use heredocs (<<'EOF' ... EOF) or here-strings, and NEVER start interactive programs (vi, less, python -, node -, npm init): they wait for keyboard input that never arrives and hang the terminal forever. Prefer writing a temp script file (e.g. .pi-tmp.sh) and running it non-interactively. ALWAYS pass a timeout to long-running commands (e.g. \`timeout 120 npm run dev\`).

Many legacy Chinese text files (.html/.txt/.md/.log, exported documents) are GBK/GB2312 encoded: the read tool decodes UTF-8 only and will show mojibake (乱码) for them. If a file's content looks garbled, read it through the terminal instead: in Git Bash use \`cat file | iconv -f GBK -t UTF-8\` (or \`iconv -f GBK -t UTF-8 file\`); in cmd use \`chcp 65001 && type file\`; in PowerShell use \`Get-Content -Encoding Default file\`. Never paste mojibake into your reasoning or answer — describe the decoded content instead.`;

/**
 * Killable bash tool: wraps the SDK bash tool (native process spawn, NO terminal).
 * Used when the「默认 bash 覆盖」setting is OFF. Registers its own AbortController
 * into a client-level set (kills) so abortBash() kills only these commands while the
 * agent run and the conversation continue. Exposes persist (ignored — native has no
 * terminal) plus head/tail (post-processed on the returned output) so the parameter
 * schema stays consistent with the terminal-backed tool.
 */
export function makeKillableBashTool(cwd: string, kills: Set<AbortController>): ToolDefinition {
	const base = createLocalBashOperations();
	const tool = createBashTool(cwd, {
		operations: {
			exec: async (command, c, opts) => {
				const ac = new AbortController();
				kills.add(ac);
				try {
					const signals = [opts.signal, ac.signal].filter((s): s is AbortSignal => s !== undefined);
					return await base.exec(command, c, {
						...opts,
						signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
					});
				} finally {
					kills.delete(ac);
				}
			},
		},
	});
	// AgentTool → ToolDefinition (same fields; customTools expects definitions).
	return {
		name: tool.name,
		label: tool.label,
		description:
			"Run a shell command natively (process spawn, no terminal) and return its full output plus exit code — the SDK's plain bash tool. persist is ignored here (no terminal); use head/tail to trim the returned output.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run" }),
			timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
			persist: Type.Optional(
				Type.Boolean({
					description: "Ignored in native mode (no terminal). Only meaningful when the terminal-backed bash is active.",
				}),
			),
			head: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "Only return the FIRST N lines of output (like `| head -N`).",
				}),
			),
			tail: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "Only return the LAST N lines of output (like `| tail -N`).",
				}),
			),
		}),
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const result = (await tool.execute(
				toolCallId,
				params as { command: string; timeout?: number },
				signal,
				onUpdate,
			)) as { content?: Array<{ type: string; text?: string }> };
			// head/tail 后处理（native 无终端，直接截返回行即可）。
			const p = params as { head?: number; tail?: number };
			if ((p?.head || p?.tail) && result?.content?.[0]?.text != null) {
				result.content![0].text = applyHeadTail(result.content![0].text!, p.head, p.tail);
			}
			return result as never;
		},
	} as ToolDefinition;
}

/**
 * 动态分流 bash：按「默认 bash 覆盖」设置（terminalBash）在调用时决定走哪套——
 * 关 = 原生 SDK bash（纯进程、不开终端）；开 = 终端接管 bash（persist 决定一次性/
 * 持久）。开关因此即时生效（customTools 固定于 runtime 创建，不能在创建时二选一）。
 */
export function makeAdaptiveBashTool(
	killable: ToolDefinition,
	terminalBacked: ToolDefinition,
	useTerminal: () => boolean,
): ToolDefinition {
	return {
		...killable,
		description:
			"Run a shell command and return its full output plus exit code. Behavior depends on the「default bash override」setting (terminalBash):\n" +
			"Setting OFF → runs natively (process spawn, no terminal) — the SDK's plain bash tool. persist has no effect.\n" +
			"Setting ON → runs in a visible terminal. persist=true keeps that terminal alive ('ai-bash': shell state such as cd/venv/ssh retained across calls, silent commands move to the background and notify when done); persist=false (default in terminal mode) creates a one-shot terminal that exits when the command finishes while its output stays for review.\n" +
			"Run the bare command — do NOT pipe through head/tail/more/less (use the head/tail parameters to trim the returned output instead; piping also hides live progress in the visible terminal). For interactive commands (REPLs, prompts, installers asking y/n) set persist=true (terminal mode) and drive them with terminal_input / terminal_key.",
		promptSnippet: "run shell commands",
		execute: (id, params, signal, onUpdate, ctx) =>
			(useTerminal() ? terminalBacked : killable).execute(id, params as never, signal, onUpdate, ctx),
	};
}

/**
 * 内置标记只读查询工具（markers_list）— 读操作仍走真工具。
 */
function makeMarkersListTool(
	getActiveId: () => string,
	markerSvc: {
		describe: (id: string, tool: string, inc?: boolean) => string;
		getRawState: (id: string, ns: string) => unknown;
	},
): ToolDefinition {
	return {
		name: "markers_list",
		label: "List marker state",
		description:
			"Read-only query of inline marker state. All WRITE operations must use inline markers ([[todo:new:...]] etc.) in the reply body — never use this tool for writes.\n只读查询内联标记状态。状态【写】操作请一律用内联标记（[[todo:new:...]] 等）写在回答正文里，不要调用本工具做写操作。",
		parameters: Type.Object({
			action: Type.Unsafe<string>({ enum: ["list"] }),
			tool: Type.Optional(Type.Literal("todo")),
			includeDeleted: Type.Optional(
				Type.Boolean({
					description:
						"Whether to include deleted tasks (tombstones, todo only).\n是否包含已删除任务（tombstone，仅 todo）。",
				}),
			),
		}),
		execute: async (_id: string, params: unknown) => {
			const p = params as { action: string; tool?: string; includeDeleted?: boolean };
			const convId = getActiveId();
			const text = markerSvc.describe(convId, "todo", !!p.includeDeleted);
			const state = markerSvc.getRawState(convId, "todo") as { tasks: unknown[]; nextId: number } | undefined;
			const visible = (state?.tasks ?? []).filter(
				(t: unknown) => p.includeDeleted || (t as { status: string }).status !== "deleted",
			);
			return {
				content: [{ type: "text", text }],
				details: { action: "list", todos: visible, nextId: state?.nextId },
			} as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * Jev 门禁工具（`jev_check`）的一次判定结果。
 * @CONTRACT `unsupported` 非空 = 输入本身不可判（未知命题/空命题），此时没有 decision；
 *   `decision.error` 非空 = 门禁没拿到有效答案（未配凭据/超时/上游失败…），outcome 必为 review。
 *   两者都必须**如实上报**，不得当成放行。
 */
export interface JevCheckResult {
	ids: string[];
	decision?: JevDecision;
	unsupported?: { error: string; errorEn: string };
}

/**
 * DEV-CON：Jev 门禁工具（标准 pi 引擎的 customTool，与 bash/edit 同机制）。
 *
 * @WHY 为什么需要它：Jev 不是对话模型（不生成文本、不写代码），它只对**二元命题**给出
 *   0..1 的置信度，由服务端按阈值定三态。接入后一直只有「设置面板自检」与 CLI 两个入口，
 *   日常编码路径上没人问它 —— 既拦不住东西，也攒不下真实分数（磁盘缓存长期 0 条，阈值无从校验）。
 * @CONTRACT 判定完全在服务端（同一 JevGate 出口/阈值/缓存/限频）：本工具只传 state 与命题名，
 *   **不自己算阈值、不自己下结论**；三态里 approve=放行、block=拦下、review=转人工。
 *   门禁坏掉（未配凭据/超时/401/429/缺答）一律是 review，**绝不是放行**，工具会明确告知。
 * @GOTCHA 只问「语义」判断（是否破坏公开 API / 测试是否真断言行为 / 改动是否在任务范围内）。
 *   计数、日期先后、算术一律不要问它（官方 model-jaggedness）；state 也只放与该命题相关的字段——
 *   大而杂的 state 是干扰项，会带 context rot。
 */
export function makeJevCheckTool(clientSession: {
	checkJev: (input: { state: unknown; propositions?: string[]; useCache?: boolean }) => Promise<JevCheckResult>;
}): ToolDefinition {
	return {
		name: "jev_check",
		label: "Jev decision gate",
		description: [
			"Ask the Jev decision gate (a System One binary-judgment model — it does NOT generate text or code)",
			"for calibrated 0..1 confidence on a few propositions, and get back the gate's three-state verdict:",
			"approve (pass) / block (stop) / review (needs a human). The verdict is computed server-side from",
			"thresholds you cannot influence — never treat a failed call as a pass.",
			"Propositions: change_preserves_public_api (does the change keep the public API compatible),",
			"test_asserts_behavior (do the added/modified tests assert specific behavior or values),",
			"change_within_task_scope (does every part of the change stay inside the task objective).",
			"Use it on semantic judgments only (API compatibility, test quality, scope) — never for counting,",
			"date ordering or arithmetic. Keep `state` small and focused on the proposition: put the task",
			"objective plus the relevant diff, not the whole repository.",
		].join(" "),
		parameters: Type.Object({
			state: Type.Union(
				[
					Type.String({ description: "Material under review (raw text)." }),
					Type.Object({}, { additionalProperties: true }),
				],
				{
					description:
						"Material under review: an object such as { objective, diff } or a plain string. Only include what the asked propositions need.",
				},
			),
			propositions: Type.Optional(
				Type.Array(Type.String(), {
					description: "Proposition ids to judge (default: all). Unknown ids are rejected with the available list.",
				}),
			),
			useCache: Type.Optional(
				Type.Boolean({
					description:
						"Reuse an identical earlier decision (default true) — the decision is a pure function of model+propositions+state, so identical input should not be paid twice.",
				}),
			),
		}),
		execute: async (_id: string, params: unknown): Promise<unknown> => {
			const input = params as { state?: unknown; propositions?: string[]; useCache?: boolean };
			if (input?.state === undefined || input.state === null) {
				throw new Error("jev_check requires `state` (the material under review).");
			}
			const result = await clientSession.checkJev({
				state: input.state,
				propositions: input.propositions,
				useCache: input.useCache,
			});
			if (result.unsupported) {
				const { error, errorEn } = result.unsupported;
				return {
					content: [{ type: "text", text: `${error}\n${errorEn}` }],
					details: result,
				} as never;
			}
			const decision = result.decision!;
			const scores =
				Object.entries(decision.checks)
					.map(([name, score]) => `${name}=${score}`)
					.join(", ") || "(no scores)";
			const lines = [
				`Jev outcome: ${decision.outcome} (approve=pass, block=stop, review=needs a human)`,
				`scores: ${scores}`,
				`reason: ${decision.reasonEn}`,
				`理由（中文）: ${decision.reason}`,
			];
			if (decision.error) {
				lines.push(`NOTE: this was not a valid decision (treatment: review, never pass). error: ${decision.errorEn}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: result } as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * 标准 pi 引擎的 ask_user_question 工具：模型调用时把问题桥到浏览器（复用 DSH
 * 引擎的 question_pending/question_answer 协议，前端 DshQuestionDialog 富渲染），
 * 阻塞 agent 循环直到用户在浏览器回答或取消。
 *
 * 标准 SDK 没有内建 ask_user_question，故由 pi-web-ui 以 customTool 注册（与
 * bash/edit 同机制）。DSH 引擎走 goal-rpc 的 userQuestions provider，两者互不
 * 冲突（各引擎各走各的）。
 *
 * askUser 签名带 {aborted} 快照而非完整 AbortSignal：customTool 的 execute 信号
 * 服务于整个 agent 生命周期，这里按「已中止即拒绝」的最小语义处理，避免与其它
 * 工具的取消逻辑纠缠。
 */
export function makeAskUserQuestionTool(clientSession: {
	askUser: (q: UiQuestion[], sig: { aborted?: boolean }) => Promise<QuestionAnswer[] | null>;
}): ToolDefinition {
	const QuestionOptionSchema = Type.Object({
		label: Type.String({ description: "Display label for the option" }),
		description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
		preview: Type.Optional(
			Type.String({
				description:
					"Optional preview rendered below when this option is selected (markdown or HTML — use for mockups/code/config).",
			}),
		),
	});
	const QuestionSchema = Type.Object({
		id: Type.String({ description: "Unique identifier for this question" }),
		question: Type.String({ description: "The full question text to display (markdown/HTML ok)" }),
		detail: Type.Optional(Type.String({ description: "Optional detail/context shown under the question" })),
		header: Type.Optional(Type.String({ description: "Optional short header for this question" })),
		options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Available options to choose from" })),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
	});
	return {
		name: "ask_user_question",
		label: "Ask the user",
		description:
			"Ask the user focused questions to pin down ambiguous requirements. Use for clarifying the task, confirming decisions, or getting preferences. Each question renders a browser dialog with markdown/HTML rich text; options may carry a `preview`. Submit or cancel to resume.",
		parameters: Type.Object({
			questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const qs = (params as { questions: UiQuestion[] }).questions;
			if (!Array.isArray(qs) || qs.length === 0) {
				throw new Error("ask_user_question requires at least one question");
			}
			const answers = await clientSession.askUser(qs, {
				aborted: signal?.aborted,
			});
			if (answers === null) {
				throw new Error("User cancelled the question.\n用户取消了提问。");
			}
			// 工具结果：把每道题的回答拼成简洁文本给模型，同时留 details 供 UI 展示。
			const lines = answers.map((a) => {
				const q = qs.find((q) => q.id === a.id);
				const label = a.selected.join(", ");
				const custom = a.custom?.trim() ? ` (wrote: ${a.custom.trim()})` : "";
				return `${q?.header ?? q?.id ?? a.id}: ${label || "(no selection)"}${custom}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { answers },
			} as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * 插件结构化工具 → SDK ToolDefinition。
 * execute 返回值宽容处理：{content,details} 原样收编；字符串/对象包成文本块。
 */
function pluginToolToDefinition(tool: PluginAgentTool): ToolDefinition {
	const normalize = (
		result: unknown,
	): {
		content: Array<{ type: "text"; text: string }>;
		details?: unknown;
	} => {
		if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
			return result as {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
			};
		}
		const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
		return { content: [{ type: "text", text }] };
	};
	return {
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: (tool.parameters ?? {
			type: "object",
			properties: {},
		}) as ToolDefinition["parameters"],
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
		) => {
			const raw = await tool.execute(
				toolCallId,
				params as Record<string, unknown>,
				signal,
				onUpdate ? (partial) => onUpdate(normalize(partial) as never) : undefined,
			);
			return normalize(raw) as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * Cheap per-message discriminator for the serialization cache key. Persisted
 * message content never changes, so this is stable across snapshots, while
 * several same-role messages created within one millisecond (attachment
 * asides) get distinct keys. Text blocks are fingerprinted by a short hash of
 * their head (paths embedded in <file> tags can share long prefixes — e.g.
 * uploads created in the same millisecond differ only at the tail); image
 * payloads by data length (identical lengths within the same ms are far too
 * unlikely to matter).
 */
function contentFingerprint(m: AgentMessage): string {
	const content = (m as unknown as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return "empty";
	const first = content[0] as { type?: string; text?: string; data?: string };
	if (first?.type === "image") {
		return `img:${(first.data ?? "").length}`;
	}
	const text = typeof first?.text === "string" ? first.text : "";
	// djb2 — fast enough to run per snapshot, distinct enough for asides.
	let h = 5381;
	for (let i = 0; i < text.length && i < 512; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	}
	return `txt:${h.toString(36)}:${text.length}`;
}

// ---------------------------------------------------------------------------
// Web UI context adapter — bridges extension UI calls (setWidget/notify) to the
// browser. Extensions like rpiv-todo render a TUI widget via
// `ui.setWidget(key, (tui, theme) => comp)`; we capture the component, render it
// with a mock theme to plain text lines, and push them to the client.
// ---------------------------------------------------------------------------

function extractPartialText(partial: unknown): string | null {
	const content = (partial as { content?: unknown } | null | undefined)?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => ((c as { type?: string; text?: string })?.type === "text" ? (c as { text: string }).text : ""))
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

function extractAssistantTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: string; text: string } =>
				(c as { type?: string }).type === "text" && typeof (c as { text?: string }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}

export { workspacePath };
// ---------------------------------------------------------------------------
// Per-client persisted UI state (<dataDir>/client-state.json)
// ---------------------------------------------------------------------------

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 */
/** 排空诊断里「谁在持有工作」的一条记录（控制套接字 status → 切换日志）。 */
export interface DrainHolder {
	/** 对话 id 前 8 位（够在界面上认出来，不把全量 id 写进日志）。 */
	id: string;
	/** 有在飞的一轮（在消费它的队列）。 */
	streaming: boolean;
	/** 排队的 steer + follow-up 条数。 */
	queued: number;
	/** 距最后一次 SDK 事件多久（秒）——“6 分钟无输出”这类诊断靠它。 */
	idleSeconds: number;
}

export interface Conversation {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	/** 子代理使用内存会话，结束后由维护模块归档并释放。 */
	isSubagent: boolean;
	subagentTemplate?: SubagentTemplate;
	subagentStarting?: boolean;
	subagentPending?: number;
	/** 派发它的父对话 id（Running 面板嵌套用；顶层子代理为空）。 */
	parentId?: string;
	/** 子代理类型/角色展示名（explore/implement/review…）。 */
	subagentType?: string;
	/** 子代理最近一次运行报错的文本（快照 error 字段的只读缓存位），消息内容不变 /
	 *  会话重建时保留，避免重复向主对话发 notice（subagentErrorNotified 是去重键）。 */
	subagentError?: string;
	/** 已就当前 subagentError 向主对话发过 notice 的错误文本（去重；文本变化时重置）。 */
	subagentErrorNotified?: string;
	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	/** In the per-project "running conversations" list. A conversation enters
	 *  the list when it is displaced to the background while still streaming;
	 *  it leaves (and its runtime is freed) when it is opened again and left
	 *  without continuing. */
	listed: boolean;
	/** A prompt was sent while this conversation was active (cleared whenever
	 *  it becomes active). A listed conversation that is displaced while idle
	 *  with this still false counts as "opened but not continued" and is
	 *  dismissed from the list. */
	promptedSinceActive: boolean;
	/** 尾部优先历史：本端上次发出的快照里省略了多少条更早消息（客户端据此显示
	 *  「载入更早」；见 server/history-window.ts）。 */
	historyOmitted: number;
	/** 客户端已把本对话完整补全过 → 之后的全量快照不再截断（否则压缩/重同步
	 *  发出的全量会把用户刚翻出来的历史又收回去）。 */
	historyExpanded: boolean;
	/** Last time this conversation became active — set_cwd picks the target
	 *  project's most recently active conversation. */
	lastActiveAt: number;
	/** Last time ANY SDK event arrived for this conversation — drives the
	 *  model-stall watchdog (#7): a run that produces no events at all for
	 *  STALL_NOTIFY_MS is probably a half-open API connection. */
	/** Unified event-level token accounting for current/run/cumulative views. */
	usageTracker: TokenUsageTracker;
	/**
	 * 请求发出时固定的渠道/凭据/模型与绑定版本（§7）：在 Agent.getApiKey 被调用
	 * （= SDK 每次 provider 请求前）时写入，使晚到的用量结果仍归属到当时的绑定。
	 */
	lastRequestBinding: { providerId: string; modelId: string | null } | null;
	/** 最近一条已写入用量历史记录的 id（避免同一记录重复落盘）。 */
	lastPersistedUsageId: string | null;
	/** 压缩前的会话统计基线：压缩摘要的 token 用会话统计差值归属为 source=compaction。 */
	compactionBaseline: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number } | null;
	/** Last time any SDK event arrived for this conversation. */
	lastSdkEventAt: number;
	/** Set once the stall notice has been sent for the current silent period;
	 *  cleared on every SDK event and on each new prompt. */
	stallNoticed: boolean;
	/** Independent goal/review state for this conversation. */
	goal: GoalStatus;
	goalGeneration: number;
	goalReviewGeneration: number;
	/** Wizard execution is per conversation; dialog transport itself remains
	 * client-wide because the browser can display one dialog at a time. */
	wizardRunning: boolean;
	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
	/** Monotonic sequence for message_delta/tool_delta pushes of this conversation —
	 *  a gap on the client triggers a get_state resync. */
	deltaSeq: number;
	/** PTYs belong to the conversation, not the browser socket or client. */
	terminals: TerminalManager;
	// Per-conversation serialization caches. Message ids derive from
	// (role, timestamp); two conversations can produce identical pairs, so
	// these must never be shared across conversations.
	msgIds: Map<string, number>;
	nextMsgId: number;
	/** Per-timestamp 1-based user-message seq (drives the `u-<ts>-<seq>` id suffix). */
	userSeqByTs: Map<number, number>;
	uiMessageCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	/** Actual queued prompt TEXTS (steer = 插队, followUp = 排队) — the UI
	 *  renders them as pending bubbles in the real message list. */
	queueSteering: string[];
	queueFollowUp: string[];
	/** tool_execution_start timestamps keyed by toolCallId — lets tool_status
	 *  report how long a tool actually ran (vs. waiting on the model). */
	toolStartTimes: Map<string, number>;
	/** LLM 瞬时报错自动重试进行中（agent_end willRetry 占位 → auto_retry_start
	 *  填实 → auto_retry_end 清除）。置位期间快照隐藏末尾的 stopReason=error
	 *  assistant 消息（重试成功则用户永远看不到，耗尽才永久标红），前端改显
	 *  温和的「正在重试」条，而非一闪而过的红色报错。 */
	retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null;
	/** 上下文压缩进行中（compaction_start 已到、compaction_end 未到）。置位期间
	 *  快照携带 compaction 字段，前端在消息区常驻「压缩中…」进度条（toast 会
	 *  自动消失，而摘要 LLM 调用可能持续数十秒）；结束/失败/取消时清除。 */
	compactionState?: { reason: string; startedAt: number } | null;
	/** 最近一次压缩成功的 estimatedTokensAfter（SDK 自算的压缩后上下文大小）。
	 *  压缩后 SDK getContextUsage() 故意报 null（压缩前的 usage 不可信），
	 *  下轮模型响应前快照用此值回填并标 estimated；开始下一次压缩时清掉。 */
	lastCompactionTokens?: number | null;
	/** 下一轮 agent_start 消费的用户任务文本（prompt() 暂存，轨迹插件的 run_start 用；
	 *  steer/内部续跑无暂存时为空，由插件回退为「继续执行」）。 */
	pendingTask?: string;
	/** tool_call watchdog timers keyed by toolCallId — a tool that runs past
	 *  TOOL_WATCHDOG_TIMEOUT_MS gets the session aborted instead of hanging
	 *  the conversation forever (the SDK bash tool has no default timeout). */
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
	/** 本端正在流式输出时收到「其他端完成了这个会话的节点」→ 置位，本轮 agent_end
	 *  结束后自动从磁盘接力重载（不打断本端正在跑的工作）。 */
	pendingDiskReload?: boolean;
	/** 接力重载正在进行——避免两个并发广播对同一对话重复换 runtime。 */
	reloadInFlight?: boolean;
	/** 上次看到的磁盘转录签名（mtimeMs:size）——用于接入/回到页面时判断是否需要追平。 */
	diskSig?: string;
}

/** 轨迹事件 payload 封顶（可直接广播/持久化，不撑爆 storage.json）。 */
const RUN_TASK_CAP = 500;
const RUN_ARGS_CAP = 4000;
const RUN_RESULT_CAP = 4000;

function truncRun(s: string, cap: number): string {
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

/** 从 SDK tool result 里抠可读文本预览（text 块拼接，图片/二进制占位，封顶）。 */
function previewToolResult(result: unknown): string {
	try {
		const content = (result as { content?: unknown })?.content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const c of content) {
				if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
					parts.push(String((c as { text?: unknown }).text ?? ""));
				} else {
					parts.push("[…]");
				}
			}
			return truncRun(parts.join("\n"), RUN_RESULT_CAP);
		}
		if (typeof result === "string") return truncRun(result, RUN_RESULT_CAP);
		return truncRun(JSON.stringify(result ?? null), RUN_RESULT_CAP);
	} catch {
		return "[unserializable result]";
	}
}

/** Hard cap on how long ONE tool call may run before the watchdog aborts the
 *  session. The SDK bash tool has NO default timeout, so a command that never
 *  finishes (servers, watchers, infinite loops) would otherwise hang the whole
 *  conversation indefinitely. Override with the PI_WEB_TOOL_TIMEOUT_MS env var
 *  (milliseconds). */
const TOOL_WATCHDOG_TIMEOUT_MS = (() => {
	const v = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 20 * 60_000;
})();

const DEFAULT_CONV_TITLE = "新对话";

/** First user text in a session, truncated for the conversation list. */
function conversationTitle(session: AgentSession): string {
	try {
		const named = session.sessionManager.getSessionName();
		if (named && named.trim()) return named.trim();
	} catch {
		// best-effort — fall through to first-message title
	}
	try {
		for (const m of session.agent.state.messages) {
			if (m.role !== "user") continue;
			const content = m.content as unknown;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (
						p &&
						typeof p === "object" &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string"
					) {
						text = (p as { text: string }).text;
						break;
					}
				}
			}
			const trimmed = text.trim().replace(/\s+/g, " ");
			if (trimmed.length > 0) {
				return trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			}
		}
	} catch {
		// best-effort
	}
	return DEFAULT_CONV_TITLE;
}

/**
 * pi 的会话存储根目录。设置了 `PI_CODING_AGENT_SESSION_DIR` 时，pi 将 transcript
 * 以**扁平布局**直接写在根目录顶层（`<root>/<timestamp>_<uuid>.jsonl`，所属 cwd 是
 * 文件内字段）；未设置时走 SDK 默认的 `<agentDir>/sessions/--<cwd>--/` 每-cwd
 * 子目录布局（此时必须**不传** sessionDir，让 SDK 落回默认路径）。
 *
 * 注意：未设置 env 时**不要**回退返回 `join(getAgentDir(), "sessions")`——那样会把
 * 根目录强塞给 SDK `list()/listAll()`，它们只会扫根目录**顶层** jsonl，默认子目录布局
 * 下顶层为空，历史对话/最近项目会全丢（回归风险，已在 0.84.4 实证）。
 */
export function piSessionsRoot(): string | undefined {
	return process.env.PI_CODING_AGENT_SESSION_DIR || undefined;
}

/** 活模型的标识（`provider/id`），供系统级上下文策略的 exemptModels 匹配；模型未就绪时 undefined。 */
function modelKeyOf(model: { provider?: string; id?: string } | undefined): string | undefined {
	if (!model?.id) return undefined;
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export class ClientSession {
	readonly clientId: string;
	/** Set by AgentService.attach: reflects the SERVICE-wide quiesce flag
	 *  (server draining — new work rejected). Default false for direct use. */
	isQuiesced: () => boolean = () => false;
	cwd: string;
	/** pi config dir (auth/models/skills). */
	private readonly agentDir: string;
	/** Persisted per-client UI state (last workspace + recent projects). */
	private readonly stateStore: ClientStateStore;
	/** Open conversations — each owns its OWN runtime, so starting a new chat
	 *  or switching chats never interrupts an in-flight run. `runtime` and
	 *  `session` accessors below target the ACTIVE conversation. */
	private convs = new Map<string, Conversation>();
	private activeId = "";
	private convSeq = 0;
	private pendingSubagentCreations = 0;
	private readonly maintenance: ConversationMaintenance;
	/** One ModelRuntime shared by all conversations — the model chosen in the
	 *  top bar applies to every chat, not just the one that set it. Seeded by
	 *  the first conversation and reused by later ones. */
	private sharedModelRuntime: Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"] | undefined;
	/** 本会话 runtime 实际加载的 models.json 身份戳（mtime+size）。用于「目录自愈」：
	 *  配置被别处改写后，旧会话不必重启服务就能跟上（见 ensureFreshModelCatalog）。 */
	private modelsConfigStamp = "";

	// -----------------------------------------------------------------------
	// 渠道端点工具能力探测（DEV-CON）——见 dev-con/endpoint-capability.ts。
	// 存在的理由：有一类网关对带 tools 的请求返回 200 却把 tools 丢掉，模型于是
	// 声称「没有工具」，开发任务静默退化成纯对话。这里在**请求真正发出时**探测一次
	// 并给出明确告警，让沉默失败变成可见失败。
	// -----------------------------------------------------------------------
	/** 按 provider/model/api/baseUrl 缓存结论（配置一变 key 就变，自动失效）。 */
	private capabilityProbes = new Map<string, { verdict: CapabilityVerdict; at: number }>();
	/** 正在探测中的 key，避免同一端点并发重复打请求。 */
	private capabilityProbesInFlight = new Set<string>();
	/** 成功结论的保鲜期（失败结论不缓存，下次请求会重试）。 */
	private static readonly CAPABILITY_PROBE_TTL_MS = 30 * 60 * 1000;

	// -----------------------------------------------------------------------
	// Goal / review / wizard —— 自包含模块，见 goal-service.ts。每个对话有独立
	// 的 GoalStatus，审查可并发；宿主回调在构造函数里接入。
	// -----------------------------------------------------------------------
	private readonly goalSvc: GoalService;
	/** Settings-panel state (system prompt + disabled skills/extensions) —
	 *  自包含模块，见 settings-service.ts。resource-loader overrides 在每次
	 *  reload() 时读 current 的最新值，session.reload() 即可应用到运行中 runtime。 */
	private settingsSvc!: SettingsService; // 构造函数里创建（需要 clientId/stateStore）
	/** How long a hard abort waits for session.abort() to make the run idle
	 *  before force-resetting the conversation (model streams that ignore the
	 *  abort signal would otherwise leave the chat stuck forever). */
	private static readonly HARD_ABORT_TIMEOUT_MS = 15_000;
	/** Extra settle window after session.abort() returns: the run is only
	 *  considered stopped once its agent_end event arrives. If it doesn't
	 *  (model stream stuck before the run even started), force-reset. */
	private static readonly HARD_ABORT_SETTLE_MS = 8_000;
	/** Live AbortControllers of THIS client's running bash tool calls — aborting
	 *  them kills only the command (agent run and conversation continue). */
	private bashKills = new Set<AbortController>();
	/** Background-server tracking (port snapshots + 后台任务 panel state) —
	 *  自包含模块，见 bg-servers.ts。列表按 CLIENT 存活，不随对话切换/结束消失。 */
	/** 文件树 / 预览读写 / SCM 查询 / watcher —— 自包含模块，见 files-service.ts。 */
	private readonly files = new FilesService({
		emit: (msg) => this.emit(msg),
		isDisposed: () => this.disposed,
		getCwd: () => this.cwd,
		getActiveCwd: () => this.conv?.cwd ?? this.cwd,
		// issue #91：文件服务错误文案按客户端 UI 语言出中英（英文默认）。
		getLang: () => this.getLang(),
	});
	private readonly bg = new BgServerTracker({
		emit: (msg) => this.emit(msg),
		flushSnapshot: () => this.flushSnapshot(),
		isDisposed: () => this.disposed,
		// 插件注册的常驻任务（host.registerBackgroundTask）并入同一「后台任务」面板。
		pluginTasks: () => this.pluginBgTasksProvider?.() ?? [],
	});

	/** index.ts 注入（经 AgentService 拷贝到每个新会话）：把 SDK 工具执行事件转发给
	 *  插件（PluginManager.emitToolEvent）。未设置时不做任何事。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入：把运行轨迹事件转发给插件（PluginManager.emitRunEvent，
	 *  轨迹视图插件靠它聚合时间线）。未设置时不做任何事。 */
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	/** index.ts 注入：当前打开对话变了（切历史会话/切 running 对话/新对话）时
	 *  通知插件（PluginManager.emitConversationChanged）——轨迹视图靠它重拉。 */
	onConversationChanged: (() => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的斜杠命令（目录展示 + prompt 拦截执行）。 */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	/** AgentService 注入：本端完成一个节点（transcript 已落盘）→ 广播给其他端，
	 *  让它们刷新会话列表并接力重载同一会话。 */
	onSessionPersisted: ((file: string, cwd: string) => void) | undefined = undefined;
	/** AgentService 注入：本端改变了会话列表本身（删除/改名/新建落盘）→ 广播给
	 *  其他端刷新列表。 */
	onSessionsListChanged: ((cwd: string) => void) | undefined = undefined;
	/** 上一轮注入会话的插件工具名集合（用于检测注销/移除）。 */
	private appliedPluginToolNames = new Set<string>();

	/** The active conversation (all session operations target it). */
	private get conv(): Conversation {
		const conv = this.convs.get(this.activeId);
		if (!conv) throw new Error("no active conversation");
		return conv;
	}
	/** Runtime of the active conversation. */
	get runtime(): AgentSessionRuntime {
		return this.conv.runtime;
	}
	/** Session of the active conversation. */
	get session(): AgentSession {
		return this.conv.session;
	}

	/** PTYs are owned by individual conversations; this getter targets the active one
	 * for compatibility with the existing terminal-panel dispatch path. */
	get terminals(): TerminalManager {
		return this.conv.terminals;
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.cwd ?? this.cwd;
	}

	private makeTerminalManager(conversationId: string, cwd: string): TerminalManager {
		const mgr = new TerminalManager(
			(msg) => this.emitTerminal(conversationId, msg),
			cwd,
			// issue #91：终端输入错误按客户端 UI 语言出中英（英文默认）。
			() => this.getLang(),
		);
		// 终端活力检测：AI 触碰过的终端静默 ≥ 阈值（PI_WEB_TERMINAL_IDLE_MS，
		// 默认 15s）且该对话正在运行时，注入一条 steer 消息唤醒 AI 去检查。
		mgr.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
			this.notifyTerminalIdle(conversationId, terminalId, idleMs, title, lastLines);
		return mgr;
	}

	/** 终端活力提醒：仅在该对话正在流式运行时注入（sendUserMessage 在流式中
	 *  即 steer 语义——当前回合结算后送达，agent 立即响应）；空闲时不打扰。
	 *  一次性语义由 TerminalManager 保证（触发后解除武装，agent 再次触碰才
	 *  重新计时），不会反复刷屏。 */
	private notifyTerminalIdle(
		conversationId: string,
		terminalId: string,
		idleMs: number,
		title: string,
		lastLines = "",
	): void {
		const conv = this.convs.get(conversationId);
		if (!conv || this.disposed) return;
		if (!conv.runtime.session.isStreaming) return;
		const seconds = Math.max(1, Math.round(idleMs / 1000));
		void conv.runtime.session
			.sendUserMessage(
				`（系统自动提醒：你启动的终端「${title}」（id=${terminalId}）已连续 ${seconds} 秒没有任何新输出。` +
					`进程可能在等待输入、卡住或已挂起。\n最近输出：\n${lastLines || "（无输出）"}\n` +
					`请用 terminal_read(terminalId="${terminalId}") 查看/搜索它的当前状态；` +
					`若在等交互就用 terminal_input / terminal_key 回应；确认不再需要就 terminal_close 关掉它。）`,
			)
			.catch(() => {
				// best effort —— 注入失败不影响终端本身
			});
	}

	/**
	 * 终端接管的 bash 静默转后台后的完成通知：命令真正结束时主动告诉 AI。
	 * 流式中 → sendUserMessage（steer，立即唤醒处理）；空闲时 → sendCustomMessage
	 * nextTurn 排队（不唤醒 agent、不耗 token，下次对话自动带上）。
	 */
	private notifyTerminalBashDone(
		terminals: TerminalManager,
		info: { terminalId: string; command: string; exitCode: number | null },
	): void {
		const conv = [...this.convs.values()].find((c) => c.terminals === terminals);
		if (!conv || this.disposed) return;
		let tail = "";
		try {
			const end = terminals.endCursor(info.terminalId);
			if (end !== null) {
				tail = terminals.read(info.terminalId, Math.max(0, end - 4000))?.data ?? "";
			}
		} catch {
			// 终端可能已被关闭
		}
		const exitText = info.exitCode === null ? "终端已关闭" : `退出码 ${info.exitCode}`;
		const cmdShort = info.command.length > 120 ? `${info.command.slice(0, 120)}…` : info.command;
		const text =
			`（系统：你之前在终端 ${info.terminalId} 后台运行的命令已结束（${exitText}）：${cmdShort}\n` +
			`最后输出：\n${stripAnsi(tail).trim() || "（无输出）"}）`;
		const session = conv.runtime.session;
		if (session.isStreaming) {
			void session.sendUserMessage(text).catch(() => {});
		} else {
			// 空闲时不唤醒 agent——排队为 nextTurn 上下文，下次对话自动可见。
			void session
				.sendCustomMessage({
					customType: "terminal-bash-done",
					content: [{ type: "text", text }],
					display: true,
				})
				.catch(() => {});
		}
	}

	/** Reserve capacity before async creation/restoration; completed archives consume no slots. */
	private reserveSubagent(): () => void {
		const running = [...this.convs.values()].filter((c) => c.isSubagent && toSubagentSnapshot(c).streaming).length;
		if (running + this.pendingSubagentCreations >= SUBAGENT_CONCURRENCY) {
			throw new Error(
				`最多同时运行${SUBAGENT_CONCURRENCY}个子代理，请先等待或停止正在运行的任务；已归档结果不占名额。 / At most ${SUBAGENT_CONCURRENCY} subagents may run concurrently; wait or stop a running task.`,
			);
		}
		this.pendingSubagentCreations++;
		return () => {
			this.pendingSubagentCreations--;
		};
	}

	private async spawnSubagentConversation(
		prompt: string,
		type: string,
		cwd: string,
		apply?: SubagentTemplate,
		model?: string | null,
		parentId?: string,
	): Promise<string> {
		this.maintenance.reap();
		const release = this.reserveSubagent();
		try {
			return await this.createSubagentConversation(prompt, type, cwd, apply, model, parentId);
		} finally {
			release();
		}
	}

	private async createSubagentConversation(
		prompt: string,
		type: string,
		cwd: string,
		apply?: SubagentTemplate,
		model?: string | null,
		parentId?: string,
	): Promise<string> {
		const conversationId = `sa-${randomUUID().slice(0, 8)}`;
		const terminals = this.makeTerminalManager(conversationId, cwd);
		const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, apply, conversationId), {
			cwd,
			agentDir: this.agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const conv = this.makeConversation(runtime, conversationId, terminals);
		conv.isSubagent = true;
		conv.subagentTemplate = apply;
		conv.subagentStarting = true;
		// 父对话 = 真正派发它的会话（按会话归属的 host 包装填入）。直接用 active
		// 会错：后台对话运行时用户可能正看着别的项目对话，孩子会被记到无关
		// 对话名下、沉到别的项目组底部（issue #95）。缺省才回退到 active。
		conv.parentId = parentId ?? this.activeId ?? undefined;
		conv.subagentType = type;
		conv.listed = true;
		conv.title = subagentTitle(prompt);
		this.convs.set(conv.id, conv);
		// 子代理不走 bindSession——这里同样注入面板的重试次数覆盖。
		this.applyRetryOverrides();
		// 扩展绑定（rpc 模式；uiContext 只给无害的 mock theme/status 槽，避免与主对话
		// 的 widget 冲突。无 uiContext 时扩展的 ctx.ui.theme.fg 会打到 TUI 真 theme
		// 代理上抛 "Theme not initialized"，每个扩展一条 error toast。）
		try {
			await conv.session.bindExtensions({
				mode: "rpc",
				uiContext: {
					theme: mockThemeProxy,
					setStatus: () => {},
					setWidget: () => {},
					notify: () => {},
				} as never,
				onError: (err) => this.emit({ type: "notice", level: "error", text: err.error, textEn: err.error }),
			});
		} catch {
			// 绑定失败不阻断运行。
		}
		// 指定模型（显式 model 参数 → 模板 model → 设置面板默认）时，在首回合前
		// 给子代理会话换模型；全都不给 = 跟随主对话：把发起会话当前的模型也
		// 显式搬过来（新 runtime 的默认模型未必等于主对话刚选的模型）。
		const resolvedModel =
			model ?? (apply?.model?.trim() || null) ?? (this.settingsSvc.current.subagentDefaultModel || null);
		const followModel = resolvedModel
			? resolvedModel
			: this.session.model
				? `${this.session.model.provider}/${this.session.model.id}`
				: null;
		if (followModel) {
			const slash = followModel.indexOf("/");
			const m =
				slash > 0 && slash < followModel.length - 1
					? this.sharedModelRuntime?.getModel(followModel.slice(0, slash), followModel.slice(slash + 1))
					: undefined;
			if (m) {
				try {
					// 先恢复该 provider 的项目密钥（setModel 的鉴权检查要用），再换模型。
					await this.restoreKeyForModel(followModel, cwd);
					await conv.session.setModel(m);
				} catch (err) {
					// 换模型失败不阻断运行——沿用默认模型继续。
					this.emit({
						type: "notice",
						level: "warning",
						text: `子代理模型切换失败（将按默认模型运行）：${followModel}（${(err as Error).message}）`,
						textEn: `Failed to set subagent model, running with default: ${followModel} (${(err as Error).message})`,
					});
				}
			} else {
				this.emit({
					type: "notice",
					level: "warning",
					text: `子代理模型不存在，将按默认模型运行：${followModel}`,
					textEn: `Subagent model not found, running with default: ${followModel}`,
				});
			}
		}
		// 触发回合（后台执行；失败转识为通知）。
		void this.sendSubagentPrompt(conv, prompt).catch((err) => {
			this.emit({
				type: "notice",
				level: "error",
				text: `子代理 ${conversationId} 启动失败: ${err instanceof Error ? err.message : String(err)}`,
				textEn: `Subagent ${conversationId} failed to start: ${err instanceof Error ? err.message : String(err)}`,
			});
		});
		this.emitConversations();
		return conv.id;
	}

	private async sendSubagentPrompt(conv: Conversation, message: string): Promise<void> {
		conv.subagentPending = (conv.subagentPending ?? 0) + 1;
		conv.subagentStarting = false;
		conv.subagentError = undefined;
		try {
			await conv.session.sendUserMessage(message, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
		} catch (error) {
			conv.subagentError = error instanceof Error ? error.message : "Subagent failed";
			throw error;
		} finally {
			conv.subagentPending--;
			this.maintenance.schedule();
		}
	}

	private async restoreSubagent(record: ArchivedSubagent): Promise<Conversation> {
		const sessionManager = SessionManager.inMemory(record.cwd, { id: record.header.id }, record.entries);
		if (record.leafId === null) sessionManager.resetLeaf();
		else if (record.leafId !== undefined) sessionManager.branch(record.leafId);
		const terminals = this.makeTerminalManager(record.id, record.cwd);
		const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, record.template, record.id), {
			cwd: record.cwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		try {
			const conv = this.makeConversation(runtime, record.id, terminals);
			Object.assign(conv, {
				isSubagent: true,
				subagentStarting: true,
				subagentTemplate: record.template,
				parentId:
					record.parentId &&
					record.parentSessionId &&
					this.convs.get(record.parentId)?.session.sessionId === record.parentSessionId
						? record.parentId
						: undefined,
				subagentType: record.snapshot.type,
				title: record.snapshot.title,
				createdAt: record.createdAt,
				listed: true,
			});
			if (record.model) {
				const model = runtime.services.modelRuntime.getModel(record.model.provider, record.model.id);
				if (model) await conv.session.setModel(model);
			}
			await conv.session.bindExtensions({
				mode: "rpc",
				uiContext: {
					theme: mockThemeProxy,
					setStatus: () => {},
					setWidget: () => {},
					notify: () => {},
				} as never,
			});
			return conv;
		} catch (error) {
			terminals.killAll();
			await runtime.dispose();
			throw error;
		}
	}

	private getSubagentSnapshot(convId: string): SubagentSnapshot | undefined {
		const conv = this.convs.get(convId);
		return conv?.isSubagent ? toSubagentSnapshot(conv) : this.maintenance.archive.read(convId)?.snapshot;
	}

	private listSubagentSnapshots(): SubagentSnapshot[] {
		const records = new Map(this.maintenance.archive.list().map((s) => [s.convId, s]));
		for (const conv of this.convs.values()) if (conv.isSubagent) records.set(conv.id, toSubagentSnapshot(conv));
		return [...records.values()];
	}

	private emitTerminal(conversationId: string, msg: ServerMessage): void {
		// Background conversations keep collecting output in their own PTY buffer.
		// Do not stream it into the active xterm; push the retained window on switch.
		if (msg.type === "terminal_output" && conversationId !== this.activeId) return;
		if (msg.type === "terminal_output" || msg.type === "terminal_exit" || msg.type === "terminal_list") {
			this.emit({ ...msg, conversationId } as ServerMessage);
			return;
		}
		this.emit(msg);
	}

	private pushTerminals(conversation = this.conv): void {
		this.emit({
			type: "terminal_list",
			conversationId: conversation.id,
			terminals: conversation.terminals.list(),
		});
		for (const output of conversation.terminals.replay()) {
			this.emit({
				type: "terminal_output",
				conversationId: conversation.id,
				terminalId: output.terminalId,
				data: output.data,
			});
		}
	}

	/**
	 * Vision-bridge transcript cache (batch hash → text). A re-sent / re-asked
	 * prompt with the same images skips the vision API call entirely — editing
	 * a question doesn't re-burn tokens on re-transcribing identical screenshots.
	 */

	/** SYSTEM.md 文件内容（最近一次 loader reload 观察到的 base；组合模板下仅作
	 *  {{soul}} 自动内容，SDK 默认分支不受影响）。非空 = 用户有系统提示词文件。 */
	private lastBaseSystemPrompt = "";

	/** SDK APPEND_SYSTEM.md 内容（appendSystemPromptOverride 收到的 base）——
	 *  composer 的 {{append}} 自动内容。仅主会话（无模板）记录。 */
	private lastSdkAppendFiles: string[] = [];

	/** 当前活动会话的工具/资源快照 → composer 输入。cwd 取活动对话的。 */
	private composeInputs(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
	}): PromptComposerInputs {
		return {
			cwd: src.cwd,
			systemPromptFile: this.lastBaseSystemPrompt || undefined,
			builtinSoul: BUILTIN_SOUL,
			selectedTools: src.selectedTools,
			toolSnippets: src.toolSnippets,
			toolGuidelines: src.toolGuidelines,
			piReadme: PI_DOC_PATHS.readme,
			piDocs: PI_DOC_PATHS.docs,
			piExamples: PI_DOC_PATHS.examples,
			appendFiles: this.lastSdkAppendFiles,
			windowsPersona: process.platform === "win32" ? WINDOWS_PERSONA : "",
			terminalGuidance: this.settingsSvc.current.terminalToolsEnabled !== false ? TERMINAL_TOOLS_GUIDANCE : "",
			markersGuidance: this.markerSvc.buildGuidance(),
			// issue #91：组合模板各来源段按客户端 UI 语言渲染（英文默认）。
			lang: this.getLang(),
			contextFiles: src.contextFiles,
			skills: src.skills,
		};
	}

	/** 渲染当前组合模板。模板为空且无任何覆盖时返回 undefined（用 SDK 默认拼装，
	 *  零开销且与原始行为逐字节一致）。 */
	private renderMainCompose(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
	}): string | undefined {
		const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
		const ovs = this.settingsSvc.current.promptOverrides ?? {};
		const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
		if (!tpl && !hasOverride) return undefined;
		const texts = resolveSectionTexts(this.composeInputs(src));
		return renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, ovs);
	}

	/** 从活动会话收集工具/资源快照 → 一次算出 ①各来源默认(自动)内容 ②实际生效的
	 *  完整提示词。会话未就绪（或出错）返回 undefined，调用方给空值。 */
	private sessionPromptSnapshot():
		| {
				texts: Record<string, string>;
				full: string;
				toolsSchema: string;
		  }
		| undefined {
		try {
			const sess = this.session;
			if (!sess) return undefined;
			const cwd = this.conv?.cwd ?? this.cwd;
			const active = sess.getActiveToolNames();
			const snippets: Record<string, string> = {};
			const guidelines: string[] = [];
			const schemaEntries: import("./prompt-composer.js").ToolSchemaEntry[] = [];
			for (const name of active) {
				const def = sess.getToolDefinition(name);
				if (!def) continue;
				// @BUGFIX 2026-09-13：SDK 只把「有 promptSnippet 的工具」写进系统提示的
				// `Available tools:`（system-prompt.js: visibleTools = tools.filter(name => !!toolSnippets[name])）。
				// 没有 snippet 的工具因此**在提示词里完全隐形**，而它实际是可调用的——
				// 结果就是模型真诚地声称「我没有文件系统或终端工具」（实测 gpt-6-astra 在
				// /home/dev/project/fayu 会话里连着两次这么答，紧接着的下一轮又正常调了
				// read/read/bash）。这里给缺 snippet 的工具用它的 description 兑底，
				// 保证「能调用的工具」一定在提示里可见。
				const snippet = def.promptSnippet?.trim() || def.description?.trim();
				if (snippet) snippets[name] = snippet;
				if (def.promptGuidelines) guidelines.push(...def.promptGuidelines);
				schemaEntries.push({
					name,
					description: def.description,
					parameters: def.parameters,
				});
			}
			const loader = sess.resourceLoader;
			const texts = resolveSectionTexts(
				this.composeInputs({
					cwd,
					selectedTools: active,
					toolSnippets: snippets,
					toolGuidelines: guidelines,
					contextFiles: loader.getAgentsFiles().agentsFiles,
					skills: loader.getSkills().skills.map((s) => ({
						name: s.name,
						description: s.description ?? "",
						filePath: (s as { filePath?: string }).filePath ?? "",
					})),
				}),
			);
			// 模板/覆盖渲染（无则保持 SDK 默认拼装，与 renderMainCompose 同规则）。
			const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
			const ovs = this.settingsSvc.current.promptOverrides ?? {};
			const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
			const rendered =
				!tpl && !hasOverride ? undefined : renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, ovs);
			return { texts, full: rendered ?? sess.systemPrompt, toolsSchema: buildToolsSchemaText(schemaEntries) };
		} catch {
			// Session not ready yet.
			return undefined;
		}
	}

	/** 设置面板预览用的 host 回调（见 SettingsHost.promptSnapshot）：完整生效提示词
	 *  + 各来源默认（自动）内容。会话未就绪时给空值，面板保持可编辑但不预览。 */
	private promptSnapshot(): { full: string; texts: Record<string, string>; toolsSchema: string } {
		return this.sessionPromptSnapshot() ?? { full: "", texts: {}, toolsSchema: "" };
	}

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext((msg) => this.emit(msg));

	/**
	 * 第一方子代理 host（见 subagents.ts 设计头注）。子代理 = 一个标记
	 * isSubagent 的普通 Conversation：inMemory runtime（不落盘、不进
	 * 历史/resume 列表）、listed=true 出现在左栏「运行的对话」并向用户可见——
	 * 切换查看 / 输入补充（steer）/ 中止（abort）/ 移出全部复用现有对话机制。
	 */
	private subagentHost: SubagentToolHost = {
		spawnSubagent: (prompt, type, cwd, templateName, model, parentId) => {
			// 模板：存在且启用时应用；传了名字但不可用 → 抛错让工具转给 AI。
			const tpl = templateName ? this.subagentTemplates.get(templateName) : undefined;
			if (templateName && (!tpl || !tpl.enabled)) {
				throw new Error(
					pick(
						this.getLang(),
						`子代理模板不可用：${templateName}（不存在或已停用）`,
						`Subagent template unavailable: ${templateName} (missing or disabled)`,
						"agent.subagent.template.unavailable",
						{ templateName: templateName },
					),
				);
			}
			// 模型优先级：显式 model 参数 > 模板自带模型 > 设置面板默认模型；都不给 = 跟随主对话。
			return this.spawnSubagentConversation(prompt, type, cwd, tpl, model, parentId);
		},
		getSubagent: (convId) => this.getSubagentSnapshot(convId),
		listSubagents: () => this.listSubagentSnapshots(),
		steerSubagent: async (convId, message) => {
			const live = this.convs.get(convId);
			const release = live?.isSubagent && toSubagentSnapshot(live).streaming ? () => {} : this.reserveSubagent();
			let completion: Promise<void>;
			try {
				const conv = await this.maintenance.restore(convId);
				if (!conv?.isSubagent) throw new Error("Subagent not found");
				completion = this.sendSubagentPrompt(conv, message);
				this.emitConversations();
			} finally {
				release();
			}
			await completion;
		},
		stopSubagent: async (convId) => {
			const conv = this.convs.get(convId);
			if (conv && (conv.session.isStreaming || !conv.session.isIdle)) {
				await this.interruptRun(
					conv,
					pick(this.getLang(), "用户停止子代理", "User stopped the subagent", "agent.subagent.stop.user"),
				);
			}
		},
		// issue #91：子代理工具返回按客户端 UI 语言出中英（英文默认）。
		lang: () => this.getLang(),
		// 只向 AI 暴露 enabled 的模板（停用的对 AI 不可见）。
		listTemplates: () =>
			this.subagentTemplates
				.list()
				.filter((t) => t.enabled)
				.map((t) => ({ name: t.name, description: t.description, descriptionEn: t.descriptionEn, model: t.model })),
		isTemplateUsable: (name) => {
			const t = this.subagentTemplates.get(name);
			return !!t && t.enabled;
		},
	};
	private widgetsTimer: ReturnType<typeof setInterval> | null = null;
	/** P4 运维：资源告警周期定时器（unref；随会话释放）。 */
	private alertTimer: ReturnType<typeof setInterval> | null = null;
	/** Model-stall watchdog interval (see startStallTimer). */
	private stallTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timestamp of the most recent message_delta push — while fresh, snapshots
	 *  use the slower STREAMING_SNAPSHOT_INTERVAL_MS cadence. */
	private lastDeltaAt = 0;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	/** Snapshot revision counter (see emitSnapshotNow / protocol snapshot_delta). */
	private snapRev = 0;
	/** Messages array as of the last emitted snapshot/delta — identity-walked
	 *  against the current array to detect append-only growth. */
	private emittedMessages: UiMessage[] | null = null;
	/** Conversation whose messages emittedMessages belongs to. A conversation
	 *  switch (set_cwd / new_chat / switch_*) must fall back to a FULL snapshot:
	 *  two empty conversations have identical (empty) arrays, so the identity
	 *  walk alone would misread the switch as "nothing changed" → delta. */
	private emittedConvId: string | null = null;
	/** snapRev value at which emittedMessages was captured. */
	private emittedRev = 0;
	/** Opt-in phase trace for the connection/switch currently being served
	 *  (see timing.ts). Set by attach(); snapshot build costs land on it. */
	timing?: TimingTrace;
	/** In-flight disk catch-up reload (see syncActiveFromDiskIfStale). */
	private diskSync: Promise<void> | null = null;
	/**
	 * Per-conversation serialization caches (stable message ids, UiMessage
	 * object cache, message-array signature, queue counts) live inside each
	 * Conversation — see Conversation above.
	 */
	private disposed = false;
	/** pi-config readiness check, cached briefly so 60ms snapshots don't hit disk. */
	private piCheckCache: { at: number; configured: boolean } | null = null;

	/** fs.watch on the currently-listed directory — file changes push an instant
	 *  refresh (`file_changed`) so the tree updates without waiting for the 10s
	 *  poll. Only the listed directory is watched (one level); navigating
	 *  re-watches the new target. fs.watch isn't available on every platform /
	 *  filesystem — failures silently fall back to the poll. */
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	/** fs.watch on the active repo's git dir — external changes (CLI commit,
	 *  IDE branch switch) push `scm_changed` so the panel refreshes itself.
	 *  One watcher per client session, re-targeted when the queried cwd
	 *  changes; failures (bare repo, unsupported fs) silently disable it. */
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;

	/** 子代理模板库（全局共享，<dataDir>/subagent-templates.json）。 */
	private readonly subagentTemplates: SubagentTemplatesStore;
	/** 内置标记服务（todo/notify/svc/rename 等，可全局/分组开关）。 */
	private readonly markerSvc: MarkerService;

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎的 ask_user_question customTool）：与 DSH 引擎的
	// question_pending/question_answer 同协议。模型调 ask_user_question 工具 →
	// 本桥发 question_pending 给浏览器 → 等 question_answer → resolve/reject
	// 工具结果（agent 循环阻塞）。一次只展示一个提问（agent 阻塞在工具执行）。
	// -----------------------------------------------------------------------
	private questionSeq = 0;
	private pendingQuestions = new Map<string, (value: QuestionAnswer[] | null) => void>();

	private constructor(clientId: string, cwd: string, agentDir: string, stateStore: ClientStateStore) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		this.maintenance = new ConversationMaintenance(new SubagentArchive(stateStore.dataDir, clientId), {
			conversations: () => this.convs,
			activeId: () => this.activeId,
			drop: (id) => this.removeConversation(id),
			changed: () => {
				this.emitConversations();
				this.flushSnapshot();
			},
			warn: () =>
				this.emit({
					type: "notice",
					level: "warning",
					text: "会话归档失败，已保留运行时和结果，请检查数据目录。",
					textEn: "Conversation archive failed; runtime and results were retained. Check the data directory.",
				}),
			restore: (record) => this.restoreSubagent(record),
		});
		this.subagentTemplates = new SubagentTemplatesStore(join(stateStore.dataDir, "subagent-templates.json"));
		this.markerSvc = new MarkerService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			isDisposed: () => this.disposed,
			getActiveConversationId: () => this.activeId,
			getSessionManager: (id) => {
				const c = this.convs.get(id);
				return c
					? (c.session.sessionManager as unknown as {
							getBranch: () => unknown[];
							appendCustomEntry?: (t: string, d: unknown) => unknown;
						})
					: undefined;
			},
			renameConversation: (convId, title) => {
				// 复用现有重命名路径（内存标题 + 磁盘 session_info）
				void this.renameConversation(convId, title);
			},
			// 标记 widget 合并进扩展 widget 里，跟随当前活动会话渲染（切换会话即刷新）。
			refreshMarkers: () => this.webUi.refresh(),
			// issue #91：标记引导/错误按客户端 UI 语言出中英（英文默认）。
			lang: () => this.getLang(),
		});
		// 标记 widget 动态渲染「当前活动会话」的 todo/overlay：切换会话时只要刷新
		// webUi（见 switchConversation/setCwd/newChat）就会显示对应会话的标记，
		// 且与扩展 widget 合并下发、不会互相覆盖。
		this.webUi.setDynamicWidget("markers", () => this.markerSvc.overlayLines(this.activeId));
		this.settingsSvc = new SettingsService(
			{
				clientId,
				stateStore,
				emit: (msg) => this.emit(msg),
				flushSnapshot: () => this.flushSnapshot(),
				isDisposed: () => this.disposed,
				getSession: () => this.session,
				cwd: () => this.cwd,
				agentDir: () => this.agentDir,
				isStreaming: () => this.session.isStreaming,
				reloadSession: async () => {
					await this.session.reload();
					// reload() 重读磁盘 settings.json，会丢掉内存 applyOverrides
					// （含重试次数覆盖）——依次重放：重试覆盖 → 终端门控。
					this.applyRetryOverrides();
					// reload() 会把 custom 工具重新加回活跃集——重放终端开关。
					this.applyToolGating(this.session);
					await this.pushSlashCommands();
				},
				applyRetryOverrides: () => this.applyRetryOverrides(),
				promptSnapshot: () => this.promptSnapshot(),
				getMarkerState: () => ({
					markersEnabled: this.markerSvc.current.markersEnabled,
					disabledMarkers: [...this.markerSvc.current.disabledMarkers],
					markers: this.markerSvc.listForUi(),
				}),
			},
			this.subagentTemplates,
		);
		this.goalSvc = new GoalService({
			clientId,
			agentDir,
			stateStore,
			webUi: this.webUi,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			quiesceBlocked: () => this.quiesceBlocked(),
			// issue #91：目标/审查文案按客户端 UI 语言出中英（英文默认）。
			lang: () => this.getLang(),
			// 目标模式总开关（设置面板「目标审查」页）：关 → 目标入口一律拒绝。
			goalModeEnabled: () => this.settingsSvc.current.goalModeEnabled !== false,
			// DEV-CON §7：复核/调研用独立 ModelRuntime，用量单独标注来源并归到发起它的对话。
			recordUsage: (source, usage) => {
				const conv = this.conv;
				this.recordUsage(conv, { scope: "final", identity: null, role: "assistant", ...usage }, this.bindingAttribution(conv, source));
			},
			activeConvId: () => this.activeId,
			activeConv: () => this.conv,
			getConv: (id) => this.convs.get(id),
			cwd: () => this.cwd,
			reviewSettings: () => this.settingsSvc.reviewPrefs,
			gitDiff: (dir) => this.gitDiff(dir),
		});

		this.modelAdmin = new ModelAdminService({
			agentDir,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			modelRuntime: () => this.runtime.services.modelRuntime,
			// 「谁是网关」的第一优先级：正在被调用的那个入口最没有歧义
			// （见 dev-con/gateway-config.ts 的 resolveGatewayProviderId）。
			activeProvider: () => this.session.agent.state.model?.provider ?? null,
			invalidatePiConfig: () => {
				this.piCheckCache = null;
			},
			// 目录变了要推给**所有**会话：每个会话有自己的 runtime 快照，只 emit 给当前会话
			// 会让别的标签页停在旧目录（见 onModelCatalogChanged）。
			pushModels: async () => {
				await this.listModels();
				this.onModelCatalogChanged?.();
			},
		});
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
		// P4 运维：资源与网关失败告警周期检查（默认 60 秒，见 OPS_ALERT_CHECK_MS；
		// unref 不阻止退出；开关与冷却见 checkResourceAlerts / checkFailureAlerts）。
		this.alertTimer = setInterval(() => {
			this.checkResourceAlerts();
			this.checkFailureAlerts();
		}, OPS_ALERT_CHECK_MS);
		this.alertTimer.unref?.();
		// 网关用量（NewAPI 一类）：只读网关自己的账单接口，地址/密钥都用**本会话** runtime 解析。
		this.gatewayUsage = new GatewayUsageService({
			providerBaseUrl: (providerId) => this.providerBaseUrlOf(providerId),
			providerName: (providerId) => this.providerNameOf(providerId),
			resolveProviderKey: (providerId) => this.resolveProviderKey(providerId),
			providerIds: () => this.providerIds(),
		});
		// Jev 门禁：配置在装配时读一次（损坏则回落默认值 + parseError，不阻塞启动）；
		// cachePath = 磁盘持久决策缓存（派生、可丢：删了只损失一次调用费用，见 jev-cache.ts）。
		// samplesPath = 真实调用后的样本（被审内容截断落盘，供一周后复盘校准，见 jev-samples.ts）。
		this.jev = new JevGate({
			config: loadJevSettings(agentDir).config,
			cachePath: jevCachePath(agentDir),
			samplesPath: jevSamplesPath(agentDir),
		});
		this.usageHistory = new UsageHistoryStore(join(agentDir, "dev-con", "usage-history.jsonl"));
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
		trace?: TimingTrace,
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		cs.timing = trace;
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		const runtime = await createAgentSessionRuntime(cs.makeRuntimeFactory(terminals, undefined, conversationId), {
			cwd,
			agentDir,
			// Resume the most recent session for this project — the SDK default
			// per-project dir (<agentDir>/sessions/--<cwd>--/, shared with the
			// pi CLI/TUI) — or start a fresh one on first visit.
			sessionManager: SessionManager.continueRecent(cwd),
		});
		// First conversation = the resumed session; it also seeds the shared
		// ModelRuntime that every later conversation reuses.
		cs.sharedModelRuntime = runtime.services.modelRuntime;
		// 目录自愈的基准：runtime 构造时就已读过一次 models.json（见 model-catalog-freshness.ts）。
		cs.modelsConfigStamp = modelConfigStamp(modelsConfigPathOf(agentDir));
		const conv = cs.makeConversation(runtime, conversationId, terminals);
		cs.convs.set(conv.id, conv);
		cs.activeId = conv.id;
		for (const d of runtime.diagnostics) {
			if (d.type !== "info") {
				cs.pendingNotices.push({
					type: "notice",
					level: d.type,
					text: d.message,
					textEn: d.message,
				});
			}
		}
		// Instrumented phases only (no behaviour change): these four awaits are the
		// whole cold-start critical path before the first snapshot can be built.
		trace?.mark("runtime");
		await traceStep(trace, "bind", () => cs.bindSession());
		await traceStep(trace, "keys", () => cs.restoreProjectProviderKeysForCwd(cwd));
		await traceStep(trace, "model", () => cs.restoreProjectModelForCwd(cwd));
		return cs;
	}

	/**
	 * Factory for cwd-bound runtimes. All conversations share ONE ModelRuntime
	 * (the model choice is client-wide), so later conversations reuse the
	 * instance created with the first one.
	 *
	 * `apply`（可选）：子代理模板 —— 会话的 system prompt / 技能 / 扩展按模板
	 * 应用（prompt replace/append + 白名单），其余（终端接管、Windows persona
	 * 等）仍跟随主会话设置。undefined = 按主会话设置（普通对话/不选模板的子代理）。
	 */
	private makeRuntimeFactory(
		terminals: TerminalManager,
		apply?: SubagentTemplate,
		ownerId?: string,
	): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			// 自动压缩阈值走系统级策略（见 context-policy.ts，形状与默认值对齐 Codex）：
			// SDK 判据是 contextTokens > contextWindow - reserveTokens，而 settings.json 里只有
			// 一份全局 reserveTokens；本进程跨渠道/模型（窗口 20 万 ~ 105 万），必须按「当前
			// 活跃模型」实时换算。默认无绝对上限 → 有效窗口 = 窗口 × 95%；想复现业界实跑预算
			// 就在 <agentDir>/context-policy.json 写 autoCompactTokenLimit（Codex 同族模型 = 258400）。
			// liveContextWindow 在下面 session 建好后指向该 session 的活 model——渠道热切换
			// 换模型后无需重建 runtime，阈值自动跟着新窗口走。
			let liveModel: () => { provider?: string; id?: string; contextWindow?: number } | undefined = () => undefined;
			const loadContextPolicy = this.contextPolicyLoader();
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				modelRuntime: this.sharedModelRuntime,
				// 设置面板钩子（官方 SDK 的 resourceLoader overrides）：三个 override
				// 在每次 resourceLoader.reload() 时重放，且读取 this.settings 的当前
				// 值——因此 session.reload() 即可让系统提示词 / 技能 / 插件开关生效，
				// 新对话（新 runtime）也会自动带上当前设置。
				// 子代理带模板（apply）时：prompt/skills/extensions 改读模板视图——
				// replace 模式：无 SYSTEM.md 时把灵魂段替换为模板提示词（见下方
				// pi-webui-persona 内联扩展）；有 SYSTEM.md 时仍由 systemPromptOverride
				// 整体替换 base。append 模式把模板提示词追加到
				// 末尾（此时主会话的自定义 prompt 不再叠加，角色由模板定义）；非空
				// 白名单取代主会话开关（只启用这些），空白名单 = 跟随主会话。
				resourceLoaderOptions: {
					// 系统提示词 base：主会话（组合模板）恒返回 undefined → SDK 走默认分支，
					// 工具列表/Guidelines/文档指引等自动段照常拼装；SYSTEM.md 内容仅在
					// 此处捕获（lastBaseSystemPrompt）作 {{soul}} 自动内容。子代理模板
					// replace 在存在 SYSTEM.md base 时整体替换该 base。
					systemPromptOverride: (base?: string) => {
						if (typeof base === "string" && base) {
							this.lastBaseSystemPrompt = base;
							if (apply && apply.promptMode === "replace" && pickTemplatePrompt(apply, this.getLang()).trim()) {
								return pickTemplatePrompt(apply, this.getLang());
							}
						}
						return undefined;
					},
					appendSystemPromptOverride: (base: string[]) => {
						// 记录 SDK APPEND_SYSTEM.md base（composer {{append}} 自动内容）。
						if (!apply) this.lastSdkAppendFiles = base.slice();
						const out = [...base];
						if (apply && apply.promptMode === "append" && pickTemplatePrompt(apply, this.getLang()).trim()) {
							out.push(pickTemplatePrompt(apply, this.getLang()));
						}
						// 主会话自定义「追加」已并入组合模板的 {{append}} 覆盖，不再在此注入。
						if (process.platform === "win32") {
							// Windows 专属 persona：bash 工具跑 Git Bash 且无默认超时、终端
							// 是交互式 TTY——注入约束避免 heredoc/交互/长驻命令挂死整个会话；
							// GBK 老中文文件让模型改用终端按正确编码读（iconv/chcp/Get-Content）。
							out.push(WINDOWS_PERSONA);
						}
						if (this.settingsSvc.current.terminalToolsEnabled !== false) {
							// 终端工具使用引导（全平台）：告诉模型什么场景该用持久终端
							// 而不是一次性 bash——没有这段模型几乎从不主动选终端工具。
							out.push(TERMINAL_TOOLS_GUIDANCE);
						}
						// bash 管道限制已并入 bash 工具自身的 description，不再作为独立提示段注入。
						// 内置标记工具引导（按总开关/分组开关过滤）
						const markerGuidance = this.markerSvc.buildGuidance();
						if (markerGuidance) out.push(markerGuidance);
						return out;
					},
					// 技能：模板非空白名单时只启用白名单里的；否则按主会话禁用集过滤。
					skillsOverride: (res) => {
						if (apply && apply.enabledSkills.length > 0) {
							const set = new Set(apply.enabledSkills);
							return { ...res, skills: res.skills.filter((s) => set.has(s.name)) };
						}
						return {
							...res,
							skills: res.skills.filter((s) => !this.settingsSvc.current.disabledSkills.includes(s.name)),
						};
					},
					// 插件：模板非空扩展白名单时只加载白名单里的；否则按主会话禁用集过滤。
					// 注意 SDK 在 extensionsOverride 之后才补 sourceInfo，包扩展此处只能靠路径
					// 匹配 —— isExtensionDisabled / isExtensionEnabled 同时比对 npm:<pkg> 候选键。
					extensionsOverride: (res) => {
						// 自家内联扩展（灵魂替换）是基础设施，不参与白名单/禁用过滤。
						const keepOwn = (e: { path: string }) => !e.path.startsWith(INLINE_PERSONA_EXT);
						if (apply && apply.enabledExtensions.length > 0) {
							const set = new Set(apply.enabledExtensions);
							return {
								...res,
								extensions: res.extensions.filter((e) => keepOwn(e) || isExtensionEnabled(e, [...set])),
							};
						}
						return {
							...res,
							extensions: res.extensions.filter(
								(e) => keepOwn(e) || !isExtensionDisabled(e, this.settingsSvc.current.disabledExtensions),
							),
						};
					},
					// 组合模板渲染（主会话）+ 模板灵魂替换（子代理）：before_agent_start 在每个
					// agent run 前触发，SDK 此时已用最新工具/资源拼好基础提示词；若配置了模板或
					// 覆盖，则用 composer 把 {{token}} 展开为各来源文本（工具列表/项目上下文/技能
					// 等都取自本次 run 的 systemPromptOptions，永远最新）。
					extensionFactories: [
						{
							name: "pi-webui-persona",
							hidden: true,
							factory: (pi) => {
								pi.on("before_agent_start", (event) => {
									// 子代理模板 replace（无 SYSTEM.md 时）：默认分支拼好的提示词里
									// 把灵魂段换成模板提示词，自动段保留；SYSTEM.md 情形已在
									// systemPromptOverride 整体替换，此处边界不存在会自然跳过。
									if (apply) {
										if (apply.promptMode !== "replace" || !pickTemplatePrompt(apply, this.getLang()).trim())
											return undefined;
										const boundary = event.systemPrompt.indexOf("\n\nAvailable tools:");
										if (boundary === -1) return undefined;
										const swapped =
											pickTemplatePrompt(apply, this.getLang()).trimEnd() + event.systemPrompt.slice(boundary);
										return swapped === event.systemPrompt ? undefined : { systemPrompt: swapped };
									}
									// 主会话：组合模板渲染（模板为空且无覆盖时返回 undefined = 用 SDK 默认）。
									const opts = event.systemPromptOptions as
										| {
												cwd?: string;
												selectedTools?: string[];
												toolSnippets?: Record<string, string>;
												promptGuidelines?: string[];
												contextFiles?: { path: string; content: string }[];
												skills?: { name: string; description?: string; filePath?: string }[];
										  }
										| undefined;
									const rendered = this.renderMainCompose({
										cwd: typeof opts?.cwd === "string" ? opts.cwd : this.cwd,
										selectedTools: opts?.selectedTools ?? [],
										toolSnippets: opts?.toolSnippets ?? {},
										toolGuidelines: opts?.promptGuidelines ?? [],
										contextFiles: opts?.contextFiles ?? [],
										skills: (opts?.skills ?? []).map((s) => ({
											name: s.name,
											description: s.description ?? "",
											filePath: s.filePath ?? "",
										})),
									});
									return rendered ? { systemPrompt: rendered } : undefined;
								});
							},
						},
					],
				},
			});
			const baseReserveTokens = services.settingsManager.getCompactionReserveTokens.bind(services.settingsManager);
			const baseKeepRecentTokens = services.settingsManager.getCompactionKeepRecentTokens.bind(services.settingsManager);
			// 每次调用都重新让策略加载器取一次（内部按 mtime 缓存）——改 context-policy.json
			// 无需重启，下一个请求就生效。
			services.settingsManager.getCompactionReserveTokens = () =>
				resolveContextBudget(liveModel()?.contextWindow, loadContextPolicy(), modelKeyOf(liveModel()))?.reserveTokens ??
				baseReserveTokens();
			// 策略可选地接管「压缩后保留最近原文」的 token 预算（null = 跟随 settings.json）。
			services.settingsManager.getCompactionKeepRecentTokens = () => loadContextPolicy().keepRecentTokens ?? baseKeepRecentTokens();
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				// 覆盖 SDK 内置 bash（customTools 按 name 覆盖）。双实现分流：
				// 「默认 bash 覆盖」开关（terminalBash）关 → 原生 SDK bash（纯进程、不开终端）；
				// 开 → 终端接管 bash（persist 决定一次性/持久，可静默自动转后台）。
				customTools: [
					makeAdaptiveBashTool(
						makeKillableBashTool(effectiveCwd, this.bashKills),
						makeTerminalBashTool(terminals, {
							cwd: effectiveCwd,
							// 设置开 = 用终端；此分支里 persist 未显式给时默认一次性（false）。
							defaultPersist: () => false,
							idleMs: () => Math.max(0, Math.floor(this.settingsSvc.current.terminalBashIdleMs) || 0),
							kills: this.bashKills,
							notifyBackgroundDone: (info) => this.notifyTerminalBashDone(terminals, info),
							// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
							lang: () => this.getLang(),
						}),
						// 设置关 → 原生 bash；开 → 终端 bash。
						() => this.settingsSvc.current.terminalBash,
					),
					...makePersistentTerminalTools(terminals, effectiveCwd, () => this.getLang()),
					// 不覆盖内置 edit 的独立宽松编辑工具（缩进不敏感匹配；开关看设置）。
					makeEditSoftTool(effectiveCwd, () => this.getLang()),
					// 插件注册的 AI 工具（创建时刻的实时快照；后续注册经
					// refreshPluginTools 动态补入已有会话）。
					...(this.pluginToolsProvider?.() ?? []).map(pluginToolToDefinition),
					// 第一方子代理工具（spawn/get_result/steer/list/stop）。子代理会话
					// 也注册了它们，因此可自然嵌套派发。host 按 ownerId 包装：子代理的
					// 父对话 = 真正调用 spawn 的那个会话（本 runtime 所属会话），而不是
					// 派发瞬间的 active——后台对话继续产出时用户可能已切到别的项目，用
					// activeId 会把孩子记到无关会话名下、沉到别的组/底部（issue #95）。
					// ownerId 即本 runtime 所属会话（创建时就已知，见各调用点）。
					...(ownerId
						? makeSubagentTools(withSubagentOwner(this.subagentHost, ownerId))
						: makeSubagentTools(this.subagentHost)),
					// 内置标记只读查询工具（todo/svc 状态查询，写操作走内联标记）。
					makeMarkersListTool(() => this.activeId, this.markerSvc),
					// 标准引擎的 ask_user_question：模型调用 → 浏览器富渲染问卷（复用 DSH
					// 的 question_pending/question_answer 协议，前端 DshQuestionDialog）。
					// DSH 引擎不经此（它走 goal-rpc 的 userQuestions provider）。
					makeAskUserQuestionTool(this),
					// DEV-CON Jev 门禁：让编码路径真的能问它（在此之前只有设置面板自检与 CLI，
					// 既不拦东西也攒不下真实分数，见 makeJevCheckTool 头部 @WHY）。
					makeJevCheckTool(this),
				],
			});
			// 会话已建好：把阈值数据源接到这个 session 的活模型上（setModel 后读到的就是新窗口）。
			liveModel = () => created.session.model;
			// 终端工具开关从创建起就生效（工具始终注册进注册表，只调活跃集）。
			this.applyToolGating(created.session);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Create independent goal state for one conversation. Preferences are
	 * client-wide defaults, while goal text/review progress is not shared. */
	private makeGoalStatus(): GoalStatus {
		return this.goalSvc.makeGoalStatus();
	}

	/** Allocate a stable conversation id before constructing its runtime/tools. */
	private nextConversationId(): string {
		return `c${++this.convSeq}`;
	}

	/** Wrap a fresh runtime as a new conversation record. */
	private makeConversation(runtime: AgentSessionRuntime, id: string, terminals: TerminalManager): Conversation {
		// 这里只挂一个观测钩子，**不返回自定义密钥**：凭据完全交给 SDK 的全局解析
		// （auth.json / runtime override / 环境变量），与本项目只对接单一网关的定位一致。
		// 钩子的用处是拿到「本次真正要调用的 provider + 当下模型」：
		//   - 用量归属（§7）：晚到的用量按请求发出时的实际服务商/模型记录；
		//   - 端点工具能力探测：网关静默丢弃 tools 时要告警一次（见 checkToolCapability）。
		runtime.session.agent.getApiKey = (provider: string) => {
			try {
				const model = runtime.session.agent.state.model;
				const modelRef = model ? `${model.provider}/${model.id}` : null;
				const conv = this.convs.get(id);
				if (conv) conv.lastRequestBinding = { providerId: provider, modelId: modelRef };
				if (modelRef) {
					void this.resolveProviderKey(provider)
						.then((key) => this.ensureToolCapability(provider, modelRef, key ?? undefined))
						.catch(() => undefined);
				}
			} catch {
				/* 观测失败绝不影响真实请求 */
			}
			return undefined;
		};
		return {
			id,
			title: conversationTitle(runtime.session),
			isSubagent: false,
			runtime,
			session: runtime.session,
			cwd: runtime.cwd,
			createdAt: Date.now(),
			// A brand-new conversation is not yet in the running list — it enters
			// only when it is displaced to the background while still streaming.
			listed: false,
			promptedSinceActive: false,
			lastActiveAt: Date.now(),
			historyOmitted: 0,
			historyExpanded: false,
			lastSdkEventAt: Date.now(),
			usageTracker: new TokenUsageTracker(),
			lastRequestBinding: null,
			lastPersistedUsageId: null,
			compactionBaseline: null,

			stallNoticed: false,
			goal: this.makeGoalStatus(),
			goalGeneration: 0,
			goalReviewGeneration: 0,
			wizardRunning: false,
			deltaSeq: 0,
			terminals,
			msgIds: new Map(),
			nextMsgId: 1,
			userSeqByTs: new Map(),
			uiMessageCache: new Map(),
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: [],
			queueFollowUp: [],
			toolStartTimes: new Map(),
			toolWatchdogs: new Map(),
		};
	}

	/** Summaries of conversations currently streaming — captured at shutdown
	 *  so the next attach can tell the user their run was interrupted. */
	streamingSummaries(): { title: string; cwd: string }[] {
		const out: { title: string; cwd: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.session.isStreaming) out.push({ title: conv.title, cwd: conv.cwd });
		}
		return out;
	}

	/** Tell the user about runs lost to the last server restart (once). */
	notifyInterrupted(list: { title: string; cwd: string; at: number }[] | undefined): void {
		if (!list || list.length === 0) return;
		const names = list.map((r) => `「${r.title}」（${r.cwd}）`).join("、");
		this.pendingNotices.push({
			type: "notice",
			level: "warning",
			text: `上次服务重启时有 ${list.length} 个进行中的对话被中断：${names}。可在历史对话中恢复继续。`,
			textEn: `${list.length} running conversation(s) were interrupted by the last restart: ${names}. Resume them from History.`,
		});
	}

	/** Add a socket to this client's broadcast set; flushes buffered startup notices. */
	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		// Replay current extension widgets (setWidget may have fired during
		// session creation, before any socket was attached).
		const widgets = this.webUi.snapshot();
		if (widgets.length > 0) send({ type: "widgets", widgets });
		const statuses = this.webUi.statusSnapshot();
		if (statuses.length > 0) send({ type: "statuses", statuses });
		// Reconnect: push the current project's running-conversation list so the
		// left panel shows every background chat (a fresh socket never got the
		// newChat/switch pushes).
		this.emitConversations();
		// Reconnect: same for the slash-command catalog (the picker needs it even
		// before the client asks).
		void this.pushSlashCommands();
		// Reconnect: push the remembered goal prefs (model choice, rounds cap,
		// locked) so the goal bar restores them on reload — "全局记忆".
		this.goalSvc.emitGoalStatus();
		// Reconnect: push the settings panel state (prompt text/mode, skill &
		// extension toggles, saved presets).
		this.pushSettings();
		// Reconnect: push the background-task list — it must survive reconnects
		// and outlive the conversation that started the tasks.
		this.bg.push();
		// Reconnect: push the built-in provider key list (multi-key grouping in the
		// model picker needs it even before the client asks).
		this.modelAdmin.listProviderKeys();
		// PTYs are conversation-owned and survive a socket reconnect.
		this.pushTerminals();
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// PTYs intentionally survive a socket drop: they are owned by the
		// conversation and can be inspected after reconnecting. Only conversation
		// disposal or server shutdown kills them.
		if (this.sinks.size === 0) {
			this.files.unwatchDir();
		}
	}

	/** Broadcast to every connected socket of this client. */
	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const sink of [...this.sinks]) sink(msg);
	}

	/** DEV-CON：实例级广播入口（渠道状态由 AgentService 分发给全部客户端；
	 *  其他客户端的 ClientSession 收到后推给自己的 sinks）。 */
	emitExternal(msg: ServerMessage): void {
		this.emit(msg);
	}

	/** 某个客户端的 chat 会话已释放（避免对已 dispose 的会话再推）。 */
	isDisposedSession(): boolean {
		return this.disposed;
	}

	/** (Re)attach extension binding + event plumbing to ONE conversation's session.
	 *  多端接力重载（reloadConversationFromDisk）也走这里，保证与新建/切换同一套绑定。 */
	private async bindConversation(conv: Conversation): Promise<void> {
		conv.unsubscribe?.();
		conv.session = conv.runtime.session;
		await conv.session.bindExtensions({
			mode: "rpc",
			uiContext: this.webUi,
			onError: (err) => {
				this.emit({ type: "notice", level: "error", text: err.error, textEn: err.error });
			},
		});
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		this.updateDiskSig(conv);
	}

	/** 记录某对话当前磁盘转录的签名（mtimeMs:size），用于判断是否需要接力重载。 */
	private updateDiskSig(conv: Conversation): void {
		try {
			const file = conv.session.sessionFile;
			if (!file) {
				conv.diskSig = undefined;
				return;
			}
			const st = statSync(file);
			conv.diskSig = `${st.mtimeMs}:${st.size}`;
		} catch {
			conv.diskSig = undefined;
		}
	}

	/** 磁盘转录是否比本端内存状态新（本端上次记录之后被其他端写过）。 */
	private diskSigChanged(conv: Conversation): boolean {
		const file = conv.session.sessionFile;
		if (!file) return false;
		try {
			const st = statSync(file);
			return conv.diskSig !== `${st.mtimeMs}:${st.size}`;
		} catch {
			return false;
		}
	}

	/**
	 * 接入 / 回到页面时追平：本端活动会话的磁盘文件若比内存新（离开期间另一端
	 * 完成了工作，且没有新广播可收），就从磁盘接力重载。
	 * 覆盖「页面重连但 clientId 未变 → 服务端复用内存 ClientSession」的缺口。
	 *
	 * @PERF 重载本身会发一份全量快照；若不等它，hello 那份基线会先把**旧**内容
	 * 发给客户端，紧接着再来一份重载后的全量——大会话等于多传一次数百 KB，
	 * 用户还会看到一次“先旧后新”的跳变。`diskSyncPending` 让 hello 把基线排到
	 * 重载之后（见 index.ts），於是只传一份且内容就是最新的。
	 */
	syncActiveFromDiskIfStale(): void {
		if (this.disposed) return;
		const conv = this.convs.get(this.activeId);
		if (!conv || conv.session.isStreaming || conv.reloadInFlight) return;
		if (!conv.session.sessionFile || !this.diskSigChanged(conv)) return;
		const running = this.reloadConversationFromDisk(conv).finally(() => {
			if (this.diskSync === running) this.diskSync = null;
		});
		this.diskSync = running;
	}

	/** 正在进行的磁盘接力重载；hello 用它把首份基线排在重载之后。 */
	diskSyncPending(): Promise<void> | null {
		return this.diskSync;
	}

	/** (Re)attach event plumbing to the ACTIVE conversation's session. */
	private async bindSession(): Promise<void> {
		this.maintenance.start();
		await this.bindConversation(this.conv);
		// 新会话 / 切换会话 / 强杀重建的必经之路：刚创建的 runtime 用的是 SDK
		// 默认重试 3 次——这里把面板的 retryMaxAttempts 覆盖注入，否则“设了 6
		// 次还是按 3 次重试”。已存在会话重复注入是幂等的（同值覆盖）。
		this.applyRetryOverrides();
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	/** Model-stall watchdog: warn when a streaming run went completely silent
	 *  (no SDK events at all) for STALL_NOTIFY_MS. Deliberately does NOT abort:
	 *  deep-thinking models can legitimately be quiet for minutes — the notice
	 *  just tells the user the run looks stuck so they can Stop it themselves. */
	private startStallTimer(): void {
		if (this.stallTimer || STALL_NOTIFY_MS === 0) return;
		this.stallTimer = setInterval(() => {
			if (this.disposed) return;
			const now = Date.now();
			for (const conv of this.convs.values()) {
				if (!conv.stallNoticed && conv.session.isStreaming && now - conv.lastSdkEventAt > STALL_NOTIFY_MS) {
					conv.stallNoticed = true;
					const mins = Math.round((now - conv.lastSdkEventAt) / 60_000);
					this.emit({
						type: "notice",
						level: "warning",
						text: `对话「${conv.title}」已 ${mins} 分钟无任何响应，可能已失联（网络中断或服务端挂起）。可点击停止后重试。`,
						textEn: `Conversation "${conv.title}" has been silent for ${mins} min — possibly disconnected (network or hung server). Stop it and retry.`,
					});
				}
			}
		}, 30_000);
	}

	/** Arm the hang-guard for a tool call: if it is still running after
	 *  TOOL_WATCHDOG_TIMEOUT_MS, abort the session instead of letting the
	 *  conversation hang forever (the SDK bash tool has no default timeout). */
	private armToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = setTimeout(() => {
			conv.toolWatchdogs.delete(toolCallId);
			// The tool finished before the deadline — nothing to do.
			if (!conv.toolStartTimes.has(toolCallId)) return;
			this.emit({
				type: "notice",
				level: "warning",
				text: `工具执行超过 ${Math.round(TOOL_WATCHDOG_TIMEOUT_MS / 60_000)} 分钟，已自动终止（防止挂死）。可调整超时：环境变量 PI_WEB_TOOL_TIMEOUT_MS（毫秒）。`,
				textEn: `Tool ran over ${Math.round(TOOL_WATCHDOG_TIMEOUT_MS / 60_000)} min and was auto-terminated (hang guard). Tune via PI_WEB_TOOL_TIMEOUT_MS (ms).`,
			});
			conv.toolStartTimes.delete(toolCallId);
			// Abort the run (kills the process tree via the SDK's abort signal);
			// agent_end will fire with stopReason "aborted" and existing logic
			// clears any goal / review loop. interruptRun adds a force-reset
			// fallback in case the model stream ignores the abort signal.
			void this.interruptRun(conv, "工具执行超时");
		}, TOOL_WATCHDOG_TIMEOUT_MS);
		t.unref?.();
		conv.toolWatchdogs.set(toolCallId, t);
	}

	/** Cancel a tool's watchdog — called when the tool finishes normally. */
	private clearToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = conv.toolWatchdogs.get(toolCallId);
		if (t) {
			clearTimeout(t);
			conv.toolWatchdogs.delete(toolCallId);
		}
	}

	/** Cancel every watchdog of a conversation (removeConversation / dispose). */
	private clearAllToolWatchdogs(conv: Conversation): void {
		for (const t of conv.toolWatchdogs.values()) clearTimeout(t);
		conv.toolWatchdogs.clear();
	}

	/** 发一条运行轨迹事件给插件（host.onRunEvent 订阅者，如轨迹视图插件）。
	 *  异常隔离——序列化/插件坏了只记日志，绝不影响主流程。 */
	private emitRun(conv: Conversation, ev: Omit<PluginRunEvent, "conversationId" | "at">): void {
		if (!this.onRunEvent) return;
		try {
			this.onRunEvent({ ...ev, conversationId: conv.id, at: Date.now() });
		} catch (err) {
			console.error("[agent-service] onRunEvent failed:", err);
		}
	}

	/** 当前打开对话变了 → 通知插件重拉（切历史会话/切 running 对话/新对话）。
	 *  异常隔离——插件坏了只记日志，绝不影响切换流程。 */
	private notifyConversationChanged(): void {
		if (!this.onConversationChanged) return;
		try {
			this.onConversationChanged();
		} catch (err) {
			console.error("[agent-service] onConversationChanged failed:", err);
		}
	}

	/** 插件用：本客户端最近活跃对话的快照（轨迹视图直接显示打开对话的时间线）。
	 *  messages/streamingMessage 为引用稳定的只读缓存对象——调用方只读、不得修改。 */
	readConversationForPlugins(): PluginConversationSnapshot | null {
		try {
			let target: Conversation | null = null;
			for (const c of this.convs.values()) {
				if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
			}
			if (!target) return null;
			const state = target.session.agent.state;
			let stats: PluginConversationSnapshot["stats"] = {
				totalMessages: 0,
				tokens: { input: 0, output: 0, total: 0 },
				cost: 0,
			};
			try {
				const s = target.session.getSessionStats();
				stats = { totalMessages: s.totalMessages, tokens: s.tokens, cost: s.cost };
			} catch {
				/* stats 尽力而为 */
			}
			let streamingMessage: UiMessage | null = null;
			try {
				streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
			} catch {
				/* 尽力而为 */
			}
			return {
				conversationId: target.id,
				title: target.title,
				at: target.lastActiveAt,
				isStreaming: target.session.isStreaming,
				messages: this.messagesOf(target),
				streamingMessage,
				stats,
			};
		} catch (err) {
			console.error("[agent-service] readConversationForPlugins failed:", err);
			return null;
		}
	}

	/**
	 * 记录用量并落盘到用量历史（唯一入口）。所有 record() 调用点都必须走这里，
	 * 否则「界面能看到、历史查不到」的缺口会再次出现。
	 */
	private recordUsage(conv: Conversation, normalized: unknown, attribution: Record<string, unknown>, now = Date.now()): void {
		conv.usageTracker.record(normalized, now, attribution);
		const newest = conv.usageTracker.records()[0] as UsageHistoryRecord | undefined;
		if (!newest || newest.id === conv.lastPersistedUsageId) return;
		conv.lastPersistedUsageId = newest.id;
		this.usageHistory.append(newest);
		ClientSession.noteFailureSample(newest);
	}

	/**
	 * 渠道失败告警的滚动样本（有界，只放内存）。
	 * @WHY 实例级而不是对话级：网关搞流是**渠道**的问题，「哪个客户端发起的」无关；
	 * 分散到各会话的计数器根本不会越线。与 alertLastFired 同级。
	 */
	private static readonly failureSamples: FailureSample[] = [];
	private static readonly FAILURE_SAMPLE_LIMIT = 600;

	private static noteFailureSample(record: UsageHistoryRecord): void {
		try {
			ClientSession.failureSamples.push({
				at: record.at,
				subjectKey: ClientSession.failureSubjectKey(record),
				failed: isFailedStopReason(record.stopReason),
				input: (record.input ?? 0) + (record.cacheRead ?? 0) + (record.cacheWrite ?? 0),
			});
			const limit = ClientSession.FAILURE_SAMPLE_LIMIT;
			if (ClientSession.failureSamples.length > limit) ClientSession.failureSamples.splice(0, ClientSession.failureSamples.length - limit);
		} catch {
			/* 采样失败绝不阻断编码 */
		}
	}

	/**
	 * 告警主体：服务商（`provider:<id>`）。取不到具体服务商时返回 null → 该样本不参与告警。
	 * @WHY 渠道级主体已随「渠道」概念一起移除：现在凭据与用量归属都只到服务商/模型这一层。
	 */
	private static failureSubjectKey(record: UsageHistoryRecord): string | null {
		if (record.providerId && record.providerId !== "unknown") return `provider:${record.providerId}`;
		return null;
	}

	/**
	 * P4 候选：系统资源快照（只读）。工作区与 Agent 数据目录若在同一文件系统，
	 * 只保留一行（避免界面出现重复的同一块盘）。
	 */
	async listResources(reqId: number): Promise<void> {
		try {
			const snapshot = collectResources({
				disks: [
					{ path: this.cwd, label: "workspace" },
					{ path: this.agentDir, label: "agent" },
				],
			});
			const seen = new Set<string>();
			snapshot.disks = snapshot.disks.filter((disk) => {
				const key = `${disk.totalBytes}:${disk.freeBytes}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			this.emit({ type: "resources", reqId, ok: true, snapshot });
		} catch (err) {
			this.emit({ type: "resources", reqId, ok: false, error: (err as Error).message });
		}
	}

	/**
	 * 待生效渠道选择的落定入口（带有限重试）。
	 * @WHY 落定依赖「会话真的空闲」：`agent_end` 时 isStreaming 仍可能为 true，
	 *      而 `agent_settled` 之后工具/排队消息也可能紧接着再来一轮；用有限重试覆盖这两种时序，
	 *      超过上限就停（下一次事件仍会再试），不做无限轮询。
	/**
	 * P4 运维：资源告警（磁盘/内存/unit 内存越线提示一次，冷却 1 小时）。
	 * 由 ClientSession 的周期定时器调用；同一实例的多个客户端共享模块级冷却表，
	 * 因此不会重复刷通知。读不到的指标不告警（没有数据 ≠ 满了）。
	 */
	private static readonly alertLastFired = new Map<string, number>();
	checkResourceAlerts(): void {
		if (!this.opsAlertsEnabled()) return;
		try {
			const snapshot = collectResources({ disks: [{ path: this.cwd, label: "workspace" }, { path: this.agentDir, label: "agent" }] });
			const alerts = evaluateAlerts({ resources: snapshot, lastFired: Object.fromEntries(ClientSession.alertLastFired), now: Date.now() });
			if (alerts.length === 0) return;
			const now = Date.now();
			for (const alert of alerts) ClientSession.alertLastFired.set(alert.key, now);
			this.emit({
				type: "notice",
				level: alerts.some((a) => a.level === "critical") ? "error" : "warning",
				text: alerts.map((a) => this.alertText(a)).join("；"),
				textEn: alerts.map((a) => this.alertTextEn(a)).join("; "),
			});
		} catch {
			/* 告警检查失败绝不影响服务 */
		}
	}

	/**
	 * P4 运维：网关失败告警。网关搞流（stream 半途断开）时请求照旧计费输入 token、
	 * 产出为空：钱一直在烧，但「请求数/费用」看上去完全正常，所以必须单独报。
	 * 阈值/冷却见 failure-alert.ts；用户主动中止不计入（那是有意为之）。
	 */
	checkFailureAlerts(): void {
		if (!this.opsAlertsEnabled()) return;
		try {
			const alerts = evaluateFailureAlerts({
				samples: ClientSession.failureSamples,
				lastFired: Object.fromEntries(ClientSession.alertLastFired),
				now: Date.now(),
			});
			if (alerts.length === 0) return;
			const now = Date.now();
			for (const alert of alerts) ClientSession.alertLastFired.set(alert.key, now);
			this.emit({
				type: "notice",
				level: "warning",
				text: alerts.map((a) => this.failureAlertText(a)).join("；"),
				textEn: alerts.map((a) => this.failureAlertTextEn(a)).join("; "),
			});
		} catch {
			/* 告警检查失败绝不影响服务 */
		}
	}

	private failureAlertText(alert: FailureAlert): string {
		const minutes = Math.round(FAILURE_WINDOW_MS / 60_000);
		return `${this.failureSubjectLabel(alert)} 近 ${minutes} 分钟 ${alert.requests} 次请求中 ${alert.failed} 次失败（${Math.round(alert.rate * 100)}%），白烧约 ${alert.wastedInput} 输入 token`;
	}

	private failureAlertTextEn(alert: FailureAlert): string {
		const minutes = Math.round(FAILURE_WINDOW_MS / 60_000);
		return `${this.failureSubjectLabel(alert)}: ${alert.failed} of ${alert.requests} requests failed in the last ${minutes} min (${Math.round(alert.rate * 100)}%), wasting ~${alert.wastedInput} input tokens`;
	}

	/** 告警文案里的主体名：服务商注册名（取不到就用 id）。 */
	private failureSubjectLabel(alert: FailureAlert): string {
		const [kind, id] = alert.subjectKey.split(":", 2);
		if (kind !== "provider") return alert.subjectLabel;
		return this.providerNameOf(id) ?? alert.subjectLabel;
	}

	private alertText(alert: OpsAlert): string {
		const what = alert.id === "disk" ? `磁盘 ${alert.key.slice(5)}` : alert.id === "memory" ? "内存" : "unit 内存";
		return `${what}使用率 ${alert.value}%（阈值 ${alert.threshold}%）`;
	}

	private alertTextEn(alert: OpsAlert): string {
		const what = alert.id === "disk" ? `Disk ${alert.key.slice(5)}` : alert.id === "memory" ? "Memory" : "unit memory";
		return `${what} usage ${alert.value}% (threshold ${alert.threshold}%)`;
	}

	/** 诊断用：本进程所属引擎（AgentService 即 pi 引擎；DSH 由另一个实现回答）。 */
	private static readonly ENGINE = "pi";

	/** 诊断用：构建与来源信息（读不到就是 null，不编造）。 */
	private releaseInfo(): { commit: string | null; appVersion: string | null; protocolVersion: number | null; builtAt: string | null; source: string | null } {
		const distDir = dirname(fileURLToPath(import.meta.url)); // <release>/vendor/pi-web-ui/dist/server
		const read = (path: string): Record<string, unknown> | null => {
			try {
				return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			} catch {
				return null;
			}
		};
		const build = read(join(distDir, "..", "build-info.json"));
		const source = read(join(distDir, "..", "..", "..", "..", "release-source.json"));
		return {
			commit: typeof build?.commit === "string" ? build.commit : null,
			appVersion: typeof build?.appVersion === "string" ? build.appVersion : null,
			protocolVersion: typeof build?.protocolVersion === "number" ? build.protocolVersion : null,
			builtAt: typeof build?.builtAt === "string" ? build.builtAt : null,
			source: typeof source?.commit === "string" ? source.commit : null,
		};
	}

	/** 诊断用：实例监听地址（来自应用进程环境；缺失为 null，不从别处推断）。 */
	private instanceAddress(): { host: string | null; port: number | null } {
		const port = Number(process.env.PI_WEB_PORT ?? "");
		return { host: process.env.PI_WEB_HOST ?? null, port: Number.isInteger(port) && port > 0 ? port : null };
	}

	/** 诊断用：单位状态（只读；systemctl 不可用时如实报 unknown，不抛错）。 */
	private unitStates(): { unit: string; active: string; enabled: string }[] {
		return ["pi-dev-pm2.service", "pi-web-ui-dev.service", "pi-web-ui-dev-watchdog.timer"].map((unit) => {
			const read = (property: "is-active" | "is-enabled"): string => {
				try {
					return execFileSync("systemctl", ["--user", property, unit], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
				} catch (err) {
					return (err as { stdout?: string }).stdout?.trim() || "unknown";
				}
			};
			return { unit, active: read("is-active"), enabled: read("is-enabled") };
		});
	}

	/** 告警开关（默认开；持久化在 dev-con/ops-settings.json）。 */
	private opsSettingsPath(): string {
		return join(this.agentDir, "dev-con", "ops-settings.json");
	}

	private opsAlertsEnabled(): boolean {
		try {
			const parsed = JSON.parse(readFileSync(this.opsSettingsPath(), "utf8")) as { alertsEnabled?: boolean };
			return parsed?.alertsEnabled !== false;
		} catch {
			return true;
		}
	}

	/** P4 运维：开关资源告警。 */
	setOpsAlerts(enabled: boolean): void {
		try {
			mkdirSync(join(this.agentDir, "dev-con"), { recursive: true });
			writeFileSync(this.opsSettingsPath(), JSON.stringify({ alertsEnabled: enabled === true }, null, 2) + "\n", { mode: 0o600 });
			this.emit({
				type: "notice",
				level: "info",
				text: enabled ? "已开启资源告警" : "已关闭资源告警",
				textEn: enabled ? "Resource alerts enabled" : "Resource alerts disabled",
			});
		} catch (err) {
			this.emit({ type: "notice", level: "error", text: `保存告警设置失败：${(err as Error).message}` });
		}
		this.flushSnapshot();
	}

	/** P4 运维：诊断包（只含元数据；密钥值/会话内容/日志正文一律不包含）。 */
	async listDiagnostics(reqId: number): Promise<void> {
		try {
			const addr = this.instanceAddress();
			const resources = collectResources({ disks: [{ path: this.cwd, label: "workspace" }, { path: this.agentDir, label: "agent" }] });
			const areas = measureAreas([
				{ path: join(this.stateStore.dataDir, "uploads"), label: "uploads", note: "uploads-cleanable" },
				{ path: join(this.agentDir, "sessions"), label: "sessions", note: "sessions-user-data" },
				{ path: join(this.agentDir, "dev-con"), label: "usage-and-jev-metadata", note: "dev-con-metadata-user-data" },
			]);
			const usageFull = this.usageHistory.query({ groupBy: "source" });
			const usageByProvider = this.usageHistory.query({ groupBy: "provider" });
			const bundle = buildDiagnostics({
				now: Date.now(),
				app: { node: process.version, pid: process.pid, uptimeSec: Math.round(process.uptime()), engine: ClientSession.ENGINE, protocolVersion: PROTOCOL_VERSION },
				release: this.releaseInfo(),
				instance: {
					configDir: dirname(this.agentDir),
					dataDir: this.stateStore.dataDir,
					agentDir: this.agentDir,
					workspaceDir: this.cwd,
					host: addr.host,
					port: addr.port,
					profile: process.env.PI_DEV_PROFILE ?? null,
				},
				units: this.unitStates(),
				resources,
				storage: {
					at: Date.now(),
					areas,
					totalBytes: areas.reduce((sum, area) => sum + area.bytes, 0),
					retention: { ...this.usageHistory.readSettings(), fileBytes: this.usageHistory.fileBytes(), choices: [0, 7, 30, 90, 365] },
				},
				providers: {
					count: this.providerIds().length,
				},
				usage: { ...usageSummaryOf(usageFull), byProvider: usageSummaryOf(usageByProvider).byProvider },
				environment: { platform: process.platform, cpuCount: resources.host.cpuCount, totalMemBytes: resources.host.mem.totalBytes },
				warnings: [...resources.warnings, ...areas.filter((a) => a.truncated).map((a) => `storage:${a.label} 已达遍历上限`)],
			});
			this.emit({
				type: "diagnostics",
				reqId,
				ok: true,
				bundle,
				alertsEnabled: this.opsAlertsEnabled(),
				thresholds: { warnPercent: ALERT_WARN_PERCENT, criticalPercent: ALERT_CRITICAL_PERCENT, cooldownMs: ALERT_COOLDOWN_MS },
			});
		} catch (err) {
			this.emit({ type: "diagnostics", reqId, ok: false, error: (err as Error).message });
		}
	}

	/**
	 * P4 运维：存储占用明细 + 用量历史保留策略（只读遍历，有界；不删除任何数据）。
	 * 区域按「用户数据 / 可清理候选」分组标注，界面据此提示，删除动作仍由操作人在服务器上做。
	 */
	async listStorage(reqId: number): Promise<void> {
		try {
			const retentionPath = join(this.agentDir, "dev-con", "usage-history.jsonl");
			const areas = measureAreas([
				{ path: join(this.stateStore.dataDir, "uploads"), label: "uploads", note: "uploads-cleanable" },
				{ path: join(this.agentDir, "sessions"), label: "sessions", note: "sessions-user-data" },
				{ path: join(this.stateStore.dataDir, "subagent-archive"), label: "subagent-archive", note: "sessions-user-data" },
				{ path: retentionPath, label: "usage-history", note: "usage-history-cleanable" },
				{ path: join(this.agentDir, "dev-con"), label: "dev-con-metadata", note: "dev-con-metadata-user-data" },
				{ path: join(this.stateStore.dataDir, "plugins"), label: "plugin-data", note: "plugin-data-user-data" },
			]);
			const settings = this.usageHistory.readSettings();
			this.emit({
				type: "storage",
				reqId,
				ok: true,
				storage: {
					at: Date.now(),
					areas,
					totalBytes: areas.reduce((sum, area) => sum + area.bytes, 0),
					retention: { maxAgeDays: settings.maxAgeDays, maxBytes: settings.maxBytes, fileBytes: this.usageHistory.fileBytes(), choices: [0, 7, 30, 90, 365] },
				},
			});
		} catch (err) {
			this.emit({ type: "storage", reqId, ok: false, error: (err as Error).message });
		}
	}

	/** P4 运维：设置用量历史保留天数（仅允许 0/7/30/90/365；立即生效）。 */
	setUsageRetention(maxAgeDays: number): void {
		const settings = this.usageHistory.writeSettings(maxAgeDays);
		const pruned = this.usageHistory.pruneByAge();
		this.emit({
			type: "notice",
			level: "info",
			text: settings.maxAgeDays === 0 ? "用量历史保留：只按大小轮转（不做时间清理）" : `用量历史保留：仅保留最近 ${settings.maxAgeDays} 天（本次清理 ${pruned.removed} 条）`,
			textEn: settings.maxAgeDays === 0 ? "Usage history retention: size-based rotation only" : `Usage history retention: last ${settings.maxAgeDays} days (removed ${pruned.removed} records)`,
		});
		this.flushSnapshot();
	}

	/** P4：只读用量历史聚合（按渠道/项目/模型/来源/天）。 */
	async queryUsageHistory(
		reqId: number,
		query: { groupBy: "provider" | "project" | "model" | "source" | "day"; from?: number; to?: number },
	): Promise<void> {
		try {
			const result = this.usageHistory.query({ groupBy: query.groupBy, from: query.from, to: query.to });
			this.emit({
				type: "usage_history",
				reqId,
				ok: true,
				groupBy: result.groupBy,
				from: result.from,
				to: result.to,
				rows: result.rows,
				totals: {
					requests: result.totals.requests,
					input: result.totals.input,
					output: result.totals.output,
					cacheRead: result.totals.cacheRead,
					cacheWrite: result.totals.cacheWrite,
					total: result.totals.total,
					cost: result.totals.cost,
					unpricedRequests: result.totals.unpricedRequests,
					unreportedRequests: result.totals.unreportedRequests,
					failedRequests: result.totals.failedRequests,
					wastedInput: result.totals.wastedInput,
					cacheHitRate: result.totals.cacheHitRate,
				},
				scanned: result.scanned,
				skipped: result.skipped,
				truncated: result.truncated,
			});
		} catch (err) {
			this.emit({ type: "usage_history", reqId, ok: false, error: (err as Error).message, groupBy: query.groupBy, from: null, to: null, rows: [], totals: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, unpricedRequests: 0, unreportedRequests: 0, failedRequests: 0, wastedInput: 0, cacheHitRate: null }, scanned: 0, skipped: 0, truncated: false });
		}
	}

	/** 会话统计总量（缺失时为 null）；压缩用量归属的唯一来源。 */
	private sessionUsageTotals(): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number } | null {
		try {
			const s = this.session.getSessionStats();
			return {
				input: s.tokens.input,
				output: s.tokens.output,
				cacheRead: s.tokens.cacheRead,
				cacheWrite: s.tokens.cacheWrite,
				total: s.tokens.total,
				cost: s.cost,
			};
		} catch {
			return null;
		}
	}

	/**
	 * 把压缩期间的会话统计差值记成一条 source=compaction 的用量。
	 * 压缩不产生 message 事件，若不这么做，摘要消耗的 token 只会在 SDK 会话统计里
	 * 出现，无法按来源区分（§7）。差值 <= 0 时不记（避免把别的调用算到压缩头上）。
	 */
	private recordCompactionUsage(conv: Conversation): void {
		const before = conv.compactionBaseline;
		conv.compactionBaseline = null;
		if (!before) return;
		const after = this.sessionUsageTotals();
		if (!after) return;
		const delta = {
			input: after.input - before.input,
			output: after.output - before.output,
			cacheRead: after.cacheRead - before.cacheRead,
			cacheWrite: after.cacheWrite - before.cacheWrite,
			total: after.total - before.total,
			cost: Math.max(0, after.cost - before.cost),
		};
		if (delta.total <= 0 && delta.cost <= 0) return;
		this.recordUsage(
			conv,
			{
				scope: "final",
				identity: null,
				input: Math.max(0, delta.input),
				output: Math.max(0, delta.output),
				cacheRead: Math.max(0, delta.cacheRead),
				cacheWrite: Math.max(0, delta.cacheWrite),
				total: Math.max(0, delta.total),
				cost: delta.cost,
				role: "assistant",
			},
			this.bindingAttribution(conv, "compaction"),
		);
	}

	/**
	 * 由「请求时归属」（getApiKey 钩子记下的服务商 + 当下模型）生成归属字段。modelId 取裸模型 id
	 * （与消息事件里的 message.model 同名），保证旁路/压缩与普通请求在归属表里同一行可合并。
	 */
	private bindingAttribution(conv: Conversation, source: string): Record<string, unknown> {
		const binding = conv.lastRequestBinding;
		const ref = binding?.modelId ?? "";
		const slash = ref.indexOf("/");
		return {
			source,
			conversationId: conv.id,
			cwd: conv.cwd,
			providerId: binding?.providerId,
			modelId: slash > 0 ? ref.slice(slash + 1) : ref || undefined,
		};
	}

	/** 旁路调用（视觉桥）的用量归属：来源标 vision，归属到发起请求的对话（§7）。 */
	private recordBypassUsage(usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		cost: number;
		provider: string;
		modelId: string;
	}): void {
		const conv = this.conv;
		this.recordUsage(conv, { scope: "final", identity: null, ...usage, role: "assistant" }, this.bindingAttribution(conv, "vision"));
	}

	/** 用量来源标注（§7）：子代理/重试/压缩摘要分别标注，其余为用户请求。 */
	private usageSource(conv: Conversation): "user" | "retry" | "subagent" | "compaction" {
		if (conv.isSubagent) return "subagent";
		if (conv.compactionState) return "compaction";
		if (conv.retryState) return "retry";
		return "user";
	}

	private onEvent(conv: Conversation, event: AgentSessionEvent): void {
		const usageEvent = normalizeUsageEvent(event);
		if (usageEvent) {
			const binding = conv.lastRequestBinding;
			this.recordUsage(conv, usageEvent, {
				source: this.usageSource(conv),
				conversationId: conv.id,
				cwd: conv.cwd,
				modelId: binding?.modelId,
				providerId: binding?.providerId,
			});
		}
		// Any SDK event proves the run is alive — feeds the stall watchdog below.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		switch (event.type) {
			case "agent_settled":
				this.maintenance.schedule();
				break;
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.id,
						toolName: "bash",
						delta: event.delta,
					});
				}
				break;
			}
			case "tool_execution_start": {
				// Record the moment the tool actually starts so tool_status can
				// report real execution time (vs. time spent waiting on the model).
				conv.toolStartTimes.set(event.toolCallId, Date.now());
				// Snapshot listeners before a bash run — the post-run diff catches
				// servers the agent started in the background.
				if (event.toolName === "bash") {
					this.bg.snapshotBefore();
				}
				this.armToolWatchdog(conv, event.toolCallId);
				// 插件扩展点：工具开始执行（异常由 emitToolEvent 隔离）。
				this.onToolEvent?.({
					phase: "start",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
				});
				// 轨迹事件：带参数预览（JSON 封顶；超大参数只记截断）。
				let argsText = "null";
				try {
					argsText = truncRun(JSON.stringify(event.args ?? null), RUN_ARGS_CAP);
				} catch {
					argsText = "[unserializable args]";
				}
				this.emitRun(conv, {
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					argsText,
				});
				break;
			}
			case "tool_execution_end": {
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);
				this.clearToolWatchdog(conv, event.toolCallId);
				// Bash finished — wait briefly for background servers to bind their
				// ports, then diff against the pre-run snapshot and record them.
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
				// 插件扩展点：工具结束执行（带耗时与错误标志）。
				this.onToolEvent?.({
					phase: "end",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// 轨迹事件：带结果预览（封顶）+ 耗时/错误标志。
				this.emitRun(conv, {
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					resultText: previewToolResult(event.result),
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// The bash tool does not put its exit code in result.details — on
				// failure it throws "Command exited with code N" and the agent
				// wraps that into the error result text. Try details first (future
				// tools / SDK changes), then parse the error text.
				const details = (event.result as { details?: unknown })?.details;
				let exitCode: number | undefined;
				if (
					typeof details === "object" &&
					details !== null &&
					typeof (details as { exitCode?: unknown }).exitCode === "number"
				) {
					exitCode = (details as { exitCode: number }).exitCode;
				} else if (event.isError) {
					const content = (event.result as { content?: unknown })?.content;
					const text = Array.isArray(content)
						? content
								.map((c) =>
									typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text"
										? ((c as { text?: unknown }).text ?? "")
										: "",
								)
								.join("\n")
						: "";
					const m = text.match(/exited with code (\d+)/);
					if (m) exitCode = Number(m[1]);
				}
				this.emit({
					type: "tool_status",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					exitCode,
					durationMs,
				});
				break;
			}
			case "tool_execution_update": {
				const text = extractPartialText(event.partialResult);
				if (text) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: text,
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = [...event.steering];
				conv.queueFollowUp = [...event.followUp];
				break;
			// 手动 /compact 或阈值/溢出自动压缩开始——常驻进度条（快照 compaction
			// 字段），而不是一次性 toast（toast 几秒就消失，而摘要生成可能持续
			// 数十秒，用户会以为「没反应」）。立即 flush 让进度条第一时间出现。
			case "compaction_start": {
				conv.compactionState = { reason: event.reason, startedAt: Date.now() };
				conv.lastCompactionTokens = null;
				// 压缩摘要走 SDK 内部 completeSimple，不产生 message 事件；用会话统计差值
				// 把这段 token 归属为 source=compaction（§7：摘要来源必须可区分）。
				conv.compactionBaseline = this.sessionUsageTotals();
				this.flushSnapshot();
				break;
			}
			case "compaction_end": {
				conv.compactionState = null;
				this.recordCompactionUsage(conv);
				if (event.errorMessage) {
					this.emit({
						type: "notice",
						level: "error",
						text: `压缩上下文失败：${event.errorMessage}`,
						textEn: `Context compaction failed: ${event.errorMessage}`,
					});
				} else if (event.aborted) {
					this.emit({
						type: "notice",
						level: "warning",
						text: "压缩上下文已取消",
						textEn: "Context compaction cancelled",
					});
				} else if (event.result) {
					const { tokensBefore, estimatedTokensAfter } = event.result;
					const after = estimatedTokensAfter ?? tokensBefore;
					// 记住压缩后大小：SDK 在下轮响应前报 null，快照用此回填底栏。
					conv.lastCompactionTokens = estimatedTokensAfter ?? null;
					this.emit({
						type: "notice",
						level: "info",
						text: `上下文压缩完成：${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens（摘要已插入消息区）`,
						textEn: `Context compacted: ${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens (summary inserted into the message list)`,
					});
				}
				break;
			}
			case "auto_retry_start": {
				// 大模型 API 瞬时报错，SDK 退避重试：填实重试信息。末尾 error
				// 消息已被（或即将被）SDK 从 state 摘掉，currentMessages() 凭此旗
				// 过滤，快照只显示温和的重试条。落盘由底部检查点立即 flush。
				conv.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				};
				break;
			}
			case "auto_retry_end": {
				// 重试结束：成功 → 新内容照常显示；耗尽 → error 消息留驻，
				// 快照永久标红。落盘由底部检查点立即 flush。
				conv.retryState = null;
				break;
			}
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end": {
				// 可重试错误：SDK 随后发 auto_retry_start 并把末尾 error 消息从
				// state 摘掉。这里先立占位，让本次立即 flush 的快照就不含瞬时红错
				// ——否则快照先画红、摘掉后又消失，即「红色报错一闪而过」。
				if (event.willRetry) {
					let errorMessage = "";
					for (let i = event.messages.length - 1; i >= 0; i--) {
						const m = event.messages[i] as { role?: unknown; errorMessage?: unknown };
						if (m.role === "assistant" && typeof m.errorMessage === "string") {
							errorMessage = m.errorMessage;
							break;
						}
					}
					conv.retryState = { attempt: 0, maxAttempts: 0, delayMs: 0, errorMessage };
				} else {
					// 本轮结束且无后续重试：任何残留占位都是过期的（会话替换、
					// 结束信号丢失等），清掉，否则横幅会卡住不消失。
					conv.retryState = null;
				}
				// 本轮结束后没有后续重试，无需额外动作（模型切换已随 set_model 走 SDK 自己的边界）。
				// 轨迹事件：本轮结束（放最前——aborted 中断路径也会 break，
				// 轨迹里必须留下「已停止」而不是凭空消失）。
				try {
					const lastAssistant = [...(event.messages as unknown[])].reverse().find((m) => {
						const a = m as { role?: string; stopReason?: string };
						return a.role === "assistant" && typeof a.stopReason === "string";
					}) as { stopReason?: string } | undefined;
					this.emitRun(
						conv,
						lastAssistant?.stopReason ? { type: "run_end", stopReason: lastAssistant.stopReason } : { type: "run_end" },
					);
				} catch {
					/* 轨迹尽力而为 */
				}
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				// 多端接力：一轮结束（transcript 已落盘）→ 先补做期间挂起的重载，
				// 再把「节点完成」广播给其他端（刷新列表 + 拉动同一会话的端）。
				void this.flushPendingDiskReloads();
				this.broadcastPersistedNode(conv);
				// 内联标记不在此兜底扫最后一条 assistant：每条气泡结束已走 message_end
				// 即时解析（含中间文本块）；这里再扫会把最后一条标记重复执行（todo 重复建号）。

				// Manual interrupt (Stop button / abort): the last assistant message
				// carries stopReason "aborted". A half-finished run should NOT be
				// reviewed (it would fail and inject a revision, only to be stopped
				// again → an endless review loop). Clear the goal so the review loop
				// stops too, then let the user give a fresh instruction.
				const aborted = (event.messages as unknown[]).some((m) => {
					const a = m as { role?: string; stopReason?: string };
					return a.role === "assistant" && a.stopReason === "aborted";
				});
				if (aborted) {
					const stopNotice = this.goalSvc.onAgentEnd(conv, true);
					if (stopNotice) {
						this.emit({ type: "notice", level: "warning", text: stopNotice.text, textEn: stopNotice.textEn });
					}
					break;
				}
				// 子代理运行报错（provider 400 / 超时等）→ 通知主对话，让用户/AI 知道
				// 拿回的结果可能是空或无意义的（否则子代理只是安静地停在「done」，
				// 主对话永远收不到失败信号）。错误文本变化时允许再次通知（去重）。
				if (conv.isSubagent) {
					const { error } = subagentRunOutcome(conv);
					if (error && error !== conv.subagentErrorNotified) {
						conv.subagentError = error;
						conv.subagentErrorNotified = error;
						this.emit({
							type: "notice",
							level: "error",
							text: `子代理 ${conv.id.slice(0, 8)}（${conv.subagentType ?? "general"}）运行失败：${error}`,
							textEn: `Subagent ${conv.id.slice(0, 8)} (${conv.subagentType ?? "general"}) failed: ${error}`,
						});
					} else if (error) {
						conv.subagentError = error;
					}
					this.emitConversations();
				}
				// Goal review hook lives in GoalService.onAgentEnd(conv, false).
				this.goalSvc.onAgentEnd(conv, false);
				// Deferred settings reload: settings (system prompt / skills /
				// extensions) changed while the run was streaming — applying now
				// would have torn down the in-flight run.
				if (this.settingsSvc.hasPendingReload() && !this.disposed) {
					this.settingsSvc.consumePendingReload();
					void this.applySettingsReload();
				}
				break;
			}
			case "entry_appended": {
				// 本端自己的写入：标记后不重扫列表（agent_end 统一刷新）。
				this.markLiveSessionFile(conv);
				// SDK 仅在扩展 appendEntry 时发 entry_appended（entry 恒为 custom），
				// assistant 消息不会走这里——气泡级解析见 case "message_end"。
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				break;
			}
			case "message_end": {
				// 同上：流式期间每条消息都失效缓存会让列表刷新反复付 540ms 全量解析。
				this.markLiveSessionFile(conv);
				// 轨迹事件：一条消息定稿（user/assistant 都收；custom display:false
				// 的 serializeMessage 返回 null 时跳过）。
				try {
					const ui = serializeMessage(event.message as AgentMessage, 0);
					if (ui) this.emitRun(conv, { type: "message", message: ui });
				} catch {
					/* 轨迹尽力而为 */
				}
				// 每条 assistant 气泡流式结束 → 立即解析其中的内联标记：每个气泡各自
				// 每条 assistant 气泡流式结束 → 立即解析其中的内联标记：每个气泡各自
				// 生效（不再等整轮 agent_end），同一轮里先前消息的标记也不再丢。
				const mm = event.message as { role?: string; stopReason?: unknown; content?: unknown };
				if (mm?.role !== "assistant") break;
				// 非 error 的 assistant 定稿 = 重试周期结束（与 SDK 重置
				// _retryAttempt 的条件一致）：即使 auto_retry_end 丢失，横幅也不会卡住。
				if (mm.stopReason !== "error") conv.retryState = null;
				const text = extractAssistantTextFromContent(mm.content);
				if (text && text.includes("[[")) void this.markerSvc.handleAssistantText(conv.id, text);
				break;
			}
			case "agent_start": {
				conv.usageTracker.startRun();

				// 无暂存时省略，插件回退为「继续执行」）。
				const task = conv.pendingTask;
				conv.pendingTask = undefined;
				this.emitRun(conv, task ? { type: "run_start", task } : { type: "run_start" });
				break;
			}
			case "turn_start": {
				this.emitRun(conv, { type: "turn_start" });
				break;
			}
			case "turn_end": {
				this.emitRun(conv, { type: "turn_end" });
				break;
			}
			case "message_update": {
				// Live assistant-message increment, deliberately OUTSIDE the snapshot
				// channel: send() drops snapshots under backpressure (big sessions),
				// but this small message must always get through or the UI freezes on
				// stale state. Only the ACTIVE conversation streams to the browser —
				// background conversations would clobber the streaming view; their
				// state arrives via snapshot when switched to.
				if (conv.id !== this.conv.id) break;
				const ame = event.assistantMessageEvent;
				const m = event.message as { timestamp?: number };
				this.lastDeltaAt = Date.now();
				this.emit({
					type: "message_delta",
					conversationId: conv.id,
					seq: ++conv.deltaSeq,
					// Must match serializeStreamingMessage()'s stable id so deltas
					// patch onto the snapshot's streamingMessage and reconcile.
					messageId: `stream-${m?.timestamp ?? 0}`,
					usage: (() => {
						try {
							const usage = conv.usageTracker.snapshot();
							return { input: usage.current.input, output: usage.current.output, total: usage.current.total };
						} catch {
							return null;
						}
					})(),
					// Strip `partial` (the cumulative message): re-serializing it per
					// token is exactly what we're trying to avoid. The next snapshot
					// carries the authoritative full message anyway.
					assistantMessageEvent: {
						type: ame.type,
						contentIndex: "contentIndex" in ame ? ame.contentIndex : undefined,
						delta: "delta" in ame ? ame.delta : undefined,
					},
				});
				break;
			}
			default:
				break;
		}
		// Snapshot checkpoint policy: deltas carry live rendering during streaming;
		// full snapshots are reconciliation checkpoints taken immediately at
		// run/tool boundaries and on a slow timer otherwise.
		if (
			event.type === "agent_end" ||
			event.type === "tool_execution_end" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end"
		) {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	/** Debounced push of the persisted session list + open conversations. */
	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			this.emitConversations();
			void this.pushSessions();
		}, 800);
		// pushSessions no-ops unless the client opted in via list_sessions.
	}

	/** Refresh a conversation's title from its persisted first user message
	 *  while it is still unnamed. Runs off the event stream (entry_appended /
	 *  agent_end) rather than the prompt() call site, so ANY entry path that
	 *  lands a message names the chat the moment it is persisted — a rename
	 *  skipped by the prompt-start fast path (e.g. a concurrent switch) is
	 *  recovered here instead of leaving a permanent “新对话”. */
	private refreshConversationTitle(conv: Conversation): void {
		if (conv.title !== DEFAULT_CONV_TITLE) return;
		const title = conversationTitle(conv.session);
		if (title === DEFAULT_CONV_TITLE) return;
		conv.title = title;
		this.emitConversations();
	}

	/** Serialize a persisted message with a STABLE id + cached object reference. */
	private serializeCached(m: AgentMessage): UiMessage | null {
		return this.serializeCachedFor(this.conv, m);
	}

	/** serializeCached 的按对话版本（插件快照读非活跃对话用；缓存仍按对话隔离）。 */
	private serializeCachedFor(conv: Conversation, m: AgentMessage): UiMessage | null {
		// toolResult messages are keyed by toolCallId; everything else by
		// role+timestamp. A single prompt can emit several same-role messages
		// within the SAME millisecond (multiple attachment asides), so the
		// timestamp alone collides in the cache and only the first one renders
		// — append a cheap content fingerprint to keep them distinct while
		// staying stable across snapshots (content never changes once persisted).
		const key = m.role === "toolResult" ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
		let n = conv.msgIds.get(key);
		if (n === undefined) {
			n = conv.nextMsgId++;
			conv.msgIds.set(key, n);
		}
		const cacheKey = `${key}#${n}`;
		const cached = conv.uiMessageCache.get(cacheKey);
		if (cached) return cached;
		// User-message id suffix is a 1-based count of user messages sharing
		// this timestamp (that's what resolveUserMessageEntryId() expects). n is
		// a global per-conversation counter across ALL roles, so it can't be
		// reused as the seq — otherwise editing anything but the first question
		// fails to resolve ("找不到要编辑的消息").
		let seq = n;
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			seq = (conv.userSeqByTs.get(ts) ?? 0) + 1;
			conv.userSeqByTs.set(ts, seq);
		}
		const msg = serializeMessage(m, seq);
		if (msg) {
			conv.uiMessageCache.set(cacheKey, msg);
			// Bound the cache (marathon sessions otherwise grow without limit;
			// single messages can reach TEXT_CAP = 200K chars). Map iteration is
			// insertion order, so dropping from the front evicts the oldest —
			// recent messages (the ones every snapshot touches) always survive.
			// Safe: a miss just recomputes an identical object on next access.
			let excess = conv.uiMessageCache.size - UI_MESSAGE_CACHE_CAP;
			while (excess-- > 0) {
				const oldest = conv.uiMessageCache.keys().next().value;
				if (oldest === undefined) break;
				conv.uiMessageCache.delete(oldest);
			}
		}
		return msg;
	}

	/** Current messages array (with the existing sig-reuse optimization).
	 *  Element objects are reference-stable (serializeCached cache), which is
	 *  what lets emitSnapshotNow detect append-only growth via identity walk. */
	private currentMessages(): UiMessage[] {
		return this.messagesOf(this.conv);
	}

	/** currentMessages 的按对话版本（插件快照读非活跃对话用）。 */
	private messagesOf(conv: Conversation): UiMessage[] {
		let rawMessages = conv.session.agent.state.messages
			.map((m) => this.serializeCachedFor(conv, m))
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// 自动重试等待期：SDK 暂留在 state 末尾的 error 气泡只是中间态（随后被
		// 摘掉重跑），不进快照——成功则用户永远看不到，耗尽才标红。否则 agent_end
		// 的立即 flush 会先画红、摘掉后又消失（红色一闪而过）。
		rawMessages = stripTransientRetryErrors(rawMessages, !!conv.retryState);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages = conv.lastMessagesSig === sig ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = rawMessages;
		return messages;
	}

	/** Build every UiState field EXCEPT messages (the expensive part). */
	private buildLightState(rev: number): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const conv = this.conv;
		const state = conv.session.agent.state;
		const model = state.model;
		const loadContextPolicy = this.contextPolicyLoader();
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		};
		try {
			const s = this.session.getSessionStats();
			const usage = conv.usageTracker.snapshot();
			stats = {
				totalMessages: s.totalMessages,
				tokens: {
					...s.tokens,
					request: usage.current,
					run: usage.turn,
				},
				// §7 归属：来源/渠道/模型维度；只含引用，不含密钥。
				attribution: conv.usageTracker.attributionList(),
				runId: conv.usageTracker.runId,
				// §7 逐请求记录（有界，新→旧）：稳定标识 + 时间 + 计价依据，供详情面板展示。
				recentRequests: conv.usageTracker.records().slice(0, 50),
				cost: s.cost,
				contextUsage: (() => {
					const cu = s.contextUsage;
					if (!cu) return stats.contextUsage;
					// 分母用**策略的有效预算**（= 触发点），而不是模型的物理窗口：这样进度条涨满就
					// 等于即将压缩，与 Codex 的显示口径一致（它的分母是 272k 而不是 872k）。
					// 物理窗口仍由 models.json 拥有；此处只影响展示（FooterBar 的 tokens / N 与百分比）。
					const budget = resolveContextBudget(model?.contextWindow, loadContextPolicy(), modelKeyOf(model));
					const denominator = budget?.triggerTokens ?? cu.contextWindow;
					// 压缩刚结束、下轮响应未到：SDK 报 null，用压缩结果回填约数。
					if (cu.tokens == null && conv.lastCompactionTokens != null && denominator > 0) {
						return {
							tokens: conv.lastCompactionTokens,
							contextWindow: denominator,
							percent: (conv.lastCompactionTokens / denominator) * 100,
							estimated: true,
						};
					}
					return {
						tokens: cu.tokens,
						contextWindow: denominator,
						percent: cu.tokens == null || denominator <= 0 ? null : (cu.tokens / denominator) * 100,
					};
				})(),
			};
		} catch {
			// stats are best-effort
		}
		// 流式 error 同样是中间态（定稿走 message_end/agent_end）：先藏起
		// errorMessage，避免红色在 streaming 气泡里闪一下。最终失败会经由
		// messages 永久标红，不影响告警。
		let streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
		if (streamingMessage?.stopReason === "error") {
			streamingMessage = { ...streamingMessage, errorMessage: undefined };
		}
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			rev,
			// 客户端已持有的历史窗口（快照与增量共用同一口径：增量不改这个数）。
			messagesOmitted: conv.historyOmitted,
			streamingMessage,
			isStreaming: this.session.isStreaming,
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						vision: model.input?.includes("image") ?? false,
					}
				: null,
			thinkingLevel: state.thinkingLevel,
			// Only the levels the current model actually supports — the SDK clamps
			// anything else, so the UI must not offer (or must disable) the rest.
			availableThinkingLevels: this.session.getAvailableThinkingLevels(),
			queue: { steering: conv.queueSteering, followUp: conv.queueFollowUp },
			errorMessage: state.errorMessage,
			retry: conv.retryState ?? null,
			compaction: conv.compactionState ?? null,
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			piAgentInstalled: this.isPiCliInstalled(),
			stats,
		};
	}

	/** Emit one snapshot update — incremental when possible, full otherwise.
	 *
	 *  Persisted messages are content-immutable with reference-stable objects
	 *  (serializeCached), so an IDENTITY WALK over the previous array detects
	 *  append-only growth in O(n) pointer compares. Appends travel as
	 *  snapshot_delta carrying only the new tail + light fields; any mid-array
	 *  change/truncation (switch session, edit fork, compaction) or a forced
	 *  resync falls back to a full snapshot. The 10MB-stringify-per-checkpoint
	 *  cost of big sessions collapses to a few hundred bytes for the common
	 *  "nothing but stats/version changed" checkpoint. */
	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		const cur = this.currentMessages();
		const prev = this.emittedMessages;
		let incremental = !forceFull && prev !== null && this.emittedConvId === this.activeId && prev.length <= cur.length;
		if (incremental && prev) {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i] !== cur[i]) {
					incremental = false;
					break;
				}
			}
		}
		const rev = ++this.snapRev;
		if (incremental && prev) {
			const baseRev = this.emittedRev;
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot_delta",
				conversationId: this.activeId,
				rev,
				baseRev,
				appended: cur.slice(prev.length),
				state: this.buildLightState(rev),
			});
		} else {
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			// 尾部优先：大历史只发最近若干条（@PERF 见 history-window.ts 的 @WHY）。
			// emittedMessages 仍保留**完整**数组——增量路径靠它做身份遍历。
			const window = snapshotWindow(cur, this.conv.historyExpanded);
			this.conv.historyOmitted = window.omitted;
			this.emit({
				type: "snapshot",
				state: { ...this.buildLightState(rev), messages: window.messages },
			});
		}
		// Build + serialize(JSON.stringify, via the sink) cost of this snapshot.
		// Only recorded while a trace is attached — see timing.ts.
		this.timing?.mark(
			incremental
				? `snap-delta[${cur.length}]`
				: `snap-full[${this.conv.historyExpanded ? cur.length : Math.min(cur.length, SNAPSHOT_TAIL_MESSAGES)}+${this.conv.historyOmitted}]`,
		);
	}

	/**
	 * 向上补历史（尾部优先的另一半）：「载入更早」与「搜索/问题导航需要全量」都走它。
	 * 只读内存里的完整消息数组（当前活动对话），命中不到 before 时返回空页并置 complete
	 * ——由客户端的下一次全量快照去校正，绝不猜内容（见 history-window.ts）。
	 */
	loadHistory(opts: { before?: string; limit?: number; all?: boolean } = {}): void {
		if (this.disposed) return;
		const conv = this.conv;
		const page = historyPage(this.currentMessages(), opts);
		// complete = 这一页之前没有更早的消息 → 客户端自此持有完整 transcript，
		// 后续全量快照不再截断（否则刚翻出来的历史会被收回去）。
		if (page.complete) conv.historyExpanded = true;
		conv.historyOmitted = page.omittedBefore;
		this.emit({
			type: "message_page",
			conversationId: this.activeId,
			messages: page.messages,
			omittedBefore: page.omittedBefore,
			complete: page.complete,
		});
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎 ask_user_question customTool）
	// -----------------------------------------------------------------------

	/** 标准引擎模型调 ask_user_question：发 question_pending 给浏览器并阻塞等待
	 *  question_answer。sig 为工具执行信号的当前状态（aborted → 立即 reject）。
	 *  返回 answers（用户选中/自定义），或 null（用户取消）。 */
	askUser(questions: UiQuestion[], sig: { aborted?: boolean }): Promise<QuestionAnswer[] | null> {
		return new Promise((resolve, reject) => {
			if (sig?.aborted || this.disposed) {
				reject(new Error("ask_user_question 已中止"));
				return;
			}
			// 问卷开关（默认开）：关 → 不弹对话框，立即报错让模型得知已禁用。
			if (this.settingsSvc.current.questionnaireEnabled === false) {
				reject(new Error("问卷功能已关闭，可在设置中重新开启"));
				return;
			}
			const id = `q-${++this.questionSeq}`;
			this.pendingQuestions.set(id, resolve);
			this.emit({
				type: "question_pending",
				id,
				questions,
			});
		});
	}

	/** 前端回答模型提问（question_answer → 恢复 askUser 的 Promise）。id 需匹配
	 *  pendingQuestions 中键；cancelled 或未匹配（例如用户早已切走）时按「取消」处理
	 *  —— 把挂起的提问全部 reject，让模型知道用户离开了。 */
	resolveQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean): void {
		const resolve = this.pendingQuestions.get(id);
		if (resolve) {
			this.pendingQuestions.delete(id);
			resolve(cancelled ? null : answers);
		}
	}

	/** 标准引擎的 question_answer 路由入口（index.ts 经 cs.answerQuestion?. 转发）。
	 *  DSH 引擎的 AgentService 也实现了同名方法，此处为 ClientSession 的转发。 */
	answerQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean): Promise<void> {
		this.resolveQuestion(id, answers, cancelled);
		return Promise.resolve();
	}

	/** 关闭所有挂起提问（切对话 / dispose 时清理）：以「取消」解析，避免模型挂死。 */
	cancelPendingQuestions(): void {
		for (const [, resolve] of this.pendingQuestions) {
			resolve(null);
		}
		this.pendingQuestions.clear();
	}

	/**
	 * Whether the pi agent has at least one usable model. ModelRuntime's
	 * available snapshot already accounts for models.json, auth.json, env-var
	 * credentials, OAuth, and runtime API-key overrides. Cached for 2s because
	 * this is called while building frequent snapshots.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		const configured = (this.sharedModelRuntime?.getAvailableSnapshot().length ?? 0) > 0;
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). Cached machine-wide (same binary for every client) for 10s —
	 * the check is only rerun after install or when the cache expires.
	 *
	 * The probe is FORK-FREE: it scans PATH for the pi executable instead of
	 * spawning `pi --version`. Do not reintroduce a spawn here — ANY fork on
	 * the main thread of this multi-threaded server can deadlock the whole
	 * process on Android/Termux (issue #78): libuv's uv_spawn blocks its
	 * caller reading the child's error pipe, and that pipe never closes when
	 * the forked child deadlocks between fork and exec. This applies to
	 * asynchronous spawns too — the previous async probe reproduced the hang.
	 */
	private static piCliProbe: { at: number; installed: boolean } | null = null;
	private static readonly PI_CLI_PROBE_TTL_MS = 10_000;

	private isPiCliInstalled(): boolean {
		const now = Date.now();
		const cached = ClientSession.piCliProbe;
		if (cached && now - cached.at < ClientSession.PI_CLI_PROBE_TTL_MS) return cached.installed;
		const installed = ClientSession.piCliOnPath();
		ClientSession.piCliProbe = { at: now, installed };
		return installed;
	}

	private static piCliOnPath(): boolean {
		const dirs = (process.env.PATH ?? "").split(delimiter);
		for (const dir of dirs) {
			if (dir && existsSync(join(dir, "pi"))) return true;
		}
		return false;
	}

	private static invalidatePiCliProbe(): void {
		ClientSession.piCliProbe = null;
	}

	/**
	 * Run a command async, collecting stdout+stderr; kills on timeout.
	 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
	 * resolve with code -1 so callers can report them as notices.
	 */
	private runAsync(
		cmd: string,
		args: string[],
		timeoutMs: number,
		cwd?: string,
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				p = spawn(cmd, args, {
					...(cwd ? { cwd } : {}),
					stdio: ["ignore", "pipe", "pipe"],
					// Windows: npm and friends are .cmd shims — Node can only exec
					// them through the shell (otherwise spawn npm → ENOENT).
					shell: process.platform === "win32",
				});
			} catch (err) {
				resolve({ code: -1, out: String(err) });
				return;
			}
			let out = "";
			let settled = false;
			const done = (code: number | null, text?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				resolve({ code, out: text ?? out });
			};
			const t = setTimeout(() => p.kill(), timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	/**
	 * Auto-install the pi agent: ensure the config dir exists and install the
	 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
	 * form or by running `pi` in a terminal.
	 */

	/**
	 * Version of the RUNNING pi-web-ui package (read from its own package.json,
	 * resolved from this compiled module: <pkg>/dist/server → <pkg>).
	 */
	private static currentAppVersion(): string {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const pkgRoot = resolve(here, "..", "..");
			const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version?: string };
			return pkg.version ?? "0.0.0";
		} catch {
			return "0.0.0";
		}
	}

	/** Simple numeric semver compare: >0 means a newer than b. */
	private static compareVersions(a: string, b: string): number {
		return compareSemver(a, b);
	}

	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 本客户端成功切换工作区（set_cwd）后触发，参数为新绝对路径。
	 *  attach 时由 AgentService 接到全局 onClientCwdChanged —— 编辑器等
	 *  工作区跟随型插件借此把根目录切到用户当前项目。 */
	onCwdChanged: ((abs: string) => void) | undefined = undefined;

	/** Ask the npm registry for the latest pi-web-ui version and report it. */
	async checkUpdate(): Promise<void> {
		const current = ClientSession.currentAppVersion();
		try {
			// Fetch the full package doc (not /latest): it carries the per-version
			// publish timestamps so the UI can hint when a version was JUST
			// published and the registry/CDN caches may not have caught up yet.
			const res = await fetch("https://registry.npmjs.org/pi-web-ui", {
				signal: AbortSignal.timeout(8_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				"dist-tags"?: { latest?: string };
				time?: Record<string, string>;
			};
			const latest = data["dist-tags"]?.latest ?? null;
			const latestPublishedAt = latest && data.time ? (data.time[latest] ?? null) : null;
			const upToDate = latest === null || ClientSession.compareVersions(current, latest) >= 0;
			this.emit({
				type: "update_status",
				current,
				latest,
				latestPublishedAt,
				upToDate,
			});
		} catch (err) {
			this.emit({
				type: "update_status",
				current,
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				error: `检查更新失败：${(err as Error).message}`,
			});
		}
	}

	/** Cache window for the all-source check: 30 minutes. */
	static UPDATE_ALL_CACHE_MS = 30 * 60_000;
	private updatesAllCache: { at: number; items: UpdateItem[] } | null = null;

	/**
	 * All-source update check: pi-web-ui + the pi core + direct pi extensions
	 * from the agent manifest (fallback: raw walk). Re-emits the cached list
	 * within UPDATE_ALL_CACHE_MS; pass force=true (explicit refresh) to bypass.
	 */
	async checkUpdatesAll(force = false): Promise<void> {
		if (!force && this.updatesAllCache && Date.now() - this.updatesAllCache.at < ClientSession.UPDATE_ALL_CACHE_MS) {
			this.emit({
				type: "update_status_all",
				items: this.updatesAllCache.items,
			});
			return;
		}
		try {
			const targets = collectTargets(this.agentDir, ClientSession.currentAppVersion());
			const items = await checkAllUpdates(targets, undefined, () => this.getLang());
			this.updatesAllCache = { at: Date.now(), items };
			this.emit({ type: "update_status_all", items });
		} catch (err) {
			// checkAll degrades per-item; only local enumeration blowing up lands
			// here — still report a usable (webui-only) error item.
			const items: UpdateItem[] = [
				{
					name: "pi-web-ui",
					kind: "webui",
					current: ClientSession.currentAppVersion(),
					latest: null,
					latestPublishedAt: null,
					upToDate: false,
					error: `检查更新失败：${(err as Error).message}`,
				},
			];
			this.emit({ type: "update_status_all", items });
		}
	}

	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "正在安装 pi agent CLI（npm i -g @earendil-works/pi-coding-agent）…",
				textEn: "Installing pi agent CLI (npm i -g @earendil-works/pi-coding-agent)…",
			});
			const { code, out } = await this.runAsync("npm", ["i", "-g", "@earendil-works/pi-coding-agent"], 180_000);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI 安装完成。填入 API 密钥即可开始，或在终端运行 pi 完成登录。",
					textEn: "✅ pi agent CLI installed. Enter an API key to start, or run pi in a terminal to log in.",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent 安装失败（${code ?? "timeout"}）：${out.slice(0, 400)}`,
					textEn: `pi agent install failed (${code ?? "timeout"}): ${out.slice(0, 400)}`,
				});
				this.emit({
					type: "install_result",
					ok: false,
					detail: out.slice(0, 600),
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `pi agent 安装失败：${(err as Error).message}`,
				textEn: `pi agent install failed: ${(err as Error).message}`,
			});
		}
		// The CLI may just have landed on PATH (or the install may have failed) —
		// drop the probe cache so the next snapshot re-checks.
		ClientSession.invalidatePiCliProbe();
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one).
	 *  forceFull skips the incremental path — used by get_state so a (re)
	 *  connecting or desynced client always receives an authoritative full
	 *  state it can rebuild from. */
	flushSnapshot(forceFull = false): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		// During active streaming the deltas carry live rendering — full snapshots
		// are just a periodic reconciliation checkpoint, so send them far less
		// often (they serialize the whole session; big sessions made this path OOM).
		const interval =
			Date.now() - this.lastDeltaAt < DELTA_ACTIVE_WINDOW_MS ? STREAMING_SNAPSHOT_INTERVAL_MS : SNAPSHOT_INTERVAL_MS;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.emitSnapshotNow();
		}, interval);
	}

	/** Slash-command catalog + native command execution — 自包含模块，见
	 *  slash-commands.ts（内置命令拦截 + 扩展/模板/技能目录推送）。 */
	private readonly slash = new SlashCommandsService({
		emit: (msg) => this.emit(msg),
		cwd: () => this.cwd,
		getSession: () => this.session,
		newChat: () => this.newChat(),
		setModel: (id) => this.setModel(id),
		setCwd: (path) => this.setCwd(path),
		setThinking: (level) => this.setThinking(level),
		renameSession: async (name) => {
			this.session.setSessionName(name);
			this.conv.title = name;
			this.invalidateSessionInfos();
			this.onSessionsListChanged?.(this.cwd);
			this.emitConversations();
			await this.pushSessions();
			this.emit({
				type: "notice",
				level: "info",
				text: `已重命名当前会话为「${name}」`,
				textEn: `Renamed current session to "${name}"`,
			});
			this.flushSnapshot();
		},
		refreshSessions: () => this.refreshSessions(),
		afterReload: () => {
			// /reload 同样重读磁盘 settings.json——重放重试覆盖 + 终端门控。
			this.applyRetryOverrides();
			this.applyToolGating(this.session);
		},
		pluginCommands: () => this.pluginCommandsProvider?.() ?? [],
		execPluginCommand: async (name, args) => {
			const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
			if (!def) return false;
			try {
				const result = await def.run(args, { clientId: this.clientId });
				// 字符串返回值 → 通知条回显给发起人；富展示用 broadcast/sendTo。
				if (typeof result === "string" && result.trim()) {
					this.emit({ type: "notice", level: "info", text: result, textEn: result });
				}
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `插件命令 /${name} 执行失败：${(err as Error).message}`,
					textEn: `Plugin command /${name} failed: ${(err as Error).message}`,
				});
			}
			return true;
		},
		onQuit: () => this.onQuit?.() ?? false,
	});

	/** Catalog push — index.ts get_commands / attach / cwd 切换等都会调用。 */
	pushSlashCommands(): Promise<void> {
		return this.slash.push();
	}

	/** 模型/服务商配置管理 —— 自包含模块，见 model-admin.ts。 */
	private readonly modelAdmin!: ModelAdminService;
	/**
	 * 网关用量查询（NewAPI 一类聚合网关的账单接口；只读、有界、带缓存）。
	 * 见 dev-con/gateway-usage.ts；地址/密钥都用**本会话**的 runtime 解析。
	 */
	private readonly gatewayUsage!: GatewayUsageService;
	/**
	 * Jev 决策门禁（有界 HTTP + TTL 缓存 + 单飞去重 + 事件计数）。
	 * 见 dev-con/jev-gate.ts；配置落盘在 <agentDir>/dev-con/jev-settings.json（只存密钥**名**）。
	 */
	private readonly jev!: JevGate;
	/**
	 * P4 首个切片：逐请求用量历史的实例私有存储（append-only JSONL）。
	 * 写入只发生在 recordUsage()；查询是只读聚合，不参与计费、不改写会话。
	 */
	/** 用量与 Jev 元数据目录（实例私有，不进 Git）。 */
	private readonly usageHistory!: UsageHistoryStore;
	/** 模型目录变化（服务商增删改）→ 让**其他**会话也重算目录。
	 *  @WHY 每个会话有自己的 ModelRuntime（连接时构造的快照），models 消息只发给当前会话时，
	 *    别的标签页会一直拿着旧目录：新服务商显示「该渠道暂无可用的模型」。 */
	onModelCatalogChanged: (() => void) | undefined = undefined;

	/** Persist an api-key credential for a provider (auth.json). */
	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	async clearProviderApiKey(provider: string): Promise<void> {
		await this.modelAdmin.clearProviderApiKey(provider);
		// The provider is back to unconfigured — drop its key preference in
		// EVERY project, otherwise each project switch re-tries a restore.
		this.stateStore.deleteProviderEverywhere(provider.trim());
	}
	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}
	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}
	fetchModelsList(reqId: number, baseUrl: string, apiKey?: string, authHeader?: boolean, api?: string): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang());
	}
	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId, () => this.getLang());
	}
	/** Copy a built-in provider into an editable custom-provider draft
	 *  (clone_provider_result) — lets the user run a second API key without
	 *  overwriting the built-in one. */
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	saveModelConfig(providerId: string, config: unknown): Promise<void> {
		return this.modelAdmin.saveModelConfig(providerId, config as never);
	}
	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId);
	}
	listProviderKeys(): void {
		return this.modelAdmin.listProviderKeys();
	}
	async addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		await this.modelAdmin.addProviderKey(provider, apiKey, name);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, active);
	}
	async activateProviderKey(provider: string, keyName: string): Promise<void> {
		const ok = await this.modelAdmin.activateProviderKey(provider, keyName);
		// Only remember existing keys — a failed switch (deleted key) must not
		// plant a stale reference that errors on every later project switch.
		if (ok) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, keyName);
		else this.stateStore.deleteProjectProviderKey(this.clientId, this.cwd, provider);
	}
	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.removeProviderKey(provider, keyName);
		// The deletion may have been made from another project: every project
		// still pinned to the deleted key must follow the key that took over
		// (or drop the pin when no keys remain), not just the current one.
		const active = this.modelAdmin.getActiveKeyName(provider);
		this.stateStore.repointDeletedKeyEverywhere(provider, keyName, active);
	}

	/** Restore per-project provider keys when entering a project. For each
	 *  provider that has a saved key for `cwd`, activate it if it differs from
	 *  the current global active. Silent + self-healing: a saved key deleted
	 *  elsewhere is dropped without notifying (a noisy error here is what
	 *  haunted project switches after a key deletion).
	 *
	 *  @PERF network:false —— 这是 attach / 切项目 / 切会话的同步路径，远端目录刷新
	 *  放到后台（否则单跳可达数秒，直接变成白屏时间）。 */
	private async restoreProjectProviderKeysForCwd(cwd: string): Promise<void> {
		const saved = this.stateStore.getProjectProviderKeys(this.clientId, cwd);
		if (!saved) return;
		for (const [provider, keyName] of Object.entries(saved)) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === keyName) continue;
			if (!this.modelAdmin.hasProviderKey(provider, keyName)) {
				this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
				continue;
			}
			const ok = await this.modelAdmin.activateProviderKey(provider, keyName, { silent: true, network: false });
			if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
		}
	}

	/** When a model is set, ensure its provider's per-project key is restored.
	 *  Silent + self-healing like the bulk restore above. */
	private async restoreKeyForModel(modelId: string, cwd: string): Promise<void> {
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const saved = this.stateStore.getProjectProviderKey(this.clientId, cwd, provider);
		if (!saved) return;
		const cur = this.modelAdmin.getActiveKeyName(provider);
		if (cur === saved) return;
		if (!this.modelAdmin.hasProviderKey(provider, saved)) {
			this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
			return;
		}
		const ok = await this.modelAdmin.activateProviderKey(provider, saved, { silent: true, network: false });
		if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
	}

	/** Remember the just-selected model (and the key that was active for its
	 *  provider) for the current project. Called IMMEDIATELY on model selection —
	 *  not only after a turn — so switching back to the project restores the exact
	 *  {model, key} left behind, even for a fresh conversation with no assistant
	 *  message yet (the SDK only flushes a model_change to disk once one exists). */
	private rememberProjectModel(modelId: string): void {
		const cwd = this.cwd;
		this.stateStore.saveProjectModel(this.clientId, cwd, modelId);
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, cwd, provider, active);
	}

	/** Restore the project's remembered model (and its provider's key) onto the
	 *  ACTIVE conversation — but ONLY for a conversation the user hasn't really
	 *  started (no messages yet). A conversation that already has content keeps its
	 *  own per-session model: switching back to a RUNNING / completed chat must not
	 *  silently overwrite its model with the project default. So a fresh chat in the
	 *  project gets the remembered model; an in-progress one keeps what it had and
	 *  the user switches via the picker. Silent on failure (model no longer in catalog). */
	private async restoreProjectModelForCwd(cwd: string): Promise<void> {
		const savedModel = this.stateStore.getProjectModel(this.clientId, cwd);
		if (!savedModel) return;
		try {
			if (this.conv.session.getSessionStats().totalMessages > 0) return;
		} catch {
			return;
		}
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = savedModel.indexOf("/");
			if (slash <= 0 || slash === savedModel.length - 1) return;
			const model = mr.getModel(savedModel.slice(0, slash), savedModel.slice(slash + 1));
			if (!model) return;
			const cur = this.session.model;
			const curId = cur ? `${cur.provider}/${cur.id}` : null;
			// Restore the model's provider key first so setModel's auth check passes.
			await this.restoreKeyForModel(savedModel, cwd);
			if (curId === savedModel) return;
			await this.session.setModel(model);
		} catch {
			// model no longer resolvable / key gone — keep the conversation default
		}
	}

	// ---------------------------------------------------------------------------
	// Settings (system prompt / skills / extensions / presets)
	// ---------------------------------------------------------------------------

	/** Push the full settings state (current settings + loaded skills/extensions
	 *  with enabled flags + saved presets). Pushed on attach and after every
	 *  settings change. */
	pushSettings(): void {
		this.settingsSvc.push();
	}

	/** 把设置面板的出错重试次数注入全部存活会话的 SDK SettingsManager。
	 *  applyOverrides 只改内存合并视图（不碰 ~/.pi/agent/settings.json），
	 *  且 SDK 每次退避前都重读 getRetrySettings()——即时生效、无需 reload。
	 *  但 session.reload() 会重读磁盘丢掉覆盖，每次 reload 后必须重放
	 *  （reloadSession / afterReload / 标记开关直载路径均已接）。 */
	applyRetryOverrides(): void {
		const n = normalizeRetryMaxAttempts(this.settingsSvc.current.retryMaxAttempts);
		for (const c of this.convs.values()) {
			try {
				c.session.settingsManager.applyOverrides({ retry: { maxRetries: n } });
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
	}

	/** Extensions/skills changed externally (e.g. `pi remove` finished in the
	 *  terminal): re-run session.reload() and re-push state. Streaming-safe —
	 *  deferred to agent_end, same as settings reloads. */
	async reloadExtensions(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** Persist + apply a partial settings update (prompt text/mode, toggles). */
	async setSettings(partial: {
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
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		subagentDefaultModel?: string | null;
		retryMaxAttempts?: number;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		disabledPlugins?: string[];
		/** 内置服务商「删除」= 从管理模型列表隐藏（纯 UI 偏好，不 reload）。 */
		hiddenBuiltinProviders?: string[];
		/** 模型路由规则：不再出现在选择器里的路由 + 别名映射（纯选择偏好，无需 reload）。 */
		retiredModelRoutes?: string[];
		modelRouteAliases?: Record<string, string>;
		markersEnabled?: boolean;
		disabledMarkers?: string[];
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
	}): Promise<void> {
		const { markersEnabled, disabledMarkers, quickPhrasesSeeded, ...rest } = partial as {
			markersEnabled?: boolean;
			disabledMarkers?: string[];
			quickPhrasesSeeded?: boolean;
		} & typeof partial;
		// 快捷短语「已 seed」是全局标记（非 per-clientId）：置位一次后永久生效。
		if (quickPhrasesSeeded) this.stateStore.markQuickPhrasesSeeded();
		let markerChanged = false;
		if (markersEnabled !== undefined || disabledMarkers !== undefined) {
			this.markerSvc.setAll({
				...(markersEnabled !== undefined ? { markersEnabled } : {}),
				...(disabledMarkers !== undefined ? { disabledMarkers } : {}),
			});
			markerChanged = true;
		}
		await this.settingsSvc.set(rest as never);
		if (markerChanged) {
			// 标记开关影响 system prompt 引导，需重载生效（流式中则延迟）
			this.pushSettings();
			this.flushSnapshot();
			// 尝试立即重载，若流式中会由 SettingsService 延迟到 agent_end
			if (!this.session.isStreaming) {
				try {
					await this.session.reload();
					this.applyRetryOverrides();
					this.applyToolGating(this.session);
					await this.pushSlashCommands();
					this.pushSettings();
				} catch {}
			}
		}
	}

	/** Save the CURRENT settings as a named preset (overwrites if exists). */
	async savePreset(name: string): Promise<void> {
		return this.settingsSvc.savePreset(name);
	}

	/** Replace the current settings with the named preset and apply it. */
	async applyPreset(name: string): Promise<void> {
		return this.settingsSvc.applyPreset(name);
	}

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		return this.settingsSvc.deletePreset(name);
	}

	/** Upsert 一个子代理模板（全局共享）。 */
	async saveSubagentTemplate(template: UiSubagentTemplate): Promise<void> {
		return this.settingsSvc.saveTemplate(template);
	}

	/** 删除一个子代理模板。 */
	async deleteSubagentTemplate(name: string): Promise<void> {
		return this.settingsSvc.deleteTemplate(name);
	}

	/** Make settings effective in the running runtime（流式中则延迟到 agent_end）。 */
	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** 把终端工具开关应用到 session 的活跃工具集：关闭时从活跃集中剔除
	 *  terminal_*（工具仍留在注册表，重开时可直接加回）。session.reload() 与新
	 *  会话创建都会把 custom 工具加回活跃集，所以这两条路径之后都要重放本方法。 */
	private applyToolGating(session: AgentSession): void {
		try {
			const terminalEnabled = this.settingsSvc.current.terminalToolsEnabled !== false;
			const softEditEnabled = this.settingsSvc.current.editSoftEnabled !== false;
			const names = new Set(session.getActiveToolNames());
			for (const n of TERMINAL_TOOL_NAMES) {
				if (terminalEnabled) names.add(n);
				else names.delete(n);
			}
			if (softEditEnabled) names.add(SOFT_EDIT_TOOL_NAME);
			else names.delete(SOFT_EDIT_TOOL_NAME);
			session.setActiveToolsByName([...names]);
		} catch {
			// Session 未就绪——下次创建/reload 会再应用。
		}
	}

	/** 把插件 AI 工具同步进一个已存在的会话（新增/更新/移除）。
	 *  实际 diff 逻辑在 plugins.ts 的 syncPluginToolsIntoSession（可单测）。 */
	private syncPluginTools(session: AgentSession): void {
		try {
			const defs = (this.pluginToolsProvider?.() ?? []).map(pluginToolToDefinition);
			const next = syncPluginToolsIntoSession(
				session as unknown as Parameters<typeof syncPluginToolsIntoSession>[0],
				defs as unknown as Parameters<typeof syncPluginToolsIntoSession>[1],
				this.appliedPluginToolNames,
			);
			if (next) this.appliedPluginToolNames = new Set(next);
		} catch (err) {
			console.error("[plugins] sync tools to session failed:", err);
		}
	}

	/** index.ts 经 pluginMgr.onAgentToolsChanged 触发：把插件 AI 工具推入全部会话。 */
	refreshPluginTools(): void {
		for (const conv of this.convs.values()) this.syncPluginTools(conv.session);
	}

	private async applySettingsReload(): Promise<void> {
		// 兼容旧入口：reload + 刷目录在宿主回调里完成
		return this.settingsSvc.applyRuntime();
	}

	/** Server language for this client (issue #91): resolved LIVE from the
	 *  persisted UI locale — "zh" only for zh*; everything else (including
	 *  never-reported) is English. Per-call tool return values read this on
	 *  every invocation, so they follow language switches with no rebuild. */
	getLang(): ServerLang {
		return resolveServerLang(this.stateStore.get(this.clientId).locale);
	}

	/** Persist the browser UI locale (hello.locale / set_locale) and refresh
	 *  lang-aware prompt segments. Reuses the settings reload path, so it is
	 *  streaming-safe (deferred to agent_end mid-run, same as settings). */
	async setLocale(locale: string): Promise<void> {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		const prev = this.getLang();
		this.stateStore.saveLocale(this.clientId, code);
		if (this.getLang() === prev) return; // same server language — nothing to re-render
		await this.applySettingsReload();
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	/** True when the service is draining (quiesced): emits a rejection notice
	 *  and returns true. Guards every NEW-work entry point (prompt / new chat /
	 *  edit-resend / session resume / goal wizard) — existing runs keep going.
	 *  Called BEFORE any LLM/token work starts so quiesce is a hard admission
	 *  gate, not a best-effort hint. */
	private quiesceBlocked(): boolean {
		if (!this.isQuiesced()) return false;
		this.emit({
			type: "notice",
			level: "error",
			text: "服务器正在排空存量工作（quiesce），已拒绝新的对话/消息/编辑。存量运行会继续跑完；用 pi-web-ui server unquiesce 可恢复。",
			textEn:
				"Server is draining (quiesce) and rejected the new chat/message/edit. Existing runs continue; resume with pi-web-ui server unquiesce.",
		});
		this.flushSnapshot();
		return true;
	}

	/** Conversations with an in-flight run — active work for quiesce status. */
	activeConversations(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += 1;
			} catch {
				// session being replaced — not running
			}
		}
		return n;
	}

	/** Messages queued in the SDK (steer + follow-up) — pending work for
	 *  quiesce status. Quiesce refuses to add more, so this only drains.
	 *
	 *  @GOTCHA 这是「排队总数」，**不是**排空该等的量：见 drainableMessages()。 */
	pendingMessages(): number {
		let n = 0;
		for (const c of this.convs.values()) n += c.queueFollowUp.length + c.queueSteering.length;
		return n;
	}

	/** Messages queued behind a LIVE run — the only pending work worth waiting for.
	 *
	 *  @WHY quiesce 会把一切新工作拒之门外（prompt 直接返回、新客户端 4403），所以**没有运行在
	 *  消费**的队列等多久都不会变。2026-09-18 的生产切换就因此白等 45 分钟
	 *  （active=0、pending=2、无运行在消费），排空循环既不报谁卡住了也不早退。
	 *  排空要等的是「在飞的工作」，不是「队列里的字节」。 */
	drainableMessages(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += c.queueFollowUp.length + c.queueSteering.length;
			} catch {
				// session being replaced — not running, so nothing consumes its queue
			}
		}
		return n;
	}

	/** 排队消息里没有运行消费的那部分（孤儿队列）：不阻塞排空，但必须报出来
	 *  （重启会丢弃它们，界面上的待发气泡要重发）。 */
	orphanedMessages(): number {
		return this.pendingMessages() - this.drainableMessages();
	}

	/** 排空诊断：谁在持有工作。切换日志用它点名，而不是只说「没排空」。 */
	drainHolders(): DrainHolder[] {
		const now = Date.now();
		const holders: DrainHolder[] = [];
		for (const c of this.convs.values()) {
			const queued = c.queueFollowUp.length + c.queueSteering.length;
			let streaming = false;
			try {
				streaming = c.session.isStreaming;
			} catch {
				// session being replaced — treat as not running
			}
			if (!streaming && queued === 0) continue;
			const lastEvent = c.lastSdkEventAt || c.lastActiveAt || now;
			holders.push({
				id: String(c.id).slice(0, 8),
				streaming,
				queued,
				idleSeconds: Math.max(0, Math.round((now - lastEvent) / 1000)),
			});
		}
		return holders;
	}

	async prompt(
		text: string,
		attachments?: {
			path: string;
			mode?: "inline" | "reference" | "lines";
			lines?: { start: number; end: number };
			/** Raw pasted/dropped/uploaded image (base64) — bypasses workspace path. */
			imageData?: string;
			/** Raw uploaded file bytes (base64) — persisted, attached as reference. */
			fileData?: string;
			mimeType?: string;
			name?: string;
			size?: number;
		}[],
		/**
		 * true = followUp: while streaming, queue the prompt and deliver it only
		 * after the WHOLE run finishes (补充 button — "AI 生成结束才发送").
		 * false/undefined = steer: the pi CLI Enter semantic — injected right
		 * after the current turn settles, skipping remaining planned tool calls.
		 */
		queue = false,
	): Promise<void> {
		// Captured at the START (before any await): the conversation being
		// addressed by this prompt. See the naming block below — a concurrent
		// switch/new_chat while prompt() is in flight must never target a
		// different conversation.
		const conv = this.conv;
		try {
			const s = this.session;
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = parseSlash(text);
			if (slash && (await this.slash.exec(slash.name, slash.args))) {
				this.flushSnapshot();
				return;
			}
			// Native commands above are pure config tweaks (no tokens) — allow them
			// even while quiesced. Everything that reaches the SDK is NEW work and
			// is refused until admission reopens.
			if (this.quiesceBlocked()) return;
			// 轨迹用：暂存本轮任务文本，下一轮 agent_start 消费（steer/内部续跑
			// 不经此处，届时 task 缺省，插件回退为「继续执行」）。
			conv.pendingTask = text.trim() ? truncRun(text.trim(), RUN_TASK_CAP) : undefined;
			// Name the conversation from its FIRST prompt immediately, before any
			// await: the typed text IS the name. The `conv` reference was captured
			// before the try block, so a concurrent switch/new_chat while prompt()
			// is in flight can never rename a DIFFERENT conversation — or miss the
			// rename entirely. A failed send still leaves the name, which matches
			// what the user typed intent-wise; the entry_appended fallback below
			// re-derives it from the persisted transcript when needed.
			if (conv.title === DEFAULT_CONV_TITLE && text.trim() && !conv.session.sessionName?.trim()) {
				const trimmed = text.trim().replace(/\s+/g, " ");
				conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
				this.emitConversations();
			}
			// Attach files as independent nextTurn context messages (asides) so the
			// user message stays clean; they render as separate attachment cards.
			const asides = await buildAttachmentMessages(
				{
					cwd: this.cwd,
					clientId: this.clientId,
					emit: (msg) => this.emit(msg),
					settings: this.settingsSvc.current,
					session: this.session,
					// issue #91：附件/视觉桥文案按客户端 UI 语言出中英（英文默认）。
					getLang: () => this.getLang(),
					// DEV-CON §7：视觉桥是真实计费的旁路调用，用量单独标注来源。
					recordUsage: (usage) => this.recordBypassUsage(usage),
				},
				attachments,
			);
			for (const aside of asides) {
				await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
			}
			if (s.isStreaming) {
				// queue=true (补充 button) → followUp: the message is delivered only
				// after the whole run finishes — the agent finishes what it started,
				// then responds to the queued message. queue=false/undefined
				// (plain Enter) → steer: interrupts the current run — the message
				// is delivered right after the current assistant turn settles
				// (remaining planned tool calls are skipped) and the agent
				// immediately responds to it. This is the pi CLI
				// Enter-during-streaming semantic (docs/usage: Enter queues a
				// steering message); followUp would wait for the whole run
				// to finish, which users perceive as ordinary queueing.
				await s.prompt(text, {
					streamingBehavior: queue ? "followUp" : "steer",
				});
			} else {
				await s.prompt(text);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `提示发送失败：${(err as Error).message}`,
				textEn: `Failed to send prompt: ${(err as Error).message}`,
			});
		}
		// The active conversation (captured at prompt start — see above) has been
		// continued since it was opened — it must not be dismissed when the user
		// switches away. (Also bumps the per-project "most recently active"
		// order used by set_cwd.)
		conv.promptedSinceActive = true;
		conv.lastActiveAt = Date.now();
		// Fresh run — restart the stall watchdog window.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		this.flushSnapshot();
	}

	/**
	 * Turn attached files into custom-message payloads.
	 *
	 * Text files are size-aware: small files are inlined into the message so the
	 * model sees them immediately; large files are passed as a <file path="...">
	 * reference and the model reads them on demand with its read tool (which has
	 * built-in truncation). Images are always passed as image content. Mode
	 * "lines" inlines only a 1-based inclusive line range of the file. Raw
	 * pasted/dropped/uploaded images (attachment.imageData) skip the workspace
	 * path entirely and go straight to the model as image content. Raw uploaded
	 * files (attachment.fileData) are persisted under <dataDir>/uploads/ and
	 * attached as absolute-path references (small text ones are inlined).
	 */

	/**
	 * Hard-abort the running agent (Stop button / global 中断). Tries
	 * session.abort() first; if the run is not idle within
	 * HARD_ABORT_TIMEOUT_MS (model stream ignoring the abort signal), the
	 * conversation's runtime is force-disposed and recreated from the last
	 * persisted session so the chat ALWAYS comes back usable — never stuck
	 * overnight. The notice fires only on the forced-reset path.
	 */
	async abort(): Promise<void> {
		// 只停止智能体运行本身；AI 在后台启动的服务由「后台任务」面板单独
		// 管理（可逐个停止或全部关闭），不会在停止对话时被连带杀掉。
		await this.interruptRun(this.conv, "已停止");
		this.flushSnapshot();
	}

	/** 手动重试上次失败的模型调用：自动重试次数（retryMaxAttempts）用完后
	 *  本轮已停止并标红，用户点「重试」再触发一轮 LLM 调用。不新增用户气泡——
	 *  用 display:false 的 custom 消息 triggerTurn 续跑，模型基于完整上下文
	 * （含上次报错）继续生成。流式中 / 无可重试失败时只发 notice 拒绝。 */
	async retryLast(): Promise<void> {
		const conv = this.conv;
		try {
			if (this.quiesceBlocked()) return;
			const s = this.session;
			if (s.isStreaming) {
				this.emit({
					type: "notice",
					level: "info",
					text: "对话正在生成中，无需重试",
					textEn: "The conversation is still generating — no need to retry",
				});
				return;
			}
			if (conv.retryState) {
				this.emit({
					type: "notice",
					level: "info",
					text: "正在自动重试中，稍候即可",
					textEn: "Auto-retry is in progress — please wait",
				});
				return;
			}
			// 最后一轮失败的证据：末尾 stopReason=error 的 assistant 消息。
			let failed: { errorMessage?: unknown; stopReason?: unknown } | null = null;
			try {
				const msgs = s.agent.state.messages;
				for (let i = msgs.length - 1; i >= 0; i--) {
					const m = msgs[i] as { role?: unknown; errorMessage?: unknown; stopReason?: unknown };
					if (m.role !== "assistant") continue;
					if ((typeof m.errorMessage === "string" && m.errorMessage.trim()) || m.stopReason === "error") {
						failed = m;
					}
					break;
				}
			} catch {
				// 会话替换中——按无可重试处理
			}
			if (!failed) {
				this.emit({
					type: "notice",
					level: "info",
					text: "没有可重试的失败：上一轮没有报错结束",
					textEn: "Nothing to retry: the last turn did not end with an error",
				});
				return;
			}
			// 轨迹用：下一轮 agent_start 消费（否则插件回退为「继续执行」）。
			conv.pendingTask = "手动重试上次失败的模型请求";
			await s.sendCustomMessage(
				{
					customType: "manual-retry",
					content: [
						{
							type: "text",
							text: "（系统：用户点击了「重试」。请基于完整上下文重新发起上一次失败的模型请求，继续完成用户的任务。）",
						},
					],
					display: false,
				},
				{ triggerTurn: true },
			);
			conv.promptedSinceActive = true;
			conv.lastActiveAt = Date.now();
			conv.lastSdkEventAt = Date.now();
			conv.stallNoticed = false;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `手动重试失败：${(err as Error).message}`,
				textEn: `Manual retry failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Remove ONE queued prompt text (the ✕ on a pending bubble) so it is neither
	 * shown nor eventually delivered. The pi SDK has no per-item queue API, so we
	 * drain the SDK queue (clearQueue), drop the target text and re-queue the rest
	 * in their original order; the SDK re-emits queue_update which re-syncs
	 * conv.queueSteering / conv.queueFollowUp.
	 */
	async removeQueued(kind: "steer" | "followUp", text: string): Promise<void> {
		const conv = this.conv;
		// Always-defined display mirrors; also the provenance of bubble rendering.
		const local = kind === "steer" ? conv.queueSteering : conv.queueFollowUp;
		if (!local.includes(text)) {
			// Already gone (delivered / cleared elsewhere) — just refresh the display.
			this.flushSnapshot();
			return;
		}
		const s = this.conv.session;
		if (!s) {
			// Runtime not bound yet (fresh conversation) — drop the display mirror;
			// a later queue_update reconciles any SDK-side state.
			const i = local.indexOf(text);
			if (i >= 0) local.splice(i, 1);
			this.flushSnapshot();
			return;
		}
		const { steering, followUp } = s.clearQueue();
		const keptSteering = steering.filter((t) => !(kind === "steer" && t === text));
		const keptFollowUp = followUp.filter((t) => !(kind === "followUp" && t === text));
		// Re-queue the survivors in original order. Guard each call so a single
		// failure can't leave the queue half-drained silently.
		for (const t of keptSteering) {
			try {
				await s.steer(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `重新入队插队消息失败：${(err as Error).message}`,
					textEn: `Failed to re-queue the steer message: ${(err as Error).message}`,
				});
			}
		}
		for (const t of keptFollowUp) {
			try {
				await s.followUp(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `重新入队排队消息失败：${(err as Error).message}`,
					textEn: `Failed to re-queue the queued message: ${(err as Error).message}`,
				});
			}
		}
		this.flushSnapshot();
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	/** 插件任务集合变化时由宿主调用：重推一次 bg_servers（含插件任务）。 */
	refreshBgTasks(): void {
		this.bg.push();
	}

	/** 插件设置保存结果等需要从 index.ts 发 notice 时用（emit 是私有的）。 */
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.emit({ type: "notice", level, text, textEn });
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	/** Kill ONE background server (by port) OR a plugin task (by taskId). */
	async killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean> {
		if (taskId) {
			// 插件任务：交给插件管理器 stop 回调（不杀进程树——任务在宿主进程内）。
			const ok = this.pluginStopBgTask?.(taskId) ?? false;
			if (!ok) {
				this.emit({
					type: "notice",
					level: "info",
					text: `后台任务「${taskId}」不存在或已结束`,
					textEn: `Background task "${taskId}" does not exist or has ended`,
				});
			}
			this.bg.push();
			this.flushSnapshot();
			return ok;
		}
		if (typeof port !== "number") return false;
		return this.bg.killOne(port);
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	/** Kill only the running bash command(s) — the agent run itself continues
	 *  (the bash tool returns an aborted error and the model moves on). Uses
	 *  the per-client AbortController set registered by the bash tool paths
	 *  ({@link makeKillableBashTool} / {@link makeTerminalBashTool}). */
	async abortBash(): Promise<void> {
		if (this.bashKills.size === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "当前没有正在运行的 bash 命令",
				textEn: "No bash command is running",
			});
			this.flushSnapshot();
			return;
		}
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const ac of [...this.bashKills]) ac.abort();
		this.emit({
			type: "notice",
			level: "info",
			text: "已停止 bash 命令（对话继续）",
			textEn: "Bash command stopped (conversation continues)",
		});
		// 让 AI 明确知道是用户手动停止：sendUserMessage 触发下一轮，agent
		// 会看到「命令被用户中止」而不是普通失败，并据此继续（不会困惑于
		// 为什么命令失败了）。
		try {
			await this.conv.runtime.session.sendUserMessage(
				"（系统：用户手动停止了刚才的 bash 命令——命令被中止，终止前已输出的内容在对应工具结果里。请据此继续，不要重跑被中止的命令，除非确实必要。）",
			);
		} catch {
			// best effort — 消息注入失败不影响命令已停止的事实
		}
		this.flushSnapshot();
	}

	/** Interrupt a run: abort, with a force-reset fallback on timeout. */
	private async interruptRun(conv: Conversation, reason: string): Promise<void> {
		// The run is only truly stopped when its agent_end event arrives:
		// session.abort() can return without stopping anything when the run is
		// stuck before the agent even started (e.g. a model stream that never
		// begins), so we watch for agent_end and force-reset when it never
		// comes — abort 卡住（超时）或空转（结算窗口）两条路都覆盖。
		let ended = false;
		let forced = false;
		const off = conv.session.subscribe((e) => {
			if (e.type === "agent_end") {
				ended = true;
			}
		});
		const force = () => {
			if (forced) return;
			forced = true;
			void this.forceResetConversation(conv, `${reason}：运行未终止，已强制重置当前对话`);
		};
		// 1) abort itself hangs (model stream ignores the signal) → hard kill.
		const abortTimer = setTimeout(() => {
			if (!ended) force();
		}, ClientSession.HARD_ABORT_TIMEOUT_MS);
		abortTimer.unref?.();
		// 2) abort itself (Stop semantics: kills the process tree, emits
		//    agent_end with stopReason "aborted" on the normal path).
		try {
			await conv.runtime.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `中止失败：${(err as Error).message}`,
				textEn: `Abort failed: ${(err as Error).message}`,
			});
		}
		// 3) abort returned but no agent_end within the settle window → the
		//    run was stuck before it started; force-reset to recover.
		if (!ended) {
			await new Promise((r) => setTimeout(r, ClientSession.HARD_ABORT_SETTLE_MS));
		}
		clearTimeout(abortTimer);
		off();
		if (!ended) force();
	}

	/** Force-reset a conversation: dispose the stuck runtime (kills the hung
	 *  model stream / child processes) and rebuild it from the most recent
	 *  persisted session. The conversation record itself is kept (same id,
	 *  same cwd, same serialization caches), so the UI stays attached. */
	private async forceResetConversation(conv: Conversation, reason: string): Promise<void> {
		try {
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			this.clearAllToolWatchdogs(conv);
			conv.toolStartTimes.clear();
			await conv.runtime.dispose();
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(conv.terminals, undefined, conv.id), {
				cwd: conv.cwd,
				agentDir: this.agentDir,
				sessionManager: SessionManager.continueRecent(conv.cwd),
			});
			conv.runtime = runtime;
			conv.session = runtime.session;
			this.emit({
				type: "notice",
				level: "warning",
				text: reason,
				textEn: `${reason} (forced reset: run did not terminate)`,
			});
			await this.bindSession();
			this.emitConversations();
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `强制中断失败：${(err as Error).message}`,
				textEn: `Force-stop failed: ${(err as Error).message}`,
			});
		}
	}

	async newChat(): Promise<void> {
		if (this.quiesceBlocked()) return;
		// Reuse an already-open blank conversation instead of piling up new ones
		// on every click: if the active chat has no messages it IS the new chat
		// (focus already on it); otherwise switch to the first blank one (under
		// the per-project running-list model displaced blanks are disposed, so
		// this branch normally can't exist — kept as a safety net).
		const isBlank = (c: Conversation): boolean => {
			if (c.isSubagent || c.cwd !== this.cwd || conversationBusy(c)) return false;
			try {
				return c.session.getSessionStats().totalMessages === 0 && c.terminals.list().length === 0;
			} catch {
				// session being replaced — treat as used so we don't switch onto it
				return false;
			}
		};
		const active = this.conv;
		if (active && isBlank(active)) {
			this.flushSnapshot();
			return;
		}
		for (const conv of this.convs.values()) {
			if (conv.id === this.activeId) continue;
			if (isBlank(conv)) {
				await this.switchConversation(conv.id);
				this.flushSnapshot();
				return;
			}
		}
		// Completed work is an evictable cache, not a reason to reject new chats.
		this.maintenance.reap();
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = this.displaceActive();
		// Carry the model chosen in the active chat over to the new chat so it
		// doesn't silently revert to the ModelRuntime default model.
		const prevModel = this.conv.session.agent.state.model ?? null;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, undefined, conversationId), {
				cwd: this.cwd,
				agentDir: this.agentDir,
				sessionManager: SessionManager.create(this.cwd),
			});
			const conv = this.makeConversation(runtime, conversationId, terminals);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// A fresh transcript appeared in the sessions dir — the next listing
			// must see it, not the pre-newChat fridge snapshot.
			this.invalidateSessionInfos();
			// 多端：新会话让其他端的列表也跟上。
			this.onSessionsListChanged?.(this.cwd);
			this.emitConversations();
			// New session seeds with the ModelRuntime default model — restore the
			// model the user had selected in the previous chat.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
					const p = (prevModel as unknown as { provider: string }).provider;
					const mid = `${p}/${(prevModel as unknown as { id: string }).id}`;
					await this.restoreKeyForModel(mid, this.cwd);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The new runtime re-discovered skills/templates — refresh the catalog
			// so the picker stops showing the previous runtime's list.
			void this.pushSlashCommands();
			// 新对话即当前打开 → 插件重拉（轨迹视图跟随）。
			this.notifyConversationChanged();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `新建对话失败：${(err as Error).message}`,
				textEn: `Failed to create chat: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * The active conversation is being left (new_chat / switch_conversation /
	 * set_cwd). Runs the running-list lifecycle:
	 *
	 * - still streaming → it becomes a background run: ensure it is listed;
	 * - idle + listed + continued → keep it (the user did continue it);
	 * - any retained terminal state → keep it listed until the terminals are closed;
	 * - idle + listed + opened-but-not-continued, or never listed at all → the
	 *   caller must drop it (returns it so removal happens only after the
	 *   active conversation has been switched away).
	 */
	private displaceActive(): Conversation | null {
		const conv = this.conv;
		// An isolated reviewer can keep working while the main session is idle;
		// retain that conversation so its review is not disposed when the user
		// switches away without sending another prompt.
		// 同时检查磁盘上的未过期 wait-subscription 记录：后台子代理运行结束后
		// 仍欠本会话一次唤醒回合；此时释放运行时会杀死 pi-subagents 扩展宿主，
		// 唤醒永远无法送达（会话表现为无限期停摆）。保留是自限的：记录过期后
		// 不再阻止释放。
		// Also retain when a non-expired pi-subagents wait-subscription record
		// exists on disk for this session: a finished background subagent run
		// still owes this conversation a wake-up turn.
		// 更靠前的阶段：run 本身还在 queued/running（workflow 编排中）时释放
		// runtime 同样杀死扩展宿主并 abort 所有 live workflow controller，比
		// wake 订阅早一步——磁盘 .active-runs marker + status.json 探测（pi-web-ui #52）。
		// Retain while the session has active (queued/running) pi-subagents async
		// runs on disk — the extension host would otherwise be torn down and its
		// workflow controllers aborted mid-flight.
		// Also retain a parent while any live first-party subagent conversation
		// points at it: dropping an idle in-memory parent orphans the child row
		// (the child vanishes from Running Chats with no result available).
		const hasLiveChild = [...this.convs.values()].some((child) => child.parentId === conv.id);
		const retained =
			hasLiveChild ||
			shouldRetainActive({
				reviewing: conv.goal.reviewing,
				wizardRunning: conv.wizardRunning,
				streaming: conv.session.isStreaming,
				openTerminals: conv.terminals.countLive(),
				listed: conv.listed,
				promptedSinceActive: conv.promptedSinceActive,
				hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
				hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
			});
		if (conv.isSubagent || conversationBusy(conv) || retained) {
			conv.listed = true;
			return null;
		}
		return conv;
	}

	/** Remove a conversation from the running list and free its runtime. The
	 *  session stays persisted on disk, so it remains recoverable from the
	 *  history list. Never removes the active conversation. */
	private removeConversation(id: string): void {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return;
		this.convs.delete(id);
		this.clearAllToolWatchdogs(conv);
		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		void conv.runtime.dispose().catch(() => {});
	}

	/** Switch the ACTIVE conversation without interrupting any other chat. */
	async switchConversation(id: string): Promise<void> {
		const trace = startTrace(`switch-conv ${this.clientId}`, { conv: "memory" });
		this.timing = trace;
		try {
			await this.switchConversationInner(id, trace);
		} finally {
			// Always answer a switch request with a snapshot, even when the id was
			// unknown or already active: the client has nothing else to synchronise on.
			this.flushSnapshot();
			trace?.end();
			this.timing = undefined;
		}
	}

	/** Applies the switch in place; the caller owns the snapshot + trace lifecycle. */
	private async switchConversationInner(id: string, trace?: TimingTrace): Promise<void> {
		if (!this.convs.has(id)) await traceStep(trace, "restore", () => this.maintenance.restore(id));
		if (!this.convs.has(id) || id === this.activeId) return;
		const displaced = this.displaceActive();
		this.activeId = id;
		this.conv.subagentStarting = false;
		const newCwd = this.conv.cwd;
		// A listed conversation may belong to ANOTHER project (cross-project
		// running list). Switching to it must also switch the active workspace
		// — otherwise the file tree / session history / recent-projects order
		// would keep showing the OLD project while the chat shows the new one.
		const cwdChanged = newCwd !== this.cwd;
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		this.webUi.refresh();
		this.emitConversations();
		this.goalSvc.emitGoalStatus();
		this.pushTerminals();
		// The switched-to conversation has its own runtime (own resource cache).
		void this.pushSlashCommands();
		if (cwdChanged) {
			this.cwd = newCwd;
			await traceStep(trace, "keys", () => this.restoreProjectProviderKeysForCwd(newCwd));
			await traceStep(trace, "model", () => this.restoreProjectModelForCwd(newCwd));
			// Mirror set_cwd's project-switch side-effects so the whole UI follows
			// the new workspace, not just the chat pane.
			try {
				this.onCwdChanged?.(newCwd);
			} catch {
				/* hook failure must not break the switch */
			}
			this.stateStore.remember(this.clientId, newCwd);
			void this.pushProjects();
			void this.refreshSessions();
			void this.listFiles(undefined);
			void this.listCommands();
		}
		// 当前打开对话变了 → 插件重拉（轨迹视图切会话后即刷新，不等轮询）。
		this.notifyConversationChanged();
	}

	/** Push every running conversation across ALL projects to the client. The
	 *  running-conversation list is global so a background run from another
	 *  workspace stays visible; clicking one switches both the conversation and
	 *  its project (see switchConversation). The client groups the list by cwd. */
	private emitConversations(): void {
		this.maintenance.schedule();
		const conversations: ConversationSummary[] = [];
		// Active parents are normally absent from Running. Keep them visible while
		// listed subagents hang under them, so both rows remain clickable.
		const visibleParents = new Set(
			[...this.convs.values()]
				.filter((conv) => conv.listed)
				.map((conv) => conv.parentId)
				.filter(Boolean),
		);
		for (const conv of this.convs.values()) {
			if (!conv.listed && !visibleParents.has(conv.id)) continue;
			let messageCount = 0;
			let isStreaming = false;
			try {
				messageCount = conv.session.getSessionStats().totalMessages;
				isStreaming = conv.session.isStreaming;
			} catch {
				// session being replaced — report defaults
			}
			conversations.push({
				id: conv.id,
				title: conv.title,
				cwd: conv.cwd,
				messageCount,
				isStreaming,
				isSubagent: !!conv.isSubagent,
				// 子代理带 error 标记：左栏红点提示（普通对话不参与）。
				...(conv.isSubagent ? subagentRunOutcome(conv) : {}),
				parentId: conv.parentId,
			});
		}
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
		});
	}

	/** List persisted sessions for this client, newest first. */
	/** The client asked for the session list at least once (lazy loading) —
	 *  background refreshes only re-push when this is true, so a mobile
	 *  client that never opened the panel never pays the disk scan. */
	private sessionsRequested = false;

	private readonly sessionHistory = this.makeSessionCache((cwd) => SessionManager.list(cwd, piSessionsRoot()));

	/** Every-project scan for the project switcher. `listAll` parses EVERY persisted
	 *  transcript (measured 2026-09-16: 960ms across 25 files / 75MB) and used to run
	 *  uncached on every attach, every cwd change and every list invalidation.
	 *  @PERF TTL 30s 只作为签名不可用时的兜底；正常情况下由签名 gate 决定是否重扫。 */
	private readonly projectSessions = this.makeSessionCache(() => SessionManager.listAll(piSessionsRoot()), 30_000);

	/** 本进程正在写入的会话文件（运行中的对话）。签名 gate 对它们豁免：这些写入的
	 *  事实源就是内存里的会话本身，没必要为它们重扫整份磁盘；由 agent_end 的
	 *  broadcastPersistedNode() → invalidateSessionInfos() 在每轮结束时统一刷新。
	 *  @PERF 没有这道豁免时，运行期每 800ms 防抖推送都会触发一次 540ms 全量重扫。 */
	private readonly liveSessionFiles = new Set<string>();

	/** 系统级上下文策略（<agentDir>/context-policy.json，按 mtime 热生效）。
	 *  懒建：agentDir 在构造函数里赋值，而字段初始化早于构造体，因此不能在字段里直接建。 */
	private policyLoader?: () => ContextPolicy;
	private contextPolicyLoader(): () => ContextPolicy {
		this.policyLoader ??= makeContextPolicyLoader(this.agentDir);
		return this.policyLoader;
	}

	/** 会话列表缓存：签名 gate（磁盘没变就不重新解析 jsonl）+ 运行中会话豁免。 */
	private makeSessionCache(
		load: (cwd: string) => Promise<SessionInfo[]>,
		ttlMs?: number,
	): SessionHistoryCache {
		return new SessionHistoryCache(load, ttlMs, undefined, undefined, {
			signature: () => scanSessionStamps(sessionsRootDir(this.agentDir)),
			adopted: (path) => this.liveSessionFiles.has(path),
		});
	}

	/** 记住「这个会话文件是本端在写」；其磁盘签名变化不再触发列表重扫。 */
	private markLiveSessionFile(conv: Conversation): void {
		const file = conv.session.sessionFile;
		if (file) this.liveSessionFiles.add(file);
	}

	/** 本轮结束：文件不再是「本端正在写」，让下一次列表刷新真正重扫一次（拿到最新
	 *  messageCount / modified）。 */
	private endLiveSessionFile(conv: Conversation): void {
		const file = conv.session.sessionFile;
		if (file) this.liveSessionFiles.delete(file);
	}

	/** Fixed key: the all-projects scan ignores cwd (see projectSessions). */
	private static readonly ALL_PROJECTS_KEY = "*";

	private loadSessionInfos(cwd = this.cwd): Promise<SessionInfo[]> {
		return this.sessionHistory.get(cwd);
	}

	private loadAllSessionInfos(): Promise<SessionInfo[]> {
		return this.projectSessions.get(ClientSession.ALL_PROJECTS_KEY);
	}

	private invalidateSessionInfos(cwd = this.cwd): void {
		this.sessionHistory.invalidate(cwd);
		// The all-projects set is a superset — any per-project change affects it.
		this.projectSessions.invalidate(ClientSession.ALL_PROJECTS_KEY);
	}

	/** Push the persisted session list to the client (client-requested). */
	async refreshSessions(): Promise<void> {
		this.sessionsRequested = true;
		await this.pushSessions();
	}

	private async pushSessions(force = false): Promise<void> {
		if (!this.sessionsRequested && !force) return;
		const cwd = this.cwd;
		try {
			// Sessions live in the SDK default per-project dir
			// (<agentDir>/sessions/--<cwd>--/), the same files the pi CLI/TUI
			// use — one listing covers every conversation of the current folder.
			const infos = await this.loadSessionInfos(cwd);
			if (this.disposed || cwd !== this.cwd) return;

			const sessions = new Map<string, SessionSummary>();
			for (const s of infos) {
				sessions.set(s.path, {
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					source: "web",
				});
			}
			const sorted = [...sessions.values()].sort((a, b) => b.modified - a.modified).slice(0, 200); // newest first — the panel shows recent history
			this.emit({ type: "sessions", sessions: sorted });
		} catch {
			if (!this.disposed && cwd === this.cwd) this.emit({ type: "sessions", sessions: [] });
		}
	}

	/** 其他端在本项目下写入/新建/删除/改名了会话 → 让本端的会话列表跟上。
	 *  列表按 cwd 过滤：不同项目不必理会（切到该项目时本来就会 refreshSessions）。 */
	notifyExternalSessionsChanged(cwd: string): void {
		if (this.disposed) return;
		this.invalidateSessionInfos(cwd);
		if (cwd !== this.cwd) return;
		// force keeps other devices' history current even before their panel opens.
		void this.pushSessions(true);
	}

	/** 本端一个节点完成（transcript 已落盘）→ 广播给其他端（列表刷新 + 接力重载）。
	 *  子代理/内存会话没有 sessionFile，或会话正被替换时静默跳过。 */
	private broadcastPersistedNode(conv: Conversation): void {
		try {
			const file = conv.session.sessionFile;
			if (!file) return;
			// 本轮已结束：撤销「本端在写」豁免，让随后的列表刷新真正重扫一次。
			this.endLiveSessionFile(conv);
			this.invalidateSessionInfos(conv.cwd);
			// 记下自己刚写入的签名，避免下次接入时把自己的写当作「其他端的更新」重载。
			this.updateDiskSig(conv);
			this.onSessionPersisted?.(file, conv.cwd);
		} catch {
			/* 无文件 / 会话正被替换 — 无需广播 */
		}
	}

	/** 其他端完成了该会话文件的一个节点 → 若本端持有它，从磁盘接力重载。
	 *  本端正在流式输出/有排队消息时置 pending，由本轮 agent_end 补做（绝不打断）。 */
	async reloadIfHolding(file: string): Promise<void> {
		if (this.disposed) return;
		let target: string;
		try {
			target = resolve(file);
		} catch {
			return;
		}
		for (const conv of this.convs.values()) {
			const own = conv.session.sessionFile;
			if (!own || resolve(own) !== target) continue;
			if (conv.reloadInFlight) {
				conv.pendingDiskReload = true;
				continue;
			}
			if (conv.session.isStreaming || conv.queueSteering.length > 0 || conv.queueFollowUp.length > 0) {
				conv.pendingDiskReload = true;
				continue;
			}
			await this.reloadConversationFromDisk(conv);
		}
	}

	/** 本端一轮结束（agent_end）后，补做期间收到的接力重载。 */
	private async flushPendingDiskReloads(): Promise<void> {
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: awaited reloads can change the conversation map
		for (const conv of [...this.convs.values()]) {
			if (!conv.pendingDiskReload || conv.session.isStreaming) continue;
			await this.reloadConversationFromDisk(conv);
		}
	}

	/**
	 * 从磁盘重新载入一个对话的 runtime（多端接力）：其他端完成节点后，把本端该
	 * 会话的内存状态换成磁盘上的最新 transcript。**就地替换**——保留对话 id、
	 * 所属项目与终端，并重置按对话隔离的消息序列化缓存。
	 * 调用方必须保证该对话当前没有本地流式输出 / 排队消息。
	 */
	private async reloadConversationFromDisk(conv: Conversation): Promise<void> {
		const file = conv.session.sessionFile;
		if (!file || conv.session.isStreaming || this.disposed) return;
		if (conv.reloadInFlight) {
			conv.pendingDiskReload = true;
			return;
		}
		if (conv.queueSteering.length > 0 || conv.queueFollowUp.length > 0) {
			conv.pendingDiskReload = true;
			return;
		}
		conv.reloadInFlight = true;
		conv.pendingDiskReload = false;
		try {
			const sessionManager = SessionManager.open(file);
			const oldRuntime = conv.runtime;
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(conv.terminals, undefined, conv.id), {
				cwd: conv.cwd,
				agentDir: this.agentDir,
				sessionManager,
			});
			// 先停旧事件订阅、释放旧 runtime（解除其扩展绑定），再换新的：避免两个
			// runtime 的扩展同时挂在 webUi 上产生重复 widget/status。
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			try {
				await oldRuntime.dispose();
			} catch {
				/* 旧 runtime 释放失败不影响接力结果 */
			}
			this.clearAllToolWatchdogs(conv);
			conv.runtime = runtime;
			conv.session = runtime.session;
			// 消息集合变了：清掉按对话隔离的序列化缓存，强制重建 UI 消息数组。
			conv.msgIds = new Map();
			conv.nextMsgId = 1;
			conv.userSeqByTs = new Map();
			conv.uiMessageCache = new Map();
			conv.lastMessagesSig = "";
			conv.lastMessagesArray = [];
			conv.deltaSeq = 0;
			conv.queueSteering = [];
			conv.queueFollowUp = [];
			conv.toolStartTimes = new Map();
			await this.bindConversation(conv);
			this.applyRetryOverrides();
			if (conv.id === this.activeId) this.flushSnapshot(true);
			this.emitConversations();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `接力刷新会话失败：${(err as Error).message}`,
				textEn: `Failed to refresh the session from disk: ${(err as Error).message}`,
			});
		} finally {
			conv.reloadInFlight = false;
			// 重载期间又收到节点完成（已置 pending）→ 补做一次。
			if (conv.pendingDiskReload && !this.disposed) void this.flushPendingDiskReloads();
		}
	}

	/** Remove an entry from the client's recent-project list (UI state only). */
	async removeProject(path: string): Promise<void> {
		this.stateStore.removeProject(this.clientId, path);
		await this.pushProjects();
	}

	/** Permanently delete a persisted session transcript file (history list ✕).
	 *
	 * Deleting the ACTIVE conversation's own transcript is allowed: the session
	 * first switches away to the next-latest persisted chat (or a fresh blank
	 * chat when no other history exists). If the displacement could not release
	 * the file (streaming / open terminals / pending wake subscription /
	 * conversation cap), the deletion is aborted with a notice instead of
	 * yanking the file out of a live runtime. Background conversations still
	 * block deletion outright.
	 */
	async deleteSession(path: string): Promise<void> {
		try {
			const abs = resolve(path);
			// Guardrail: only transcripts under the shared sessions root
			// (<agentDir>/sessions/) may be deleted — never arbitrary files.
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能删除会话目录中的对话记录",
					textEn: "Only transcripts inside the session directory can be deleted",
				});
				return;
			}
			// A live conversation may hold the target transcript. A BACKGROUND
			// conversation must still block deletion outright, but when the ACTIVE
			// conversation holds it the request can be satisfied by switching away
			// first (next-latest history chat, or a fresh blank one) and letting
			// the displacement drop the old runtime.
			const holdsTarget = (conv: Conversation): boolean => {
				const file = conv.session.sessionFile;
				return file !== undefined && resolve(file) === abs;
			};
			const holder = [...this.convs.values()].find(holdsTarget);
			if (holder && holder.id !== this.activeId) {
				this.emit({
					type: "notice",
					level: "warning",
					text: "该对话正在后台运行，请先停止或关闭该对话再删除",
					textEn: "This conversation is still running — stop or close it before deleting",
				});
				return;
			}
			if (holder) {
				// Same source the history panel uses (refreshSessions): newest first.
				const infos = await SessionManager.list(this.cwd, piSessionsRoot());
				const next = infos
					.filter((s) => resolve(s.path) !== abs)
					.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
				if (next) await this.switchSession(next.path);
				else await this.newChat();
				// displaceActive() may have RETAINED the old conversation as a
				// background run (streaming, open terminals, pending wake
				// subscription, conversation cap) — in every such case the file is
				// still held, so abort instead of yanking it from a live runtime.
				// Only a conversation that is genuinely still running in the
				// background (streaming / listed) keeps the "wait for it" notice;
				// a retained-but-idle hold means the switch itself failed (cap,
				// quiesce, runtime creation) — say that instead.
				const stillHeld = [...this.convs.values()].find(holdsTarget);
				if (stillHeld) {
					let stillRunning = stillHeld.listed;
					try {
						stillRunning = stillHeld.session.isStreaming || stillRunning;
					} catch {
						// session being replaced — keep the listed-flag fallback
					}
					this.emit({
						type: "notice",
						level: "warning",
						text: stillRunning
							? "对话仍在后台运行，已停止删除；请等待其结束后再删除"
							: "未能切换到其他对话，已取消删除本次操作",
						textEn: stillRunning
							? "Conversation is still running in the background; delete aborted — wait for it to finish and retry"
							: "Could not switch to another conversation; delete cancelled",
					});
					return;
				}
			}
			rmSync(abs, { force: true });
			// Bust the brief session-info fridge: refreshSessions() below usually
			// lands inside its 3s TTL and would otherwise re-serve a listing that
			// still contains the deleted transcript.
			this.invalidateSessionInfos();
			await this.refreshSessions();
			this.onSessionsListChanged?.(this.cwd);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除会话失败：${(err as Error).message}`,
				textEn: `Failed to delete session: ${(err as Error).message}`,
			});
		}
	}

	/** Rename a persisted session by appending a session_info entry — the same
	 *  mechanism pi's /name uses (SessionManager.appendSessionInfo). Works on
	 *  any transcript under the sessions root, live or not; no session switch. */
	async renameSession(path: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const abs = resolve(path);
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能重命名会话目录中的对话记录",
					textEn: "Only transcripts inside the session directory can be renamed",
				});
				return;
			}
			const mgr = SessionManager.open(abs);
			mgr.appendSessionInfo(trimmed);
			this.setConversationTitleForFile(abs, trimmed);
			this.invalidateSessionInfos();
			await this.refreshSessions();
			this.onSessionsListChanged?.(this.cwd);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重命名会话失败：${(err as Error).message}`,
				textEn: `Failed to rename session: ${(err as Error).message}`,
			});
		}
	}

	/** Rename a live conversation by id: retitle in memory AND persist a
	 *  session_info entry to its transcript so History matches immediately. */
	async renameConversation(id: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const conv = this.convs.get(id);
			if (!conv) return;
			conv.title = trimmed;
			try {
				const file = conv.session.sessionFile;
				if (file !== undefined) SessionManager.open(resolve(file)).appendSessionInfo(trimmed);
			} catch {
				// in-memory title still updated; transcript write is best-effort
			}
			this.emitConversations();
			this.invalidateSessionInfos(conv.cwd);
			this.onSessionsListChanged?.(conv.cwd);
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重命名对话失败：${(err as Error).message}`,
				textEn: `Failed to rename conversation: ${(err as Error).message}`,
			});
		}
	}

	/** Point every live conversation holding this transcript file at a new title. */
	private setConversationTitleForFile(abs: string, title: string): void {
		let changed = false;
		for (const conv of this.convs.values()) {
			const file = conv.session.sessionFile;
			if (file !== undefined && resolve(file) === abs) {
				conv.title = title;
				changed = true;
			}
		}
		if (changed) this.emitConversations();
	}

	/** Dismiss a running conversation from the left-panel list without deleting its
	 *  transcript file. Only idle (non-streaming) conversations that are not
	 *  retained by terminal/wake/review state can be dismissed. The session stays
	 *  in history and can be reopened. */
	async dismissConversation(id: string): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		if (id === this.activeId) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "当前对话不能直接移出，请先切换到其他对话",
				textEn: "The active conversation cannot be removed directly — switch to another conversation first",
			});
			return;
		}
		if (!conv.listed) {
			// Not in list anyway — nothing to do.
			this.emitConversations();
			return;
		}
		// Streaming / retained conversations refuse dismissal — mirrors displaceActive retention.
		// A parent with live children also refuses: dropping it orphans the child rows.
		const hasLiveChild = [...this.convs.values()].some((child) => child.parentId === id);
		const retained = hasLiveChild || conversationBusy(conv);
		if (retained) {
			if (conv.session.isStreaming) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `对话「${conv.title}」仍在运行中，请先等待结束或点击停止后再移出`,
					textEn: `Conversation "${conv.title}" is still running — wait for it to finish or press Stop before removing`,
				});
			} else if (conv.terminals.countLive() > 0) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `对话「${conv.title}」还有未关闭的终端，请先关闭终端后再移出`,
					textEn: `Conversation "${conv.title}" still has open terminals — close them before removing`,
				});
			} else if (hasLiveChild) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `对话「${conv.title}」还有运行中的子代理，请先移出子代理后再移出`,
					textEn: `Conversation "${conv.title}" still has running subagents — remove them first`,
				});
			} else {
				this.emit({
					type: "notice",
					level: "warning",
					text: `对话「${conv.title}」暂时无法移出（存在待处理的后台任务/审查）`,
					textEn: `Conversation "${conv.title}" cannot be removed right now (pending background task/review)`,
				});
			}
			return;
		}
		if (conv.isSubagent) this.maintenance.reap();
		else this.removeConversation(id);
		this.emitConversations();
		this.flushSnapshot();
	}

	/** Open a persisted session as the active conversation (from listSessions).
	 *
	 * A persisted-session click must follow the same ownership rule as
	 * new_chat/switch_conversation: every open conversation keeps its own
	 * runtime. AgentSessionRuntime.switchSession() tears down (and aborts) the
	 * current runtime, which would otherwise stop a response merely because the
	 * user opened history while it was streaming.
	 */
	async switchSession(path: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trace = startTrace(`switch-session ${this.clientId}`, { conv: "disk" });
		this.timing = trace;
		/** Set when the target session is already open: that path ends the trace
		 *  itself (switchConversation owns its own trace + snapshot). */
		let handedOff = false;
		let openedRuntime: AgentSessionRuntime | null = null;
		let openedTerminals: TerminalManager | null = null;
		try {
			const targetPath = resolve(path);

			// A session may already be open in the running-conversation map. Reuse it
			// instead of creating a second writer for the same JSONL transcript.
			for (const conv of this.convs.values()) {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) {
					handedOff = true;
					await this.switchConversation(conv.id);
					return;
				}
			}

			const sessionManager = SessionManager.open(targetPath);
			trace?.mark("open");
			const targetCwd = sessionManager.getCwd();
			const conversationId = this.nextConversationId();
			openedTerminals = this.makeTerminalManager(conversationId, targetCwd);
			openedRuntime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(openedTerminals, undefined, conversationId),
				{
					cwd: targetCwd,
					agentDir: this.agentDir,
					sessionManager,
				},
			);
			trace?.mark("runtime");

			// Only displace the old active conversation after the replacement runtime
			// is known-good. This keeps a failed history open entirely non-destructive.
			const displaced = this.displaceActive();
			const conv = this.makeConversation(openedRuntime, conversationId, openedTerminals);
			// Deliberately resumed — must not be dismissed when the user later
			// switches away without sending a new message.
			conv.promptedSinceActive = true;
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			openedRuntime = null;
			openedTerminals = null;
			if (displaced) this.removeConversation(displaced.id);
			await traceStep(trace, "bind", () => this.bindSession());
			this.cwd = targetCwd;
			await traceStep(trace, "keys", () => this.restoreProjectProviderKeysForCwd(targetCwd));
			await traceStep(trace, "model", () => this.restoreProjectModelForCwd(targetCwd));
			this.conv.lastActiveAt = Date.now();
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The restored conversation has a fresh project-bound resource cache.
			void this.pushSlashCommands();
			// 切历史会话成功 → 插件重拉（轨迹视图立即显示该会话时间线）。
			this.notifyConversationChanged();
		} catch (err) {
			openedTerminals?.killAll();
			if (openedRuntime) await openedRuntime.dispose().catch(() => {});
			this.emit({
				type: "notice",
				level: "error",
				text: `切换会话失败：${(err as Error).message}`,
				textEn: `Failed to switch session: ${(err as Error).message}`,
			});
		} finally {
			// The trace must be cleared on EVERY exit path: a leaked trace keeps
			// appending snapshot marks forever.
			if (!handedOff) {
				this.timing = trace;
				this.flushSnapshot();
			}
			trace?.end();
			this.timing = undefined;
		}
	}

	/**
	 * Map a rendered user-message id (`u-<timestamp>-<seq>`, assigned in
	 * serialize.ts) back to its append-only session entry id. The seq handles
	 * two user messages sharing the same millisecond timestamp.
	 */
	private resolveUserMessageEntryId(messageId: string): string | null {
		const m = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
		if (!m) return null;
		const ts = Number(m[1]);
		const seq = m[2] ? Number(m[2]) : 1;
		let count = 0;
		// Resolve against the compaction-aware current leaf path — the same list
		// the UI renders (state.messages). Scanning the whole file (getEntries)
		// could match a summarized entry or one on a different branch.
		for (const entry of this.session.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const msg = (entry as unknown as { message?: AgentMessage }).message;
			if (!msg || msg.role !== "user" || msg.timestamp !== ts) continue;
			count += 1;
			if (count === seq) return entry.id;
		}
		return null;
	}

	/**
	 * Edit a past user question and re-ask it: forks a NEW session file that
	 * keeps everything up to (but not including) that question, then sends the
	 * edited text there. The original thread is untouched and stays in the
	 * session list, so nothing is ever lost.
	 *
	 * Attachments (attachments) travel through the SAME pipeline as prompt()
	 * — the fork intentionally drops the original attachment asides because
	 * they live on the old branch past the fork point, so the browser re-sends
	 * the images it kept in the edit composer (original image blocks + any
	 * newly pasted/dropped ones). Text-only edits pass undefined.
	 */
	async editMessage(
		messageId: string,
		text: string,
		attachments?: Parameters<ClientSession["prompt"]>[1],
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trimmed = text.trim();
		if (!trimmed) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "编辑内容为空，已取消",
				textEn: "Edited content is empty — cancelled",
			});
			this.flushSnapshot();
			return;
		}
		const entryId = this.resolveUserMessageEntryId(messageId);
		if (!entryId) {
			this.emit({
				type: "notice",
				level: "error",
				text: "找不到要编辑的消息（可能已被压缩或不在当前分支）",
				textEn: "Message to edit not found (may have been compacted or is on another branch)",
			});
			this.flushSnapshot();
			return;
		}
		try {
			// Preserve the model the user had selected — fork() seeds a new
			// branch with the ModelRuntime default model otherwise.
			const prevModel = this.session.agent.state.model ?? null;
			const result = await this.runtime.fork(entryId);
			if (result.cancelled) {
				this.emit({
					type: "notice",
					level: "info",
					text: "已取消编辑重问",
					textEn: "Edit-and-reask cancelled",
				});
				this.flushSnapshot();
				return;
			}
			await this.bindSession();
			// Restore the previously-selected model on the forked branch.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
					const pm = prevModel as unknown as { provider: string; id: string };
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, this.cwd);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			await this.prompt(trimmed, attachments);
			this.emit({
				type: "notice",
				level: "info",
				text: "已从该问题重新提问（原对话保留在会话列表中）",
				textEn: "Re-asked from that question (the original stays in the session list)",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `编辑重问失败：${(err as Error).message}`,
				textEn: `Edit-and-reask failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Push the recent-project list (persisted per client, merged with every cwd
	 * that has persisted sessions in this client's session store — so workspaces
	 * opened before the recent-list feature existed still show up).
	 */
	async pushProjects(): Promise<void> {
		try {
			const saved = this.stateStore.get(this.clientId);
			const removedProjects = new Set(this.stateStore.getRemovedProjects(this.clientId));
			const map = new Map<string, number>();
			for (const p of saved.projects) map.set(p.path, p.lastUsed);
			const all = await this.loadAllSessionInfos();
			for (const s of all) {
				if (s.cwd) {
					const t = s.modified.getTime();
					const prev = map.get(s.cwd);
					if (prev === undefined || t > prev) map.set(s.cwd, t);
				}
			}
			// Only keep directories that still exist — a deleted/unmounted workspace
			// is useless in the picker. Tombstoned entries (explicitly removed by
			// the user) stay hidden even though session files still mention them.
			const projects: ProjectSummary[] = [...map.entries()]
				.filter(([path]) => !removedProjects.has(path) && existsSync(path))
				.map(([path, lastUsed]) => ({ path, lastUsed }))
				.sort((a, b) => b.lastUsed - a.lastUsed)
				.slice(0, 20);
			this.emit({ type: "projects", projects });
		} catch {
			this.emit({ type: "projects", projects: [] });
		}
	}

	/** List a workspace directory (relative to the configured cwd). */
	async listFiles(relPath?: string): Promise<void> {
		return this.files.listFiles(relPath);
	}

	/** 全局搜索：递归文件名匹配（结果经 search_files_result 回推，reqId 匹配）。 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		return this.files.searchFiles(query, reqId);
	}

	/** 全局搜索：在当前工作区的会话转录全文里做大小写不敏感匹配 ——
	 *  不止首条消息，而是每一段 user 与 assistant 文本（AI 输出也在内）。
	 *  结果经 session_search_results 回推（reqId 匹配）；复用 loadSessionInfos()
	 *  缓存，避免每个按键都重新解析全部转录文件。 */
	async searchSessions(query: string, reqId: number): Promise<void> {
		const q = query.trim().toLowerCase();
		if (!q) {
			this.emit({ type: "session_search_results", reqId, query, ok: true, results: [] });
			return;
		}
		try {
			const infos = await this.loadSessionInfos();
			const results = await searchSessionInfos(infos, q);
			this.emit({ type: "session_search_results", reqId, query, ok: true, results });
		} catch {
			this.emit({ type: "session_search_results", reqId, query, ok: false, results: [] });
		}
	}

	/** SCM 只读查询（结构化 JSON，reqId 匹配）。 */
	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		return this.files.scmQuery(kind, reqId, arg);
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		return this.files.readFile(relPath);
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		return this.files.writeFile(relPath, text);
	}

	async uploadFile(relDir: string, name: string, data: string): Promise<void> {
		return this.files.uploadFile(relDir, name, data);
	}

	async makeDir(relPath: string): Promise<void> {
		return this.files.makeDir(relPath);
	}

	async cycleModel(): Promise<void> {
		try {
			const result = await this.session.cycleModel();
			if (result?.model) {
				const mid = `${result.model.provider}/${result.model.id}`;
				await this.restoreKeyForModel(mid, this.cwd);
				// Remember per-project like setModel — cycling is also a model switch.
				this.rememberProjectModel(mid);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
				textEn: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		return this.files.completePath(input);
	}

	async setCwd(newCwd: string): Promise<void> {
		try {
			const { resolve, sep } = await import("node:path");
			this.files.unwatchGit(); // stale repo's watcher must not fire across projects
			const fs = await import("node:fs/promises");
			const trimmed = newCwd.trim();
			if (trimmed === MACHINE_ROOT) {
				// 机器根是虚拟层（盘符列表），不能作工作目录——指引用户选具体目录。
				this.emit({
					type: "notice",
					level: "warning",
					text: "请选择一个具体目录作为工作目录（此电脑本身不是目录）",
					textEn: "Pick a concrete directory as the workspace (This PC itself is not a directory)",
				});
				return;
			}
			// Windows 裸盘符（"C:"）：resolve 会按该盘当前目录解析，必须显式指到盘根；
			// 仅 win32 生效——posix 下 "C:" 仍是普通相对路径，避免误伤同名目录。
			const abs =
				process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed)
					? `${trimmed.toUpperCase()}${sep}`
					: resolve(trimmed);
			const st = await fs.stat(abs);
			if (!st.isDirectory()) {
				throw new Error("路径不是目录");
			}
			if (abs === this.cwd) {
				this.emit({
					type: "notice",
					level: "info",
					text: `已在工作目录：${abs}`,
					textEn: `Already in directory: ${abs}`,
				});
				this.flushSnapshot();
				return;
			}

			// The outgoing conversation is left behind — apply the running-list
			// lifecycle (removal is deferred until the active conversation is
			// safely switched away).
			const displaced = this.displaceActive();

			// Prefer the target project's own most recently active conversation;
			// only create a fresh one (resuming its most recent session) when the
			// project has none open yet.
			let target: Conversation | undefined;
			for (const c of this.convs.values()) {
				if (c.cwd === abs && (!target || c.lastActiveAt > target.lastActiveAt)) {
					target = c;
				}
			}

			if (target) {
				this.activeId = target.id;
				if (displaced) this.removeConversation(displaced.id);
			} else {
				// First visit to this project: resume its most recent session.
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				const newRuntime = await createAgentSessionRuntime(
					this.makeRuntimeFactory(terminals, undefined, conversationId),
					{
						cwd: abs,
						agentDir: this.agentDir,
						sessionManager: SessionManager.continueRecent(abs),
					},
				);
				const conv = this.makeConversation(newRuntime, conversationId, terminals);
				this.convs.set(conv.id, conv);
				this.activeId = conv.id;
				if (displaced) this.removeConversation(displaced.id);
				for (const d of newRuntime.diagnostics) {
					if (d.type !== "info") {
						this.emit({ type: "notice", level: d.type, text: d.message, textEn: d.message });
					}
				}
				await this.bindSession();
			}

			this.pushTerminals();
			this.conv.promptedSinceActive = false;
			this.conv.lastActiveAt = Date.now();
			this.cwd = abs;
			await this.restoreProjectProviderKeysForCwd(abs);
			await this.restoreProjectModelForCwd(abs);
			// 工作区跟随型插件（编辑器文件树等）同步切根。
			try {
				this.onCwdChanged?.(abs);
			} catch {
				/* 钩子异常不影响主流程 */
			}
			// Remember the new workspace (restore target + recent-project entry).
			this.stateStore.remember(this.clientId, abs);
			void this.pushProjects();
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			// Skills / prompt templates are project-bound — refresh the catalog.
			void this.pushSlashCommands();
			this.emit({
				type: "notice",
				level: "info",
				text: `已切换到工作目录：${abs}`,
				textEn: `Switched to directory: ${abs}`,
			});
			void this.refreshSessions();
			void this.listFiles(undefined);
			// Commands are per-project (.pi/commands.json in the current cwd).
			void this.listCommands();
			// 切项目即换了当前打开对话 → 插件重拉。
			this.notifyConversationChanged();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换工作目录失败：${(err as Error).message}`,
				textEn: `Failed to switch directory: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * 模型目录自愈：models.json 被别处改过就先重读一次（判据见 model-catalog-freshness.ts）。
	 *
	 * @WHY 会话的 runtime 是「连接那一刻的快照」：服务在跑，用户新加了一个服务商（或改了 baseUrl），
	 *   旧会话里它根本不存在 —— 选择器显示「该渠道暂无可用的模型」、模板里的 {baseUrl} 也解析不出来，
	 *   而刷新页面没用（同 clientId 会复用同一个 ClientSession）。任何依赖「服务商/模型表」的操作
	 *   之前都该先过这里，用户就不必重启服务或换浏览器。
	 * @CONTRACT refresh({allowNetwork:false}) 只重读磁盘配置，不请求远端目录（远端刷新是 SDK 的
	 *   周期逻辑）。刷新失败**保留旧戳**：下次再试，不假装已是最新。
	 * @GOTCHA 写路径（model-admin）自己 refresh 过但不更新本戳，所以紧接着的那次 list_models 会
	 *   多刷一次本地重读（幂等、本地、无网络）。刻意如此：只为目录变更维护**一份**真相源。
	 */
	async ensureFreshModelCatalog(): Promise<void> {
		const path = modelsConfigPathOf(this.agentDir);
		const next = modelConfigStamp(path);
		if (!modelCatalogStale(this.modelsConfigStamp, next)) return;
		try {
			await this.runtime.services.modelRuntime.refresh({ allowNetwork: false });
			this.modelsConfigStamp = next;
		} catch (err) {
			console.warn(`[models] models.json reload failed: ${(err as Error).message}`);
		}
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			// 先自愈再列：否则旧会话永远看不到用户刚加的服务商。
			await this.ensureFreshModelCatalog();
			const mr = this.runtime.services.modelRuntime;
			const available = await mr.getAvailable();
			// 被「模型路由规则」判为退役的 id 不再作为可选路由（历史绑定仍能经 getModel 解析）。
			// 规则来自设置面板（settings.retiredModelRoutes / modelRouteAliases），缺省 = 出厂默认；
			// 见 server/model-routing.ts 与 docs/MODEL-ROUTING.md。
			//
			// 单网关接入：目录只保留**已配置服务商**（models.json）的模型。内置服务商（pi 注册表里
			// 那些没配、也管不了的）与重复接入的第二份拷贝都不该出现在选择器里。一个都没配时
			// 不收窄（全新实例不能因此没有可选模型），见 dev-con/gateway-config.ts。
			const configured = this.modelAdmin.configuredProviderIds();
			const models = filterCatalogToProviders(
				filterRoutableModels(available, this.settingsSvc.modelRoutingRules),
				configured,
			).map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: m.name,
				provider: m.provider,
				reasoning: m.reasoning,
				vision: m.input?.includes("image") ?? false,
			}));
			this.emit({ type: "models", models });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `获取模型列表失败：${(err as Error).message}`,
				textEn: `Failed to fetch model list: ${(err as Error).message}`,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Goal / review
	// ---------------------------------------------------------------------------

	/** Goal family delegates to GoalService (see goal-service.ts). */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			autoStart?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.setGoal(goalText, opts);
	}

	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.startGoalWizard(text, opts);
	}

	async setGoalPrefs(opts?: { reviewModel?: string; maxRounds?: number; locked?: boolean }): Promise<void> {
		return this.goalSvc.setGoalPrefs(opts);
	}

	async clearGoal(): Promise<void> {
		return this.goalSvc.clearGoal();
	}

	/** Run a git diff (unstaged + staged) in a conversation's workspace, or
	 * "" when not a repo. */
	private async gitDiff(cwd: string): Promise<string> {
		try {
			const { code, out } = await this.runAsync("git", ["diff", "HEAD"], 10_000, cwd);
			if (code !== 0) return "";
			return out.slice(0, 60_000);
		} catch {
			return "";
		}
	}

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5"). */
	async setModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`模型不存在：${modelId}`);
			await this.session.setModel(model);
			await this.restoreKeyForModel(modelId, this.cwd);
			// Immediately remember the model + the key it uses for the current
			// project (not only after a turn). This is what makes project switching
			// restore both the model and the provider key.
			this.rememberProjectModel(modelId);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
				textEn: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	// ---------------------------------------------------------------------------
	// ---------------------------------------------------------------------------
	// 单网关辅助（服务商目录 / 密钥 / 工具能力探测 / 网关用量）
	// 本项目只对接一个聚合网关（NewAPI 一类）：模型选择、按模型调用照旧，
	// 余额与用量直接问网关自己的账单接口（见 dev-con/gateway-usage.ts 与 docs/NEWAPI-GATEWAY.md）。
	// ---------------------------------------------------------------------------

	/** 已注册的服务商 id（取不到就空数组：宁可少说，也不编造目录）。 */
	private providerIds(): string[] {
		try {
			return this.runtime.services.modelRuntime.getProviders().map((p) => p.id);
		} catch {
			return [];
		}
	}

	/** 该服务商注册的 baseUrl。
	 *  @CONTRACT 必须用**本会话**的 runtime 回答：模块级全局 lookup 会让旧会话借到别的
	 *    客户端已热加载的目录，用一个 bug 掩盖另一个。 */
	private providerBaseUrlOf(providerId: string): string | undefined {
		try {
			return this.runtime.services.modelRuntime.getProviders().find((p) => p.id === providerId)?.baseUrl;
		} catch {
			return undefined;
		}
	}

	/** 服务商展示名（告警/用量标签用；取不到返回 undefined，调用方回落 id）。 */
	private providerNameOf(providerId: string): string | undefined {
		try {
			return this.runtime.services.modelRuntime.getProviders().find((p) => p.id === providerId)?.name;
		} catch {
			return undefined;
		}
	}

	/** 该服务商当前真正解析出的密钥正文（models.json 内联 key / $ENV / 命令 / auth.json / OAuth），
	 *  与模型调用走同一套优先级，不在服务层重实现一遍。密钥只在服务端内部使用。 */
	private async resolveProviderKey(providerId: string): Promise<string | null> {
		try {
			const resolved = await this.runtime.services.modelRuntime.getAuth(providerId);
			return resolved?.auth.apiKey ?? null;
		} catch {
			return null;
		}
	}

	/** 工具能力探测入口（同步返回，实际探测在后台跑完）。 */
	private ensureToolCapability(providerId: string, modelRef: string, credentialKey: string | undefined): void {
		void this.checkToolCapability(providerId, modelRef, credentialKey).catch(() => {
			/* 探测链路自身的问题不得影响正常请求 */
		});
	}

	/**
	 * 探测「该服务商 + 该模型」的端点是否真的支持工具调用，不支持就告警一次。
	 * @WHY 单网关场景下这件事更重要：网关静默丢弃 tools 时，请求与费用看上去完全正常，
	 *   只有编码能力退化成纯对话 —— 不说出来用户只会以为模型变笨了。
	 * @CONTRACT 结论按 provider/model/api/baseUrl 缓存 30 分钟（配置一变 key 就变，自然失效）；
	 *   同一端点并发只探一次；**只有确定的 unsupported 才告警**，unverified（网络/超时/
	 *   HTTP 错误/HTML）一律保持沉默 —— 探测不确定时宁可不打扰，也不误报网关不能用。
	 */
	private async checkToolCapability(providerId: string, modelRef: string, credentialKey: string | undefined): Promise<void> {
		const slash = modelRef.indexOf("/");
		const modelId = slash > 0 ? modelRef.slice(slash + 1) : modelRef;
		if (!providerId || !modelId) return;
		let model: { api?: string; baseUrl?: string } | null | undefined = null;
		try {
			model = this.runtime.services.modelRuntime.getModel(providerId, modelId);
		} catch {
			return;
		}
		const api = model?.api;
		const baseUrl = model?.baseUrl;
		if (!api || !baseUrl) return;
		const key = `${providerId}/${modelId}/${api}/${baseUrl}`;
		const cached = this.capabilityProbes.get(key);
		if (cached && Date.now() - cached.at < ClientSession.CAPABILITY_PROBE_TTL_MS) return;
		if (this.capabilityProbesInFlight.has(key)) return;
		this.capabilityProbesInFlight.add(key);
		try {
			// 认证头与密钥都与真实调用走同一口径（credentialKey 由 getApiKey 钩子传入同一把）。
			const resolved = credentialKey ? undefined : await this.runtime.services.modelRuntime.getAuth(providerId);
			const verdict = await runCapabilityProbe({
				api,
				baseUrl,
				model: modelId,
				apiKey: credentialKey ?? resolved?.auth.apiKey ?? null,
				headers: resolved?.auth.headers as Record<string, string> | undefined,
			});
			this.capabilityProbes.set(key, { verdict, at: Date.now() });
			if (verdict.kind === "unsupported") this.warnLacksTools(providerId, modelId, api, baseUrl);
		} finally {
			this.capabilityProbesInFlight.delete(key);
		}
	}

	/** 端点不支持工具调用时的告警文案（沉默失败 → 可见失败）。 */
	private warnLacksTools(providerId: string, modelId: string, api: string, baseUrl: string): void {
		const name = this.providerNameOf(providerId) ?? providerId;
		const hint = capabilityFixHint({ api, baseUrl });
		const remedyZh = hint ? `另外：${hint}。` : "如果网关只支持某一种协议（例如只透传 Codex/Responses），请把服务商协议改成那一种。";
		const remedyEn = hint ? `Also: ${hint}.` : "If the gateway only supports one protocol (e.g. Codex/Responses), switch the provider to that protocol.";
		this.emit({
			type: "notice",
			level: "warning",
			text: `服务商「${name}」的模型 ${modelId} 实测不支持工具调用：端点返回 200，但始终没有工具调用（网关很可能丢弃了 tools）。用它做开发任务会退化成纯对话，读写文件、执行命令都不可用。${remedyZh}`,
			textEn: `Provider “${name}” / ${modelId} does not support tool calls: the endpoint returns 200 but never emits one (the gateway most likely drops “tools”). Dev tasks on it degrade to plain chat — no file or terminal access. ${remedyEn}`,
		});
	}

	/** 只读：读网关配置（单网关接入）。全部实现委托给 ModelAdminService（同一个 models.json 写者）。 */
	async getGateway(reqId: number): Promise<void> {
		return this.modelAdmin.getGateway(reqId);
	}

	/** 写网关配置；省略的字段保持不动。 */
	async saveGateway(
		reqId: number,
		input: { baseUrl?: string; api?: string; apiKey?: string | null; models?: UiModelConfigEntry[] },
	): Promise<void> {
		return this.modelAdmin.saveGateway(reqId, input, () => this.getLang());
	}

	/** 查询网关自报的用量（只读；providerId 省略 = 当前生效模型所属服务商）。 */
	async queryGatewayUsage(reqId: number, providerId?: string, force?: boolean): Promise<void> {
		try {
			// 目录自愈：刚在设置里加的服务商要能立刻查到，而不是等重启（见 §4 目录时效性）。
			await this.ensureFreshModelCatalog();
			const target = (providerId ?? this.session.agent.state.model?.provider ?? "").trim();
			if (!target) {
				this.emit({ type: "gateway_usage", reqId, ok: false, error: "当前没有生效模型，无法确定要查询的网关" });
				return;
			}
			// force 由调用方决定：手动刷新绕过 60s 缓存，自动轮询复用（见 gateway-usage.ts 的 TTL）。
			const result = await this.gatewayUsage.query(target, { force: force === true });
			if (!result.ok)
				this.emit({ type: "gateway_usage", reqId, ok: false, error: result.error, unsupported: result.unsupported });
			else this.emit({ type: "gateway_usage", reqId, ok: true, usage: result.usage });
		} catch (err) {
			this.emit({ type: "gateway_usage", reqId, ok: false, error: (err as Error).message });
		}
	}


	/** DEV-CON：Jev 门禁只读状态（配置已清洗：只回密钥名 + 运行聚合 + 可用命题）。 */
	async pushJevStatus(reqId: number): Promise<void> {
		try {
			this.emit({
				type: "jev_status",
				reqId,
				ok: true,
				status: {
					config: redactJevGateConfigForEcho(this.jev.config()),
					runtime: this.jev.snapshotStatus(),
					// 展示面拿"已展平的字符串"：发往模型的原始值现在是结构化判据（见 JevProse），
					// 在服务端用**同一个** formatJevProse 渲染，web 与 CLI 就不会各自再拼一份。
					propositions: JEV_PROPOSITIONS.map((p) => ({
						id: p.id,
						instructions: formatJevProse(p.instructions),
						criteria: { true: formatJevProse(p.criteria.true), false: formatJevProse(p.criteria.false) },
					})),
				},
			});
		} catch (err) {
			this.emit({
				type: "jev_status",
				reqId,
				ok: false,
				error: `读取 Jev 门禁状态失败：${(err as Error).message}`,
				errorEn: `Failed to read the Jev gate status: ${(err as Error).message}`,
			});
		}
	}

	/**
	 * DEV-CON：保存 Jev 门禁配置（读-合并-写；明文密钥一律拒绝）。
	 * @CONTRACT 写盘成功后才 applyConfig（与渠道层同口径：先落盘再生效），
	 *   且改动会在下一条命令的 evaluate 里生效；已发出的调用不受影响。
	 */
	async saveJevConfig(
		reqId: number,
		config: Extract<ClientMessage, { type: "jev_config_save" }>["config"],
	): Promise<void> {
		const result = saveJevSettings(this.agentDir, config);
		if (!result.ok) {
			this.emit({
				type: "jev_config_result",
				reqId,
				ok: false,
				phase: "rejected",
				error: result.error,
				errorEn: result.errorEn,
			});
			return;
		}
		this.jev.applyConfig(result.config);
		this.emit({
			type: "jev_config_result",
			reqId,
			ok: true,
			phase: "applied",
			config: redactJevGateConfigForEcho(result.config),
		});
		this.emit({
			type: "notice",
			level: "info",
			text: "Jev 决策门禁配置已保存",
			textEn: "Jev decision-gate settings saved",
		});
	}

	/**
	 * 主动推一份门禁状态（reqId: 0 = 无请求来源，见 protocol.ts 的 jev_status @CONTRACT）。
	 * @WHY 状态栏/面板要能在**决策刚发生**时就看见（否则得手动刷新 = 黑盒）；
	 *   推而不是轮询：空闲反复查是既有回归禁忌（见 tests/jev/browser-ui.mjs 的「空闲不重复查询」）。
	 * @CONTRACT 只推聚合与计数（调用数/三态/失败/费用/缓存 + 样本复盘状态），不含 state、不含密钥。
	 */
	private notifyJevStatus(): void {
		void this.pushJevStatus(0);
	}

	/**
	 * DEV-CON：跑一次真实门禁判定（Agent 工具 `jev_check` 的服务端实现）。
	 * @CONTRACT 判定完全复用 `JevGate.evaluate`（同一出口、同一阈值、同一缓存、同一限频）；
	 *   未知命题 / 未配凭据 / 上游失败一律**如实回**（error 非空 = 这次不是有效决策），
	 *   绝不在工具层把失败降级成放行（同 JevGate 头部 @WHY）。
	 * @WHY 门禁接入后一直只有「设置面板自检」与 CLI 两个入口，日常编码路径上没人问它：
	 *   既拦不住东西，也攒不下真实分数（磁盘缓存长期为 0 条）。这是那个缺失的消费者。
	 */
	async checkJev(input: { state: unknown; propositions?: string[]; useCache?: boolean }): Promise<JevCheckResult> {
		const ids =
			Array.isArray(input.propositions) && input.propositions.length > 0
				? input.propositions.map((id) => String(id).trim()).filter((id) => id.length > 0)
				: JEV_PROPOSITIONS.map((p) => p.id);
		const unknown = ids.filter((id) => !JEV_PROPOSITIONS.some((p) => p.id === id));
		if (ids.length === 0 || unknown.length > 0) {
			const available = JEV_PROPOSITIONS.map((p) => p.id).join(", ");
			return {
				ids,
				unsupported: {
					error:
						ids.length === 0
							? `没有要判定的命题（可用：${available}）`
							: `未知命题：${unknown.join(", ")}（可用：${available}）`,
					errorEn:
						ids.length === 0
							? `No proposition to judge (available: ${available})`
							: `Unknown propositions: ${unknown.join(", ")} (available: ${available})`,
				},
			};
		}
		// 未配凭据时传空串：evaluate 会归一成 review + 「未配置可用凭据」，
		// 比在工具层抛异常更容易让调用方看懂（门禁失败永远转人工）。
		const decision = await this.jev.evaluate({
			state: input.state,
			questions: buildJevQuestions(ids),
			apiKey: this.resolveJevApiKey() ?? "",
			useCache: input.useCache !== false,
			// 复盘时要能区分「agent 主动问的」与「设置面板自检 / 脚本跑的」（见 JevSampleSource）。
			source: "tool",
		});
		this.notifyJevStatus();
		return { ids, decision };
	}

	/**
	 * DEV-CON：门禁自检（非黑盒）：用一条内置命题真实打一次 Decisions 接口。
	 * @CONTRACT ok=true 表示**真的拿到了有效决策**（哪怕结论是 block）；
	 *   任何失败（未配凭据/超时/401/429/缺答/越界）都 rc ok=false 并把双语错误带回。
	 *   密钥只在服务端解析，绝不进回包/日志/notice。
	 * @CONTRACT `useCache: false`：自检必须**真的打一次接口**，否则按钮会变成「读上一次的缓存」，
	 *   而它就断言“测试连接”是验证门禁可否用的唯一入口（磁盘缓存对固定自检样本必然命中）。
	 */
	async probeJev(reqId: number, state?: Record<string, unknown>): Promise<void> {
		let decision: JevDecision;
		try {
			const apiKey = this.resolveJevApiKey();
			if (!apiKey) {
				const error = "未配置可用的 Jev 凭据：请在门禁设置里选择一个密钥名（provider-keys.json）";
				this.emit({
					type: "jev_probe_result",
					reqId,
					ok: false,
					error,
					errorEn: "No usable Jev credential: pick a key name (provider-keys.json) in the gate settings",
				});
				return;
			}
			decision = await this.jev.evaluate({
				state: state ?? JEV_PROBE_STATE,
				questions: buildJevQuestions([JEV_PROBE_PROPOSITION_ID]),
				apiKey,
				// 自检必须真的打一次接口（见上方 @CONTRACT）。
				useCache: false,
				source: "probe",
			});
		} catch (err) {
			// evaluate 本就永不抛；这里是兵底（例如 keyName 解析器抛错），同样不能冒泡到 dispatch。
			this.emit({
				type: "jev_probe_result",
				reqId,
				ok: false,
				error: `门禁自检失败：${(err as Error).message}`,
				errorEn: `Gate probe failed: ${(err as Error).message}`,
			});
			return;
		}
		this.emit({
			type: "jev_probe_result",
			reqId,
			ok: !decision.error,
			decision,
			error: decision.error,
			errorEn: decision.errorEn,
		});
		// 自检也是一次真实决策：把新的聚合推给所有客户端（状态栏据此实时更新）。
		this.notifyJevStatus();
	}

	/**
	 * 解析 Jev 凭据正文（只在服务端内部流转，绝不落日志/回显）。
	 * @CONTRACT 用配置里的 credentialRef（providerId + keyName）；未绑定命名凭据时回落到
	 *   该服务商当前 **active** 密钥（与模型调用同一套优先级），两处都取不到则返回 null。
	 * @WHY 不把 name 包一层“默认密钥”：resolveProviderKeyValue 只認名字，
	 *   “有名字但名字不存在”与“根本没配”都应当如实报「未配置可用凭据」。
	 */
	private resolveJevApiKey(): string | null {
		try {
			const ref = this.jev.config().credentialRef;
			if (ref) return this.modelAdmin.resolveProviderKeyValue(ref.providerId, ref.keyName);
			const active = this.modelAdmin.keyNameList(JEV_PROVIDER_ID).find((k) => k.active);
			return active ? this.modelAdmin.resolveProviderKeyValue(JEV_PROVIDER_ID, active.keyName) : null;
		} catch {
			return null;
		}
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			this.session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
				textEn: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	cycleThinking(): void {
		try {
			this.session.cycleThinkingLevel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
				textEn: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Push the user command list (.pi/commands.json) to the client. */
	async listCommands(): Promise<void> {
		const { commands, path, warning, warningEn } = await loadCommands(this.cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning, textEn: warningEn });
		}
		this.emit({ type: "commands", commands, path });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error, errorEn } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error, textEn: errorEn });
			return;
		}
		this.emit({ type: "commands", commands, path });
		this.emit({ type: "notice", level: "info", text: `命令已保存：${path}`, textEn: `Command saved: ${path}` });
	}

	async dispose(): Promise<void> {
		this.maintenance.stop();
		this.disposed = true;
		for (const conv of this.convs.values()) conv.terminals.killAll();
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.sessionsTimer) {
			clearTimeout(this.sessionsTimer);
			this.sessionsTimer = null;
		}
		if (this.widgetsTimer) {
			clearInterval(this.widgetsTimer);
			this.widgetsTimer = null;
		}
		if (this.stallTimer) {
			clearInterval(this.stallTimer);
			this.stallTimer = null;
		}
		this.files.unwatchDir();
		this.files.unwatchGit();
		this.webUi.dispose();
		// 关闭所有挂起的用户提问（dispose 时以「取消」解析，避免模型挂死）。
		this.cancelPendingQuestions();
		this.bg.stop();
		for (const conv of this.convs.values()) {
			this.clearAllToolWatchdogs(conv);
			conv.unsubscribe?.();
			try {
				await conv.runtime.dispose();
			} catch {
				// best effort
			}
		}
	}
}

export class AgentService {
	/** index.ts 注入：SDK 工具执行事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入：运行轨迹事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	/** index.ts 注入：对话切换通知钩子，attach 时拷贝到每个新会话。 */
	onConversationChanged: (() => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的斜杠命令（attach 时拷贝到每个新会话）。 */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	private clients = new Map<string, ClientSession>();
	/** Quiesce (draining) state — the service refuses NEW work (prompts, forks,
	 *  session resumes, new clients) so a deploy/upgrade/backup can stop cleanly
	 *  once existing runs finish. Controlled via the local control socket:
	 *  `pi-web-ui server quiesce|unquiesce`. */
	private quiesced = false;
	private quiescedAt = 0;
	/** Attached browser sockets (reported by index.ts on open/close) — the
	 *  control socket reports real sockets, not cached client-session objects. */
	private socketCount = 0;
	private pending = new Map<string, Promise<ClientSession>>();
	private stateStore: ClientStateStore;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 任意客户端成功切换工作区后触发（新绝对路径）。index.ts 接到
	 *  PluginManager.notifyCwd，让插件宿主的 host.cwd 实时跟随当前项目。 */
	onClientCwdChanged: ((cwd: string) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string,
	) {
		this.stateStore = new ClientStateStore(stateFile);
	}

	/** Get or create the session for a client, racing attach calls safely. */
	/** True while the service is draining — new work is refused. */
	isQuiesced(): boolean {
		return this.quiesced;
	}

	/** Enter quiesce: stop admitting new work. Existing runs keep going.
	 *
	 *  @WHY 进来时先把「孤儿队列」点出来：排队但没有任何运行在消费的消息，在 quiesce 期间
	 *  永远不会变（新工作全被拒），排空门禁不该等它。只把 pending 计数报出去而不说是谁，
	 *  操作人只能看到门禁不动（2026-09-18 因此白等 45 分钟）。 */
	quiesce(): void {
		this.quiesced = true;
		this.quiescedAt = Date.now();
		const orphaned = this.orphanedMessages();
		if (orphaned > 0) {
			const who = this.drainHolders()
				.filter((holder) => !holder.streaming && holder.queued > 0)
				.map((holder) => `${holder.id}(排队 ${holder.queued} 条)`)
				.join("、");
			console.warn(
				`[quiesce] ${orphaned} 条排队消息没有运行在消费（孤儿队列），不计入排空等待：${who || "对话未知"}；重启会丢弃它们。`,
			);
		}
	}

	/** Leave quiesce: admit new work again. */
	unquiesce(): void {
		this.quiesced = false;
		this.quiescedAt = 0;
	}

	/** Snapshot for the control socket / status command. */
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return this.quiesced ? { quiesced: true, quiescedSince: this.quiescedAt } : { quiesced: false };
	}

	/** Aggregate across every client session: conversations with in-flight runs. */
	activeConversations(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.activeConversations();
		return n;
	}

	/** Aggregate across every client session: messages queued in the SDK. */
	pendingMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.pendingMessages();
		return n;
	}

	/** Aggregate: 排队消息中有运行在消费的那部分（排空门禁只看它）。 */
	drainableMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.drainableMessages();
		return n;
	}

	/** Aggregate: 排队消息中没有人消费的那部分（不阻塞排空，但会报出来）。 */
	orphanedMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.orphanedMessages();
		return n;
	}

	/** Aggregate: 持有排空门禁的对话（用于早退时点名）。 */
	drainHolders(): DrainHolder[] {
		const holders: DrainHolder[] = [];
		for (const cs of this.clients.values()) holders.push(...cs.drainHolders());
		return holders;
	}

	/** 插件用：全客户端最近活跃对话的快照（at 最大者即“当前打开的对话”）。 */
	readConversationForPlugins(): PluginConversationSnapshot | null {
		let best: PluginConversationSnapshot | null = null;
		for (const cs of this.clients.values()) {
			try {
				const s = cs.readConversationForPlugins();
				if (s && (!best || s.at > best.at)) best = s;
			} catch {
				/* 单客户端坏了不影响其他 */
			}
		}
		return best;
	}

	/** index.ts calls this when a browser socket opens/closes. */
	noteSocketOpen(): void {
		this.socketCount += 1;
	}
	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	/** Full status for the control socket / `server status` command. */
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
		drainableMessages: number;
		orphanedMessages: number;
		drainHolders: DrainHolder[];
	} {
		return {
			pid: process.pid,
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			drainableMessages: this.drainableMessages(),
			orphanedMessages: this.orphanedMessages(),
			drainHolders: this.drainHolders(),
		};
	}

	/** Get or create the session for a client, racing attach calls safely.
	 *  `trace`（timing.ts，可选）只做观测：记录冷启动各阶段耗时。 */
	async attach(clientId: string, send: (msg: ServerMessage) => void, trace?: TimingTrace): Promise<ClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
			} else {
				// Restore this client's last-used workspace when it still exists;
				// Admission gate: while quiesced, only clients with an EXISTING
				// session may attach (they can watch their runs drain); brand-new
				// clients are refused — index.ts closes their socket (4403) and the
				// browser reconnect loop retries after admission reopens.
				if (this.quiesced) {
					throw new QuiesceRejectedError("新连接被拒绝，请等服务器恢复后重试");
				}
				// otherwise fall back to the server's configured default cwd.
				let cwd = this.cwd;
				const saved = this.stateStore.get(clientId);
				if (saved.lastCwd && saved.lastCwd !== this.cwd) {
					try {
						if (statSync(saved.lastCwd).isDirectory()) cwd = saved.lastCwd;
					} catch {
						// gone (unmounted drive / deleted) — fall back to the default
					}
				}
				// Sessions use the SDK default per-project dir — no per-client dir.
				const creating = ClientSession.create(clientId, cwd, this.stateStore, trace).finally(() => {
					this.pending.delete(clientId);
				});
				this.pending.set(clientId, creating);
				cs = await creating;
				this.clients.set(clientId, cs);
				// Make sure the restored/default workspace appears in the project list.
				this.stateStore.remember(clientId, cwd);
				if (cwd !== this.cwd) {
					send({
						type: "notice",
						level: "info",
						text: `已恢复上次的工作目录：${cwd}`,
						textEn: `Restored the last working directory: ${cwd}`,
					});
				}
			}
		}
		// First attach after a restart: report runs that were interrupted when
		// the previous process shut down (consumed once, then cleared). Queue
		// BEFORE attachSink so the notice rides the initial pending-notice flush.
		cs.notifyInterrupted(this.stateStore.takeInterrupted(clientId));
		cs.attachSink(send);
		trace?.mark("attach-sink");
		// 接入/回到页面时追平：离开期间另一端完成的工作，这里按磁盘新鲜度补上。
		cs.syncActiveFromDiskIfStale();
		trace?.mark("sync-disk");
		// Let emitSnapshotNow record the snapshot's build+serialize cost on the
		// same trace line (attach/switch wrap their own critical section).
		cs.timing = trace;
		// Forward hooks (set once by index.ts) to every session.
		cs.onQuit = this.onQuit;
		cs.onToolEvent = this.onToolEvent;
		cs.onRunEvent = this.onRunEvent;
		cs.onConversationChanged = () => this.onConversationChanged?.();
		cs.pluginToolsProvider = this.pluginToolsProvider;
		cs.pluginCommandsProvider = this.pluginCommandsProvider;
		cs.pluginBgTasksProvider = this.pluginBgTasksProvider;
		cs.pluginStopBgTask = this.pluginStopBgTask;
		cs.isQuiesced = () => this.quiesced;
		// 多端同步：本端完成节点 / 会话列表变化 → 广播给其他客户端。
		// 节点完成 → 对方刷新列表 + 若持有同一会话则从磁盘接力重载；
		// 列表变化（新建/删除/改名）→ 对方只刷新列表。
		cs.onSessionPersisted = (file, cwd) => this.broadcastSessionPersisted(cs.clientId, file, cwd);
		// 服务商/模型目录变化 → 其他会话各自重算（每个会话有自己的 runtime 快照，
		// 要先自愈再列；见 ClientSession.ensureFreshModelCatalog）。不广播的话，
		// 别人已打开的标签页会一直停在旧目录（新服务商 =「该渠道暂无可用的模型」）。
		cs.onModelCatalogChanged = () => {
			for (const other of this.clients.values()) {
				if (other === cs || other.isDisposedSession()) continue;
				void other.listModels();
			}
		};
		cs.onSessionsListChanged = (cwd) => this.broadcastSessionsListChanged(cs.clientId, cwd);
		// 插件宿主工作区跟随：初次接入也同步一次（恢复的 lastCwd 可能≠服务启动目录），
		// notifyCwd 幂等去重；此后 set_cwd 成功时由 cs.onCwdChanged 继续驱动。
		cs.onCwdChanged = (abs) => this.onClientCwdChanged?.(abs);
		this.onClientCwdChanged?.(cs.cwd);
		trace?.mark("hooks");
		return cs;
	}

	/** 插件 AI 工具集合变化（注册/注销）时由 index.ts 触发：推送到所有客户端的全部会话。 */
	applyPluginAgentTools(): void {
		for (const cs of this.clients.values()) cs.refreshPluginTools();
	}

	/** Browser UI locale report (hello.locale / set_locale): persist per client
	 *  and refresh lang-aware prompts (streaming-safe via ClientSession). */
	async setLocale(clientId: string, locale: string): Promise<void> {
		const cs = this.clients.get(clientId);
		if (cs) {
			await cs.setLocale(locale);
			return;
		}
		// hello race: session still being created — wait for it, then apply.
		const inflight = this.pending.get(clientId);
		if (inflight) {
			try {
				await (await inflight).setLocale(locale);
			} catch {
				/* attach failed — nothing to apply to */
			}
		}
	}

	/** 插件斜杠命令集合变化时由 index.ts 触发：重推各客户端的命令目录。 */
	applyPluginCommandCatalog(): void {
		for (const cs of this.clients.values()) void cs.pushSlashCommands();
	}

	/** 插件常驻后台任务变化时由 index.ts 触发：重推各客户端的 bg_servers。 */
	refreshBackgroundServers(): void {
		for (const cs of this.clients.values()) cs.refreshBgTasks();
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		this.clients.get(clientId)?.detachSink(send);
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	/** 一个客户端完成一个节点（transcript 已落盘）→ 其他端刷新会话列表；持有
	 *  同一会话的端从磁盘接力重载（节点粒度，不打扰正在流式输出的端）。 */
	private broadcastSessionPersisted(originClientId: string, file: string, cwd: string): void {
		for (const cs of this.clients.values()) {
			if (cs.clientId === originClientId) continue;
			cs.notifyExternalSessionsChanged(cwd);
			void cs.reloadIfHolding(file);
		}
	}

	/** 会话列表本身变化（新建落盘 / 删除 / 改名）→ 其他同项目端刷新列表。 */
	private broadcastSessionsListChanged(originClientId: string, cwd: string): void {
		for (const cs of this.clients.values()) {
			if (cs.clientId === originClientId) continue;
			cs.notifyExternalSessionsChanged(cwd);
		}
	}

	async disposeAll(): Promise<void> {
		// Record still-streaming conversations BEFORE tearing anything down, so
		// the next attach can tell the user what was lost (SIGTERM / update).
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [clientId, cs] of [...this.clients]) {
			try {
				const running = cs.streamingSummaries();
				if (running.length > 0) {
					this.stateStore.saveInterrupted(
						clientId,
						running.map((r) => ({ ...r, at: Date.now() })),
					);
				}
			} catch {
				// best effort — never block shutdown on bookkeeping
			}
		}
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
