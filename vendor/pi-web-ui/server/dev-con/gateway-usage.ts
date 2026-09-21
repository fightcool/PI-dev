/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../agent-service.ts（queryGatewayUsage 入口 + attach 时的端口注入）,
 *            ../protocol.ts（UiGatewayUsage / gateway_usage 消息）,
 *            ../../web/src/components/UsageDetail.tsx（展示「网关自报用量」）
 *   📖 docs/NEWAPI-GATEWAY.md（接口事实、实测证据、单位换算的口径）
 *   @CONTRACT **只读**网关自己的账单接口，不代理模型流量、不改任何配置；失败不阻塞编码。
 *             数字是「网关自报」，不是本地按 token 估算的费用 —— 两者不得相加（§7）。
 *   @GOTCHA 单位换算（实测，见协议里 UiGatewayUsage 的 @GOTCHA）：NewAPI 的
 *             `total_usage` = USD × 100 × (display_in_currency ? usd_exchange_rate : 1)。
 *             所以必须先读公开的 `/api/status` 拿 display_in_currency / usd_exchange_rate，
 *             否则在不显示本币的部署上会把金额放大 7.3 倍（本实例就是 ¥7.3/USD）。
 *   @GOTCHA NewAPI 用 1e8 表示「不限额度令牌」：`hard_limit_usd` 是这个占位值时**没有**真实余额，
 *             只报已用（与旧账户适配器同口径，见 §7「不猜余额」）。
 *   @GOTCHA 账单统计是**异步**的：一次请求打完后 `total_usage` 可能几秒后才变（实测约 3–6s），
 *             界面上的数字天然滞后，不要把它当作实时计费。
 *   @GOTCHA 日期窗口不可信（2026-09-21 实测 api.ftai.cc）：`start_date`/`end_date` 被**完全忽略**
 *             —— 2020 年的窗口与不带窗口返回同一个 `total_usage`，那是**累计**值。
 *             所以本模块默认不带窗口查询，且只在回落路径（带窗口那次才成功）才回报 windowDays；
 *             界面据此说「累计」而不是「近 30 天」。
 *   @MAGIC 缓存 TTL 60s（同一服务商重复查询不打网关）；force=true 走手动刷新。
 *   @MAGIC 有界：单请求超时 8s、响应体上限 64KB、拒绝重定向（3xx 一律失败）。
 * ──────────────────────────────────────────────────
 */
import type { UiGatewayUsage } from "../protocol.js";
import { fetchJson } from "./http-json.js";
/** 网关地址与凭据由宿主（ClientSession）回答，本模块不碰配置。 */
export interface GatewayUsagePort {
	/** 该服务商注册的 baseUrl（必须由**当前会话**的 runtime 回答）。 */
	providerBaseUrl: (providerId: string) => string | undefined;
	/** 服务商展示名（仅用于界面标签）。 */
	providerName: (providerId: string) => string | undefined;
	/** 解析该服务商的凭据正文（服务端内部；密钥不出服务端）。 */
	resolveProviderKey: (providerId: string) => Promise<string | null>;
	/** 已注册的服务商 id（未指定 providerId 时按当前模型的 provider 兜底）。 */
	providerIds: () => string[];
}

/** @MAGIC 单次查询超时（网关账单接口很快；慢就不该拖住界面）。 */
export const GATEWAY_USAGE_TIMEOUT_MS = 8_000;
/** @MAGIC NewAPI/one-api 的「不限额度」占位值（实测 1e8）：>= 它就不是真实余额。 */
export const UNLIMITED_LIMIT_MIN = 1e7;
/** @MAGIC 账单查询的日期窗口（**仅在**不带窗口的查询失败时才试；见 @GOTCHA）。 */
export const BILLING_WINDOW_DAYS = 30;
/** @MAGIC 成功结果缓存 TTL。 */
export const GATEWAY_USAGE_TTL_MS = 60_000;

interface Cached {
	at: number;
	usage: UiGatewayUsage;
}

function num(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** 站点根：从用户给的地址里剥掉 /v1…、/api/… 与尾斜杠，得到 `https://host[:port]`。 */
export function siteRootOf(raw: string): string {
	return raw
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/api\/[a-z0-9/_-]*$/i, "")
		.replace(/\/v\d+[a-z-]*\/.*$/i, "")
		.replace(/\/v\d+[a-z-]*$/i, "")
		.replace(/\/+$/, "");
}

/** `{ object: "list", total_usage: n }`（one-api/new-api 的用量接口）。 */
export function parseBillingUsage(body: unknown): number | undefined {
	const r = (body ?? {}) as Record<string, unknown>;
	return num(r.total_usage) ?? num(r.totalUsage);
}

/** `{ hard_limit_usd, soft_limit_usd, system_hard_limit_usd }`（总额度；占位值 = 不限额度）。 */
export function parseSubscriptionLimit(body: unknown): number | undefined {
	const r = (body ?? {}) as Record<string, unknown>;
	return num(r.hard_limit_usd) ?? num(r.soft_limit_usd) ?? num(r.system_hard_limit_usd);
}

/**
 * `/api/status`（公开）里的显示口径：本币显示时 `total_usage` 会被乘上汇率。
 * @CONTRACT 读不到就按「不显示本币、汇率 1」处理 —— 那正是 one-api 的原始口径。
 */
export function parseDisplayFactor(body: unknown): number {
	const r = (body ?? {}) as Record<string, unknown>;
	if (r.display_in_currency !== true) return 1;
	const rate = num(r.usd_exchange_rate);
	return rate && rate > 0 ? rate : 1;
}

/** 一次有界 GET（拒绝重定向、解析 JSON）；返回 undefined 表示「这个接口在这台部署上不可用」。 */
async function getJson(
	fetchImpl: typeof fetch,
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<unknown | undefined> {
	const res = await fetchJson(fetchImpl, url, { method: "GET", headers }, signal);
	return res.ok ? res.body : undefined;
}

export interface GatewayUsageResult {
	ok: boolean;
	usage?: UiGatewayUsage;
	error?: string;
	/**
	 * true = 这台网关**没有**可读的账单接口（端点不存在 / 不是账单 JSON）。
	 * @WHY 界面必须把「这个服务商不是网关」与「网关暂时连不上」分开：前者是永久的
	 *   （直连上游如 api.deepseek.com 就没有这个接口），不该在状态栏一直报错；
	 *   后者是暂时的，值得重试。字符串匹配错误文案做不到这件事。
	 */
	unsupported?: boolean;
}

/**
 * 查询一个网关（NewAPI 一类）自报的用量/额度。
 * @WHY 只依赖三个接口：`/v1/dashboard/billing/usage`（已用）、`/v1/dashboard/billing/subscription`
 *   （总额度，可能是不限额度占位）、`/api/status`（显示币种与汇率，公开可读）。
 *   控制台接口（`/api/user/self`）需要系统访问令牌，模型 key 一律 401（实测）→ 本模块不碰它们。
 */
export class GatewayUsageService {
	private readonly cache = new Map<string, Cached>();

	constructor(
		private readonly port: GatewayUsagePort,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	/** 该服务商是否像一个网关（有 baseUrl 即可查询；查不到就如实说查不到）。 */
	async query(providerId: string, opts?: { force?: boolean; now?: number }): Promise<GatewayUsageResult> {
		const now = opts?.now ?? Date.now();
		const cached = this.cache.get(providerId);
		if (!opts?.force && cached && now - cached.at < GATEWAY_USAGE_TTL_MS) return { ok: true, usage: cached.usage };

		const baseUrl = this.port.providerBaseUrl(providerId);
		if (!baseUrl) return { ok: false, error: `服务商 ${providerId} 未注册地址（models.json 里没有 baseUrl）` };
		const origin = siteRootOf(baseUrl);
		if (!/^https?:\/\//i.test(origin)) return { ok: false, error: `网关地址必须是 http(s)：${baseUrl}` };
		const apiKey = await this.port.resolveProviderKey(providerId);
		if (!apiKey) return { ok: false, error: `服务商 ${providerId} 没有可用密钥，无法查询网关用量` };

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), GATEWAY_USAGE_TIMEOUT_MS);
		try {
			const auth = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
			const end = new Date(now + 864e5).toISOString().slice(0, 10);
			const start = new Date(now - BILLING_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
			/** 用量接口是**必需**的：先不带日期窗口（多数部署直接可读），不行再按窗口试一次；
			 *  两次都输就分情况说实话 —— 端点不存在（没这个能力）与连不上/超时（网络问题）
			 *  对用户是完全不同的两件事，不能都说成「未提供用量接口」。 */
			const usageUrl = `${origin}/v1/dashboard/billing/usage`;
			let first = await fetchJson(this.fetchImpl, usageUrl, { method: "GET", headers: auth }, controller.signal);
			let used = first.ok ? parseBillingUsage(first.body) : undefined;
			/**
			 * 数字是否来自**带窗口**的那次查询。
			 * @GOTCHA 实测（2026-09-21，api.ftai.cc）：这台部署**完全忽略** start_date/end_date
			 *   —— 2020 年的窗口与不带窗口返回同一个 total_usage（累计值）。所以不能想当然
			 *   写成「近 30 天」：只有走带窗口的回落路径时才敢说窗口，否则如实报「累计」。
			 */
			let dated = false;
			if (used === undefined) {
				// 端点不存在（404/重定向/非 JSON）→ 换带日期窗口的地址再试一次。
				const withWindow = await fetchJson(
					this.fetchImpl,
					`${usageUrl}?start_date=${start}&end_date=${end}`,
					{ method: "GET", headers: auth },
					controller.signal,
				);
				if (withWindow.ok) {
					used = parseBillingUsage(withWindow.body);
					first = withWindow;
					dated = used !== undefined;
				}
			}
			if (used === undefined) {
				// 分三种说实话，而不是把一切都叫「没有账单接口」：
				//  ① 传输失败（网络/超时）→ 暂时故障，值得重试；
				//  ② 鉴权被拒（401/403）→ 密钥不对或没解析出密钥。这是**配置问题**，说成
				//     「不是网关」会把人引向完全错误的方向（2026-09-21 实测踩到：运行时里没有这个
				//     服务商时这里拿到 401，界面却写「直连上游、不是网关」，真因是 models.json 被拒）；
				//  ③ 其余（404/405/非 JSON/重定向）→ 才是「这台网关没有账单接口」。
				const transport =
					first.kind === "network" || first.kind === "timeout" ? (first.error ?? "网关不可达") : undefined;
				const unauthorized = first.status === 401 || first.status === 403;
				return {
					ok: false,
					unsupported: !transport && !unauthorized,
					error: transport
						? `查询网关用量失败：${transport}（${usageUrl}）`
						: unauthorized
							? `网关拒绝了这把密钥（HTTP ${first.status}）：检查「设置 → 网关」里的 API 密钥；若密钥没问题，则是该服务商没有注册进运行时（配置被 SDK schema 拒绝时也会走到这里，详见网关页顶部的运行时提示）`
							: `网关未提供用量接口（${usageUrl} 不可读或字段无法识别）`,
				};
			}
			const [subBody, statusBody] = await Promise.all([
				getJson(this.fetchImpl, `${origin}/v1/dashboard/billing/subscription`, auth, controller.signal),
				// /api/status 是公开配置接口：读不到就按 one-api 原口径（不显示本币）。
				getJson(this.fetchImpl, `${origin}/api/status`, { accept: "application/json" }, controller.signal),
			]);
			const factor = parseDisplayFactor((statusBody as Record<string, unknown>)?.data ?? statusBody);
			const rawLimit = parseSubscriptionLimit(subBody);
			const unlimited = rawLimit !== undefined && rawLimit >= UNLIMITED_LIMIT_MIN;
			const usedUsd = used / 100 / factor;
			const limitUsd = rawLimit === undefined || unlimited ? null : rawLimit / factor;
			const usage: UiGatewayUsage = {
				providerId,
				providerName: this.port.providerName(providerId),
				baseUrl: origin,
				usedUsd,
				limitUsd,
				remainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - usedUsd),
				unlimited,
				// 只有带窗口那次成功才敢报窗口；不带窗口的部署口径是**累计**（见上面的 @GOTCHA）。
				...(dated ? { windowDays: BILLING_WINDOW_DAYS } : {}),
				checkedAt: now,
			};
			this.cache.set(providerId, { at: now, usage });
			return { ok: true, usage };
		} catch (err) {
			return { ok: false, error: (err as Error).name === "AbortError" ? "查询网关用量超时" : (err as Error).message };
		} finally {
			clearTimeout(timer);
		}
	}
}
