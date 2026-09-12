/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-service.ts (命令层：串行化 + 回执 + 校验的委托方),
 *            channel-state.ts (目录读写：commitConfig/refresh/绑定版本),
 *            channel-model.ts (纯逻辑：validateChannelRecord/detachChannel/nextChannelId),
 *            channel-accounts.ts (queryAccount 的账户适配器)
 *   📖 docs/DEV-CON-PROPOSAL.md §4「配置变更采用校验/预览 → revision复核 → 应用 → 验证和回执」,
 *      §7（余额/配额查询）, §9（P0 技术项）
 *   @CONTRACT 本模块只实现「渠道档案 / 默认值 / 账户查询」四类配置命令，通过 ChannelConfigPort
 *             取能力：不直接持有 ChannelService，也不自己串行化（串行化/回执发送仍在命令层）。
 *   @CONTRACT 写入顺序不可调换：先算 next → commitConfig 落盘成功 → 才发 applied 回执 + pushState；
 *             commitConfig 失败必须 conflict 回执（不得静默覆盖外部修改）。
 *   @GOTCHA 删除渠道后必须释放「本 client」被摘除对话的待生效选择：存储键带 clientId 前缀，
 *           必须经 ChannelState.conversationIdOf 剥前缀，否则会误删别的客户端的同名对话。
 *   @SECURITY 密钥正文只在 queryAccount 的 resolveKeyValue 回调里流转，绝不进入回执/状态消息。
 * ──────────────────────────────────────────────────
 */
import type { ServerMessage } from "../protocol.js";
import type { ChannelProviderInput } from "../protocol.js";
import {
	checkConfigRevision,
	DEFAULT_ENDPOINT_ID,
	detachChannel,
	isValidProviderId,
	nextChannelId,
	providerIdFromName,
	validateChannelRecord,
	type ChannelBinding,
	type ChannelCatalog,
	type ChannelRecord,
	type ChannelSelection,
} from "./channel-model.js";
import type { ChannelState } from "./channel-state.js";
import type { AccountRegistry } from "./channel-accounts.js";
import type { SelectionInput } from "./channel-service.js";

type ReceiptPhase = Extract<ServerMessage, { type: "channel_command_result" }>["phase"];

/** 回执入参（配置命令只构造回执，真正的发送/版本字段由命令层补齐）。 */
export interface ChannelReceiptInput {
	commandId: string;
	ok: boolean;
	phase: ReceiptPhase;
	conversationId?: string;
	channelId?: string;
	error?: string;
	errorEn?: string;
	binding?: ChannelBinding | null;
}

/** 配置/账户命令依赖的宿主与命令层能力（窄端口，由 ChannelService 提供）。 */
export interface ChannelConfigPort {
	/** runtime 是否注册了该服务商。 */
	hasProvider: (providerId: string) => boolean;
	/** provider-keys.json 的命名密钥（仅名称 + 是否 active）。 */
	keyNames: (providerId: string) => { keyName: string; active: boolean }[];
	/** 服务端解析命名密钥正文（仅账户查询使用）。 */
	resolveKeyValue: (providerId: string, keyName: string) => string | null;
	/** 服务商自己配置的密钥（models.json 内联 / $ENV / 命令 / auth.json / OAuth）：
	 *  渠道没绑定命名凭据，或账户配置未指定「账户凭据」时的兜底。
	 *  @WHY 自定义服务商（CCQTCC / micu 这类）的 key 只存在 models.json，没有 provider-keys.json
	 *  里的名字；旧实现直接报「未绑定命名凭据」，这类渠道的余额永远查不出来。 */
	resolveProviderKey: (providerId: string) => Promise<string | null>;
	/** 目录状态（读写唯一出口：commitConfig）。 */
	state: ChannelState;
	/** 释放某个对话的待生效选择（渠道被删除时）。 */
	dropPending: (conversationId: string) => void;
	/** 选择校验（渠道/模型/命名凭据存在性）。 */
	buildSelection: (input: SelectionInput) => { selection: ChannelSelection } | { error: string; errorEn: string };
	/** 已注册的服务商 id（用于生成不冲突的服务商 id）。 */
	providerIds: () => string[];
	/** 写入/更新一个服务商（models.json + 热加载）；错误以返回值上报，不静默失败。 */
	upsertProvider: (
		input: ChannelProviderInput & { providerId: string },
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	receipt: (input: ChannelReceiptInput) => void;
	/** 版本冲突回执（channel=配置冲突，binding=绑定冲突），并推送真实状态。 */
	conflictReceipt: (commandId: string, what: "channel" | "binding", note?: string) => void;
	pushState: () => void;
	accounts?: AccountRegistry;
}

export interface SaveChannelInput {
	commandId: string;
	channel: Partial<ChannelRecord> & { id?: string };
	/** 与该渠道同帧写入的服务商连接（省略 = 只引用已注册服务商）。 */
	provider?: ChannelProviderInput;
	expectedConfigRevision?: number;
}

export interface DeleteChannelInput {
	commandId: string;
	channelId: string;
	expectedConfigRevision?: number;
}

export interface SetDefaultInput {
	commandId: string;
	scope: "instance" | "project";
	selection: SelectionInput | null;
	expectedConfigRevision?: number;
}

export interface QueryAccountInput {
	commandId: string;
	channelId: string;
}

/** 新增/更新渠道档案（不允许暗改；冲突显式回执）。
 *  @CONTRACT 顺序不可颠倒：先写服务商（models.json）→ 再写渠道（channels.json）。
 *    服务商写失败 → 不动渠道；渠道写失败（版本冲突）→ 回执明确说出「服务商已写入、渠道未保存」，
 *    用户重试即幂等（provider upsert 不重复创建）。 */
export async function saveChannelCommand(port: ChannelConfigPort, input: SaveChannelInput): Promise<void> {
	if (!checkConfigRevision(port.state.configRevision, input.expectedConfigRevision).ok) {
		return port.conflictReceipt(input.commandId, "channel");
	}
	const existing = port.state.catalog.channels.find((c) => c.id === input.channel.id);
	let providerId = input.channel.providerId?.trim() || "";
	/** 是否本帧真的写过服务商（用于部分失败回执的措辞）。 */
	let providerWritten = false;
	if (input.provider) {
		// 「新建服务商」：id 留空时由显示名生成，避开已有 id（models.json + runtime 里的）。
		const candidate = (input.provider.providerId?.trim() || providerId || "").trim();
		const pid = candidate || providerIdFromName(input.channel.displayName ?? "", port.providerIds());
		if (!isValidProviderId(pid)) {
			return port.receipt({
				commandId: input.commandId,
				error: `服务商 ID 无效（仅字母/数字/._-）：${pid}`,
				errorEn: `Invalid provider ID (letters/digits/._- only): ${pid}`,
				ok: false,
				phase: "rejected",
			});
		}
		const written = await port.upsertProvider({ ...input.provider, providerId: pid });
		if (!written.ok) {
			return port.receipt({
				commandId: input.commandId,
				error: `服务商未写入，渠道未保存：${written.error}`,
				errorEn: `Provider was not written; channel not saved: ${written.error}`,
				ok: false,
				phase: "rejected",
			});
		}
		providerWritten = true;
		providerId = pid;
	}
	const record: ChannelRecord = {
		id: input.channel.id?.trim() || nextChannelId(port.state.catalog.channels),
		displayName: input.channel.displayName?.trim() || "",
		providerId,
		endpointId: input.channel.endpointId?.trim() || DEFAULT_ENDPOINT_ID,
		credentialRef: input.channel.credentialRef ?? null,
		accountRef: input.channel.accountRef ?? null,
		// 模型白名单：去重去空；空数组 = 不限制（列出该服务商全部模型）。
		models: [...new Set((input.channel.models ?? []).map((m) => String(m).trim()).filter(Boolean))],
		enabled: input.channel.enabled !== false,
		extra: { ...(existing?.extra ?? {}), ...(input.channel.extra ?? {}) },
	};
	// 部分失败的统一措辞：服务商已落盘，重试不会重复创建。
	const partial = providerWritten ? "服务商已保存，但渠道未保存" : "";
	const partialEn = providerWritten ? "provider saved, channel not saved" : "";
	if (!port.hasProvider(record.providerId)) {
		port.receipt({
			commandId: input.commandId,
			ok: false,
			phase: "rejected",
			channelId: record.id,
			error: `${partial ? `${partial}；` : ""}服务商「${record.providerId}」未在模型中注册`,
			errorEn: `${partialEn ? `${partialEn}; ` : ""}Provider "${record.providerId}" is not registered`,
		});
		return;
	}
	const others = port.state.catalog.channels.filter((c) => c.id !== record.id);
	const errors = validateChannelRecord(record, others);
	if (errors.length > 0) {
		port.receipt({ commandId: input.commandId, ok: false, phase: "rejected", channelId: record.id, error: `${partial ? `${partial}；` : ""}${errors.join("；")}`, errorEn: `${partialEn ? `${partialEn}; ` : ""}${errors.join("; ")}` });
		return;
	}
	if (record.credentialRef && !port.keyNames(record.providerId).some((k) => k.keyName === record.credentialRef?.keyName)) {
		port.receipt({
			commandId: input.commandId,
			ok: false,
			phase: "rejected",
			channelId: record.id,
			error: `${partial ? `${partial}；` : ""}命名凭据不存在：${record.credentialRef.keyName}`,
			errorEn: `${partialEn ? `${partialEn}; ` : ""}Named credential not found: ${record.credentialRef.keyName}`,
		});
		return;
	}
	const next: ChannelCatalog = {
		...port.state.catalog,
		channels: [...others, record].sort((a, b) => a.id.localeCompare(b.id)),
		configRevision: port.state.configRevision + 1,
	};
	if (!port.state.commitConfig(next)) {
		return port.conflictReceipt(
			input.commandId,
			"channel",
			providerWritten ? "服务商已保存，但渠道未保存（配置已被其他端修改，刷新后重试）" : undefined,
		);
	}
	port.receipt({ commandId: input.commandId, ok: true, phase: "applied", channelId: record.id });
	port.pushState();
}

/** 删除渠道：同时清理引用它的默认值与绑定（不改写历史用量）。 */
export function deleteChannelCommand(port: ChannelConfigPort, input: DeleteChannelInput): void {
	if (!checkConfigRevision(port.state.configRevision, input.expectedConfigRevision).ok) {
		return port.conflictReceipt(input.commandId, "channel");
	}
	if (!port.state.catalog.channels.some((c) => c.id === input.channelId)) {
		port.receipt({ commandId: input.commandId, ok: false, phase: "rejected", error: "渠道不存在", errorEn: "Channel not found" });
		return;
	}
	const { catalog, detachedConversations } = detachChannel(port.state.catalog, input.channelId);
	const next: ChannelCatalog = { ...catalog, configRevision: port.state.configRevision + 1 };
	if (!port.state.commitConfig(next)) return port.conflictReceipt(input.commandId, "channel");
	for (const id of detachedConversations) {
		const ownId = port.state.conversationIdOf(id);
		if (ownId !== null) port.dropPending(ownId);
	}
	port.state.bumpBindingRevision();
	port.receipt({ commandId: input.commandId, ok: true, phase: "applied", channelId: input.channelId });
	port.pushState();
}

/** 设置项目/实例默认（只影响未发言对话，不重绑正在运行的对话）。 */
export function setDefaultCommand(port: ChannelConfigPort, input: SetDefaultInput): void {
	if (!checkConfigRevision(port.state.configRevision, input.expectedConfigRevision).ok) {
		return port.conflictReceipt(input.commandId, "channel");
	}
	let selection: ChannelSelection | null = null;
	if (input.selection) {
		const built = port.buildSelection(input.selection);
		if ("error" in built) {
			port.receipt({ commandId: input.commandId, ok: false, phase: "rejected", error: built.error, errorEn: built.errorEn });
			return;
		}
		selection = built.selection;
	}
	const next: ChannelCatalog = {
		...port.state.catalog,
		instanceDefault: input.scope === "instance" ? selection : port.state.catalog.instanceDefault,
		projectDefaults:
			input.scope === "project"
				? { ...port.state.catalog.projectDefaults, [port.state.cwd()]: selection }
				: port.state.catalog.projectDefaults,
		configRevision: port.state.configRevision + 1,
	};
	if (!port.state.commitConfig(next)) return port.conflictReceipt(input.commandId, "channel");
	port.receipt({ commandId: input.commandId, ok: true, phase: "applied", channelId: selection?.channelId });
	port.pushState();
}

/** P3：查询渠道账户余额/配额（有界超时、缓存、失败保留旧值）。 */
export async function queryAccountCommand(port: ChannelConfigPort, input: QueryAccountInput): Promise<void> {
	const channel = port.state.catalog.channels.find((c) => c.id === input.channelId);
	if (!channel) {
		port.receipt({ commandId: input.commandId, ok: false, phase: "rejected", error: "渠道不存在", errorEn: "Channel not found" });
		return;
	}
	if (!port.accounts) {
		port.receipt({
			commandId: input.commandId,
			ok: false,
			phase: "rejected",
			channelId: channel.id,
			error: "当前实例未启用账户查询",
			errorEn: "Account query is not enabled on this instance",
		});
		return;
	}
	const result = await port.accounts.query(channel, async (keyName) =>
		keyName ? port.resolveKeyValue(channel.providerId, keyName) : await port.resolveProviderKey(channel.providerId),
	);
	const usable = result.status === "ok" || result.status === "stale";
	port.receipt({
		commandId: input.commandId,
		ok: usable,
		phase: usable ? "applied" : "rejected",
		channelId: channel.id,
		error: result.error,
		errorEn: result.error,
	});
	port.pushState();
}
