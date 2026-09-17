/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED account-template-schema.ts（校验/迁移/回显清洗）, account-template-presets.ts（内置预设）,
 *            channel-accounts.ts（模板适配器发请求）, channel-state.ts（模板 JSON 回显）,
 *            channel-model.ts（findSecretMaterial 对 request.headers 的窄豁免）,
 *            web/src/components/ChannelAccountQuery.tsx（模板编辑器）
 *   📖 docs/DEV-CON-PROPOSAL.md §7（余额/配额：带单位、查询时间与状态）与 §8 P3
 *   @CONTRACT 本文件只有纯函数：JSON 路径取值、占位符渲染、响应 → 账户结果映射。不做 IO。
 *   @WHY 模板从「多字段平铺」升级为**声明式单份 JSON**（request / map / invalidWhen）：
 *        一份模板就能表达 cc-switch 那类 JS extractor 的全部语义（回退链、可读补充、无效判定），
 *        但**绝不执行用户代码**——没有 eval / new Function / vm，取值只走 readPath 这条死路。
 *   @GOTCHA JSON 路径要支持数组下标（balance_infos[0].total_balance）；取不到必须是 undefined，
 *          绝不能退化成 0（0 与「没有这个字段」在余额语义上完全不同）。
 *   @GOTCHA 占位符是**单花括号** {baseUrl}/{apiKey}。写成 {{baseUrl}} 会被原样保留，
 *          渲染出 `{https://uuapi.io}/usage` 再报 http(s) 校验失败——用户完全看不懂，
 *          所以 describeTemplateProblem 专门把这句坑翻译成中文提示。
 * ──────────────────────────────────────────────────
 */

/** 请求定义：地址/方法/头/体，全部支持 {baseUrl} 与 {apiKey} 占位（单花括号）。 */
export interface AccountTemplateRequest {
	url: string;
	method?: "GET" | "POST";
	/** 自定义请求头（键名统一小写）；缺省自动带 authorization: Bearer {apiKey} 与 accept。 */
	headers?: Record<string, string>;
	/** POST 请求体（JSON 文本）。 */
	body?: string;
}

/** 多币种明细映射（DeepSeek balance_infos[] 这类数组形态）。 */
export interface AccountTemplateBreakdownMap {
	path: string;
	currency?: string;
	total?: string;
	granted?: string;
	toppedUp?: string;
}

/** 字段映射：每个值都是 JSON 路径表达式，支持 `a.b[0].c` 与 `x ?? y` 回退链。 */
export interface AccountTemplateMap {
	/** 布尔；false → 标注余额不足/不可用（查询本身仍算成功）。 */
	isValid?: string;
	remaining?: string;
	used?: string;
	limit?: string;
	/** 币种字段路径（取不到时用模板的 unit）。 */
	unit?: string;
	planName?: string;
	/** 可读补充说明，支持 ${json.path} 插值（数值 2 位小数，取不到 → —）。 */
	extra?: string;
	breakdown?: AccountTemplateBreakdownMap;
}

/** 密钥无效判定（在映射之前执行）。 */
export interface AccountTemplateInvalidWhen {
	path: string;
	equals?: string | number | boolean;
	exists?: boolean;
	messagePath?: string;
}

/** 账户查询模板：一份声明式 JSON，运行时只认这一套语义（老配置在读取时迁移）。 */
export interface AccountTemplate {
	kind: "template";
	request: AccountTemplateRequest;
	map: AccountTemplateMap;
	invalidWhen?: AccountTemplateInvalidWhen;
	/** map.unit 取不到时的固定单位/币种。 */
	unit?: string;
	/** 数值缩放（如网关配额的换算比例）。 */
	scale?: number;
	topupUrl?: string;
	/** 账户查询专用的命名凭据（provider-keys.json 里的密钥名）。 */
	credentialKeyName?: string;
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

/** invalidWhen 命中且 messagePath 取不到文案时的固定中文。 */
export const INVALID_KEY_MESSAGE = "鉴权失败：接口返回该密钥无效";
/** extra 插值取不到路径时的占位符。 */
export const MISSING_VALUE_TEXT = "—";
/** isValid=false 的面向用户说法（与内置 DeepSeek 适配器口径一致）。 */
export const INSUFFICIENT_NOTE = "接口标注：余额不足以继续调用";
/** note 里多句提示的连接符（既有提示在前）。 */
export const NOTE_SEPARATOR = " · ";

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

/**
 * 回退链取值：`remaining ?? balance` 表示先取 remaining，取不到再取 balance。
 * @CONTRACT 「取不到」= undefined / null / 空串（与 toNumber/toText 的既有语义一致）。
 */
export function readFallback(root: unknown, expr: string | undefined): unknown {
	if (!expr) return undefined;
	for (const segment of expr.split("??")) {
		const path = segment.trim();
		if (!path) continue;
		const value = readPath(root, path);
		if (value === undefined || value === null) continue;
		if (typeof value === "string" && !value.trim()) continue;
		return value;
	}
	return undefined;
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

/** 渲染 URL / header / body 里的占位符。 */
export function renderTemplateText(text: string, vars: { baseUrl: string; apiKey: string }): string {
	return text.replaceAll("{baseUrl}", vars.baseUrl).replaceAll("{apiKey}", vars.apiKey);
}

/**
 * 把「双花括号占位符」这个真实踩过的坑翻译成人话。
 * @BUGFIX 用户照抄 cc-switch 的 `{{baseUrl}}/usage`：渲染后是 `{https://uuapi.io}/usage`，
 *   只报「地址必须是 http(s)」，用户完全看不懂问题出在括号上。
 */
export function describeTemplateProblem(url: string): string | null {
	if (typeof url !== "string") return null;
	if (/\{\{\s*baseUrl\s*\}\}/.test(url)) return "占位符请用单花括号 {baseUrl}";
	if (/\{\{\s*apiKey\s*\}\}/.test(url)) return "占位符请用单花括号 {apiKey}";
	return null;
}

/**
 * 「这个头里写的是明文密钥吗」的启发式（用于校验时劝用户改成 {apiKey} 占位）。
 * @CONTRACT 只看形状：含占位符就一定不是明文；sk-/ghp_ 这类前缀 + 够长的无空格串才算。
 */
export function looksLikeLiteralSecret(value: string): boolean {
	if (typeof value !== "string") return false;
	if (value.includes("{apiKey}") || value.includes("{baseUrl}")) return false;
	const body = value.replace(/^\s*(bearer|basic|token)\s+/i, "").trim();
	if (/\s/.test(body)) return false;
	return /^(sk|pk|rk|api|ghp|gho|xox[abp])[-_]/i.test(body) && body.length >= 16;
}

/**
 * 请求头值是否「不含密钥正文」（供 channel-model 的写盘闸子做窄豁免）。
 * @CONTRACT 占位符（{apiKey}/{baseUrl}）与短常量（application/json、2023-06-01）安全；
 *   任何 20 位以上的不透明串或 sk-/ghp_ 这类前缀一律当成密钥（宁可误报也不漏）。
 */
export function isSafeHeaderValue(value: unknown): boolean {
	if (typeof value !== "string") return false;
	if (looksLikeLiteralSecret(value)) return false;
	const withoutPlaceholders = value.replaceAll("{apiKey}", "").replaceAll("{baseUrl}", "");
	return !/[A-Za-z0-9_-]{20,}/.test(withoutPlaceholders);
}

/** 渲染 extra 补充说明里的 ${json.path} 插值（数值保留 2 位小数，整数不加小数）。 */
export function renderExtraTemplate(text: string, body: unknown): string {
	return text.replace(/\$\{([^}]*)\}/g, (_all, expr: string) => {
		const raw = readFallback(body, expr);
		const n = toNumber(raw);
		if (n !== undefined) return Number.isInteger(n) ? String(n) : n.toFixed(2);
		return toText(raw) ?? MISSING_VALUE_TEXT;
	});
}

/**
 * 请求头合并（纯函数，便于单测）：显式 headers 优先，键名统一小写。
 * @CONTRACT 默认补 authorization: Bearer {apiKey} 与 accept: application/json；POST 补 content-type。
 *   显式给空串 = 明确不带这个头（少数供应商把 key 放 query 里，带 authorization 会 400）。
 */
export function buildTemplateHeaders(
	template: AccountTemplate,
	vars: { baseUrl: string; apiKey: string },
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [rawKey, rawValue] of Object.entries(template.request.headers ?? {})) {
		const key = rawKey.trim().toLowerCase();
		if (!key || typeof rawValue !== "string") continue;
		out[key] = renderTemplateText(rawValue, vars);
	}
	const method = template.request.method ?? "GET";
	const defaults: Record<string, string> = {
		authorization: `Bearer ${vars.apiKey}`,
		accept: "application/json",
		...(method === "POST" ? { "content-type": "application/json" } : {}),
	};
	for (const [key, value] of Object.entries(defaults)) if (out[key] === undefined) out[key] = value;
	// 空串 = 显式不带该头（渲染后为空的占位符同理）。
	return Object.fromEntries(Object.entries(out).filter(([, value]) => value.trim() !== ""));
}

/** invalidWhen 判定：命中返回面向用户的错误文案，未命中返回 null。 */
function detectInvalid(rule: AccountTemplateInvalidWhen | undefined, body: unknown): string | null {
	if (!rule?.path) return null;
	const value = readFallback(body, rule.path);
	let hit = false;
	if (rule.equals !== undefined) {
		if (typeof rule.equals === "string")
			hit = typeof value === "string" && value.trim().toLowerCase() === rule.equals.trim().toLowerCase();
		else if (typeof rule.equals === "number") hit = toNumber(value) === rule.equals;
		else hit = value === rule.equals;
	} else if (rule.exists === true) {
		hit = value !== undefined && value !== null && !(typeof value === "string" && !value.trim());
	}
	if (!hit) return null;
	return toText(readFallback(body, rule.messagePath)) ?? INVALID_KEY_MESSAGE;
}

/** 多币种明细分支（map.breakdown.path 指向数组，逐项映射）。 */
function applyBreakdown(
	template: AccountTemplate,
	body: unknown,
	scale: number,
	note: string | undefined,
): AccountTemplateResult {
	const spec = template.map.breakdown as AccountTemplateBreakdownMap;
	const list = readFallback(body, spec.path);
	if (!Array.isArray(list)) return { status: "failed", error: `模板映射的数组路径取不到数组：${spec.path}` };
	const breakdown = list
		.map((entry) => {
			const currency = toText(readFallback(entry, spec.currency)) ?? template.unit ?? "";
			const total = toNumber(readFallback(entry, spec.total));
			if (total === undefined) return null;
			return {
				currency: currency || "?",
				total: total / scale,
				granted: (toNumber(readFallback(entry, spec.granted)) ?? 0) / scale,
				toppedUp: (toNumber(readFallback(entry, spec.toppedUp)) ?? 0) / scale,
			};
		})
		.filter((entry): entry is { currency: string; total: number; granted: number; toppedUp: number } => entry !== null);
	if (breakdown.length === 0) return { status: "failed", error: `模板映射未解析出任何余额项（数组路径 ${spec.path}）` };
	const primary = template.unit
		? (breakdown.find((entry) => entry.currency === template.unit) ?? breakdown[0])
		: breakdown[0];
	return {
		status: "ok",
		unit: primary.currency || template.unit,
		balance: primary.total,
		quota: { limit: primary.total, remaining: primary.total, unit: primary.currency || template.unit },
		breakdown,
		note,
	};
}

/**
 * 把接口响应按模板映射成账户结果（纯函数，便于单测各种供应商形态）。
 * 顺序：invalidWhen 判定 → 明细数组分支 → 单对象分支。
 */
export function applyAccountTemplate(template: AccountTemplate, body: unknown): AccountTemplateResult {
	const invalid = detectInvalid(template.invalidWhen, body);
	if (invalid) return { status: "failed", error: invalid };
	const scale = typeof template.scale === "number" && template.scale > 0 ? template.scale : 1;
	const map = template.map ?? {};
	const isValid = map.isValid ? readFallback(body, map.isValid) : undefined;
	const notes: string[] = [];
	if (isValid === false || isValid === "false") notes.push(INSUFFICIENT_NOTE);
	const extra = map.extra ? renderExtraTemplate(map.extra, body).trim() : "";
	if (extra) notes.push(extra);
	const note = notes.length > 0 ? notes.join(NOTE_SEPARATOR) : undefined;

	if (map.breakdown?.path) return applyBreakdown(template, body, scale, note);

	const unit = toText(readFallback(body, map.unit)) ?? template.unit;
	const remaining = toNumber(readFallback(body, map.remaining));
	const used = toNumber(readFallback(body, map.used));
	const limit = toNumber(readFallback(body, map.limit));
	if (remaining === undefined && used === undefined && limit === undefined) {
		return { status: "failed", error: `模板映射未解析出余额字段（map.remaining=${map.remaining ?? "未配置"}）` };
	}
	return {
		status: "ok",
		unit,
		balance: remaining === undefined ? undefined : remaining / scale,
		quota: {
			used: used === undefined ? undefined : used / scale,
			limit: limit === undefined ? undefined : limit / scale,
			remaining: remaining === undefined ? undefined : remaining / scale,
			unit,
		},
		scope: toText(readFallback(body, map.planName)),
		note,
	};
}
