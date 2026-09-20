/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-config.ts (queryAccountCommand 调用 query), channel-service.ts (accounts 快照
 *            注入 stateMessage), protocol.ts (UiAccountStatus), channel-state.ts（账户配置视图）,
 *            channel-model.ts (ChannelRecord.extra.account 配置入口)
 *   📖 docs/DEV-CON-PROPOSAL.md §7（余额/配额/限频/失败状态）, §9（账户查询 P0 项）
 *   @CONTRACT 显式 channel.extra.account 优先；指向 *.cctq.ai 的既有渠道自动使用已验证的
 *             openai-gateway 账单接口。其他未配置渠道返回 unsupported，绝不用 Token 反推余额。
 *   @BUGFIX 2026-09-12: CCQTCC/cctq 旧渠道没有 extra.account，导致同一 CCTQ 服务无法查询；
 *             fix: 按 provider baseUrl 统一派生内存配置，且不改写持久化渠道。
 *   @BUGFIX 2026-09-14: stale 以前把「数据过了缓存 TTL」与「最近一次查询失败」混为一谈，
 *             界面只能统一显示「已过期」——渠道一直在正常说话也被报警。现在快照带
 *             staleReason（ttl/failed），失败保留的旧值 staleSince 保留**最早那次成功**时间。
 *   @WHY 账户查询是外部网络 IO：必须同时具备有界超时、响应体上限、禁止重定向、
 *        限频与缓存；任一缺失都会让「查询故障不阻塞编码」变成空话（§4/§9）。
 *   @GOTCHA fetch 的 redirect 默认 follow 会把 Authorization 带到别的来源；
 *           这里显式 redirect:"manual" 并把 3xx 当失败。
 *   @ASSUME fetchJson 的失败默认只给状态码；要排障 alpha 接口（如 Jev Decisions 的 400）
 *           需调用方显式开 opts.captureErrorDetail（错误体同样受 64KiB 上限，默认关闭）。
 *   @MAGIC DEFAULT_TIMEOUT_MS=5000 / MAX_BODY_BYTES=64KiB / CACHE_TTL_MS=300_000 /
 *          MIN_INTERVAL_MS=10_000（每渠道限频窗口）。
 * ──────────────────────────────────────────────────
 */
import type { UiAccountStatus } from "../protocol.js";
import type { ChannelRecord } from "./channel-model.js";
import {
	applyAccountTemplate,
	buildTemplateHeaders,
	describeTemplateProblem,
	renderTemplateText,
} from "./account-template.js";
import { accountTemplateOf } from "./account-template-schema.js";
import { ACCOUNT_TEMPLATE_PRESETS } from "./account-template-presets.js";
export { ACCOUNT_TEMPLATE_PRESETS } from "./account-template-presets.js";

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
	/** `status="stale"` 的原因（ttl = 数据旧了；failed = 最近一次查询失败）。 */
	staleReason?: "ttl" | "failed";
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
	query(input: {
		channel: ChannelRecord;
		apiKey: string;
		signal: AbortSignal;
		/** 该服务商注册的 baseUrl（调用方按**本会话** runtime 解析；见 providerBaseUrlOf）。 */
		providerBaseUrl?: (providerId: string) => string | undefined;
	}): Promise<Omit<AccountQueryResult, "accountRef" | "kind">>;
}

/** 渠道里的账户配置（channel.extra.account）。 */
export interface AccountConfig {
	kind?: string;
	url?: string;
	unit?: string;
	/** 网关配额的换算比例（1 个单位 = scale 个最小单位）。 */
	scale?: number;
	/**
	 * 充值页地址（可选）：展示在「用量详情」标题右侧的直达链接，便于用户随手充值。
	 * 支持 {baseUrl} 占位；未配置时按 kind 取内置默认（见 TOPUP_DEFAULTS）。
	 */
	topupUrl?: string;
	/**
	 * 账户查询专用的命名凭据（provider-keys.json 里的密钥名）。
	 * 说明：少数供应商的账户接口需要用**另一把 API key**（如 OpenRouter 的 provisioning key）；
	 * 不填则用渠道的模型凭据（DeepSeek 官方这类同一把 key 的供应商适用）。
	 */
	credentialKeyName?: string;
}

/**
 * 账户配置的唯一读取入口：显式配置优先；CCTQ 的既有渠道按服务商地址补齐内存默认值。
 * @WHY CCQTCC 与 cctq 只是同一服务商的不同 providerId，按名字判断会再次分叉；baseUrl 才是
 *      两者共享且稳定的身份。此派生不落盘，也不影响其他 OpenAI 兼容服务。
 */
export function accountQueryConfig(channel: ChannelRecord): AccountConfig | null {
	return accountConfig(channel);
}

function accountConfig(channel: ChannelRecord): AccountConfig | null {
	const raw = channel.extra?.account;
	if (raw && typeof raw === "object") {
		const cfg = raw as AccountConfig;
		if (typeof cfg.kind === "string" && cfg.kind.trim()) return cfg;
	}
	const providerBaseUrl = providerBaseUrlOf(channel);
	if (!isCctqUrl(providerBaseUrl)) return null;
	return {
		kind: "openai-gateway",
		url: providerBaseUrl,
		unit: "USD",
		topupUrl: "{baseUrl}/console/topup",
	};
}

function isCctqUrl(raw: string): boolean {
	try {
		const hostname = new URL(raw).hostname.toLowerCase();
		return hostname === "cctq.ai" || hostname.endsWith(".cctq.ai");
	} catch {
		return false;
	}
}

/**
 * 有界 JSON 读取的失败种类。
 * @WHY error 文本是**账户查询语境**的中文（“账户接口…”）：复用方（jev-gate）需要按种类
 *   生成自己的双语文案，所以这里额外给出机器可读的 kind，而不是让调用方去匹配中文串。
 *   `http` 需结合 status 判断（401/402/429/5xx），`status` 恒为真实 HTTP 状态。
 */
export type FetchJsonFailureKind = "timeout" | "network" | "redirect" | "http" | "no-body" | "too-large" | "not-json";

/**
 * 有界读取响应体（超时 / 体积上限与 ok 路径完全同一套规则）。
 * @CONTRACT 返回 `{ok:false}` 时 `kind`/`message` 就是既有失败种类与中文文案，状态码由调用方补。
 */
async function readBoundedBody(
	res: Response,
): Promise<{ ok: true; text: string } | { ok: false; kind: FetchJsonFailureKind; message: string }> {
	const reader = res.body?.getReader();
	if (!reader) return { ok: false, kind: "no-body", message: "账户接口无响应体" };
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
					return { ok: false, kind: "too-large", message: "账户接口响应体超出上限" };
				}
				chunks.push(value);
			}
		}
	} catch (err) {
		const aborted = (err as Error).name === "AbortError";
		return {
			ok: false,
			kind: aborted ? "timeout" : "network",
			message: aborted ? "查询超时" : (err as Error).message,
		};
	}
	return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
}

/** 有界 JSON 读取：超时、体积上限、禁止重定向、非 2xx 即失败。
 *  @CONTRACT 导出供 jev-gate 复用（单一有界传输实现，安全修复只需改一处）；
 *  调用方自己持有 AbortController 与超时定时器，这里只发一次请求、**绝不重试**。
 *  `opts.captureErrorDetail` = 额外读取**错误响应体**（同样是 64KiB 上限）放到 `detail`，供
 *  调用方拼自己的错误文案：alpha 接口的 400 只靠状态码无法排障（实测：形状错时正文才是答案）。
 *  默认关闭，现有账户查询调用完全不受影响。
 */
export async function fetchJson(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	opts?: { captureErrorDetail?: boolean },
): Promise<{
	ok: boolean;
	status: number;
	body?: unknown;
	error?: string;
	kind?: FetchJsonFailureKind;
	detail?: string;
}> {
	let res: Response;
	try {
		res = await fetchImpl(url, { ...init, redirect: "manual", signal });
	} catch (err) {
		const aborted = (err as Error).name === "AbortError";
		return {
			ok: false,
			status: 0,
			kind: aborted ? "timeout" : "network",
			error: aborted ? "查询超时" : (err as Error).message,
		};
	}
	if (res.status >= 300 && res.status < 400)
		return { ok: false, status: res.status, kind: "redirect", error: "账户接口返回重定向，已按策略拒绝" };
	if (!res.ok) {
		const failed = { ok: false, status: res.status, kind: "http" as const, error: `账户接口返回 HTTP ${res.status}` };
		if (!opts?.captureErrorDetail) return failed;
		const raw = await readBoundedBody(res);
		// 错误体本身读失败（无正文/超限/断流）时不覆盖状态码错误：detail 只是附加信息。
		return raw.ok ? { ...failed, detail: raw.text } : failed;
	}
	const raw = await readBoundedBody(res);
	if (!raw.ok) return { ok: false, status: res.status, kind: raw.kind, error: raw.message };
	try {
		return { ok: true, status: res.status, body: JSON.parse(raw.text) };
	} catch {
		return { ok: false, status: res.status, kind: "not-json", error: "账户接口返回非 JSON" };
	}
}

function num(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** @MAGIC new-api/one-api 用「不限额度」占位值（实测 1e8）：大于等于它就不当成真余额。 */
const UNLIMITED_QUOTA_MIN = 1e7;
/** @MAGIC 账单接口的用量窗口（部分部署要求 start_date/end_date，取近 30 天）。 */
const BILLING_WINDOW_DAYS = 30;

/** 站点根：从用户给的地址里剥掉 /api/user/self、/v1…、尾斜杠，得到 `https://host[:port]`。 */
function siteRootOf(raw: string): string {
	return raw
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/api\/user\/self$/i, "")
		.replace(/\/v\d+[a-z-]*\/.*$/i, "")
		.replace(/\/v\d+[a-z-]*$/i, "")
		.replace(/\/+$/, "");
}

/**
 * OpenAI 兼容账单接口（new-api / one-api 一类；**只用渠道里那把 API token**）：
 *   GET {origin}/v1/dashboard/billing/usage[?start_date&end_date] → total_usage（已用，USD）
 *   GET {origin}/v1/dashboard/billing/subscription → hard_limit_usd（总额度；不限额度时是 1e8 占位）
 * @WHY 实测（2026-09-12，www.cctq.ai，两把 API token × 16 个端点）：API token 能读 /v1/models、
 *   账单 usage/subscription；`/api/user/self`、`/api/user/dashboard`、`/api/token/` 一律 401
 *   （那些是**控制台会话**接口，与 API token 无关，本模块不碰），/v1/balance、/v1/credits、
 *   /v1/quota、/v1/me 则根本不存在。`subscription` 对「不限额度」的 token 只给占位值。
 *   所以：**有真实总额度才报余额，否则只报已用**，并在 note 里说明（§7：不猜测余额）。
 * @CONTRACT 返回 null = 该站没有可用的账单接口（调用方回落 /api/user/self 探针 → 再不行就报
 *   「该供应商 API 未提供查询能力」，绝不引导用户去找控制台令牌）。
 */
async function queryOpenAiBilling(
	fetchImpl: typeof fetch,
	origin: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<Omit<AccountQueryResult, "accountRef" | "kind"> | null> {
	const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
	const end = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
	const start = new Date(Date.now() - BILLING_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
	// 先不带窗口（实测该部署直接可读，少两个参数）；不行再按日期窗口试一次。
	let usage = await fetchJson(fetchImpl, `${origin}/v1/dashboard/billing/usage`, { method: "GET", headers }, signal);
	let used = usage.ok ? num(((usage.body ?? {}) as Record<string, unknown>).total_usage) : undefined;
	if (used === undefined) {
		usage = await fetchJson(
			fetchImpl,
			`${origin}/v1/dashboard/billing/usage?start_date=${start}&end_date=${end}`,
			{ method: "GET", headers },
			signal,
		);
		used = usage.ok ? num(((usage.body ?? {}) as Record<string, unknown>).total_usage) : undefined;
	}
	if (used === undefined) return null;
	const sub = await fetchJson(
		fetchImpl,
		`${origin}/v1/dashboard/billing/subscription`,
		{ method: "GET", headers },
		signal,
	);
	const subBody = (sub.ok ? (sub.body ?? {}) : {}) as Record<string, unknown>;
	const total = num(subBody.hard_limit_usd) ?? num(subBody.soft_limit_usd) ?? num(subBody.system_hard_limit_usd);
	// 面向用户的一句话（不要放字段名/上限占位值这类开发者语言；技术细节留给失败时的 error）。
	const note = "来自该渠道的账户接口";
	// 真总额度 → 给余额；只是「不限额度」占位值 → 只说已用，不假装余额。
	if (total !== undefined && total < UNLIMITED_QUOTA_MIN) {
		const remaining = total - used;
		return {
			status: "ok",
			unit: "USD",
			balance: remaining,
			quota: { used, limit: total, remaining, unit: "USD" },
			scope: "gateway",
			note,
			checkedAt: Date.now(),
		};
	}
	return {
		status: "ok",
		unit: "USD",
		quota: { used, unit: "USD" },
		scope: "gateway",
		note: `${note}：该渠道只返回了用量，没有余额信息`,
		checkedAt: Date.now(),
	};
}

/**
 * OpenAI 兼容自建网关（one-api / new-api 一类）的账户查询。
 * @CONTRACT **只用渠道里配置的那把 API token**（渠道命名凭据；没绑命名凭据时用服务商自己那把）。
 *   本适配器不引入任何额外凭据，也不碰控制台会话接口——探的就是「这个 API token 有没有查询能力」。
 * @WHY 探测顺序（都是同一把 API token）：
 *   1. `{origin}/v1/dashboard/billing/usage`（OpenAI 兼容账单）→ 已用；subscription 给出真实
 *      总额度时才算余额，是「不限额度」占位值就只报已用。
 *   2. 账单接口不可用 → 探一次 `{origin}/api/user/self`：少数部署允许 API token 读它并给出额度。
 *   3. 都不行 → 如实报「该供应商 API 未提供可用的查询接口」（§7：查不到就说查不到，不猜、不引导
 *      用户去用控制台令牌）。
 */
export const openAiGatewayAdapter: AccountAdapter = {
	kind: "openai-gateway",
	match: (channel) => accountConfig(channel)?.kind === "openai-gateway",
	async query({
		channel,
		apiKey,
		signal,
		providerBaseUrl,
	}: {
		channel: ChannelRecord;
		apiKey: string;
		signal: AbortSignal;
		providerBaseUrl?: (providerId: string) => string | undefined;
	}) {
		const cfg = accountConfig(channel);
		// 支持 {baseUrl} 占位（与模板适配器同一口径：取该渠道所属服务商注册的 baseUrl）。
		const configured = renderTemplateText((cfg?.url ?? "").trim(), {
			baseUrl: providerBaseUrlOf(channel, providerBaseUrl),
			apiKey,
		}).replace(/\/+$/, "");
		if (!configured) return { status: "failed", error: "未配置账户接口地址" };
		const origin = siteRootOf(configured);
		if (!/^https?:\/\//i.test(origin)) return { status: "failed", error: `账户接口地址必须是 http(s)：${configured}` };
		// @BUGFIX 2026-09-11（真实网关验收发现）：one-api/new-api 的账户接口在**站点根**
		// /api/user/self，而渠道里通常填的是 OpenAI 兼容基址（末尾带 /v1）。直接拼接会得到
		// /v1/api/user/self → HTTP 404。这里先剥掉 /v1（或 /v1/... 子路径）再拼；若用户已直接
		// 给出完整 /api/user/self 地址，则原样使用。
		const selfUrl = /\/api\/user\/self$/i.test(configured) ? configured : `${origin}/api/user/self`;
		const scale = typeof cfg?.scale === "number" && cfg.scale > 0 ? cfg.scale : 1;
		const unit = cfg?.unit ?? "quota";
		/**
		 * 额度探针（/api/user/self）：少数部署允许 API token 读它并直接返回 quota/used_quota。
		 * 保留失败原因（HTTP 500 / 非 JSON / 重定向 / 超限…）：这些是用户该看到的真实诊断。
		 */
		const queryQuotaProbe = async (): Promise<
			{ result: Omit<AccountQueryResult, "accountRef" | "kind"> } | { error: string; status?: number }
		> => {
			const res = await fetchJson(
				fetch,
				selfUrl,
				{ method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } },
				signal,
			);
			if (!res.ok) return { error: res.error ?? "账户接口请求失败", status: res.status };
			const body = (res.body ?? {}) as Record<string, unknown>;
			const data = (body.data ?? body) as Record<string, unknown>;
			const quota = num(data.quota);
			const used = num(data.used_quota) ?? num(data.usedQuota);
			if (quota === undefined && used === undefined) return { error: "账户接口未返回可识别的额度字段" };
			const displayName =
				typeof data.display_name === "string"
					? data.display_name
					: typeof data.username === "string"
						? data.username
						: undefined;
			// balance = 可用余额（有已用量时扣掉），不是总额度。
			const remaining = quota === undefined ? undefined : (used === undefined ? quota : quota - used) / scale;
			return {
				result: {
					status: "ok",
					scope: displayName,
					unit,
					balance: remaining,
					quota: {
						used: used === undefined ? undefined : used / scale,
						limit: quota === undefined ? undefined : quota / scale,
						remaining,
						unit,
					},
					checkedAt: Date.now(),
				},
			};
		};
		// 1) 账单接口（API token 就能读用量）。
		const billing = await queryOpenAiBilling(fetch, origin, apiKey, signal);
		if (billing) return billing;
		// 2) 再探一次 /api/user/self：不是「去要控制台令牌」，而是用**同一把 API token** 试一下，
		//    有些部署直接放行并返回额度。
		const quotaProbe = await queryQuotaProbe();
		if ("result" in quotaProbe) return quotaProbe.result;
		// 3) 都拿不到 → 如实说「这个 API 没有可用的查询接口」（不猜、不引导控制台令牌）。
		return {
			status: "failed",
			error: `该供应商的 API 未提供可用的用量/余额查询接口（已用渠道里的 API token 探测 ${origin}/v1/dashboard/billing/usage 与 ${origin}/api/user/self：${quotaProbe.error}）`,
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
		const res = await fetchJson(
			fetch,
			`${base}/user/balance`,
			{ method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } },
			signal,
		);
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
			.filter(
				(entry): entry is { currency: string; total: number; granted: number; toppedUp: number } => entry !== null,
			);
		if (entries.length === 0)
			return { status: "failed", error: "账户接口未返回可识别的余额字段（balance_infos 为空或缺少 total_balance）" };
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

/**
 * 模板适配器：用户在渠道里自配请求与字段映射（内置几家只是预设）。
 * 请求与解析都走同一套有界基建（超时/体积/禁重定向/限频/缓存）。
 * @CONTRACT 磁盘上的老平铺配置由 accountTemplateOf 现场迁移，这里只面对**新结构**。
 */
export const templateAdapter: AccountAdapter = {
	kind: "template",
	match: (channel) => accountTemplateOf(channel) !== null,
	async query({
		channel,
		apiKey,
		signal,
		providerBaseUrl,
	}: {
		channel: ChannelRecord;
		apiKey: string;
		signal: AbortSignal;
		providerBaseUrl?: (providerId: string) => string | undefined;
	}) {
		const template = accountTemplateOf(channel);
		if (!template) return { status: "failed", error: "未配置账户查询模板" };
		const baseUrl = providerBaseUrlOf(channel, providerBaseUrl);
		const url = renderTemplateText(template.request.url, { baseUrl, apiKey });
		if (!/^https?:\/\//i.test(url)) {
			// @BUGFIX 双花括号被渲染成 `{https://uuapi.io}/usage` 后只报 http(s) 校验失败，
			//   用户完全看不懂问题在括号上 —— 把这句坑翻译成人话附在后面。
			const hint = describeTemplateProblem(template.request.url);
			return { status: "failed", error: `账户接口地址必须是 http(s)：${url}${hint ? `（${hint}）` : ""}` };
		}
		const method = template.request.method ?? "GET";
		const res = await fetchJson(
			fetch,
			url,
			{
				method,
				headers: buildTemplateHeaders(template, { baseUrl, apiKey }),
				...(method === "POST" && template.request.body
					? { body: renderTemplateText(template.request.body, { baseUrl, apiKey }) }
					: {}),
			},
			signal,
		);
		if (!res.ok) return { status: "failed", error: res.error };
		const mapped = applyAccountTemplate(template, res.body);
		if (mapped.status === "failed") return { status: "failed", error: mapped.error };
		return {
			status: "ok",
			unit: mapped.unit,
			balance: mapped.balance,
			quota: mapped.quota,
			scope: mapped.scope,
			breakdown: mapped.breakdown,
			note: mapped.note,
			checkedAt: Date.now(),
		};
	},
};

/**
 * 渠道所属服务商的 baseUrl（来自运行时模型目录；取不到给空串，模板里的 {baseUrl} 会渲染成空）。
 * @WHY 用户写的模板需要 {baseUrl} 才能复用同一个网关的不同部署；服务商 baseUrl 由 models.json 拥有。
 */
let providerBaseUrlLookup: ((providerId: string) => string | undefined) | null = null;
export function setProviderBaseUrlLookup(lookup: (providerId: string) => string | undefined): void {
	providerBaseUrlLookup = lookup;
}
/**
 * 渠道所属服务商的 baseUrl。
 *
 * @WHY 用户写的模板需要 {baseUrl} 才能复用同一个网关的不同部署；服务商 baseUrl 由 models.json 拥有。
 * @CONTRACT 调用方（账户查询）应当传自己的 resolve（本会话的 runtime）。模块级 lookup 只是
 *   **兑现用命**（UI 视图推导某个渠道是不是 cctq 部署、单测）：它由最后创建的 ClientSession 覆写，
 *   服务进程里多会话并存时它答的是「别的标签页」的服务商表。
 * @BUGFIX 2026-09-18：这里以前只有模块级 lookup。旧会话自己目录里没有的服务商，余额却能查到
 *   （它的 {baseUrl} 被另一个会话已热加载的 runtime 答上了）——一个 bug 掩盖了另一个。
 */
function providerBaseUrlOf(channel: ChannelRecord, resolve?: (providerId: string) => string | undefined): string {
	try {
		const fn = resolve ?? providerBaseUrlLookup;
		return (fn?.(channel.providerId) ?? "").replace(/\/+$/, "");
	} catch {
		return "";
	}
}

/**
 * 充值页的**内置默认**（按账户查询方式选）。
 * @WHY 用户配好渠道就该能一键去充值，不该自己去找供应商的控制台地址；网关照旧用 {baseUrl} 占位，
 *   因此同一个"new-api 网关"配置换个部署也不用改。
 * @GOTCHA 这是 href，只放行 http(s)（见 topupUrlOf）：javascript:/data: 一律丢弃。
 */
const TOPUP_DEFAULTS: Record<string, string> = {
	deepseek: "https://platform.deepseek.com/top_up",
	"openai-gateway": "{baseUrl}/console/topup",
	openrouter: "https://openrouter.ai/settings/credits",
	template: "",
};

/** 该渠道的充值页地址（显式配置优先，其次按 kind 的默认值；只返回 http(s)，否则 null）。 */
export function topupUrlOf(channel: ChannelRecord): string | null {
	const cfg = accountConfig(channel);
	const explicit = typeof cfg?.topupUrl === "string" ? cfg.topupUrl.trim() : "";
	const raw = explicit || (cfg?.kind ? (TOPUP_DEFAULTS[cfg.kind] ?? "") : "");
	if (!raw) return null;
	// {baseUrl} 用**站点根**（剥掉 /v1）：网关的控制台页面挂在站点根下，
	// 供应商的 baseUrl 往往是 `https://host/v1`，直接拼会得到 /v1/console/topup（404）。
	const rendered = renderTemplateText(raw, { baseUrl: siteRootOf(providerBaseUrlOf(channel)), apiKey: "" }).trim();
	return /^https?:\/\//i.test(rendered) ? rendered : null;
}

/**
 * OpenRouter 余额查询。
 * @WHY 普通**推理 key** 只能查 `/api/v1/key`（该 key 的额度与用量）；`/api/v1/credits`
 *   （账户总余额）需要 **management key**。旧实现只打 `/credits`，于是普通 key 一律查不到余额。
 *   现在以 `/key` 为主、`/credits` 为可选补充：任一可用即有值，两个都不可用才算失败。
 */
export const openRouterAdapter: AccountAdapter = {
	kind: "openrouter",
	match: (channel) => accountConfig(channel)?.kind === "openrouter",
	async query({ channel, apiKey, signal }) {
		const cfg = accountConfig(channel);
		const base = (cfg?.url ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
		const headers = { authorization: `Bearer ${apiKey}` };

		// 1) key 级额度与用量：任何 key 都能查（含普通推理 key）。
		const keyRes = await fetchJson(fetch, `${base}/key`, { headers }, signal);
		if (keyRes.ok) {
			const kdata = ((keyRes.body ?? {}) as Record<string, unknown>).data as Record<string, unknown> | undefined;
			const usage = num(kdata?.usage);
			const limit = num(kdata?.limit);
			const remaining = num(kdata?.limit_remaining);
			// 2) key 没有额度上限时，剩余额度信息不足 → 尝试账户总余额补位（需 management key）。
			if (limit === undefined || remaining === undefined) {
				const account = await openRouterAccountBalance(base, headers, signal);
				if (account) return account;
				return {
					status: "ok",
					unit: "USD",
					balance: remaining,
					quota: { used: usage, unit: "USD" },
					checkedAt: Date.now(),
					note: "该 key 未设置额度上限；账户总余额需要 management key，可在 openrouter.ai/settings/credits 查看",
				};
			}
			return {
				status: "ok",
				unit: "USD",
				balance: remaining,
				quota: { used: usage, limit, remaining, unit: "USD" },
				checkedAt: Date.now(),
				note: "该 API key 的额度",
			};
		}

		// 3) key 接口不可用（权限或路径差异）→ 退回账户总余额端点。
		const account = await openRouterAccountBalance(base, headers, signal);
		if (account) return account;
		return { status: "failed", error: keyRes.error ?? "账户接口查询失败" };
	},
};

/** OpenRouter 账户总余额（需 management key）。不可用时返回 null，由调用方决定降级。 */
async function openRouterAccountBalance(
	base: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<Omit<AccountQueryResult, "accountRef" | "kind"> | null> {
	const res = await fetchJson(fetch, `${base}/credits`, { headers }, signal);
	if (!res.ok) return null;
	const cdata = ((res.body ?? {}) as Record<string, unknown>).data as Record<string, unknown> | undefined;
	const total = num(cdata?.total_credits);
	const used = num(cdata?.total_usage);
	if (total === undefined) return null;
	const remaining = used === undefined ? undefined : total - used;
	return {
		status: "ok",
		unit: "USD",
		balance: remaining,
		quota: { used, limit: total, remaining, unit: "USD" },
		checkedAt: Date.now(),
		note: "账户总余额",
	};
}

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
		// 顺序：模板（用户自配）优先 → 内置三家（预设实现，行为已验证）兜底。
		this.adapters = opts.adapters ?? [templateAdapter, deepSeekAdapter, openAiGatewayAdapter, openRouterAdapter];
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
		this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_MS;
		this.now = opts.now ?? (() => Date.now());
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	/** 缓存快照（UI 只读）。
	 * @CONTRACT 两种 stale 必须分得开（见 protocol.UiAccountStatus.staleReason）：
	 *   - 缓存里的成功结果超过 TTL → `ttl`（渠道没有报错，只是数字旧了）；
	 *   - 缓存里本身就是「失败保留的旧值」→ `failed`（带上失败原因）。
	 *   `staleSince` 两种都给：界面要能算出「这份数据是多久以前的」。
	 */
	snapshot(): UiAccountStatus[] {
		const now = this.now();
		return [...this.cache.values()].map((entry) => {
			const ttlExpired = entry.checkedAt !== undefined && now - entry.checkedAt > this.cacheTtlMs;
			const stale = entry.status === "ok" ? (ttlExpired ? ("ttl" as const) : undefined) : entry.staleReason;
			return {
				accountRef: entry.accountRef,
				kind: entry.kind,
				status: stale ? "stale" : entry.status,
				scope: entry.scope,
				unit: entry.unit,
				balance: entry.balance,
				quota: entry.quota,
				checkedAt: entry.checkedAt,
				staleSince: stale ? (entry.staleSince ?? entry.checkedAt) : undefined,
				staleReason: stale,
				error: entry.error,
				breakdown: entry.breakdown,
				note: entry.note,
			};
		});
	}

	/** 查询某渠道的账户状态；resolveKey 由服务层提供（密钥不出服务端）。
	 *  @CONTRACT resolveKey(null) = 「渠道没绑定命名凭据，用服务商自己那把密钥」——
	 *  自定义服务商（models.json 内联 key / auth.json）没有 provider-keys.json 名字，
	 *  旧实现直接报「未绑定命名凭据」，导致这类渠道的余额永远查不出来。 */
	async query(
		channel: ChannelRecord,
		resolveKey: (keyName: string | null) => string | null | Promise<string | null>,
		/** 目录自愈 + {baseUrl} 解析都由调用方（会话层）提供；见 providerBaseUrlOf。 */
		options: {
			providerBaseUrl?: (providerId: string) => string | undefined;
			ensureFresh?: () => Promise<void>;
		} = {},
	): Promise<AccountQueryResult> {
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
		const apiKey = await resolveKey(keyName);
		if (!apiKey)
			return this.remember({
				accountRef,
				kind: adapter.kind,
				status: "failed",
				error: keyName ? `命名凭据「${keyName}」已不存在` : "该渠道未绑定命名凭据，无法查询账户",
			});

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
			// 目录自愈放在真正发请求之前：用户刚加的服务商，{baseUrl} 要能立刻解析出来。
			// 失败不阻塞查询（沿用旧目录，由 adapter 如实报地址解析不出来）。
			await options.ensureFresh?.().catch(() => undefined);
			const result = await adapter.query({
				channel,
				apiKey,
				signal: controller.signal,
				providerBaseUrl: options.providerBaseUrl,
			});
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
				// staleSince 要保留**最早那次成功**的时间（连续失败时不能被后面的失败往前推）。
				return this.remember({
					...previous,
					status: "stale",
					staleReason: "failed",
					staleSince: previous.staleSince ?? previous.checkedAt,
					error: merged.error ?? "查询失败",
				});
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

	/** 账户查询模板预设（UI 一键填充；不含任何密钥）。 */
	presets(): { id: string; label: string; description: string; template: Record<string, unknown> }[] {
		return ACCOUNT_TEMPLATE_PRESETS.map((p) => ({
			id: p.id,
			label: p.label,
			description: p.description,
			template: { ...p.template },
		}));
	}

	/** 测试/维护用：清空缓存。 */
	reset(): void {
		this.cache.clear();
		this.lastAttempt.clear();
		this.inFlight.clear();
	}
}
