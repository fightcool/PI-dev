/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-store.ts (persists this shape), channel-state.ts (目录内存态 + 视图),
 *            channel-service.ts / channel-config.ts (commands),
 *            protocol.ts (wire types channel_state / channel_command_result / channel_select)
 *   📖 docs/DEV-CON-PROPOSAL.md §4 (配置对象、所有权与安全), §5 (热切换与会话语义), §9 (P0 技术项)
 *   @CONTRACT 纯逻辑模块：禁止 fs / 网络 / SDK 导入，便于 vitest 单测直接覆盖规格。
 *   @WHY 渠道元数据只保存「引用」（providerId/keyName/modelId），不复制 models.json 或
 *        provider-keys.json 的可写事实源；密钥正文永不进入本模块的数据结构。
 *   @MAGIC MAX_PERSISTED_BINDINGS=200: 对话绑定是引用型元数据，超出按 lastUsedAt 淘汰最旧。
 * ──────────────────────────────────────────────────
 */

/** 协议端点：同一渠道内的模型调用协议入口；缺省单端点用 "default"。 */
export const DEFAULT_ENDPOINT_ID = "default";

/** 渠道下拉里「不指定命名凭据」时使用该引用值：走服务商当前 active key。 */
export const PROVIDER_ACTIVE_KEY = "active";

/** 本模块持久化的绑定上限（见 @MAGIC）。 */
export const MAX_PERSISTED_BINDINGS = 200;

/** 凭据引用：指向 provider-keys.json 里的命名密钥，不含密钥正文。 */
export interface CredentialRef {
	providerId: string;
	/** provider-keys.json 里的密钥名；PROVIDER_ACTIVE_KEY = 服务商当前 active key。 */
	keyName: string;
}

/** 渠道档案（引用现有 runtime provider，不复制其模型目录/密钥）。 */
export interface ChannelRecord {
	/** 稳定标识；由用户命名或服务端生成（ch-1, ch-2 …）。 */
	id: string;
	displayName: string;
	/** 引用 models.json / runtime 里已注册的服务商 id。 */
	providerId: string;
	endpointId: string;
	/** null = 未绑定命名凭据（跟随服务商 active key）。 */
	credentialRef: CredentialRef | null;
	/** P3 账户引用（供应商账户接口的键），null = 不查询。 */
	accountRef: string | null;
	/**
	 * 该渠道允许使用的模型白名单（provider 内的模型 id，如 "deepseek-flash"）。
	 * 空数组/undefined = 不限制（列出该服务商的全部模型，保持向后兼容）。
	 * @WHY 服务商（尤其聚合网关）往往有几十个用不到的模型；渠道应只暴露你要用的那几个。
	 */
	models: string[];
	enabled: boolean;
	/** 保留写回：未来字段/外部工具写入的未知键不丢失。 */
	extra: Record<string, unknown>;
}

/** 一次「渠道+凭据+模型」选择（用于默认值与绑定）。 */
export interface ChannelSelection {
	channelId: string;
	endpointId: string;
	credentialRef: CredentialRef | null;
	/** 完整模型 id（"provider/model"）。 */
	modelId: string;
}

/** 对话绑定：记录选择发生在哪一版配置上，便于冲突检测与回执。 */
export interface ChannelBinding extends ChannelSelection {
	conversationId: string;
	bindingRevision: number;
	/** 建立该绑定时渠道配置的 configRevision。 */
	configRevision: number;
	/** 最近一次被选中/生效的时间（淘汰旧绑定的依据）。 */
	lastUsedAt: number;
}

/** 绑定来源：对话自身 / 项目默认 / 实例默认 / 无。 */
export type BindingSource = "conversation" | "project" | "instance" | "none";

/** 请求发出时固定的绑定快照（§7 用量归属用；含引用，不含密钥正文）。 */
export interface RequestBindingSnapshot {
	channelId: string;
	endpointId: string;
	credentialKeyName: string | null;
	modelId: string;
	providerId: string | null;
	bindingRevision: number;
	configRevision: number;
}

/** 渠道目录（channels.json 的完整内容）。 */
export interface ChannelCatalog {
	/** 单调递增的配置版本；任何渠道/默认值变更都会 +1。 */
	configRevision: number;
	channels: ChannelRecord[];
	instanceDefault: ChannelSelection | null;
	/** cwd → 项目默认选择。 */
	projectDefaults: Record<string, ChannelSelection | null>;
	/** conversationId → 绑定（引用型元数据，可裁剪）。 */
	bindings: Record<string, ChannelBinding>;
	/** 保留写回未知顶层字段。 */
	extra: Record<string, unknown>;
}

/** 切换计划：立即应用 or 待生效（等本轮结束）。 */
export type SwitchPlan =
	| { mode: "apply" }
	| { mode: "pending"; reason: "streaming" | "queue" };

/** 版本冲突结果。 */
export type RevisionCheck = { ok: true } | { ok: false; kind: "conflict" | "missing" };

/** 空目录。 */
export function defaultCatalog(): ChannelCatalog {
	return {
		configRevision: 0,
		channels: [],
		instanceDefault: null,
		projectDefaults: {},
		bindings: {},
		extra: {},
	};
}

/** "provider/model" → 两段；不是两段则 null（set_model 的历史校验同款）。 */
export function parseModelRef(modelId: string): { providerId: string; modelId: string } | null {
	const raw = typeof modelId === "string" ? modelId.trim() : "";
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) return null;
	return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

/** 渠道 id 规则：小写字母/数字/连字符，2–48 字符。 */
export function isValidChannelId(id: string): boolean {
	return typeof id === "string" && /^[a-z0-9][a-z0-9-]{1,47}$/.test(id);
}

/**
 * 禁止把密钥正文写进渠道元数据（本模块的唯一安全不变量）。
 * 返回命中的字段路径列表；非空即拒绝写入。
 */
export function findSecretMaterial(value: unknown, path = ""): string[] {
	const forbidden = new Set(["apikey", "api_key", "key", "keys", "token", "secret", "password", "headers", "authorization"]);
	const hits: string[] = [];
	const walk = (node: unknown, at: string): void => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach((item, i) => walk(item, `${at}[${i}]`));
			return;
		}
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
			const here = at ? `${at}.${k}` : k;
			if (forbidden.has(k.trim().toLowerCase()) && v !== null && v !== undefined && v !== "") hits.push(here);
			walk(v, here);
		}
	};
	walk(value, path);
	return hits;
}

/** 渠道档案结构校验（不查 runtime；provider/model 是否存在由服务层判定）。 */
export function validateChannelRecord(rec: ChannelRecord, others: ChannelRecord[] = []): string[] {
	const errors: string[] = [];
	if (!isValidChannelId(rec.id)) errors.push("渠道 ID 需为 2–48 位小写字母/数字/连字符");
	if (!rec.displayName?.trim()) errors.push("渠道名称不能为空");
	if (!rec.providerId?.trim()) errors.push("渠道必须引用一个服务商");
	if (!rec.endpointId?.trim()) errors.push("渠道必须指定协议端点");
	if (rec.credentialRef) {
		if (rec.credentialRef.providerId !== rec.providerId) errors.push("凭据引用的服务商与渠道不一致");
		if (!rec.credentialRef.keyName?.trim()) errors.push("命名凭据不能为空");
	}
	if (others.some((o) => o.id === rec.id)) errors.push(`渠道 ID「${rec.id}」已存在`);
	return errors;
}

/** 校验一次选择是否与其渠道档案自洽。 */
export function validateSelection(sel: ChannelSelection, channel: ChannelRecord | undefined): string[] {
	const errors: string[] = [];
	if (!channel) return ["渠道不存在"];
	if (!channel.enabled) errors.push("渠道已禁用");
	// 白名单非空时，只能选其中的模型（空 = 不限制）。
	if (channel.models.length > 0 && !channel.models.includes(sel.modelId.split("/").slice(1).join("/"))) {
		errors.push(`模型不在该渠道的可用列表内：${sel.modelId}`);
	}
	if (sel.channelId !== channel.id) errors.push("选择与渠道档案不匹配");
	if (sel.endpointId !== channel.endpointId) errors.push("协议端点与渠道档案不一致");
	const want = channel.credentialRef;
	const got = sel.credentialRef;
	if ((want?.keyName ?? null) !== (got?.keyName ?? null)) {
		// 允许显式覆盖渠道默认凭据，但服务商必须一致。
		if (got && got.providerId !== channel.providerId) errors.push("凭据引用的服务商与渠道不一致");
	}
	const parsed = parseModelRef(sel.modelId);
	if (!parsed) errors.push("模型 ID 需为 provider/model");
	else if (parsed.providerId !== channel.providerId) errors.push("所选模型不属于该渠道的服务商");
	return errors;
}

/** 按对话 → 项目默认 → 实例默认的顺序解析有效选择。 */
export function resolveEffectiveSelection(
	catalog: ChannelCatalog,
	conversationId: string,
	cwd?: string,
): { selection: ChannelSelection | null; source: BindingSource; binding: ChannelBinding | null } {
	const binding = catalog.bindings[conversationId];
	if (binding && binding.channelId) return { selection: toSelection(binding), source: "conversation", binding };
	if (cwd) {
		const proj = catalog.projectDefaults[cwd];
		if (proj) return { selection: proj, source: "project", binding: null };
	}
	if (catalog.instanceDefault) return { selection: catalog.instanceDefault, source: "instance", binding: null };
	return { selection: null, source: "none", binding: null };
}

/** 只取选择字段（去掉绑定元数据）。 */
export function toSelection(value: ChannelSelection): ChannelSelection {
	return {
		channelId: value.channelId,
		endpointId: value.endpointId,
		credentialRef: value.credentialRef ? { ...value.credentialRef } : null,
		modelId: value.modelId,
	};
}

/** 两个选择是否等价（用于判断「已是当前选择」）。 */
export function sameSelection(a: ChannelSelection | null, b: ChannelSelection | null): boolean {
	if (!a || !b) return a === b;
	return (
		a.channelId === b.channelId &&
		a.endpointId === b.endpointId &&
		a.modelId === b.modelId &&
		(a.credentialRef?.providerId ?? "") === (b.credentialRef?.providerId ?? "") &&
		(a.credentialRef?.keyName ?? "") === (b.credentialRef?.keyName ?? "")
	);
}

/**
 * 切换时点（P0 结论）：模型只在请求边界生效，已发出的请求与正在执行的工具不受影响。
 * - 空闲（无流式、无排队）→ 立即应用，回执 phase=applied。
 * - 正在生成/排队 → 记 pending，等本轮 agent_end 再应用，回执 phase=pending。
 */
export function planSwitch(input: { busy: boolean; hasQueue: boolean }): SwitchPlan {
	if (input.busy) return { mode: "pending", reason: "streaming" };
	if (input.hasQueue) return { mode: "pending", reason: "queue" };
	return { mode: "apply" };
}

/** 配置版本复核：外部修改/他人写入必须显式暴露，不能静默覆盖。 */
export function checkConfigRevision(current: number, expected: number | undefined): RevisionCheck {
	if (expected === undefined) return { ok: true };
	if (!Number.isInteger(expected)) return { ok: false, kind: "missing" };
	return expected === current ? { ok: true } : { ok: false, kind: "conflict" };
}

/** 绑定版本复核：旧回执不得覆盖新状态。 */
export function checkBindingRevision(current: number, expected: number | undefined): RevisionCheck {
	if (expected === undefined) return { ok: true };
	if (!Number.isInteger(expected)) return { ok: false, kind: "missing" };
	return expected === current ? { ok: true } : { ok: false, kind: "conflict" };
}

/** 生成绑定（bindingRevision 单调递增，服务端为唯一权威）。 */
export function makeBinding(input: {
	conversationId: string;
	selection: ChannelSelection;
	configRevision: number;
	bindingRevision: number;
	now: number;
}): ChannelBinding {
	return {
		conversationId: input.conversationId,
		...toSelection(input.selection),
		bindingRevision: input.bindingRevision,
		configRevision: input.configRevision,
		lastUsedAt: input.now,
	};
}

/** 裁剪持久化绑定：保留最近使用的 N 条。 */
export function pruneBindings(
	bindings: Record<string, ChannelBinding>,
	max = MAX_PERSISTED_BINDINGS,
): Record<string, ChannelBinding> {
	const entries = Object.entries(bindings);
	if (entries.length <= max) return bindings;
	entries.sort((a, b) => (b[1]?.lastUsedAt ?? 0) - (a[1]?.lastUsedAt ?? 0));
	return Object.fromEntries(entries.slice(0, max));
}

/** 渠道删除后清理引用它的默认值与绑定（返回需要重绑的 conversationId 列表）。 */
export function detachChannel(
	catalog: ChannelCatalog,
	channelId: string,
): { catalog: ChannelCatalog; detachedConversations: string[] } {
	const detached = Object.entries(catalog.bindings)
		.filter(([, b]) => b.channelId === channelId)
		.map(([id]) => id);
	const projectDefaults: Record<string, ChannelSelection | null> = {};
	for (const [cwd, sel] of Object.entries(catalog.projectDefaults)) {
		projectDefaults[cwd] = sel && sel.channelId === channelId ? null : sel;
	}
	return {
		catalog: {
			...catalog,
			channels: catalog.channels.filter((c) => c.id !== channelId),
			instanceDefault: catalog.instanceDefault?.channelId === channelId ? null : catalog.instanceDefault,
			projectDefaults,
			bindings: Object.fromEntries(Object.entries(catalog.bindings).filter(([id]) => !detached.includes(id))),
		},
		detachedConversations: detached,
	};
}

/** 渠道 id 生成：ch-1, ch-2 …（避开已占用的编号）。 */
export function nextChannelId(existing: ChannelRecord[]): string {
	const taken = new Set(existing.map((c) => c.id));
	let n = 1;
	while (taken.has(`ch-${n}`)) n++;
	return `ch-${n}`;
}

/** 归一化外部读入的渠道档案（缺字段补默认值，未知键进 extra）。 */
export function normalizeChannelRecord(raw: unknown): ChannelRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id.trim() : "";
	if (!id) return null;
	const credRaw = r.credentialRef;
	const credentialRef =
		credRaw && typeof credRaw === "object" && typeof (credRaw as CredentialRef).keyName === "string"
			? {
					providerId: String((credRaw as CredentialRef).providerId ?? r.providerId ?? ""),
					keyName: String((credRaw as CredentialRef).keyName),
				}
			: null;
	const known = new Set(["id", "displayName", "providerId", "endpointId", "credentialRef", "accountRef", "models", "enabled", "extra"]);
	const extra: Record<string, unknown> = { ...((r.extra as Record<string, unknown>) ?? {}) };
	for (const [k, v] of Object.entries(r)) if (!known.has(k)) extra[k] = v;
	return {
		id,
		displayName: typeof r.displayName === "string" && r.displayName.trim() ? r.displayName.trim() : id,
		providerId: typeof r.providerId === "string" ? r.providerId.trim() : "",
		endpointId: typeof r.endpointId === "string" && r.endpointId.trim() ? r.endpointId.trim() : DEFAULT_ENDPOINT_ID,
		credentialRef,
		accountRef: typeof r.accountRef === "string" && r.accountRef.trim() ? r.accountRef.trim() : null,
		models: Array.isArray(r.models) ? (r.models as unknown[]).filter((m): m is string => typeof m === "string" && m.trim().length > 0) : [],
		enabled: r.enabled !== false,
		extra,
	};
}
