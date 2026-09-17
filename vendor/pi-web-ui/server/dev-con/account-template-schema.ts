/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED account-template.ts（模板结构与映射语义）, channel-accounts.ts（accountTemplateOf 唯一入口）,
 *            channel-state.ts（redactTemplateForEcho 回显）, channel-model.ts（写盘密钥闸）,
 *            web/src/components/ChannelAccountQuery.tsx（仍提交旧平铺结构 → 这里迁移）
 *   @CONTRACT 磁盘/前端可能是**旧平铺结构**，运行时只有**新结构**一套语义：
 *             accountTemplateOf 先试新结构，再 migrateAccountTemplate，返回值永远是新结构。
 *   @WHY 「两套语义并存」是这类配置最贵的坑（同一份配置在不同代码路径解释不同）。
 *        所以迁移集中在唯一读取入口，只发生一次，不落盘、不改写用户配置。
 *   @GOTCHA 校验错误文案会**直接显示给用户**：必须中文、说清哪个字段、怎么改。
 * ──────────────────────────────────────────────────
 */
import {
	describeTemplateProblem,
	looksLikeLiteralSecret,
	type AccountTemplate,
	type AccountTemplateBreakdownMap,
	type AccountTemplateInvalidWhen,
	type AccountTemplateMap,
} from "./account-template.js";
import type { ChannelRecord } from "./channel-model.js";

/** 旧平铺结构（磁盘上的历史配置 + 当前前端提交的形状）。 */
interface LegacyAccountTemplate {
	kind?: string;
	url?: string;
	method?: string;
	apiKeyHeader?: string;
	apiKeyPrefix?: string;
	body?: string;
	mapping?: Record<string, unknown>;
	items?: Record<string, unknown>;
	unit?: string;
	scale?: number;
	topupUrl?: string;
	credentialKeyName?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** 新结构特征：有 request 或 map（旧结构是 url/mapping/items 平铺）。 */
function looksLikeNewShape(raw: Record<string, unknown>): boolean {
	return isObject(raw.request) || isObject(raw.map);
}

/**
 * 旧结构 → 新结构（一次性迁移，供读取渠道目录时使用；不落盘）。
 * 迁移规则见 @CONTRACT：mapping.balance/remaining → map.remaining（保持 `?? ` 回退语义等价）、
 * mapping.used/limit → map.used/limit、mapping.currency → map.unit、mapping.scope → map.planName、
 * mapping.available → map.isValid、items → map.breakdown、apiKeyHeader/apiKeyPrefix → request.headers 的鉴权头。
 */
export function migrateAccountTemplate(raw: unknown): AccountTemplate | null {
	if (!isObject(raw)) return null;
	const old = raw as LegacyAccountTemplate;
	const url = typeof old.url === "string" ? old.url : "";
	if (!url.trim()) return null;
	const mapping = isObject(old.mapping) ? old.mapping : {};
	const items = isObject(old.items) ? old.items : undefined;
	const map: AccountTemplateMap = {};
	// 旧语义：balance = balance ?? remaining，最终展示 remaining ?? balance —— 合成一条回退链即等价。
	const remainingChain = [text(mapping.remaining), text(mapping.balance)].filter(Boolean).join(" ?? ");
	if (remainingChain) map.remaining = remainingChain;
	const carry: [keyof AccountTemplateMap, unknown][] = [
		["used", mapping.used],
		["limit", mapping.limit],
		["unit", mapping.currency],
		["planName", mapping.scope],
		["isValid", mapping.available],
	];
	for (const [key, value] of carry) {
		const path = text(value);
		if (path) map[key] = path as never;
	}
	if (items && text(items.path)) {
		const breakdown: AccountTemplateBreakdownMap = { path: text(items.path) as string };
		for (const key of ["currency", "total", "granted", "toppedUp"] as const) {
			const path = text(items[key]);
			if (path) breakdown[key] = path;
		}
		map.breakdown = breakdown;
	}
	const headerName = (text(old.apiKeyHeader) ?? "authorization").toLowerCase();
	// prefix 的 "" 与「不填」语义不同：不填 = "Bearer "，空串 = 不加前缀（旧字段契约）。
	const prefix = typeof old.apiKeyPrefix === "string" ? old.apiKeyPrefix : "Bearer ";
	const template: AccountTemplate = {
		kind: "template",
		request: {
			url,
			method: old.method === "POST" ? "POST" : "GET",
			headers: { [headerName]: `${prefix}{apiKey}` },
			...(typeof old.body === "string" && old.body.trim() ? { body: old.body } : {}),
		},
		map,
	};
	if (text(old.unit)) template.unit = text(old.unit);
	if (typeof old.scale === "number" && old.scale > 0) template.scale = old.scale;
	if (text(old.topupUrl)) template.topupUrl = text(old.topupUrl);
	if (text(old.credentialKeyName)) template.credentialKeyName = text(old.credentialKeyName);
	return template;
}

/** 归一化新结构（只取认识的键，值类型不对就丢弃 —— 坏值不该悄悄变成别的语义）。 */
function normalizeNewShape(raw: Record<string, unknown>): AccountTemplate {
	const req = isObject(raw.request) ? raw.request : {};
	const rawMap = isObject(raw.map) ? raw.map : {};
	const map: AccountTemplateMap = {};
	for (const key of ["isValid", "remaining", "used", "limit", "unit", "planName", "extra"] as const) {
		const value = rawMap[key];
		if (typeof value === "string" && value.trim()) map[key] = value.trim();
	}
	if (isObject(rawMap.breakdown) && text(rawMap.breakdown.path)) {
		const spec = rawMap.breakdown;
		const breakdown: AccountTemplateBreakdownMap = { path: text(spec.path) as string };
		for (const key of ["currency", "total", "granted", "toppedUp"] as const) {
			const path = text(spec[key]);
			if (path) breakdown[key] = path;
		}
		map.breakdown = breakdown;
	}
	const headers: Record<string, string> = {};
	if (isObject(req.headers)) {
		for (const [key, value] of Object.entries(req.headers)) {
			if (typeof value === "string" && key.trim()) headers[key.trim().toLowerCase()] = value;
		}
	}
	const out: AccountTemplate = {
		kind: "template",
		request: {
			url: typeof req.url === "string" ? req.url.trim() : "",
			method: req.method === "POST" ? "POST" : "GET",
			...(Object.keys(headers).length > 0 ? { headers } : {}),
			...(typeof req.body === "string" && req.body.trim() ? { body: req.body } : {}),
		},
		map,
	};
	if (isObject(raw.invalidWhen) && text(raw.invalidWhen.path)) {
		const rule = raw.invalidWhen;
		const invalidWhen: AccountTemplateInvalidWhen = { path: text(rule.path) as string };
		if (typeof rule.equals === "string" || typeof rule.equals === "number" || typeof rule.equals === "boolean")
			invalidWhen.equals = rule.equals;
		if (rule.exists === true) invalidWhen.exists = true;
		if (text(rule.messagePath)) invalidWhen.messagePath = text(rule.messagePath);
		out.invalidWhen = invalidWhen;
	}
	if (text(raw.unit)) out.unit = text(raw.unit);
	if (typeof raw.scale === "number" && raw.scale > 0) out.scale = raw.scale;
	if (text(raw.topupUrl)) out.topupUrl = text(raw.topupUrl);
	if (text(raw.credentialKeyName)) out.credentialKeyName = text(raw.credentialKeyName);
	return out;
}

/** 内置适配器的 kind（它们不是模板：自带探测/回退逻辑，见 channel-accounts.ts）。 */
const BUILT_IN_KINDS = new Set(["openai-gateway", "deepseek", "openrouter"]);

/**
 * 校验一份账户模板（前端先本地 JSON.parse，服务端用本函数给出可直接展示的中文错误）。
 * 旧平铺结构会先迁移再校验，因此老配置与新配置走同一套判定。
 */
export function validateAccountTemplate(
	raw: unknown,
): { ok: true; template: AccountTemplate } | { ok: false; error: string } {
	if (!isObject(raw)) return { ok: false, error: "账户模板必须是一个 JSON 对象" };
	const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
	if (kind && kind !== "template") {
		return {
			ok: false,
			error: BUILT_IN_KINDS.has(kind)
				? `「${kind}」是内置查询方式，不是模板，无需填写模板字段`
				: `账户模板的 kind 必须是 template（当前：${kind}）`,
		};
	}
	const template = looksLikeNewShape(raw) ? normalizeNewShape(raw) : migrateAccountTemplate(raw);
	if (!template) return { ok: false, error: "模板缺少请求地址 request.url" };
	const url = template.request.url;
	if (!url) return { ok: false, error: "模板缺少请求地址 request.url" };
	const placeholderProblem = describeTemplateProblem(url);
	if (placeholderProblem) return { ok: false, error: `${placeholderProblem}（当前：${url}）` };
	if (!/^https?:\/\//i.test(url) && !url.includes("{baseUrl}")) {
		return { ok: false, error: `请求地址必须是 http(s)，也可用 {baseUrl} 占位（当前：${url}）` };
	}
	for (const [key, value] of Object.entries(template.request.headers ?? {})) {
		const headerProblem = describeTemplateProblem(value);
		if (headerProblem) return { ok: false, error: `请求头「${key}」的${headerProblem}` };
		if (looksLikeLiteralSecret(value))
			return { ok: false, error: `请求头「${key}」里不要写明文密钥，请用 {apiKey} 占位` };
	}
	if (template.request.body) {
		try {
			JSON.parse(template.request.body);
		} catch (err) {
			return { ok: false, error: `POST 请求体必须是合法 JSON：${(err as Error).message}` };
		}
	}
	const map = template.map;
	const hasField = Boolean(map.remaining || map.used || map.limit || map.breakdown?.path);
	if (!hasField)
		return {
			ok: false,
			error: "模板缺少字段映射：至少配置 map.remaining（或 map.used / map.limit / map.breakdown.path）",
		};
	if (template.invalidWhen && template.invalidWhen.equals === undefined && template.invalidWhen.exists !== true) {
		return { ok: false, error: "invalidWhen 需要给出 equals 或 exists: true" };
	}
	if (raw.scale !== undefined && !(typeof raw.scale === "number" && raw.scale > 0))
		return { ok: false, error: "scale 必须是大于 0 的数字" };
	if (template.topupUrl && !/^https?:\/\//i.test(template.topupUrl) && !template.topupUrl.includes("{baseUrl}")) {
		return { ok: false, error: `充值链接必须是 http(s) 地址（当前：${template.topupUrl}）` };
	}
	return { ok: true, template };
}

/**
 * 从渠道档案读出账户模板：新结构直接用，旧平铺结构现场迁移；返回值永远是新结构。
 * @CONTRACT 显式指定内置查询方式（deepseek / openai-gateway / openrouter）的渠道返回 null，
 *   由对应适配器处理；模板校验不通过也返回 null（由 templateAdapter 报可读错误前先看 kind）。
 */
export function accountTemplateOf(channel: ChannelRecord): AccountTemplate | null {
	const raw = channel.extra?.account;
	if (!isObject(raw)) return null;
	const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
	if (kind && kind !== "template") return null;
	const template = looksLikeNewShape(raw) ? normalizeNewShape(raw) : migrateAccountTemplate(raw);
	if (!template) return null;
	// kind 缺省时要求「像个模板」：有地址且有字段映射，否则不认（避免把无关 extra 当模板）。
	if (!template.request.url) return null;
	if (!kind && !(template.map.remaining || template.map.used || template.map.limit || template.map.breakdown?.path))
		return null;
	return template;
}

/** 回显时保留的「名字型」键：它是 provider-keys.json 里的**密钥名**，不是密钥值。 */
const ECHO_KEEP_KEYS = new Set(["credentialkeyname"]);
/** 键名含这些词的一律剔除（防线：模板本来就不该有密钥值，但回显是出网方向，宁可多剔）。 */
const ECHO_DROP_PATTERN = /key|token|secret|password/i;

/**
 * 模板回显清洗（channel_state 下发给浏览器）：结构原样保留，**值**疑似密钥的剔除。
 * @GOTCHA request.headers.authorization 的值是 `Bearer {apiKey}` 这类**占位符**，可以回显；
 *   真出现明文密钥的写入在 channel-model 的 findSecretMaterial 就被拒了（两道闸）。
 * @BUGFIX 原来按**键名**剔除（/key|token|secret|password/），于是 `x-api-key: {apiKey}`
 *   这种 Anthropic 风格鉴权头在回显时被整条丢掉 —— 用户一打开弹窗、一保存，鉴权头就没了，
 *   查询随即 401，而界面上完全看不出少了什么。键名不是密钥，**值**才是：占位符一律保留，
 *   只有 looksLikeLiteralSecret 认定的明文密钥值才抹成 null（前端会显示为 null，提示用户重填）。
 */
export function redactTemplateForEcho(value: unknown, inHeaders = false): unknown {
	if (Array.isArray(value)) return value.map((item) => redactTemplateForEcho(item, inHeaders));
	if (!isObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const lower = key.trim().toLowerCase();
		// 请求头里**键名永远保留**（键名是头名，不是密钥）；值为明文密钥时抹成 null，
		// 让用户看得见「这里有个头、值要重填」，而不是整条悄悄消失。
		if (inHeaders && typeof item === "string") {
			out[key] = looksLikeLiteralSecret(item) ? null : item;
			continue;
		}
		if (!ECHO_KEEP_KEYS.has(lower) && ECHO_DROP_PATTERN.test(lower)) continue;
		out[key] = redactTemplateForEcho(item, lower === "headers");
	}
	return out;
}
