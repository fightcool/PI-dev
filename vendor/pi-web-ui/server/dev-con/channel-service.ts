/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-state.ts (目录内存态/持久化/视图), channel-config.ts (渠道/默认值/账户命令),
 *            channel-model.ts, channel-store.ts, channel-accounts.ts,
 *            protocol.ts (channel_state / channel_command_result / channel_select),
 *            index.ts (dispatch + DispatchSession), agent-service.ts (host 实现),
 *            dsh/dsh-agent-service.ts (不支持热切换的引擎必须给出显式回执)
 *   📖 docs/DEV-CON-PROPOSAL.md §4（组合命令+revision 复核+回执+鉴权）, §5（切换场景表）, §9（P0 技术项）
 *   @CONTRACT 普通渠道选择只有一条命令 channel_select（渠道+凭据+模型一起提交、服务端确认）；
 *             回执 channel_command_result 携带 commandId/configRevision/bindingRevision，
 *             旧回执不得覆盖新状态（enqueue 串行化 + 版本校验 + superseded 回执）。
 *   @CONTRACT 对外 API 与拆分前一致（agent-service.ts 的 makeChannelHost、index.ts 的 DispatchSession
 *             依赖它）：本层只做串行化/回执/选择校验/待生效登记，状态与持久化委托 ChannelState，
 *             配置与账户命令委托 channel-config.ts。
 *   @WHY 切换时点用「本轮结束」而不是「run 内下一个 turn」：SDK 在 turn 边界会重读模型
 *        （agent-session.js:304 + agent-loop.js:90-95），但在途工具仍按旧计划跑；先交付
 *        更窄、可解释的边界（空闲立即、忙则待生效），更激进的时点留给后续验证。
 *   @GOTCHA 每条命令进入时先 refresh()（多端/外部编辑后本端内存可能是旧快照），
 *           否则会以旧状态误报「不存在」。
 *   @GOTCHA 待生效选择由本层 pending map 持有，状态层只通过 bindPendingSource 读取它构造视图；
 *           pending 条目的 bindingRevision 预写为「当前版本 + 1」，applyNow 时才真正推进版本。
 *   @SECURITY 密钥正文只在 credentialFor()（委托 ChannelState）内部返回给 Agent.getApiKey；
 *             所有出站消息都经 stateMessage()/receipt()，绝不携带密钥值或掩码片段。
 * ──────────────────────────────────────────────────
 */
import type { ChannelProviderInput, ServerMessage, UiChannelBindingView } from "../protocol.js";
import {
	checkBindingRevision,
	checkConfigRevision,
	DEFAULT_ENDPOINT_ID,
	makeBinding,
	planSwitch,
	sameSelection,
	validateSelection,
	type BindingSource,
	type ChannelBinding,
	type ChannelSelection,
	type CredentialRef,
	type RequestBindingSnapshot,
} from "./channel-model.js";
import { ChannelState, type ChannelStateHost, type PendingSelection } from "./channel-state.js";
import {
	deleteChannelCommand,
	queryAccountCommand,
	saveChannelCommand,
	setDefaultCommand,
	type ChannelConfigPort,
	type ChannelReceiptInput,
	type DeleteChannelInput,
	type QueryAccountInput,
	type SaveChannelInput,
	type SetDefaultInput,
} from "./channel-config.js";
import type { AccountRegistry } from "./channel-accounts.js";

/** 渠道服务依赖的宿主能力（由 ClientSession 实现）。
 *  状态层只消费其中的 ChannelStateHost 子集，因此这里直接 extends 它，避免同一份读口声明两次。 */
export interface ChannelServiceHost extends ChannelStateHost {
	emit: (msg: ServerMessage) => void;
	/** 跨客户端广播（多端看到同一有效绑定）。 */
	broadcast: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	/** runtime 中 (provider, model) 是否存在。 */
	getModel: (providerId: string, modelId: string) => { id: string; name: string } | null;
	/** 服务商自己配置的密钥（仅账户查询的兜底；密钥正文不出服务端）。 */
	resolveProviderKey: (providerId: string) => Promise<string | null>;
	/** 已注册的服务商 id（渠道表单生成不冲突的服务商 id 用）。 */
	providerIds: () => string[];
	/** 渠道表单的「服务商连接」写入（models.json + 热加载）；错误以返回值上报。 */
	upsertProvider: (
		input: ChannelProviderInput & { providerId: string },
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	/** 让某个对话使用该模型（内部调用 SDK session.setModel，会落 model_change）。 */
	setConversationModel: (conversationId: string, modelId: string) => Promise<void>;
	activeConversationId: () => string;
	conversationExists: (id: string) => boolean;
	/** 该对话是否正在生成（在途请求/工具）。 */
	isBusy: (id: string) => boolean;
	/** 该对话是否有排队消息（steering / followUp）。 */
	hasQueue: (id: string) => boolean;
}

/** 选择提交（channel_select / 默认值复用）。 */
export interface SelectionInput {
	channelId: string;
	endpointId?: string;
	credentialKeyName?: string | null;
	modelId: string;
}

type ChannelStateMessage = Extract<ServerMessage, { type: "channel_state" }>;

/** 渠道命令层：串行化 + 回执 + 选择校验；状态/持久化在 channel-state.ts，配置命令在 channel-config.ts。 */
export class ChannelService {
	private readonly state: ChannelState;
	private readonly pending = new Map<string, PendingSelection>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly host: ChannelServiceHost,
		private readonly accounts?: AccountRegistry,
	) {
		// 状态层只消费宿主里的 ChannelStateHost 子集（类型层面收窄），命令层保留 emit/broadcast 等。
		this.state = new ChannelState(host);
		this.state.bindPendingSource(() => this.pending.values());
	}

	// -- plumbing --------------------------------------------------------------

	/**
	 * 所有变更串行化：服务端排序保证旧回执不可能晚于新状态，且每条命令都**先从磁盘对齐**
	 * ——本端内存可能是别的客户端写入前的快照（多端下命令会以旧状态为准而误报「不存在」）。
	 */
	private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
		const task = async (): Promise<T> => {
			this.refresh();
			return fn();
		};
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private receipt(input: ChannelReceiptInput): void {
		this.host.emit({
			type: "channel_command_result",
			commandId: input.commandId,
			ok: input.ok,
			phase: input.phase,
			conversationId: input.conversationId,
			channelId: input.channelId,
			error: input.error,
			errorEn: input.errorEn,
			binding: input.binding ? this.state.decorate(input.binding) : undefined,
			configRevision: this.state.configRevision,
			bindingRevision: this.state.bindingRevision,
		});
	}

	private conflictReceipt(commandId: string, what: "channel" | "binding", note?: string): void {
		const base = what === "channel" ? "渠道配置已被其他端修改，请刷新后重试" : "对话绑定已被其他端修改，请刷新后重试";
		const baseEn = what === "channel" ? "Channel config changed elsewhere; refresh and retry" : "Conversation binding changed elsewhere; refresh and retry";
		this.receipt({
			commandId,
			ok: false,
			phase: "conflict",
			error: note ? `${note}；${base}` : base,
			errorEn: note ? `${note}; ${baseEn}` : baseEn,
		});
		// 冲突后把真实状态推给所有端，避免 UI 停在旧值上无法恢复（A02）。
		this.pushState();
	}

	/** 配置/账户命令的窄端口：只暴露它们需要的能力，其余保持本类私有。 */
	private configPort(): ChannelConfigPort {
		return {
			hasProvider: (providerId) => this.host.hasProvider(providerId),
			keyNames: (providerId) => this.host.keyNames(providerId),
			resolveKeyValue: (providerId, keyName) => this.host.resolveKeyValue(providerId, keyName),
			resolveProviderKey: (providerId) => this.host.resolveProviderKey(providerId),
			state: this.state,
			dropPending: (conversationId) => this.disposeConversation(conversationId),
			buildSelection: (input) => this.buildSelection(input),
			providerIds: () => this.host.providerIds(),
			upsertProvider: (input) => this.host.upsertProvider(input),
			receipt: (input) => this.receipt(input),
			conflictReceipt: (commandId, what, note) => this.conflictReceipt(commandId, what, note),
			pushState: () => this.pushState(),
			accounts: this.accounts,
		};
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
			if (!checkConfigRevision(this.state.configRevision, input.expectedConfigRevision).ok) {
				this.conflictReceipt(input.commandId, "channel");
				return;
			}
			if (!checkBindingRevision(this.state.storedBinding(conversationId)?.bindingRevision ?? 0, input.expectedBindingRevision).ok) {
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
				bindingRevision: this.state.bindingRevision + 1,
			});
			this.receipt({ commandId: input.commandId, ok: true, phase: "pending", conversationId, channelId: selection.channelId });
			if (superseded && superseded.commandId !== input.commandId) {
				this.receipt({ commandId: superseded.commandId, ok: false, phase: "superseded", conversationId, error: "已被更新的选择取代", errorEn: "Superseded by a newer selection" });
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
			const reason = (err as Error).message;
			this.receipt({ commandId, ok: false, phase: "rejected", conversationId, channelId: selection.channelId, error: `切换失败：${reason}`, errorEn: `Switch failed: ${reason}` });
			this.pushState();
			return;
		}
		const revision = this.state.bumpBindingRevision();
		const binding = makeBinding({
			conversationId,
			selection,
			configRevision: this.state.configRevision,
			bindingRevision: revision,
			now: Date.now(),
		});
		this.state.commitBindings({ [this.state.key(conversationId)]: binding });
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
			if (!checkBindingRevision(this.state.storedBinding(conversationId)?.bindingRevision ?? 0, input.expectedBindingRevision).ok) {
				this.conflictReceipt(input.commandId, "binding");
				return;
			}
			this.pending.delete(conversationId);
			this.state.bumpBindingRevision();
			this.state.commitBindings({ [this.state.key(conversationId)]: null });
			this.receipt({ commandId: input.commandId, ok: true, phase: "applied", conversationId });
			this.pushState();
		});
	}

	/** 新增/更新渠道档案（见 channel-config.ts；本层只负责串行化）。 */
	saveChannel(input: SaveChannelInput): Promise<void> {
		return this.enqueue(() => saveChannelCommand(this.configPort(), input));
	}

	/** 删除渠道：同时清理引用它的默认值与绑定（不改写历史用量）。 */
	deleteChannel(input: DeleteChannelInput): Promise<void> {
		return this.enqueue(() => deleteChannelCommand(this.configPort(), input));
	}

	/** 设置项目/实例默认（只影响未发言对话，不重绑正在运行的对话）。 */
	setDefault(input: SetDefaultInput): Promise<void> {
		return this.enqueue(() => setDefaultCommand(this.configPort(), input));
	}

	/** P3：查询渠道账户余额/配额（有界超时、缓存、失败保留旧值）。 */
	queryAccount(input: QueryAccountInput): Promise<void> {
		return this.enqueue(() => queryAccountCommand(this.configPort(), input));
	}

	// -- validation ------------------------------------------------------------

	/** 一次选择是否与渠道档案自洽（渠道/端点/模型服务商/命名凭据存在性）。 */
	private buildSelection(input: SelectionInput): { selection: ChannelSelection } | { error: string; errorEn: string } {
		const channel = this.state.catalog.channels.find((c) => c.id === input.channelId);
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
		const channel = this.state.catalog.channels.find((c) => c.id === selection.channelId);
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
		const { selection: current } = this.state.effectiveSelectionFor(conversationId);
		if (!current) return false;
		const channel = this.state.catalog.channels.find((c) => c.id === input.channelId);
		const keyName = input.credentialKeyName ?? channel?.credentialRef?.keyName ?? null;
		return sameSelection(current, {
			channelId: input.channelId,
			endpointId: input.endpointId ?? DEFAULT_ENDPOINT_ID,
			credentialRef: keyName ? { providerId: current.credentialRef?.providerId ?? channel?.providerId ?? "", keyName } : null,
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

	// -- state pass-through（对外 API 与拆分前一致） -----------------------------

	/** 有效选择（对话绑定 → 项目默认 → 实例默认）。 */
	effectiveSelectionFor(conversationId: string): { selection: ChannelSelection | null; source: BindingSource } {
		return this.state.effectiveSelectionFor(conversationId);
	}

	/** 该对话该服务商应使用的密钥正文（仅服务端内部，见头部 @SECURITY）。 */
	credentialFor(conversationId: string, providerId: string): string | undefined {
		return this.state.credentialFor(conversationId, providerId);
	}

	/** 有效/待生效绑定的只读视图。 */
	bindingViewFor(conversationId: string): { effective: ChannelBinding | null; pending: ChannelBinding | null; source: BindingSource } {
		return this.state.bindingViewFor(conversationId);
	}

	/** 快照 UI 用：当前对话的有效/待生效绑定视图（不含任何密钥）。 */
	bindingViewMessage(conversationId: string): UiChannelBindingView {
		return this.state.bindingViewMessage(conversationId);
	}

	/** 请求发出时的绑定快照（§7 用量归属）。 */
	bindingSnapshotFor(conversationId: string): RequestBindingSnapshot | null {
		return this.state.bindingSnapshotFor(conversationId);
	}

	/** 该对话是否已有显式渠道绑定。 */
	hasConversationBinding(conversationId: string): boolean {
		return this.state.hasConversationBinding(conversationId);
	}

	/** 新对话继承上一对话的渠道绑定（不调用 setModel）。 */
	inheritBinding(fromConversationId: string, toConversationId: string): void {
		this.state.inheritBinding(fromConversationId, toConversationId);
	}

	/** 重新从磁盘读取渠道目录（多端/外部编辑后刷新）。 */
	refresh(): void {
		this.state.refresh();
	}

	/** 唯一的状态消息构造（账号快照由本层注入，状态层不认识 AccountRegistry）。 */
	stateMessage(): ChannelStateMessage {
		return this.state.stateMessage(this.accounts?.snapshot() ?? [], this.accounts?.presets() ?? []);
	}

	pushState(): void {
		this.host.broadcast(this.stateMessage());
		this.host.flushSnapshot();
	}
}
