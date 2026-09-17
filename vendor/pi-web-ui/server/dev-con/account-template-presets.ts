/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED account-template.ts（模板结构）, channel-accounts.ts（预设下发 + 内置适配器）,
 *            ../protocol.ts（channel_state.accountPresets）, web/src/components/ChannelAccountQuery.tsx
 *   @CONTRACT 预设只是「一键填充」的初始 JSON，用户可继续改；预设本身不含任何密钥。
 *   @GOTCHA openai-gateway 预设指向**内置探测型适配器**（kind 不是 template）：它会依次探账单接口
 *          与 /api/user/self，模板打一个地址做不到这件事，所以它不能被改写成模板。
 * ──────────────────────────────────────────────────
 */
import type { AccountTemplate } from "./account-template.js";

/** 预设条目：template 可以是模板，也可以指向内置适配器（kind ≠ template）。 */
export interface AccountTemplatePreset {
	id: string;
	label: string;
	description: string;
	template:
		| (Omit<AccountTemplate, "kind"> & { kind: "template" })
		| { kind: "openai-gateway"; url: string; method?: "GET"; scale?: number; unit?: string; topupUrl?: string };
}

/** 内置预设：一键填充到模板编辑器（用户可继续改 URL/字段，不再是写死的适配器）。 */
export const ACCOUNT_TEMPLATE_PRESETS: AccountTemplatePreset[] = [
	{
		id: "deepseek",
		label: "DeepSeek 官方",
		description: "GET https://api.deepseek.com/user/balance（Bearer）→ balance_infos[] 多币种",
		template: {
			kind: "template",
			request: { url: "https://api.deepseek.com/user/balance", method: "GET" },
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
			topupUrl: "https://platform.deepseek.com/top_up",
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
			topupUrl: "{baseUrl}/console/topup",
		},
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		description: "GET https://openrouter.ai/api/v1/credits（Bearer）→ data.total_credits / data.total_usage",
		template: {
			kind: "template",
			request: { url: "https://openrouter.ai/api/v1/credits", method: "GET" },
			map: { limit: "data.total_credits", used: "data.total_usage", remaining: "data.total_credits" },
			unit: "USD",
			topupUrl: "https://openrouter.ai/settings/credits",
		},
	},
	{
		id: "uu-api",
		label: "UU api",
		// @GOTCHA 该服务商注册的 baseUrl 是 https://uuapi.io（不含 /v1），所以模板自己带 /v1/usage；
		//   占位符是**单花括号** {baseUrl}（cc-switch 的 {{baseUrl}} 会渲染成 `{https://uuapi.io}/...`）。
		description: "GET {baseUrl}/v1/usage（Bearer）→ balance / usage.total.actual_cost",
		template: {
			kind: "template",
			request: { url: "{baseUrl}/v1/usage", method: "GET" },
			map: {
				isValid: "isValid",
				remaining: "remaining ?? balance",
				used: "usage.total.actual_cost",
				unit: "unit",
				planName: "planName",
				extra: "今日 ${usage.today.cost} USD（${usage.today.requests} 次）· 累计 ${usage.total.requests} 次",
			},
			invalidWhen: { path: "code", exists: true, messagePath: "message" },
			unit: "USD",
			topupUrl: "https://uuapi.io/console/topup",
		},
	},
];
