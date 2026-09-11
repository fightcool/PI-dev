/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-config.ts (queryAccountCommand 调用 query), channel-service.ts (accounts 快照
 *            注入 stateMessage), protocol.ts (UiAccountStatus),
 *            channel-model.ts (ChannelRecord.extra.account 配置入口)
 *   📖 docs/DEV-CON-PROPOSAL.md §7（余额/配额/限频/失败状态）, §9（账户查询 P0 项）
 *   @CONTRACT 只在渠道显式配置账户端点（channel.extra.account）时查询；没有适配器时
 *             返回 unsupported，绝不用 Token 反推余额。
 *   @WHY 账户查询是外部网络 IO：必须同时具备有界超时、响应体上限、禁止重定向、
 *        限频与缓存；任一缺失都会让「查询故障不阻塞编码」变成空话（§4/§9）。
 *   @GOTCHA fetch 的 redirect 默认 follow 会把 Authorization 带到别的来源；
 *           这里显式 redirect:"manual" 并把 3xx 当失败。
 *   @MAGIC DEFAULT_TIMEOUT_MS=5000 / MAX_BODY_BYTES=64KiB / CACHE_TTL_MS=300_000 /
 *          MIN_INTERVAL_MS=10_000（每渠道限频窗口）。
 * ──────────────────────────────────────────────────
 */
import type { UiAccountStatus } from "../protocol.js";
import type { ChannelRecord } from "./channel-model.js";

/** @MAGIC 见头部说明。 */
export const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_BODY_BYTES = 64 * 1024;
export const CACHE_TTL_MS = 5 * 60_000;
export const MIN_INTERVAL_MS = 10_000;

/** 一次账户/配额查询的结果（status 语义见 §7）。 */
export interface AccountQueryResult {
	accountRef: string;
	/** 适配器种类；"unsupported" 表示没有可用适配。 */
	kind: string;
	status: UiAccountStatus["status"];
	/** 账户范围说明（供应商账户 id / 名称 / 掩码）。 */
	scope?: string;
	/** 余额单位/币种。 */
	unit?: string;
	balance?: number;
	quota?: { used?: number; limit?: number; remaining?: number; unit?: string };
	/** 本次查询时间（ms）。 */
	checkedAt?: number;
	/** 上次成功时间（失败时用于显示「旧值」）。 */
	staleSince?: number;
	error?: string;
	/** 多币种明细（供应商可能返回多个币种）：逐条展示，不做无依据相加。 */
	breakdown?: { currency: string; total: number; granted: number; toppedUp: number }[];
	/** 供应商标注的状态说明（例如余额不足以调用）。 */
	note?: string;
}

/** 供应商账户适配器契约。 */
export interface AccountAdapter {
	kind: string;
	/** 该渠道是否可用此适配器。 */
	match(channel: ChannelRecord): boolean;
	/** 执行查询；实现必须只使用传入的凭据，不得落盘。 */
	query(input: { channel: ChannelRecord; apiKey: string; signal: AbortSignal }): Promise<Omit<AccountQueryResult, "accountRef" | "kind">>;
}

/** 渠道里的账户配置（channel.extra.account）。 */
interface AccountConfig {
	kind?: string;
	url?: string;
	unit?: string;
	/** 网关配额的换算比例（1 个单位 = scale 个最小单位）。 */
	scale?: number;
	/**
	 * 账户查询专用的命名凭据（provider-keys.json 里的密钥名）。
	 * 说明：one-api/new-api 类网关的 /api/user/self 需要**控制台访问令牌**，通常不是模型 key；
	 * 不填则回落到渠道的模型凭据（DeepSeek 官方这类用同一把 key 的供应商适用）。
	 */
	credentialKeyName?: string;
}

/** 账户配置（渠道 extra.account）；供注册表选择「账户专用凭据」。 */
export function accountQueryConfig(channel: ChannelRecord): AccountConfig | null { return accountConfig(channel); }

function accountConfig(channel: ChannelRecord): AccountConfig | null {
	const raw = channel.extra?.account;
	if (!raw || typeof raw !== "object") return null;
	const cfg = raw as AccountConfig;
	if (typeof cfg.kind !== "string" || !cfg.kind.trim()) return null;
	return cfg;
}

/** 有界 JSON 读取：超时、体积上限、禁止重定向、非 2xx 即失败。 */
async function fetchJson(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	signal: AbortSignal,
): Promise<{ ok: boolean; status: number; body?: unknown; error?: string }> {
	let res: Response;
	try {
		res = await fetchImpl(url, { ...init, redirect: "manual", signal });
	} catch (err) {
		return { ok: false, status: 0, error: (err as Error).name === "AbortError" ? "查询超时" : (err as Error).message };
	}
	if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: "账户接口返回重定向，已按策略拒绝" };
	if (!res.ok) return { ok: false, status: res.status, error: `账户接口返回 HTTP ${res.status}` };
	const reader = res.body?.getReader();
	if (!reader) return { ok: false, status: res.status, error: "账户接口无响应体" };
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.byteLength;
				if (total > MAX_BODY_BYTES) {
					await reader.cancel();
					return { ok: false, status: res.status, error: "账户接口响应体超出上限" };
				}
				chunks.push(value);
			}
		}
	} catch (err) {
		return { ok: false, status: res.status, error: (err as Error).name === "AbortError" ? "查询超时" : (err as Error).message };
	}
	const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
	try {
		return { ok: true, status: res.status, body: JSON.parse(text) };
	} catch {
		return { ok: false, status: res.status, error: "账户接口返回非 JSON" };
	}
}

function num(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * OpenAI 兼容自建网关（one-api / new-api 一类）：默认 /api/user/self，
 * 用同一把 key 鉴权（Bearer）。额度字段名各家不同，只读取明确存在的数值字段，
 * 读不到就报失败——不猜。
 */
export const openAiGatewayAdapter: AccountAdapter = {
	kind: "openai-gateway",
	match: (channel) => accountConfig(channel)?.kind === "openai-gateway",
	async query({ channel, apiKey, signal }) {
		const cfg = accountConfig(channel);
		const configured = (cfg?.url ?? "").replace(/\/+$/, "");
		if (!configured) return { status: "failed", error: "未配置账户接口地址" };
		// @BUGFIX 2026-09-11（真实网关验收发现）：one-api/new-api 的账户接口在**站点根**
		// /api/user/self，而渠道里通常填的是 OpenAI 兼容基址（末尾带 /v1）。直接拼接会得到
		// /v1/api/user/self → HTTP 404。这里先剥掉 /v1（或 /v1/... 子路径）再拼；若用户已直接
		// 给出完整 /api/user/self 地址，则原样使用。
		const url = /\/api\/user\/self$/.test(configured)
			? configured
			: `${configured.replace(/\/v1$/i, "").replace(/\/v1\/.*$/i, "")}/api/user/self`;
		const res = await fetchJson(
			fetch,
			url,
			{ method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } },
			signal,
		);
		if (!res.ok) {
			const hint =
				res.status === 401 || res.status === 403
					? "（网关账户接口通常需要控制台访问令牌，而不是模型 key：请在账户配置里指定「账户凭据」）"
					: "";
			return { status: "failed", error: `${res.error}${hint}` };
		}
		const body = (res.body ?? {}) as Record<string, unknown>;
		const data = (body.data ?? body) as Record<string, unknown>;
		const scale = typeof cfg?.scale === "number" && cfg.scale > 0 ? cfg.scale : 1;
		const unit = cfg?.unit ?? "quota";
		const quota = num(data.quota);
		const used = num(data.used_quota) ?? num(data.usedQuota);
		const displayName = typeof data.display_name === "string" ? data.display_name : typeof data.username === "string" ? data.username : undefined;
		if (quota === undefined && used === undefined) return { status: "failed", error: "账户接口未返回可识别的额度字段" };
		// balance = 可用余额（有已用量时扣掉），不是总额度。
		const remaining = quota === undefined ? undefined : (used === undefined ? quota : quota - used) / scale;
		return {
			status: "ok",
			scope: displayName,
			unit,
			balance: remaining,
			quota: { used: used === undefined ? undefined : used / scale, limit: quota === undefined ? undefined : quota / scale, remaining, unit },
			checkedAt: Date.now(),
		};
	},
};

/**
 * DeepSeek 官方余额查询（官方文档：API Reference → Get User Balance）。
 *   GET {base}/user/balance          base 默认 https://api.deepseek.com
 *   Authorization: Bearer <api key>
 *   200 → { is_available: boolean, balance_infos: [ { currency: "CNY"|"USD",
 *            total_balance: string, granted_balance: string, topped_up_balance: string } ] }
 * 诚实处理：金额是**字符串**（需转数字并保留两位精度）；可能返回多个币种（分别列出，不相加）；
 * `is_available=false` 表示「余额不足以继续调用」，此时查询本身是成功的，用 note 标注而不是当作失败。
 */
export const deepSeekAdapter: AccountAdapter = {
	kind: "deepseek",
	match: (channel) => accountConfig(channel)?.kind === "deepseek",
	async query({ channel, apiKey, signal }) {
		const cfg = accountConfig(channel);
		const base = (cfg?.url ?? "https://api.deepseek.com").replace(/\/+$/, "");
		const res = await fetchJson(fetch, `${base}/user/balance`, { method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } }, signal);
		if (!res.ok) return { status: "failed", error: res.error };
		const body = (res.body ?? {}) as { is_available?: unknown; balance_infos?: unknown };
		const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
		const toNumber = (value: unknown): number | undefined => {
			const n = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : Number.NaN;
			return Number.isFinite(n) ? n : undefined;
		};
		const entries = infos
			.map((raw) => {
				const info = (raw ?? {}) as Record<string, unknown>;
				const currency = typeof info.currency === "string" ? info.currency.trim() : "";
				const total = toNumber(info.total_balance);
				if (!currency || total === undefined) return null;
				return {
					currency,
					total,
					granted: toNumber(info.granted_balance) ?? 0,
					toppedUp: toNumber(info.topped_up_balance) ?? 0,
				};
			})
			.filter((entry): entry is { currency: string; total: number; granted: number; toppedUp: number } => entry !== null);
		if (entries.length === 0) return { status: "failed", error: "账户接口未返回可识别的余额字段（balance_infos 为空或缺少 total_balance）" };
		// 主条目：优先匹配渠道配置的币种，否则取第一条（官方通常只返回账户所属币种）。
		const preferred = cfg?.unit ? entries.find((entry) => entry.currency === cfg.unit) : undefined;
		const primary = preferred ?? entries[0];
		const insufficient = body.is_available === false;
		return {
			status: "ok",
			unit: primary.currency,
			balance: primary.total,
			quota: { limit: primary.total, remaining: primary.total, unit: primary.currency },
			breakdown: entries,
			note: insufficient ? "is_available=false：官方标注余额不足以继续调用" : undefined,
			checkedAt: Date.now(),
		};
	},
};

/** OpenRouter：/api/v1/key 给出该 key 的限额与用量，/api/v1/credits 给出账户余额。 */
export const openRouterAdapter: AccountAdapter = {
	kind: "openrouter",
	match: (channel) => accountConfig(channel)?.kind === "openrouter",
	async query({ channel, apiKey, signal }) {
		const cfg = accountConfig(channel);
		const base = (cfg?.url ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
		const credits = await fetchJson(fetch, `${base}/credits`, { headers: { authorization: `Bearer ${apiKey}` } }, signal);
		if (!credits.ok) return { status: "failed", error: credits.error };
		const cdata = ((credits.body ?? {}) as Record<string, unknown>).data as Record<string, unknown> | undefined;
		const total = num(cdata?.total_credits);
		const used = num(cdata?.total_usage);
		if (total === undefined) return { status: "failed", error: "账户接口未返回可识别的额度字段" };
		return {
			status: "ok",
			unit: "USD",
			balance: used === undefined ? undefined : total - used,
			quota: { used, limit: total, remaining: used === undefined ? undefined : total - used, unit: "USD" },
			checkedAt: Date.now(),
		};
	},
};

export interface AccountRegistryOptions {
	adapters?: AccountAdapter[];
	timeoutMs?: number;
	cacheTtlMs?: number;
	minIntervalMs?: number;
	now?: () => number;
	/** 测试注入；默认全局 fetch。 */
	fetchImpl?: typeof fetch;
}

/**
 * 账户查询注册表：负责适配选择、限频、缓存、失败保留旧值。
 * 不阻塞编码路径：所有查询都只在显式命令里触发。
 */
export class AccountRegistry {
	private readonly adapters: AccountAdapter[];
	private readonly timeoutMs: number;
	private readonly cacheTtlMs: number;
	private readonly minIntervalMs: number;
	private readonly now: () => number;
	private readonly fetchImpl: typeof fetch;
	private readonly cache = new Map<string, AccountQueryResult>();
	private readonly lastAttempt = new Map<string, number>();
	private readonly inFlight = new Set<string>();

	constructor(opts: AccountRegistryOptions = {}) {
		this.adapters = opts.adapters ?? [deepSeekAdapter, openAiGatewayAdapter, openRouterAdapter];
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
		this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_MS;
		this.now = opts.now ?? (() => Date.now());
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	/** 缓存快照（UI 只读；失败保留旧值并标 stale）。 */
	snapshot(): UiAccountStatus[] {
		const now = this.now();
		return [...this.cache.values()].map((entry) => ({
			accountRef: entry.accountRef,
			kind: entry.kind,
			status: entry.status === "ok" && entry.checkedAt !== undefined && now - entry.checkedAt > this.cacheTtlMs ? "stale" : entry.status,
			scope: entry.scope,
			unit: entry.unit,
			balance: entry.balance,
			quota: entry.quota,
			checkedAt: entry.checkedAt,
			staleSince: entry.status === "failed" ? entry.staleSince : undefined,
			error: entry.error,
			breakdown: entry.breakdown,
			note: entry.note,
		}));
	}

	/** 查询某渠道的账户状态；resolveKey 由服务层提供（密钥不出服务端）。 */
	async query(channel: ChannelRecord, resolveKey: (keyName: string) => string | null): Promise<AccountQueryResult> {
		const accountRef = channel.accountRef || channel.id;
		// 「账户查询只用用户为该用途明确配置的授权」：账户配置可指定自己的凭据名。
		const keyName = accountConfig(channel)?.credentialKeyName ?? channel.credentialRef?.keyName ?? null;
		const adapter = this.adapters.find((a) => a.match(channel));
		if (!adapter) {
			return this.remember({
				accountRef,
				kind: "unsupported",
				status: "unsupported",
				error: "该渠道未配置可用的账户查询方式",
			});
		}
		if (!keyName) {
			return this.remember({ accountRef, kind: adapter.kind, status: "failed", error: "该渠道未绑定命名凭据，无法查询账户" });
		}
		const apiKey = resolveKey(keyName);
		if (!apiKey) return this.remember({ accountRef, kind: adapter.kind, status: "failed", error: "命名凭据已不存在" });

		const previous = this.cache.get(accountRef);
		const last = this.lastAttempt.get(accountRef);
		if (last !== undefined && this.now() - last < this.minIntervalMs) {
			return previous
				? { ...previous, error: "查询过于频繁，已显示上次结果" }
				: this.remember({ accountRef, kind: adapter.kind, status: "failed", error: "查询过于频繁，请稍后重试" });
		}
		if (this.inFlight.has(accountRef)) {
			return previous ?? this.remember({ accountRef, kind: adapter.kind, status: "failed", error: "查询进行中" });
		}
		this.lastAttempt.set(accountRef, this.now());
		this.inFlight.add(accountRef);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const result = await adapter.query({ channel, apiKey, signal: controller.signal });
			const merged: AccountQueryResult = {
				accountRef,
				kind: adapter.kind,
				status: result.status,
				breakdown: result.breakdown,
				note: result.note,
				scope: result.scope,
				unit: result.unit,
				balance: result.balance,
				quota: result.quota,
				checkedAt: result.checkedAt ?? this.now(),
				error: result.error,
			};
			if (merged.status !== "ok" && previous?.balance !== undefined) {
				// 失败保留上次结果与旧时间，绝不显示为 0。
				return this.remember({ ...previous, status: "stale", staleSince: previous.checkedAt, error: merged.error ?? "查询失败" });
			}
			return this.remember(merged);
		} finally {
			clearTimeout(timer);
			this.inFlight.delete(accountRef);
		}
	}

	private remember(result: AccountQueryResult): AccountQueryResult {
		this.cache.set(result.accountRef, result);
		return result;
	}

	/** 测试/维护用：清空缓存。 */
	reset(): void {
		this.cache.clear();
		this.lastAttempt.clear();
		this.inFlight.clear();
	}
}
