/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-model.ts (纯逻辑/数据结构)、channel-store.ts (channels.json 读写),
 *            channel-service.ts (命令层唯一调用方)、channel-config.ts (渠道/默认值/账户命令),
 *            protocol.ts (channel_state 视图类型)
 *   📖 docs/DEV-CON-PROPOSAL.md §4（配置对象、所有权与安全/组合命令）, §5（切换场景表）,
 *      §7（请求时绑定快照 → 用量归属）
 *   @CONTRACT 状态层只做三件事：目录内存态、持久化（先落盘成功再提交内存）、视图构造；
 *             不发回执、不串行化命令、不认识 emit/broadcast/flushSnapshot。
 *   @WHY 待生效选择（pending）由命令层持有，状态层用 bindPendingSource() 只读它构造视图：
 *        这样状态层不依赖命令流程，视图与绑定语义可以脱离 ChannelService 单独验证。
 *   @GOTCHA 绑定存储键是 "<clientId>::<conversationId>"：对话 id（c1/c2…）只在单个客户端内
 *           唯一，而 channels.json 是全实例共享的；直接用 conversationId 会跨端互相覆盖。
 *   @GOTCHA refresh/commitConfig 遇到文件损坏或不一致时保留内存态并重新对齐，绝不静默清空。
 *   @SECURITY 出站视图只含引用（providerId/keyName）；密钥正文只在 credentialFor() 内部返回。
 * ──────────────────────────────────────────────────
 */
import type { ServerMessage, UiAccountStatus, UiChannelBindingView } from "../protocol.js";
import {
	makeBinding,
	pruneBindings,
	toSelection,
	type BindingSource,
	type ChannelBinding,
	type ChannelCatalog,
	type ChannelSelection,
	type RequestBindingSnapshot,
} from "./channel-model.js";
import { loadCatalog, saveCatalog } from "./channel-store.js";
import { topupUrlOf } from "./channel-accounts.js";

/** 状态层依赖的宿主能力（窄接口：只含目录/绑定语义需要的读口）。 */
export interface ChannelStateHost {
	agentDir: string;
	/** 本会话所属客户端 id（绑定键必须带 clientId，见头部 @GOTCHA）。 */
	clientId: string;
	cwd: () => string;
	/** provider-keys.json 的命名密钥（仅名称 + 是否 active）。 */
	keyNames: (providerId: string) => { keyName: string; active: boolean }[];
	/** runtime 是否注册了该服务商。 */
	hasProvider: (providerId: string) => boolean;
	/** 该对话是否已经有过消息（决定项目/实例默认是否可继承）。 */
	conversationHasMessages: (id: string) => boolean;
	/** 解析命名密钥正文；仅 credentialFor() 使用，密钥值不出状态层以外的调用方。 */
	resolveKeyValue: (providerId: string, keyName: string) => string | null;
}

/** 待生效选择（由命令层的 pending map 持有，状态层只读取它构造视图）。 */
export interface PendingSelection {
	conversationId: string;
	selection: ChannelSelection;
	commandId: string;
	bindingRevision: number;
}

type ChannelStateMessage = Extract<ServerMessage, { type: "channel_state" }>;

/**
 * 渠道状态层：目录内存态 + 持久化 + 视图构造。
 * 所有写入走 commitConfig（配置）与 commitBindings（绑定），两者都保证「先落盘成功再提交内存」。
 */
export class ChannelState {
	/** 内存中的目录（唯一可写者：refresh / commitConfig / commitBindings）。 */
	private current: ChannelCatalog;
	private hash: string | null;
	private revision = 0;
	/** 待生效选择的只读来源（命令层注入，见头部 @WHY）。 */
	private pendingSource: () => Iterable<PendingSelection> = () => [];

	constructor(private readonly host: ChannelStateHost) {
		const loaded = loadCatalog(host.agentDir);
		this.current = loaded.catalog;
		this.hash = loaded.hash;
		this.revision = Math.max(0, ...Object.values(this.current.bindings).map((b) => b.bindingRevision ?? 0));
	}

	/** 只读目录视图（命令层校验选择与构造 next 用）。 */
	get catalog(): ChannelCatalog {
		return this.current;
	}

	get configRevision(): number {
		return this.current.configRevision;
	}

	get bindingRevision(): number {
		return this.revision;
	}

	/** 绑定版本单调递增；返回新版本（唯一权威在服务端内存）。 */
	bumpBindingRevision(): number {
		this.revision += 1;
		return this.revision;
	}

	/** 注入待生效选择来源（命令层构造时调用一次）。 */
	bindPendingSource(read: () => Iterable<PendingSelection>): void {
		this.pendingSource = read;
	}

	// -- conversation binding keys ---------------------------------------------
	// 对话 id 形如 c1/c2，只在单个客户端内唯一；而 channels.json 是全实例共享的。
	// 若直接用 conversationId 当键，两个客户端的「c1」会互相覆盖（实测），所以存储键
	// 用 "<clientId>::<conversationId>"，对外（channel_state/回执）仍只暴露裸 conversationId。

	/** 存储键（仅本 client 的对话会写入该键空间）。 */
	key(conversationId: string): string {
		return `${this.host.clientId}::${conversationId}`;
	}

	/** 存储键 → 本 client 的 conversationId（不是本 client 的返回 null）。 */
	conversationIdOf(storageKey: string): string | null {
		const prefix = `${this.host.clientId}::`;
		return storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : null;
	}

	/** 当前项目目录（项目默认值的键）。 */
	cwd(): string {
		return this.host.cwd();
	}

	/** 本 client 对应 conversationId 的存储绑定。 */
	storedBinding(conversationId: string): ChannelBinding | undefined {
		return this.current.bindings[this.key(conversationId)];
	}

	/** 存储键 → 对外视图（剥掉 clientId 前缀；不是本 client 的返回 null）。 */
	private ownBindingView(
		conversationId: string,
		binding: ChannelBinding,
	): Omit<ChannelBinding, "conversationId"> & { conversationId: string } | null {
		const ownId = this.conversationIdOf(conversationId);
		if (ownId === null) return null;
		return { ...binding, conversationId: ownId };
	}

	// -- state -----------------------------------------------------------------

	/**
	 * 有效选择：对话绑定优先；没有绑定时只有「尚未发言」的对话才继承
	 * 项目/实例默认（§4：修改默认不悄悄重绑已运行对话）。
	 */
	effectiveSelectionFor(conversationId: string): { selection: ChannelSelection | null; source: BindingSource } {
		const stored = this.storedBinding(conversationId);
		if (stored?.channelId) return { selection: toSelection(stored), source: "conversation" };
		if (this.host.conversationHasMessages(conversationId)) return { selection: null, source: "none" };
		const cwd = this.host.cwd();
		const cwdDefault = this.current.projectDefaults[cwd];
		if (cwdDefault) return { selection: cwdDefault, source: "project" };
		// 其他项目的默认不得跨项目继承。
		if (!this.current.projectDefaults[cwd] && this.current.instanceDefault) {
			return { selection: this.current.instanceDefault, source: "instance" };
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
		const stored = this.storedBinding(conversationId);
		const channel = this.current.channels.find((c) => c.id === selection.channelId);
		return {
			channelId: selection.channelId,
			endpointId: selection.endpointId,
			credentialKeyName: selection.credentialRef?.keyName ?? null,
			modelId: selection.modelId,
			providerId: channel?.providerId ?? null,
			bindingRevision: stored?.bindingRevision ?? 0,
			configRevision: this.current.configRevision,
		};
	}

	/** 该对话是否已有显式渠道绑定（未发言对话不应被旧的“项目默认模型”覆盖）。 */
	hasConversationBinding(conversationId: string): boolean {
		return Boolean(this.storedBinding(conversationId)?.channelId);
	}

	/**
	 * 新对话继承上一对话的渠道绑定（不调用 setModel —— 模型已由 newChat 携带过去），
	 * 否则新对话会只剩下模型而没有渠道/凭据归属。
	 */
	inheritBinding(fromConversationId: string, toConversationId: string): void {
		const source = this.storedBinding(fromConversationId);
		if (!source || fromConversationId === toConversationId) return;
		if (this.storedBinding(toConversationId)?.channelId) return;
		this.bumpBindingRevision();
		this.commitBindings({
			[this.key(toConversationId)]: makeBinding({
				conversationId: toConversationId,
				selection: toSelection(source),
				configRevision: this.current.configRevision,
				bindingRevision: this.revision,
				now: Date.now(),
			}),
		});
	}

	/** 有效/待生效绑定的只读视图（快照 UI 用）。 */
	bindingViewFor(conversationId: string): { effective: ChannelBinding | null; pending: ChannelBinding | null; source: BindingSource } {
		const stored = this.storedBinding(conversationId) ?? null;
		const { selection, source } = this.effectiveSelectionFor(conversationId);
		const effective =
			stored ??
			(selection
				? makeBinding({ conversationId, selection, configRevision: this.current.configRevision, bindingRevision: 0, now: 0 })
				: null);
		const pend = this.pendingFor(conversationId);
		const pending = pend
			? makeBinding({
					conversationId,
					selection: pend.selection,
					configRevision: this.current.configRevision,
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

	/** 绑定视图里的渠道显示名（渠道可能已被删除 → null）。 */
	decorate(binding: ChannelBinding): ChannelStateMessage["bindings"][number] {
		return {
			...binding,
			channelName: this.current.channels.find((c) => c.id === binding.channelId)?.displayName ?? null,
		};
	}

	/** 渠道视图（引用 runtime provider + 命名密钥的存在性，不含密钥值）。 */
	private channelViews(): ChannelStateMessage["channels"] {
		return this.current.channels.map((c) => {
			const keys = this.host.keyNames(c.providerId);
			return {
				id: c.id,
				displayName: c.displayName,
				providerId: c.providerId,
				endpointId: c.endpointId,
				credentialRef: c.credentialRef,
				accountRef: c.accountRef,
				// 该渠道限定的模型（provider 内 id）；空 = 不限制。
				models: c.models ?? [],
				// 只回显账户查询配置的非敏感字段（URL/单位/换算/账户凭据名），绝不含密钥值。
				// 回显账户查询配置（模板字段一并回显，否则"已存模板无法编辑"）：
				// 只允许白名单键，且**只允许字符串/数字/布尔/纯对象**——任何密钥值都不可能带出去
				// （渠道配置本身也不允许出现 apiKey/key 字段，见 channel-store 的写入校验）。
				account: (() => {
					const raw = (c.extra as { account?: Record<string, unknown> } | undefined)?.account;
					if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") return null;
					const allowed = ["kind", "url", "method", "apiKeyHeader", "apiKeyPrefix", "body", "unit", "scale", "credentialKeyName"] as const;
					const out: Record<string, unknown> = {};
					for (const key of allowed) {
						const value = raw[key];
						if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
					}
					// 充值链接由服务端解析（{baseUrl} 占位需要服务商 baseUrl，前端不知道），前端直接当 href 用。
					const topup = topupUrlOf(c);
					if (topup) out.topupUrl = topup;
					for (const key of ["mapping", "items"] as const) {
						const value = raw[key];
						if (value && typeof value === "object" && !Array.isArray(value)) {
							const entries = Object.entries(value as Record<string, unknown>)
								.filter(([, v]) => typeof v === "string")
								.slice(0, 20);
							if (entries.length > 0) out[key] = Object.fromEntries(entries);
						}
					}
					return Object.keys(out).length > 0 ? out : null;
				})(),
				enabled: c.enabled,
				keys,
				keyMissing: c.credentialRef ? !keys.some((k) => k.keyName === c.credentialRef?.keyName) : false,
				providerMissing: !this.host.hasProvider(c.providerId),
			};
		});
	}

	/** 唯一的状态构造出口（账号快照由命令层传入，状态层不认识 AccountRegistry）。 */
	stateMessage(accounts: UiAccountStatus[], accountPresets: ChannelStateMessage["accountPresets"] = []): ChannelStateMessage {
		return {
			type: "channel_state",
			configRevision: this.current.configRevision,
			bindingRevision: this.revision,
			channels: this.channelViews(),
			instanceDefault: this.current.instanceDefault,
			projectDefault: this.current.projectDefaults[this.host.cwd()] ?? null,
			bindings: Object.entries(this.current.bindings)
				.map(([id, b]) => this.ownBindingView(id, b))
				.filter((b): b is NonNullable<typeof b> => b !== null)
				.map((b) => this.decorate(b)),
			pending: [...this.pendingSource()].map((p) => ({
				conversationId: p.conversationId,
				...toSelection(p.selection),
				bindingRevision: p.bindingRevision,
				commandId: p.commandId,
			})),
			accounts,
			accountPresets,
		};
	}

	/**
	 * 重新从磁盘读取渠道目录（多端/外部编辑后刷新）。
	 * 保留内存中更高的绑定版本（本端刚写的可能还没进文件）与待生效选择；
	 * 不改变 bindingRevision 的单调性。冲突后可恢复的关键：刷新一次就能拿到别人写入的
	 * configRevision，用新版本重试即能成功（§4「已知外部修改不能被静默覆盖」+ 可恢复）。
	 */
	refresh(): void {
		const loaded = loadCatalog(this.host.agentDir);
		// 文件损坏时保留内存态（不得因一次读写失误把渠道列表清空）。
		if (loaded.parseError) return;
		const merged: Record<string, ChannelBinding> = { ...loaded.catalog.bindings };
		for (const [id, binding] of Object.entries(this.current.bindings)) {
			const other = merged[id];
			if (!other || (binding.bindingRevision ?? 0) >= (other.bindingRevision ?? 0)) merged[id] = binding;
		}
		this.current = { ...loaded.catalog, bindings: pruneBindings(merged) };
		this.hash = loaded.hash;
		this.revision = Math.max(this.revision, ...Object.values(this.current.bindings).map((b) => b.bindingRevision ?? 0));
	}

	// -- persistence -----------------------------------------------------------

	/**
	 * 渠道/默认值写入：先落盘成功再提交内存。
	 * 失败（外部修改/不可写）时**重新对齐磁盘状态**，让用户刷新后能用新版本重试。
	 */
	commitConfig(next: ChannelCatalog): boolean {
		const result = saveCatalog(this.host.agentDir, next, this.hash);
		if (!result.ok) {
			this.refresh();
			return false;
		}
		this.current = next;
		this.hash = result.hash;
		return true;
	}

	/**
	 * 绑定写入：重载文件后按 bindingRevision 合并（别的 client 可能刚写了别的绑定），
	 * 再整体落盘。绑定写入失败不回滚内存里的 setModel 结果 —— 模型确实已经切了，
	 * 只是持久化没成功；下一次选择会再写。
	 */
	commitBindings(changes: Record<string, ChannelBinding | null>): void {
		const inline: ChannelCatalog = {
			...this.current,
			bindings: { ...this.current.bindings },
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
			this.current = merged;
			this.hash = result.hash;
			return;
		}
		// 保留内存态（模型已切），下次写入重新同步。
		this.current = inline;
	}

	// -- internals -------------------------------------------------------------

	private pendingFor(conversationId: string): PendingSelection | undefined {
		for (const p of this.pendingSource()) if (p.conversationId === conversationId) return p;
		return undefined;
	}
}
