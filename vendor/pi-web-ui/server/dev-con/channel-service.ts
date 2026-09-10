/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-model.ts, channel-store.ts, channel-accounts.ts,
 *            protocol.ts (channel_state / channel_command_result / channel_select),
 *            index.ts (dispatch + DispatchSession), agent-service.ts (host 实现),
 *            dsh/dsh-agent-service.ts (不支持热切换的引擎必须给出显式回执)
 *   📖 docs/DEV-CON-PROPOSAL.md §4（组合命令+revision 复核+回执+鉴权）, §5（切换场景表）, §9（P0 技术项）
 *   @CONTRACT 普通渠道选择只有一条命令 channel_select（渠道+凭据+模型一起提交、服务端确认）；
 *             回执 channel_command_result 携带 commandId/configRevision/bindingRevision，
 *             旧回执不得覆盖新状态（enqueue 串行化 + 版本校验 + superseded 回执）。
 *   @WHY 切换时点用「本轮结束」而不是「run 内下一个 turn」：SDK 在 turn 边界会重读模型
 *        （agent-session.js:304 + agent-loop.js:90-95），但在途工具仍按旧计划跑；先交付
 *        更窄、可解释的边界（空闲立即、忙则待生效），更激进的时点留给后续验证。
 *   @GOTCHA 绑定写入用「重载+按 bindingRevision 合并」；渠道/默认值写入必须是
 *           先算 next → 落盘成功才提交内存，冲突时不改内存、不回滚半个状态。
 *   @SECURITY 密钥正文只在 credentialFor() 内部返回给 Agent.getApiKey；所有出站消息
 *             都经 stateMessage()/receipt()，绝不携带密钥值或掩码片段。
 * ──────────────────────────────────────────────────
 */
import type { ServerMessage, UiChannelBindingView } from "../protocol.js";
import {
	checkBindingRevision,
	checkConfigRevision,
	DEFAULT_ENDPOINT_ID,
	detachChannel,
	makeBinding,
	nextChannelId,
	planSwitch,
	pruneBindings,
	sameSelection,
	toSelection,
	validateChannelRecord,
	validateSelection,
	type BindingSource,
	type ChannelBinding,
	type ChannelCatalog,
	type ChannelRecord,
	type ChannelSelection,
	type CredentialRef,
	type RequestBindingSnapshot,
} from "./channel-model.js";
import { catalogHash, loadCatalog, saveCatalog } from "./channel-store.js";
import type { AccountRegistry } from "./channel-accounts.js";

/** 渠道服务依赖的宿主能力（由 ClientSession 实现）。 */
export interface ChannelServiceHost {
	agentDir: string;
	emit: (msg: ServerMessage) => void;
	/** 跨客户端广播（多端看到同一有效绑定）。 */
	broadcast: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	/** runtime 是否注册了该服务商。 */
	hasProvider: (providerId: string) => boolean;
	/** runtime 中 (provider, model) 是否存在。 */
	getModel: (providerId: string, modelId: string) => { id: string; name: string } | null;
	/** provider-keys.json 的命名密钥（仅名称 + 是否 active）。 */
	keyNames: (providerId: string) => { keyName: string; active: boolean }[];
	/** 服务端解析命名密钥正文；密钥不存在返回 null。 */
	resolveKeyValue: (providerId: string, keyName: string) => string | null;
	/** 让某个对话使用该模型（内部调用 SDK session.setModel，会落 model_change）。 */
	setConversationModel: (conversationId: string, modelId: string) => Promise<void>;
	activeConversationId: () => string;
	conversationExists: (id: string) => boolean;
	/** 该对话是否正在生成（在途请求/工具）。 */
	isBusy: (id: string) => boolean;
	/** 该对话是否有排队消息（steering / followUp）。 */
	hasQueue: (id: string) => boolean;
	/** 该对话是否已经有过消息（决定项目/实例默认是否可继承）。 */
	conversationHasMessages: (id: string) => boolean;
	cwd: () => string;
}

interface PendingSwitch {
	conversationId: string;
	selection: ChannelSelection;
	commandId: string;
	bindingRevision: number;
}

/** 选择提交（channel_select / 默认值复用）。 */
export interface SelectionInput {
	channelId: string;
	endpointId?: string;
	credentialKeyName?: string | null;
	modelId: string;
}

type ChannelState = Extract<ServerMessage, { type: "channel_state" }>;
type ChannelReceipt = Extract<ServerMessage, { type: "channel_command_result" }>;

export class ChannelService {
	private catalog: ChannelCatalog;
	private hash: string | null;
	private bindingRevision = 0;
	private readonly pending = new Map<string, PendingSwitch>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly host: ChannelServiceHost,
		private readonly accounts?: AccountRegistry,
	) {
		const loaded = loadCatalog(host.agentDir);
		this.catalog = loaded.catalog;
		this.hash = loaded.hash;
		this.bindingRevision = Math.max(0, ...Object.values(this.catalog.bindings).map((b) => b.bindingRevision ?? 0));
	}

	// -- state -----------------------------------------------------------------

	/**
	 * 有效选择：对话绑定优先；没有绑定时只有「尚未发言」的对话才继承
	 * 项目/实例默认（§4：修改默认不悄悄重绑已运行对话）。
	 */
	effectiveSelectionFor(conversationId: string): { selection: ChannelSelection | null; source: BindingSource } {
		const stored = this.catalog.bindings[conversationId];
		if (stored?.channelId) return { selection: toSelection(stored), source: "conversation" };
		if (this.host.conversationHasMessages(conversationId)) return { selection: null, source: "none" };
		const cwd = this.host.cwd();
		const cwdDefault = this.catalog.projectDefaults[cwd];
		if (cwdDefault) return { selection: cwdDefault, source: "project" };
		// 其他项目的默认不得跨项目继承。
		if (!this.catalog.projectDefaults[cwd] && this.catalog.instanceDefault) {
			return { selection: this.catalog.instanceDefault, source: "instance" };
		}
		return { selection: null, source: "none" };
	}

	/**
	 * 供 Agent.getApiKey 使用：该对话该服务商应使用的密钥正文（仅服务端内部）。
	 * 只认「已生效」绑定 —— 待生效选择必须等本轮结束后才影响请求，
	 * 否则同一 run 的后续请求会用上新 key（违反 §5「已发请求按原绑定完成」）。
	 */
	credentialFor(conversationId: string, providerId: string): string | undefined {
		const selection = this.effectiveSelectionFor(conversationId).selection;
		if (!selection?.credentialRef) return undefined;
		if (selection.credentialRef.providerId !== providerId) return undefined;
		return this.host.resolveKeyValue(providerId, selection.credentialRef.keyName) ?? undefined;
	}

	/** 请求发出时的绑定快照（§7：用量按请求时的渠道/凭据/模型归属）。 */
	bindingSnapshotFor(conversationId: string): RequestBindingSnapshot | null {
		const { selection } = this.effectiveSelectionFor(conversationId);
		if (!selection) return null;
		const stored = this.catalog.bindings[conversationId];
		const channel = this.catalog.channels.find((c) => c.id === selection.channelId);
		return {
			channelId: selection.channelId,
			endpointId: selection.endpointId,
			credentialKeyName: selection.credentialRef?.keyName ?? null,
			modelId: selection.modelId,
			providerId: channel?.providerId ?? null,
			bindingRevision: stored?.bindingRevision ?? 0,
			configRevision: this.catalog.configRevision,
		};
	}

	/** 该对话是否已有显式渠道绑定（未发言对话不应被旧的“项目默认模型”覆盖）。 */
	hasConversationBinding(conversationId: string): boolean {
		return Boolean(this.catalog.bindings[conversationId]?.channelId);
	}

	/**
	 * 新对话继承上一对话的渠道绑定（不调用 setModel —— 模型已由 newChat 携带过去），
	 * 否则新对话会只剩下模型而没有渠道/凭据归属。
	 */
	inheritBinding(fromConversationId: string, toConversationId: string): void {
		const source = this.catalog.bindings[fromConversationId];
		if (!source || source.conversationId === toConversationId) return;
		if (this.catalog.bindings[toConversationId]?.channelId) return;
		this.bindingRevision += 1;
		this.commitBindings({
			[toConversationId]: makeBinding({
				conversationId: toConversationId,
				selection: toSelection(source),
				configRevision: this.catalog.configRevision,
				bindingRevision: this.bindingRevision,
				now: Date.now(),
			}),
		});
	}

	/** 有效/待生效绑定的只读视图（快照 UI 用）。 */
	bindingViewFor(conversationId: string): { effective: ChannelBinding | null; pending: ChannelBinding | null; source: BindingSource } {
		const stored = this.catalog.bindings[conversationId] ?? null;
		const { selection, source } = this.effectiveSelectionFor(conversationId);
		const effective =
			stored ??
			(selection
				? makeBinding({ conversationId, selection, configRevision: this.catalog.configRevision, bindingRevision: 0, now: 0 })
				: null);
		const pend = this.pending.get(conversationId);
		const pending = pend
			? makeBinding({
					conversationId,
					selection: pend.selection,
					configRevision: this.catalog.configRevision,
					bindingRevision: pend.bindingRevision,
					now: 0,
				})
			: null;
		return { effective, pending, source };
	}

	/** 快照 UI 用：当前对话的有效/待生效绑定视图（不含任何密钥）。 */
	bindingViewMessage(conversationId: string): UiChannelBindingView {
		const { effective, pending, source } = this.bindingViewFor(conversationId);
		return {
			effective: effective ? this.decorate(effective) : null,
			pending: pending ? this.decorate(pending) : null,
			source,
		};
	}

	private channelViews(): ChannelState["channels"] {
		return this.catalog.channels.map((c) => {
			const keys = this.host.keyNames(c.providerId);
			return {
				id: c.id,
				displayName: c.displayName,
				providerId: c.providerId,
				endpointId: c.endpointId,
				credentialRef: c.credentialRef,
				accountRef: c.accountRef,
				enabled: c.enabled,
				keys,
				keyMissing: c.credentialRef ? !keys.some((k) => k.keyName === c.credentialRef?.keyName) : false,
				providerMissing: !this.host.hasProvider(c.providerId),
			};
		});
	}

	private decorate(binding: ChannelBinding): ChannelState["bindings"][number] {
		return {
			...binding,
			channelName: this.catalog.channels.find((c) => c.id === binding.channelId)?.displayName ?? null,
		};
	}

	/** 唯一的状态推送出口。 */
	stateMessage(): ChannelState {
		return {
			type: "channel_state",
			configRevision: this.catalog.configRevision,
			bindingRevision: this.bindingRevision,
			channels: this.channelViews(),
			instanceDefault: this.catalog.instanceDefault,
			projectDefault: this.catalog.projectDefaults[this.host.cwd()] ?? null,
			bindings: Object.values(this.catalog.bindings).map((b) => this.decorate(b)),
			pending: [...this.pending.values()].map((p) => ({
				conversationId: p.conversationId,
				...toSelection(p.selection),
				bindingRevision: p.bindingRevision,
				commandId: p.commandId,
			})),
			accounts: this.accounts?.snapshot() ?? [],
		};
	}

	pushState(): void {
		this.host.broadcast(this.stateMessage());
		this.host.flushSnapshot();
	}

	// -- plumbing --------------------------------------------------------------

	/** 所有变更串行化：服务端排序保证旧回执不可能晚于新状态。 */
	private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private receipt(input: {
		commandId: string;
		ok: boolean;
		phase: ChannelReceipt["phase"];
		conversationId?: string;
		channelId?: string;
		error?: string;
		errorEn?: string;
		binding?: ChannelBinding | null;
	}): void {
		this.host.emit({
			type: "channel_command_result",
			commandId: input.commandId,
			ok: input.ok,
			phase: input.phase,
			conversationId: input.conversationId,
			channelId: input.channelId,
			error: input.error,
			errorEn: input.errorEn,
			binding: input.binding ? this.decorate(input.binding) : undefined,
			configRevision: this.catalog.configRevision,
			bindingRevision: this.bindingRevision,
		});
	}

	private conflictReceipt(commandId: string, what: "channel" | "binding"): void {
		this.receipt({
			commandId,
			ok: false,
			phase: "conflict",
			error: what === "channel" ? "渠道配置已被其他端修改，请刷新后重试" : "对话绑定已被其他端修改，请刷新后重试",
			errorEn: what === "channel" ? "Channel config changed elsewhere; refresh and retry" : "Conversation binding changed elsewhere; refresh and retry",
		});
	}

	// -- commands --------------------------------------------------------------

	/** 组合命令：一次提交渠道 + 凭据 + 模型，服务端确认最终状态。 */
	select(input: {
		commandId: string;
		conversationId?: string;
		selection: SelectionInput;
		expectedConfigRevision?: number;
		expectedBindingRevision?: number;
	}): Promise<void> {
		return this.enqueue(async () => {
			const conversationId = input.conversationId || this.host.activeConversationId();
			if (!this.host.conversationExists(conversationId)) {
				this.receipt({ commandId: input.commandId, ok: false, phase: "rejected", conversationId, error: "对话不存在", errorEn: "Conversation not found" });
				return;
			}
			if (!checkConfigRevision(this.catalog.configRevision, input.expectedConfigRevision).ok) {
				this.conflictReceipt(input.commandId, "channel");
				return;
			}
			if (!checkBindingRevision(this.catalog.bindings[conversationId]?.bindingRevision ?? 0, input.expectedBindingRevision).ok) {
				this.conflictReceipt(input.commandId, "binding");
				return;
			}
			const built = this.buildSelection(input.selection);
			if ("error" in built) {
				this.receipt({ commandId: input.commandId, ok: false, phase: "rejected", conversationId, error: built.error, errorEn: built.errorEn });
				return;
			}
			const { selection } = built;
			const plan = planSwitch({ busy: this.host.isBusy(conversationId), hasQueue: this.host.hasQueue(conversationId) });
			if (plan.mode === "apply") {
				await this.applyNow(conversationId, selection, input.commandId);
				return;
			}
			const superseded = this.pending.get(conversationId);
			this.pending.set(conversationId, {
				conversationId,
				selection,
				commandId: input.commandId,
				bindingRevision: this.bindingRevision + 1,
			});
			this.receipt({ commandId: input.commandId, ok: true, phase: "pending", conversationId, channelId: selection.channelId });
			if (superseded && superseded.commandId !== input.commandId) {
				this.receipt({
					commandId: superseded.commandId,
					ok: false,
					phase: "superseded",
					conversationId,
					error: "已被更新的选择取代",
					errorEn: "Superseded by a newer selection",
				});
			}
			this.pushState();
		});
	}

	/** 立即应用（空闲路径 + 待生效到期）。失败保留原绑定。 */
	private async applyNow(conversationId: string, selection: ChannelSelection, commandId: string): Promise<void> {
		try {
			await this.host.setConversationModel(conversationId, selection.modelId);
		} catch (err) {
			// 在途请求与工具不受影响；绑定保持原样，UI 显示失败阶段。
			this.receipt({
				commandId,
				ok: false,
				phase: "rejected",
				conversationId,
				channelId: selection.channelId,
				error: `切换失败：${(err as Error).message}`,
				errorEn: `Switch failed: ${(err as Error).message}`,
			});
			this.pushState();
			return;
		}
		this.bindingRevision += 1;
		const binding = makeBinding({
			conversationId,
			selection,
			configRevision: this.catalog.configRevision,
			bindingRevision: this.bindingRevision,
			now: Date.now(),
		});
		this.commitBindings({ [conversationId]: binding });
		this.receipt({ commandId, ok: true, phase: "applied", conversationId, channelId: selection.channelId, binding });
		this.pushState();
	}

	/** 本轮结束：应用待生效选择（agent-service 在 agent_end 调用）。 */
	async onConversationSettled(conversationId: string): Promise<void> {
		const pending = this.pending.get(conversationId);
		if (!pending) return;
		await this.enqueue(async () => {
			// 期间可能来了更新的选择或被清除 —— 只应用当前登记的那一个。
			if (this.pending.get(conversationId) !== pending) return;
			if (this.host.isBusy(conversationId) || this.host.hasQueue(conversationId)) return;
			this.pending.delete(conversationId);
			await this.applyNow(conversationId, pending.selection, pending.commandId);
		});
	}

	/** 清除对话绑定（回到项目/实例默认或全局 active key）。 */
	clearBinding(input: { commandId: string; conversationId?: string; expectedBindingRevision?: number }): Promise<void> {
		return this.enqueue(() => {
			const conversationId = input.conversationId || this.host.activeConversationId();
			if (!this.host.conversationExists(conversationId)) {
				this.receipt({ commandId: input.commandId, ok: false, phase: "rejected", conversationId, error: "对话不存在", errorEn: "Conversation not found" });
				return;
			}
			if (!checkBindingRevision(this.catalog.bindings[conversationId]?.bindingRevision ?? 0, input.expectedBindingRevision).ok) {
				this.conflictReceipt(input.commandId, "binding");
				return;
			}
			this.pending.delete(conversationId);
			this.bindingRevision += 1;
			this.commitBindings({ [conversationId]: null });
			this.receipt({ commandId: input.commandId, ok: true, phase: "applied", conversationId });
			this.pushState();
		});
	}

	/** 新增/更新渠道档案（不允许暗改；冲突显式回执）。 */
	saveChannel(input: { commandId: string; channel: Partial<ChannelRecord> & { id?: string }; expectedConfigRevision?: number }): Promise<void> {
		return this.enqueue(() => {
			if (!checkConfigRevision(this.catalog.configRevision, input.expectedConfigRevision).ok) {
				return this.conflictReceipt(input.commandId, "channel");
			}
			const existing = this.catalog.channels.find((c) => c.id === input.channel.id);
			const record: ChannelRecord = {
				id: input.channel.id?.trim() || nextChannelId(this.catalog.channels),
				displayName: input.channel.displayName?.trim() || "",
				providerId: input.channel.providerId?.trim() || "",
				endpointId: input.channel.endpointId?.trim() || DEFAULT_ENDPOINT_ID,
				credentialRef: input.channel.credentialRef ?? null,
				accountRef: input.channel.accountRef ?? null,
				enabled: input.channel.enabled !== false,
				extra: { ...(existing?.extra ?? {}), ...(input.channel.extra ?? {}) },
			};
			if (!this.host.hasProvider(record.providerId)) {
				this.receipt({
					commandId: input.commandId,
					ok: false,
					phase: "rejected",
					channelId: record.id,
					error: `服务商「${record.providerId}」未在模型中注册`,
					errorEn: `Provider "${record.providerId}" is not registered`,
				});
				return;
			}
			const others = this.catalog.channels.filter((c) => c.id !== record.id);
			const errors = validateChannelRecord(record, others);
			if (errors.length > 0) {
				this.receipt({ commandId: input.commandId, ok: false, phase: "rejected", channelId: record.id, error: errors.join("；"), errorEn: errors.join("; ") });
				return;
			}
			if (record.credentialRef && !this.host.keyNames(record.providerId).some((k) => k.keyName === record.credentialRef?.keyName)) {
				this.receipt({
					commandId: input.commandId,
					ok: false,
					phase: "rejected",
					channelId: record.id,
					error: `命名凭据不存在：${record.credentialRef.keyName}`,
					errorEn: `Named credential not found: ${record.credentialRef.keyName}`,
				});
				return;
			}
			const next: ChannelCatalog = {
				...this.catalog,
				channels: [...others, record].sort((a, b) => a.id.localeCompare(b.id)),
				configRevision: this.catalog.configRevision + 1,
			};
			if (!this.commitConfig(next)) return this.conflictReceipt(input.commandId, "channel");
			this.receipt({ commandId: input.commandId, ok: true, phase: "applied", channelId: record.id });
			this.pushState();
		});
	}

	/** 删除渠道：同时清理引用它的默认值与绑定（不改写历史用量）。 */
	deleteChannel(input: { commandId: string; channelId: string; expectedConfigRevision?: number }): Promise<void> {
		return this.enqueue(() => {
			if (!checkConfigRevision(this.catalog.configRevision, input.expectedConfigRevision).ok) {
				return this.conflictReceipt(input.commandId, "channel");
			}
			if (!this.catalog.channels.some((c) => c.id === input.channelId)) {
				this.receipt({ commandId: input.commandId, ok: false, phase: "rejected", error: "渠道不存在", errorEn: "Channel not found" });
				return;
			}
			const { catalog, detachedConversations } = detachChannel(this.catalog, input.channelId);
			const next: ChannelCatalog = { ...catalog, configRevision: this.catalog.configRevision + 1 };
			if (!this.commitConfig(next)) return this.conflictReceipt(input.commandId, "channel");
			for (const id of detachedConversations) this.pending.delete(id);
			this.bindingRevision += 1;
			this.receipt({ commandId: input.commandId, ok: true, phase: "applied", channelId: input.channelId });
			this.pushState();
		});
	}

	/** 设置项目/实例默认（只影响未发言对话，不重绑正在运行的对话）。 */
	setDefault(input: {
		commandId: string;
		scope: "instance" | "project";
		selection: SelectionInput | null;
		expectedConfigRevision?: number;
	}): Promise<void> {
		return this.enqueue(() => {
			if (!checkConfigRevision(this.catalog.configRevision, input.expectedConfigRevision).ok) {
				return this.conflictReceipt(input.commandId, "channel");
			}
			let selection: ChannelSelection | null = null;
			if (input.selection) {
				const built = this.buildSelection(input.selection);
				if ("error" in built) {
					this.receipt({ commandId: input.commandId, ok: false, phase: "rejected", error: built.error, errorEn: built.errorEn });
					return;
				}
				selection = built.selection;
			}
			const next: ChannelCatalog = {
				...this.catalog,
				instanceDefault: input.scope === "instance" ? selection : this.catalog.instanceDefault,
				projectDefaults:
					input.scope === "project"
						? { ...this.catalog.projectDefaults, [this.host.cwd()]: selection }
						: this.catalog.projectDefaults,
				configRevision: this.catalog.configRevision + 1,
			};
			if (!this.commitConfig(next)) return this.conflictReceipt(input.commandId, "channel");
			this.receipt({ commandId: input.commandId, ok: true, phase: "applied", channelId: selection?.channelId });
			this.pushState();
		});
	}

	/** P3：查询渠道账户余额/配额（有界超时、缓存、失败保留旧值）。 */
	queryAccount(input: { commandId: string; channelId: string }): Promise<void> {
		return this.enqueue(async () => {
			const channel = this.catalog.channels.find((c) => c.id === input.channelId);
			if (!channel) {
				this.receipt({ commandId: input.commandId, ok: false, phase: "rejected", error: "渠道不存在", errorEn: "Channel not found" });
				return;
			}
			if (!this.accounts) {
				this.receipt({
					commandId: input.commandId,
					ok: false,
					phase: "rejected",
					channelId: channel.id,
					error: "当前实例未启用账户查询",
					errorEn: "Account query is not enabled on this instance",
				});
				return;
			}
			const result = await this.accounts.query(channel, (keyName) => this.host.resolveKeyValue(channel.providerId, keyName));
			const usable = result.status === "ok" || result.status === "stale";
			this.receipt({
				commandId: input.commandId,
				ok: usable,
				phase: usable ? "applied" : "rejected",
				channelId: channel.id,
				error: result.error,
				errorEn: result.error,
			});
			this.pushState();
		});
	}

	// -- validation ------------------------------------------------------------

	private buildSelection(input: SelectionInput): { selection: ChannelSelection } | { error: string; errorEn: string } {
		const channel = this.catalog.channels.find((c) => c.id === input.channelId);
		if (!channel) return { error: "渠道不存在", errorEn: "Channel not found" };
		const keyName = input.credentialKeyName ?? channel.credentialRef?.keyName ?? null;
		const credentialRef: CredentialRef | null = keyName ? { providerId: channel.providerId, keyName } : null;
		const selection: ChannelSelection = {
			channelId: channel.id,
			endpointId: channel.endpointId || DEFAULT_ENDPOINT_ID,
			credentialRef,
			modelId: input.modelId,
		};
		const errors = validateSelection(selection, channel);
		if (errors.length > 0) return { error: errors.join("；"), errorEn: errors.join("; ") };
		const parsed = selection.modelId.split("/");
		if (parsed.length < 2 || !this.host.getModel(parsed[0], parsed.slice(1).join("/"))) {
			return { error: `模型不存在：${selection.modelId}`, errorEn: `Model not found: ${selection.modelId}` };
		}
		if (credentialRef && !this.host.keyNames(channel.providerId).some((k) => k.keyName === credentialRef.keyName)) {
			return { error: `命名凭据不存在：${credentialRef.keyName}`, errorEn: `Named credential not found: ${credentialRef.keyName}` };
		}
		return { selection };
	}

	/** 该选择当前是否仍可用（UI 展示 + 恢复路径）。 */
	isSelectionUsable(selection: ChannelSelection | null): boolean {
		if (!selection) return false;
		const channel = this.catalog.channels.find((c) => c.id === selection.channelId);
		if (!channel || !channel.enabled) return false;
		if (validateSelection(selection, channel).length > 0) return false;
		const parsed = selection.modelId.split("/");
		if (parsed.length < 2 || !this.host.getModel(parsed[0], parsed.slice(1).join("/"))) return false;
		if (selection.credentialRef && !this.host.keyNames(selection.credentialRef.providerId).some((k) => k.keyName === selection.credentialRef?.keyName)) {
			return false;
		}
		return true;
	}

	/** 与当前有效选择等价？（UI 抑制重复提交） */
	isCurrent(conversationId: string, input: SelectionInput): boolean {
		const { selection: current } = this.effectiveSelectionFor(conversationId);
		if (!current) return false;
		const keyName = input.credentialKeyName ?? this.catalog.channels.find((c) => c.id === input.channelId)?.credentialRef?.keyName ?? null;
		return sameSelection(current, {
			channelId: input.channelId,
			endpointId: input.endpointId ?? DEFAULT_ENDPOINT_ID,
			credentialRef: keyName ? { providerId: current.credentialRef?.providerId ?? this.catalog.channels.find((c) => c.id === input.channelId)?.providerId ?? "", keyName } : null,
			modelId: input.modelId,
		});
	}

	/** 计划中的待生效选择（回执/快照用）。 */
	pendingSelectionFor(conversationId: string): ChannelSelection | null {
		return this.pending.get(conversationId)?.selection ?? null;
	}

	/** 对话关闭/删除时释放待生效项。 */
	disposeConversation(conversationId: string): void {
		this.pending.delete(conversationId);
	}

	// -- persistence -----------------------------------------------------------

	/**
	 * 渠道/默认值写入：先落盘成功再提交内存。
	 * 失败（外部修改/不可写）时内存保持原状，由调用方回 conflict 回执。
	 */
	private commitConfig(next: ChannelCatalog): boolean {
		const result = saveCatalog(this.host.agentDir, next, this.hash);
		if (!result.ok) {
			this.hash = catalogHash(this.host.agentDir);
			return false;
		}
		this.catalog = next;
		this.hash = result.hash;
		return true;
	}

	/**
	 * 绑定写入：重载文件后按 bindingRevision 合并（别的 client 可能刚写了别的绑定），
	 * 再整体落盘。绑定写入失败不回滚内存里的 setModel 结果 —— 模型确实已经切了，
	 * 只是持久化没成功；下一次选择会再写。
	 */
	private commitBindings(changes: Record<string, ChannelBinding | null>): void {
		const inline: ChannelCatalog = {
			...this.catalog,
			bindings: { ...this.catalog.bindings },
		};
		for (const [id, binding] of Object.entries(changes)) {
			if (binding) inline.bindings[id] = binding;
			else delete inline.bindings[id];
		}
		inline.bindings = pruneBindings(inline.bindings);
		const loaded = loadCatalog(this.host.agentDir);
		const merged: ChannelCatalog = { ...inline, bindings: { ...loaded.catalog.bindings } };
		for (const [id, binding] of Object.entries(inline.bindings)) {
			const other = loaded.catalog.bindings[id];
			if (!other || other.bindingRevision <= binding.bindingRevision) merged.bindings[id] = binding;
		}
		for (const id of Object.keys(changes)) {
			if (changes[id] === null && loaded.catalog.bindings[id] && !inline.bindings[id]) delete merged.bindings[id];
		}
		merged.bindings = pruneBindings(merged.bindings);
		const result = saveCatalog(this.host.agentDir, merged, loaded.hash);
		if (result.ok) {
			this.catalog = merged;
			this.hash = result.hash;
			return;
		}
		// 保留内存态（模型已切），下次写入重新同步。
		this.catalog = inline;
	}
}
