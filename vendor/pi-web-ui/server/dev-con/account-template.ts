/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-accounts.ts（模板适配器调用本模块）, channel-model.ts（extra.account 承载模板）,
 *            ../protocol.ts（channel_state.accountPresets 下发预设）, web/src/components/ChannelForm.tsx（模板编辑器）
 *   📖 docs/DEV-CON-PROPOSAL.md §7（余额/配额：带单位、查询时间与状态）与 §8 P3
 *   @CONTRACT 纯函数：JSON 路径取值、模板渲染、响应 → 账户结果映射。不做 IO（由 adapter 负责）。
 *   @WHY 之前只有三个写死的适配器（DeepSeek/网关/OpenRouter），用户无法适配自己的供应商 →
 *        把这些"死功能"变成**可配置模板**：URL/方法/鉴权/字段映射都可改，三个内置实现降级为**预设**。
 *   @GOTCHA JSON 路径要支持数组下标（balance_infos[0].total_balance）；取不到必须是 undefined，
 *          绝不能退化成 0（0 与「没有这个字段」在余额语义上完全不同）。
 * ──────────────────────────────────────────────────
 */
import type { ChannelRecord } from "./channel-model.js";

/** 账户查询模板：用户可自由配置的接口与字段映射。 */
export interface AccountTemplate {
	kind: "template";
	/** 接口地址；支持 {baseUrl} 占位（取渠道所属服务商注册的 baseUrl，未注册则为空串）。 */
	url: string;
	method?: "GET" | "POST";
	/** 鉴权头名（默认 authorization）与前缀（默认 "Bearer "，可设为 "" 表示不加前缀）。 */
	apiKeyHeader?: string;
	apiKeyPrefix?: string;
	/** POST 请求体（JSON 文本；支持 {apiKey} 占位）。 */
	body?: string;
	/** 单个对象形态的字段映射（JSON 路径）。 */
	mapping?: {
		balance?: string;
		currency?: string;
		granted?: string;
		toppedUp?: string;
		limit?: string;
		used?: string;
		remaining?: string;
		scope?: string;
		/** 布尔：为 false 时标注「余额不足以继续调用」（DeepSeek 的 is_available 语义）。 */
		available?: string;
	};
	/** 数组形态（多币种）：items.path 指向数组，逐项映射。 */
	items?: { path: string; currency?: string; total?: string; granted?: string; toppedUp?: string };
	/** 固定单位/币种（映射里取不到时使用）。 */
	unit?: string;
	/** 数值缩放（如网关注额的换算比例）。 */
	scale?: number;
}

/** 从渠道档案里读出账户模板（kind=template，或直接给了 mapping/items 也认）。 */
export function accountTemplateOf(channel: ChannelRecord): AccountTemplate | null {
	const raw = channel.extra?.account;
	if (!raw || typeof raw !== "object") return null;
	const cfg = raw as AccountTemplate;
	const hasMapping = Boolean(cfg.mapping && Object.values(cfg.mapping).some((v) => typeof v === "string" && v.trim()));
	const hasItems = Boolean(cfg.items && typeof cfg.items.path === "string" && cfg.items.path.trim());
	if (cfg.kind !== "template" && !hasMapping && !hasItems) return null;
	if (typeof cfg.url !== "string" || !cfg.url.trim()) return null;
	return { ...cfg, kind: "template" };
}

/** 按 JSON 路径取值：`a.b[0].c`；不存在返回 undefined（绝不当成 0）。 */
export function readPath(root: unknown, path: string | undefined): unknown {
	if (!path) return undefined;
	let node: unknown = root;
	for (const rawKey of path.split(".")) {
		if (node === null || node === undefined) return undefined;
		const key = rawKey.trim();
		if (!key) return undefined;
		const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(key);
		if (!match) return undefined;
		const [, name, indexes] = match;
		if (name) {
			if (typeof node !== "object") return undefined;
			node = (node as Record<string, unknown>)[name];
		}
		for (const index of indexes.matchAll(/\[(\d+)\]/g)) {
			if (!Array.isArray(node)) return undefined;
			node = node[Number(index[1])];
		}
	}
	return node;
}

/** 数值解析：接受 number 与数字字符串；其余（含 null/undefined/空串）返回 undefined。 */
export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		const n = Number(trimmed);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

/** 字符串解析：只接受非空字符串/数字，其它为 undefined。 */
export function toText(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

/** 渲染 URL / body 里的占位符。 */
export function renderTemplateText(text: string, vars: { baseUrl: string; apiKey: string }): string {
	return text.replaceAll("{baseUrl}", vars.baseUrl).replaceAll("{apiKey}", vars.apiKey);
}

export interface AccountTemplateResult {
	status: "ok" | "failed";
	unit?: string;
	balance?: number;
	granted?: number;
	toppedUp?: number;
	quota?: { used?: number; limit?: number; remaining?: number; unit?: string };
	scope?: string;
	breakdown?: { currency: string; total: number; granted: number; toppedUp: number }[];
	note?: string;
	error?: string;
}

/**
 * 把接口响应按模板映射成账户结果（纯函数，便于单测各种供应商形态）。
 * 数组形态优先：给了 items.path 就逐项映射为多币种 breakdown。
 */
export function applyAccountTemplate(template: AccountTemplate, body: unknown): AccountTemplateResult {
	const scale = typeof template.scale === "number" && template.scale > 0 ? template.scale : 1;
	const unitOf = (currency: string | undefined): string | undefined => currency ?? template.unit;

	if (template.items?.path) {
		const list = readPath(body, template.items.path);
		if (!Array.isArray(list)) return { status: "failed", error: `模板映射的数组路径取不到数组：${template.items.path}` };
		const breakdown = list
			.map((entry) => {
				const currency = toText(readPath(entry, template.items?.currency)) ?? template.unit ?? "";
				const total = toNumber(readPath(entry, template.items?.total));
				if (total === undefined) return null;
				return {
					currency: currency || "?",
					total: total / scale,
					granted: (toNumber(readPath(entry, template.items?.granted)) ?? 0) / scale,
					toppedUp: (toNumber(readPath(entry, template.items?.toppedUp)) ?? 0) / scale,
				};
			})
			.filter((entry): entry is { currency: string; total: number; granted: number; toppedUp: number } => entry !== null);
		if (breakdown.length === 0) return { status: "failed", error: `模板映射未解析出任何余额项（数组路径 ${template.items.path}）` };
		const primary = template.unit ? (breakdown.find((entry) => entry.currency === template.unit) ?? breakdown[0]) : breakdown[0];
		const available = template.mapping?.available ? readPath(body, template.mapping.available) : undefined;
		return {
			status: "ok",
			unit: unitOf(primary.currency),
			balance: primary.total,
			quota: { limit: primary.total, remaining: primary.total, unit: unitOf(primary.currency) },
			breakdown,
			note: available === false ? "接口标注：余额不足以继续调用" : undefined,
		};
	}

	const mapping = template.mapping ?? {};
	const rawBalance = readPath(body, mapping.balance);
	const rawRemaining = readPath(body, mapping.remaining);
	const rawLimit = readPath(body, mapping.limit);
	const rawUsed = readPath(body, mapping.used);
	const balance = toNumber(rawBalance ?? rawRemaining);
	const limit = toNumber(rawLimit);
	const used = toNumber(rawUsed);
	const remaining = toNumber(rawRemaining) ?? balance;
	if (balance === undefined && limit === undefined && used === undefined && remaining === undefined) {
		return { status: "failed", error: `模板映射未解析出余额字段（mapping.balance=${mapping.balance ?? "未配置"}）` };
	}
	const currency = toText(readPath(body, mapping.currency)) ?? template.unit;
	const available = mapping.available ? readPath(body, mapping.available) : undefined;
	const granted = toNumber(readPath(body, mapping.granted));
	const toppedUp = toNumber(readPath(body, mapping.toppedUp));
	return {
		status: "ok",
		unit: currency,
		balance: (remaining ?? balance) === undefined ? undefined : (remaining ?? balance)! / scale,
		quota: {
			used: used === undefined ? undefined : used / scale,
			limit: limit === undefined ? undefined : limit / scale,
			remaining: remaining === undefined ? undefined : remaining / scale,
			unit: currency,
		},
		scope: toText(readPath(body, mapping.scope)),
		breakdown:
			balance === undefined
				? undefined
				: [{ currency: currency ?? "?", total: balance / scale, granted: (granted ?? 0) / scale, toppedUp: (toppedUp ?? 0) / scale }],
		note: available === false ? "接口标注：余额不足以继续调用" : undefined,
	};
}

/** 内置预设：一键填充到模板编辑器（用户可继续改 URL/字段，不再是写死的适配器）。 */
export const ACCOUNT_TEMPLATE_PRESETS: {
	id: string;
	label: string;
	description: string;
	/** 预设可以指向内置适配器（如 openai-gateway）：它会用渠道那把 API token 依次探测账单/额度接口。 */
	template: Omit<AccountTemplate, "kind"> & { kind: "template" | "openai-gateway" };
}[] = [
	{
		id: "deepseek",
		label: "DeepSeek 官方",
		description: "GET https://api.deepseek.com/user/balance（Bearer）→ balance_infos[] 多币种",
		template: {
			kind: "template",
			url: "https://api.deepseek.com/user/balance",
			method: "GET",
			items: { path: "balance_infos", currency: "currency", total: "total_balance", granted: "granted_balance", toppedUp: "topped_up_balance" },
			mapping: { available: "is_available" },
		},
	},
	{
		id: "openai-gateway",
		label: "OpenAI 兼容网关（one-api / new-api）",
		// @WHY 用内置适配器而不是模板：它只用渠道那把 API token 依次探账单接口与 /api/user/self，
		// 拿得到余额就报余额、只有用量就报已用、都没有就如实说「该 API 无查询接口」；模板只能打一个地址。
		description: "GET {baseUrl}/v1/dashboard/billing/usage（API token）→ 用量；该 API 若有余额字段则一并给出",
		template: {
			kind: "openai-gateway",
			url: "{baseUrl}",
			method: "GET",
			scale: 500000,
			unit: "USD",
		},
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		description: "GET https://openrouter.ai/api/v1/credits（Bearer）→ data.total_credits / data.total_usage",
		template: {
			kind: "template",
			url: "https://openrouter.ai/api/v1/credits",
			method: "GET",
			mapping: { limit: "data.total_credits", used: "data.total_usage", remaining: "data.total_credits" },
			unit: "USD",
		},
	},
];
