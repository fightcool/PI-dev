/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/account-template.ts,
 *   ../../server/dev-con/account-template-schema.ts, ../../server/dev-con/account-template-presets.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §7（余额/配额：带单位与状态）与 §8 P3（账户查询）
 * 覆盖：JSON 路径（含数组下标）、?? 回退链、extra 插值、invalidWhen、请求头合并、
 *       单对象与多币种数组、缩放与单位、isValid 语义、缺字段必须失败（绝不把缺失当 0）、
 *       旧平铺配置迁移后行为等价、双花括号占位符的中文提示、预设可解析真实响应体。
 */
import { describe, expect, it } from "vitest";
import {
	applyAccountTemplate,
	buildTemplateHeaders,
	describeTemplateProblem,
	isSafeHeaderValue,
	readFallback,
	readPath,
	renderExtraTemplate,
	renderTemplateText,
	toNumber,
	type AccountTemplate,
} from "../../server/dev-con/account-template.js";
import {
	accountTemplateOf,
	migrateAccountTemplate,
	redactTemplateForEcho,
	validateAccountTemplate,
} from "../../server/dev-con/account-template-schema.js";
import { ACCOUNT_TEMPLATE_PRESETS } from "../../server/dev-con/account-template-presets.js";
import type { ChannelRecord } from "../../server/dev-con/channel-model.js";

const channelWith = (account: unknown): ChannelRecord => ({
	id: "ch-1",
	displayName: "渠道",
	providerId: "p",
	endpointId: "default",
	credentialRef: null,
	accountRef: null,
	models: [],
	enabled: true,
	extra: { account },
});

/** 模板构造糖：只写关心的字段。 */
const tpl = (patch: Partial<AccountTemplate> & { map: AccountTemplate["map"] }): AccountTemplate => ({
	kind: "template",
	request: { url: "https://x", method: "GET", ...patch.request },
	...patch,
});

/** UU api 的真实响应体（2026 实测）。 */
const uuBody = {
	balance: 47.9,
	remaining: 47.9,
	unit: "USD",
	planName: "钱包余额",
	isValid: true,
	usage: { today: { cost: 1.67, actual_cost: 1.34, requests: 23 }, total: { actual_cost: 51.21, requests: 439 } },
};

describe("template path + value parsing", () => {
	it("reads dotted paths with array indexes and never invents values", () => {
		const body = { data: { list: [{ quota: "10.50" }, { quota: 2 }] }, is_available: false };
		expect(readPath(body, "data.list[0].quota")).toBe("10.50");
		expect(readPath(body, "data.list[1].quota")).toBe(2);
		expect(readPath(body, "data.missing.quota")).toBeUndefined();
		expect(readPath(body, "data.list[9].quota")).toBeUndefined();
		expect(readPath(body, undefined)).toBeUndefined();
		expect(toNumber("3.50")).toBe(3.5);
		expect(toNumber("")).toBeUndefined();
		expect(toNumber(null)).toBeUndefined();
		expect(toNumber("abc")).toBeUndefined();
	});

	it("renders {baseUrl}/{apiKey} placeholders", () => {
		expect(renderTemplateText("{baseUrl}/api/user/self?k={apiKey}", { baseUrl: "https://gw", apiKey: "secret" })).toBe(
			"https://gw/api/user/self?k=secret",
		);
	});

	it("walks a `??` fallback chain and treats null/empty as missing", () => {
		expect(readFallback({ remaining: 5, balance: 9 }, "remaining ?? balance")).toBe(5);
		expect(readFallback({ balance: 9 }, "remaining ?? balance")).toBe(9);
		expect(readFallback({ remaining: null, balance: 9 }, "remaining ?? balance")).toBe(9);
		expect(readFallback({ remaining: "", balance: 9 }, "remaining ?? balance")).toBe(9);
		// 0 是真值（余额 0 与「没有这个字段」完全不同）：回退链不能跳过它。
		expect(readFallback({ remaining: 0, balance: 9 }, "remaining ?? balance")).toBe(0);
		expect(readFallback({ a: { b: [{ c: 3 }] } }, "nope ?? a.b[0].c")).toBe(3);
		expect(readFallback({}, "a ?? b")).toBeUndefined();
		expect(readFallback({ a: 1 }, undefined)).toBeUndefined();
	});
});

describe("extra note interpolation", () => {
	it("keeps 2 decimals for fractional numbers, plain integers, and — for missing paths", () => {
		expect(renderExtraTemplate("今日 ${usage.today.cost} USD（${usage.today.requests} 次）", uuBody)).toBe(
			"今日 1.67 USD（23 次）",
		);
		expect(renderExtraTemplate("${usage.total.actual_cost} / ${nope.deep}", uuBody)).toBe("51.21 / —");
		// 字符串字段原样、回退链同样生效。
		expect(renderExtraTemplate("${nope ?? planName}", uuBody)).toBe("钱包余额");
		expect(renderExtraTemplate("${a}", { a: 3.14159 })).toBe("3.14");
	});
});

describe("invalidWhen", () => {
	const withRule = (rule: AccountTemplate["invalidWhen"]): AccountTemplate =>
		tpl({ map: { remaining: "balance" }, invalidWhen: rule });

	it("fails before mapping when a value equals the configured marker (case-insensitive strings)", () => {
		const result = applyAccountTemplate(withRule({ path: "status", equals: "INVALID", messagePath: "message" }), {
			status: "invalid",
			message: "密钥已被禁用",
			balance: 10,
		});
		expect(result).toEqual({ status: "failed", error: "密钥已被禁用" });
		// 数字与布尔按值比较。
		expect(applyAccountTemplate(withRule({ path: "code", equals: 401 }), { code: 401 })).toMatchObject({
			status: "failed",
		});
		expect(applyAccountTemplate(withRule({ path: "ok", equals: false }), { ok: false })).toMatchObject({
			status: "failed",
		});
		// 不相等 → 正常映射。
		expect(
			applyAccountTemplate(withRule({ path: "status", equals: "invalid" }), { status: "ok", balance: 10 }),
		).toMatchObject({ status: "ok", balance: 10 });
	});

	it("uses exists:true and falls back to a fixed Chinese message when messagePath resolves nothing", () => {
		expect(
			applyAccountTemplate(withRule({ path: "code", exists: true, messagePath: "message" }), {
				code: "AUTH_FAILED",
				message: "key 无效",
			}),
		).toEqual({ status: "failed", error: "key 无效" });
		expect(
			applyAccountTemplate(withRule({ path: "code", exists: true, messagePath: "message" }), { code: "AUTH_FAILED" }),
		).toEqual({ status: "failed", error: "鉴权失败：接口返回该密钥无效" });
		// 路径为空串 / 不存在 → 不命中。
		expect(applyAccountTemplate(withRule({ path: "code", exists: true }), { code: "", balance: 7 })).toMatchObject({
			status: "ok",
			balance: 7,
		});
		expect(applyAccountTemplate(withRule({ path: "code", exists: true }), { balance: 7 })).toMatchObject({
			status: "ok",
			balance: 7,
		});
	});
});

describe("request headers", () => {
	it("merges explicit headers over the defaults, lowercases keys and renders placeholders", () => {
		const headers = buildTemplateHeaders(
			tpl({
				request: {
					url: "https://x",
					method: "POST",
					headers: { "X-Api-Key": "{apiKey}", Accept: "application/vnd+json", "X-Base": "{baseUrl}" },
				},
				map: { remaining: "b" },
			}),
			{ baseUrl: "https://gw", apiKey: "sk-secret" },
		);
		expect(headers).toEqual({
			"x-api-key": "sk-secret",
			accept: "application/vnd+json",
			"x-base": "https://gw",
			authorization: "Bearer sk-secret",
			"content-type": "application/json",
		});
		// 显式 authorization 不被默认值覆盖；GET 不带 content-type。
		expect(
			buildTemplateHeaders(
				tpl({ request: { url: "https://x", headers: { authorization: "Token {apiKey}" } }, map: { remaining: "b" } }),
				{ baseUrl: "", apiKey: "k" },
			),
		).toEqual({ authorization: "Token k", accept: "application/json" });
		// 空串 = 明确不带该头（有些供应商把 key 放 query 里）。
		expect(
			buildTemplateHeaders(
				tpl({ request: { url: "https://x", headers: { authorization: "" } }, map: { remaining: "b" } }),
				{ baseUrl: "", apiKey: "k" },
			),
		).toEqual({ accept: "application/json" });
	});

	it("classifies header values as placeholder-safe or literal secrets", () => {
		expect(isSafeHeaderValue("Bearer {apiKey}")).toBe(true);
		expect(isSafeHeaderValue("application/json")).toBe(true);
		expect(isSafeHeaderValue("Bearer sk-0123456789abcdef")).toBe(false);
		expect(isSafeHeaderValue("0123456789abcdefghij")).toBe(false);
	});
});

describe("applyAccountTemplate", () => {
	it("maps a DeepSeek-shaped payload (multi-currency array, string amounts)", () => {
		const result = applyAccountTemplate(
			tpl({
				map: {
					isValid: "is_available",
					breakdown: {
						path: "balance_infos",
						currency: "currency",
						total: "total_balance",
						granted: "granted_balance",
						toppedUp: "topped_up_balance",
					},
				},
			}),
			{
				is_available: false,
				balance_infos: [
					{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
				],
			},
		);
		expect(result).toMatchObject({ status: "ok", unit: "CNY", balance: 110, note: "接口标注：余额不足以继续调用" });
		expect(result.breakdown).toEqual([{ currency: "CNY", total: 110, granted: 10, toppedUp: 100 }]);
	});

	it("maps a gateway-shaped payload with scale and unit", () => {
		const result = applyAccountTemplate(
			tpl({
				map: { limit: "data.quota", used: "data.used_quota", remaining: "data.quota", planName: "data.display_name" },
				scale: 500000,
				unit: "USD",
			}),
			{ data: { quota: 5_000_000, used_quota: 1_000_000, display_name: "acc" } },
		);
		expect(result).toMatchObject({ status: "ok", unit: "USD", balance: 10, scope: "acc" });
		expect(result.quota).toEqual({ used: 2, limit: 10, remaining: 10, unit: "USD" });
	});

	it("fails honestly when the mapping resolves nothing (missing != 0)", () => {
		expect(applyAccountTemplate(tpl({ map: { remaining: "nope" } }), {})).toMatchObject({ status: "failed" });
		expect(
			applyAccountTemplate(tpl({ map: { breakdown: { path: "list", total: "total_balance" } } }), {
				list: [{ currency: "CNY" }],
			}),
		).toMatchObject({ status: "failed" });
		expect(
			applyAccountTemplate(tpl({ map: { breakdown: { path: "list", total: "v" } } }), { list: "not-an-array" }),
		).toMatchObject({ status: "failed" });
	});

	it("prefers the configured unit among multiple currency entries", () => {
		const result = applyAccountTemplate(
			tpl({ unit: "CNY", map: { breakdown: { path: "infos", currency: "currency", total: "total" } } }),
			{
				infos: [
					{ currency: "USD", total: 3 },
					{ currency: "CNY", total: 25 },
				],
			},
		);
		expect(result).toMatchObject({ unit: "CNY", balance: 25 });
		expect(result.breakdown?.map((entry) => entry.currency)).toEqual(["USD", "CNY"]);
	});

	it("joins the isValid warning and the extra note with the existing hint first", () => {
		const result = applyAccountTemplate(
			tpl({ map: { isValid: "isValid", remaining: "remaining ?? balance", extra: "累计 ${usage.total.requests} 次" } }),
			{ ...uuBody, isValid: false },
		);
		expect(result.note).toBe("接口标注：余额不足以继续调用 · 累计 439 次");
	});

	it("recognizes only real templates (kind=template or a request/map) with a URL", () => {
		expect(
			accountTemplateOf(channelWith({ kind: "template", request: { url: "https://x" }, map: { remaining: "b" } })),
		).not.toBeNull();
		expect(accountTemplateOf(channelWith({ kind: "template", map: { remaining: "b" } }))).toBeNull();
		expect(accountTemplateOf(channelWith({ kind: "deepseek" }))).toBeNull();
		expect(accountTemplateOf(channelWith(null))).toBeNull();
	});
});

describe("legacy template migration", () => {
	it("migrates the legacy DeepSeek items config into map.breakdown with identical behaviour", () => {
		const legacy = {
			kind: "template",
			url: "https://api.deepseek.com/user/balance",
			method: "GET",
			apiKeyHeader: "authorization",
			apiKeyPrefix: "Bearer ",
			items: {
				path: "balance_infos",
				currency: "currency",
				total: "total_balance",
				granted: "granted_balance",
				toppedUp: "topped_up_balance",
			},
			mapping: { available: "is_available" },
		};
		const migrated = migrateAccountTemplate(legacy);
		expect(migrated).toMatchObject({
			kind: "template",
			request: {
				url: "https://api.deepseek.com/user/balance",
				method: "GET",
				headers: { authorization: "Bearer {apiKey}" },
			},
			map: {
				isValid: "is_available",
				breakdown: { path: "balance_infos", currency: "currency", total: "total_balance" },
			},
		});
		const result = applyAccountTemplate(migrated as AccountTemplate, {
			is_available: false,
			balance_infos: [
				{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
			],
		});
		expect(result).toMatchObject({ status: "ok", unit: "CNY", balance: 110, note: "接口标注：余额不足以继续调用" });
		expect(result.breakdown).toEqual([{ currency: "CNY", total: 110, granted: 10, toppedUp: 100 }]);
	});

	it("migrates the legacy OpenRouter mapping (limit/used/remaining + currency/scope/available)", () => {
		const migrated = migrateAccountTemplate({
			kind: "template",
			url: "https://openrouter.ai/api/v1/credits",
			mapping: {
				limit: "data.total_credits",
				used: "data.total_usage",
				remaining: "data.total_credits",
				currency: "data.unit",
				scope: "data.label",
				available: "data.ok",
			},
			unit: "USD",
			scale: 2,
			topupUrl: "https://openrouter.ai/settings/credits",
			credentialKeyName: "控制台令牌",
		});
		expect(migrated).toMatchObject({
			map: {
				limit: "data.total_credits",
				used: "data.total_usage",
				remaining: "data.total_credits",
				unit: "data.unit",
				planName: "data.label",
				isValid: "data.ok",
			},
			unit: "USD",
			scale: 2,
			topupUrl: "https://openrouter.ai/settings/credits",
			credentialKeyName: "控制台令牌",
		});
		expect(
			applyAccountTemplate(
				migrateAccountTemplate({
					kind: "template",
					url: "https://x",
					mapping: { limit: "data.total_credits", used: "data.total_usage", remaining: "data.total_credits" },
					unit: "USD",
				}) as AccountTemplate,
				{ data: { total_credits: 20, total_usage: 5 } },
			),
		).toMatchObject({
			status: "ok",
			unit: "USD",
			balance: 20,
			quota: { used: 5, limit: 20, remaining: 20, unit: "USD" },
		});
	});

	it("keeps mapping.balance reachable through a `??` chain (legacy balance/remaining pair)", () => {
		const migrated = migrateAccountTemplate({
			kind: "template",
			url: "https://x",
			mapping: { balance: "balance", remaining: "remaining" },
		});
		expect(migrated?.map.remaining).toBe("remaining ?? balance");
		expect(applyAccountTemplate(migrated as AccountTemplate, { balance: 7 })).toMatchObject({ balance: 7 });
		expect(applyAccountTemplate(migrated as AccountTemplate, { balance: 7, remaining: 3 })).toMatchObject({
			balance: 3,
		});
		// apiKeyPrefix="" 是「不加前缀」，不填才是 "Bearer "。
		expect(
			migrateAccountTemplate({ url: "https://x", apiKeyHeader: "X-Key", apiKeyPrefix: "", mapping: { balance: "b" } })
				?.request.headers,
		).toEqual({ "x-key": "{apiKey}" });
		expect(migrateAccountTemplate({ mapping: { balance: "b" } })).toBeNull();
	});

	it("migrates on read so a stored legacy config still resolves at runtime", () => {
		const template = accountTemplateOf(
			channelWith({
				kind: "template",
				url: "https://openrouter.ai/api/v1/credits",
				mapping: { limit: "data.total_credits", used: "data.total_usage" },
				unit: "USD",
			}),
		);
		expect(template).toMatchObject({
			request: { url: "https://openrouter.ai/api/v1/credits" },
			map: { limit: "data.total_credits" },
		});
		expect(template?.map).not.toHaveProperty("mapping");
	});
});

describe("template validation", () => {
	it("explains the double-brace placeholder trap in Chinese", () => {
		expect(describeTemplateProblem("{{baseUrl}}/usage")).toBe("占位符请用单花括号 {baseUrl}");
		expect(describeTemplateProblem("https://x?k={{apiKey}}")).toBe("占位符请用单花括号 {apiKey}");
		expect(describeTemplateProblem("{baseUrl}/v1/usage")).toBeNull();
		// 用户线上那份配置（照抄 cc-switch）：迁移后校验必须点出括号问题。
		const live = {
			kind: "template",
			url: "{{baseUrl}}/usage",
			apiKeyHeader: "authorization",
			apiKeyPrefix: "Bearer ",
			unit: "USD",
		};
		const migrated = migrateAccountTemplate(live);
		expect(migrated?.request.url).toBe("{{baseUrl}}/usage");
		const verdict = validateAccountTemplate(live);
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.error).toContain("占位符请用单花括号 {baseUrl}");
	});

	it("rejects unusable templates with user-facing Chinese errors", () => {
		expect(validateAccountTemplate("nope")).toMatchObject({ ok: false });
		expect(validateAccountTemplate({ kind: "template", map: { remaining: "b" } })).toMatchObject({
			ok: false,
			error: "模板缺少请求地址 request.url",
		});
		expect(
			validateAccountTemplate({ kind: "template", request: { url: "ftp://x" }, map: { remaining: "b" } }),
		).toMatchObject({ ok: false, error: expect.stringContaining("http(s)") });
		expect(validateAccountTemplate({ kind: "template", request: { url: "https://x" }, map: {} })).toMatchObject({
			ok: false,
			error: expect.stringContaining("map.remaining"),
		});
		expect(
			validateAccountTemplate({
				kind: "template",
				request: { url: "https://x", method: "POST", body: "{oops" },
				map: { remaining: "b" },
			}),
		).toMatchObject({ ok: false, error: expect.stringContaining("合法 JSON") });
		expect(
			validateAccountTemplate({
				kind: "template",
				request: { url: "https://x", headers: { authorization: "Bearer sk-0123456789abcdef" } },
				map: { remaining: "b" },
			}),
		).toMatchObject({ ok: false, error: expect.stringContaining("{apiKey}") });
		expect(
			validateAccountTemplate({
				kind: "template",
				request: { url: "https://x" },
				map: { remaining: "b" },
				invalidWhen: { path: "code" },
			}),
		).toMatchObject({ ok: false, error: expect.stringContaining("invalidWhen") });
		expect(
			validateAccountTemplate({ kind: "template", request: { url: "https://x" }, map: { remaining: "b" }, scale: 0 }),
		).toMatchObject({ ok: false, error: expect.stringContaining("scale") });
		expect(validateAccountTemplate({ kind: "openai-gateway", url: "{baseUrl}" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("内置查询方式"),
		});
	});

	it("accepts every built-in template preset and the legacy shapes", () => {
		for (const preset of ACCOUNT_TEMPLATE_PRESETS) {
			if (preset.template.kind !== "template") continue;
			expect(validateAccountTemplate(preset.template), preset.id).toMatchObject({ ok: true });
		}
		expect(validateAccountTemplate({ kind: "template", url: "https://x", mapping: { balance: "b" } })).toMatchObject({
			ok: true,
		});
	});

	it("echoes placeholder auth headers but never a literal secret", () => {
		// @BUGFIX 按键名剔除会把 `x-api-key: {apiKey}`（Anthropic 风格）整条丢掉：用户一保存就丢鉴权头。
		const withApiKeyHeader = redactTemplateForEcho({
			kind: "template",
			request: { url: "{baseUrl}/v1/messages", headers: { "x-api-key": "{apiKey}", "anthropic-version": "2023-06-01" } },
		}) as { request: { headers: Record<string, unknown> } };
		expect(withApiKeyHeader.request.headers).toEqual({ "x-api-key": "{apiKey}", "anthropic-version": "2023-06-01" });
		// 明文密钥值：键名保留（用户知道这里要重填），值抹成 null。
		const withLiteral = redactTemplateForEcho({
			request: { headers: { "x-api-key": "sk-0123456789abcdef0123" } },
		}) as { request: { headers: Record<string, unknown> } };
		expect(withLiteral.request.headers["x-api-key"]).toBeNull();
		expect(JSON.stringify(withLiteral)).not.toContain("sk-0123456789abcdef0123");
	});

	it("echoes the whole template but drops any key-shaped field", () => {
		const echoed = redactTemplateForEcho({
			kind: "template",
			request: { url: "{baseUrl}/v1/usage", headers: { authorization: "Bearer {apiKey}" } },
			map: { remaining: "remaining ?? balance" },
			credentialKeyName: "控制台令牌",
			apiKey: "sk-leak",
			nested: { token: "t", keep: 1 },
		}) as Record<string, unknown>;
		expect(echoed).toEqual({
			kind: "template",
			request: { url: "{baseUrl}/v1/usage", headers: { authorization: "Bearer {apiKey}" } },
			map: { remaining: "remaining ?? balance" },
			credentialKeyName: "控制台令牌",
			nested: { keep: 1 },
		});
		expect(JSON.stringify(echoed)).not.toContain("sk-leak");
	});
});

describe("built-in presets", () => {
	it("ships DeepSeek / gateway / OpenRouter / UU api presets that actually parse a representative payload", () => {
		const ids = ACCOUNT_TEMPLATE_PRESETS.map((preset) => preset.id);
		expect(ids).toEqual(["deepseek", "openai-gateway", "openrouter", "uu-api"]);
		const deepseek = ACCOUNT_TEMPLATE_PRESETS[0].template as AccountTemplate;
		expect(
			applyAccountTemplate(deepseek, {
				is_available: true,
				balance_infos: [{ currency: "CNY", total_balance: "1.00" }],
			}),
		).toMatchObject({ status: "ok", unit: "CNY", balance: 1 });
		// 网关预设指向**内置适配器**（不是模板）：模型 key 打不了 /api/user/self 时它会自动退回
		// OpenAI 兼容账单接口（见 channel-accounts.ts 的 queryOpenAiBilling），模板做不到这一点。
		expect(ACCOUNT_TEMPLATE_PRESETS[1].template).toMatchObject({
			kind: "openai-gateway",
			url: "{baseUrl}",
			scale: 500000,
			unit: "USD",
		});
		const openrouter = ACCOUNT_TEMPLATE_PRESETS[2].template as AccountTemplate;
		expect(applyAccountTemplate(openrouter, { data: { total_credits: 20, total_usage: 5 } })).toMatchObject({
			status: "ok",
			unit: "USD",
			balance: 20,
		});
	});

	it("maps the real UU api /v1/usage payload (balance 47.9 / used 51.21 / USD / 钱包余额)", () => {
		const uu = ACCOUNT_TEMPLATE_PRESETS[3].template as AccountTemplate;
		expect(uu.request.url).toBe("{baseUrl}/v1/usage");
		const result = applyAccountTemplate(uu, uuBody);
		expect(result).toMatchObject({ status: "ok", unit: "USD", balance: 47.9, scope: "钱包余额" });
		expect(result.quota).toMatchObject({ used: 51.21, remaining: 47.9, unit: "USD" });
		expect(result.note).toBe("今日 1.67 USD（23 次）· 累计 439 次");
		// invalidWhen 命中（该服务商用 code/message 报无效密钥）→ 直接失败，不映射余额。
		expect(applyAccountTemplate(uu, { code: "invalid_api_key", message: "API key 无效" })).toEqual({
			status: "failed",
			error: "API key 无效",
		});
		expect(applyAccountTemplate(uu, { code: 401 })).toEqual({
			status: "failed",
			error: "鉴权失败：接口返回该密钥无效",
		});
		// balance 缺失时回退链取 balance（remaining 不在响应里也能出数）。
		expect(
			applyAccountTemplate(uu, { balance: 12.5, unit: "USD", usage: { total: { actual_cost: 1 } } }),
		).toMatchObject({ balance: 12.5 });
	});
});
