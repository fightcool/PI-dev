/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED agent-service.ts (listModels 过滤退役路由), dsh/dsh-agent-service.ts
 *            (DEFAULT_MODEL / DSH_MODELS / 成本表), dsh/dsh-client.ts (launcher 默认模型),
 *            dsh/runtime/override.patch.yml (agent-default-model 与 llm-deepseek 目录),
 *            tests/unit/model-routing.test.ts
 *   📖 docs/MODEL-ROUTING.md（官方对齐记录、核对日期与 agent/models.json 覆盖块）
 *   @CONTRACT 纯逻辑模块：禁止 fs / 网络 / SDK 导入，便于 vitest 单测直接覆盖规格。
 *   @WHY 下面的常量只是**出厂默认**（官方核对于 verifiedAt）：实际生效的退役列表/别名由设置面板
 *        「模型路由规则」覆盖（settings.retiredModelRoutes / modelRouteAliases）——官方随时会
 *        改路由，操作者要能自己修正，不需要改代码重新发版。模型本身的名字/上下文/价格/思考档位
 *        不在这里，它们在 agent/models.json（「管理模型」面板可改）。
 *   @WHY 官方事实源只有一条 Flash 路由：2026-09-10 起 deepseek-flash = DeepSeek-V4.1-Flash。
 *        V4-Flash 与 V4-Flash-Vision-Exp 已退役（旧 id 仅作兼容转发），V4-Pro 正在退场；
 *        因此本系统只把 deepseek-flash 暴露为可选路由，旧 id 仍可解析（历史会话与既有渠道
 *        绑定不失效），但不再出现在选择器与 DSH 目录里。
 *   @ASSUME 官方按高峰/低谷分时计价，而 pi 与 DSH 的成本表都只能存一个单价；这里统一记录
 *        高峰列表价（低谷时段为其一半），估算不会低于实际扣费。
 */

/** 官方核对日期与事实来源。改模型信息时必须同时更新这里与 docs/MODEL-ROUTING.md。 */
export const OFFICIAL_ALIGNMENT = {
	verifiedAt: "2026-09-10",
	sources: [
		"https://api-docs.deepseek.com/news/news260910",
		"https://api-docs.deepseek.com/quick_start/pricing",
		"https://api-docs.deepseek.com/guides/vision",
		"https://api-docs.deepseek.com/guides/thinking_mode",
		"GET https://api.deepseek.com/models",
	],
} as const;

/** pi 引擎的服务商 id（内置 pi-ai 目录 + agent/models.json 覆盖层）。 */
export const DEEPSEEK_PROVIDER = "deepseek";
/** DSH 引擎的原生适配器路由 id（与 pi 目录刻意分开，可并存）。 */
export const DSH_DEEPSEEK_PROVIDER = "deepseek-official";

/**
 * 官方唯一在售 Flash 路由。字段全部来自官方文档（见 OFFICIAL_ALIGNMENT.sources）。
 * pi 引擎侧的模型定义以 agent/models.json 为准（「管理模型」面板可改）；这里是 **DSH 侧的出厂
 * 默认值**（DSH 没有 models.json 目录）与 dsh/runtime/override.patch.yml 的一致性来源。
 * @MAGIC 384000 = 官方 MAX OUTPUT 384K；1000000 = 官方 CONTEXT LENGTH 1M。
 */
export const DEEPSEEK_FLASH = {
	id: "deepseek-flash",
	name: "DeepSeek-V4.1-Flash",
	contextWindow: 1_000_000,
	maxTokens: 384_000,
	/** 官方原生多模态（JPEG / PNG / GIF / WebP），不再是单独的实验模型。 */
	input: ["text", "image"],
	reasoning: true,
	/** 每 1M token 单价（USD，高峰列表价；低谷为一半）。 */
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	/**
	 * pi 思考档位 → 官方 reasoning_effort。官方映射：minimal→low、low→low、
	 * medium→high、high→high、xhigh→high、max→max；off（未列）关闭思考模式。
	 */
	thinkingLevelMap: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max" },
	/** 与官方 openai-completions 兼容层一致（工具轮次需回传 reasoning_content）。 */
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		maxTokensField: "max_tokens",
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	},
} as const;

/** "provider/id" 完整引用。 */
export const DEEPSEEK_FLASH_REF = `${DEEPSEEK_PROVIDER}/${DEEPSEEK_FLASH.id}`;

/**
 * 退役/退场路由（**出厂默认**）：官方 API 仍接受这些 id，但服务的是 V4.1-Flash
 * （V4-Pro 自 effectiveAt 起）。默认不再把它们作为可选路由，仅保留解析能力。
 * 改这份列表请优先在设置面板「模型路由规则」里改（落盘进设置，不动代码）。
 */
export const DEFAULT_RETIRED_DEEPSEEK_ROUTES = [
	{
		id: "deepseek-v4-flash",
		replacedBy: DEEPSEEK_FLASH.id,
		effectiveAt: "2026-09-10T00:00:00Z",
		reason: "V4-Flash 已退役，官方把该 id 的请求转给 DeepSeek-V4.1-Flash",
	},
	{
		id: "deepseek-v4-flash-vision-exp",
		replacedBy: DEEPSEEK_FLASH.id,
		effectiveAt: "2026-09-10T00:00:00Z",
		reason: "V4-Flash-Vision-Exp 已退役，视觉能力并入 V4.1-Flash",
	},
	{
		id: "deepseek-v4-pro",
		replacedBy: DEEPSEEK_FLASH.id,
		effectiveAt: "2026-09-14T04:00:00Z",
		reason: "V4-Pro 有序退场，届时该 id 的请求全部转给 V4.1-Flash",
	},
] as const;

/** DSH 适配器目录条目（dsh-llm-deepseek 的 models 列表项）。 */
export function dshModelCatalog(): {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	inputModalities: string[];
}[] {
	return [
		{
			id: DEEPSEEK_FLASH.id,
			name: DEEPSEEK_FLASH.name,
			contextWindow: DEEPSEEK_FLASH.contextWindow,
			maxTokens: DEEPSEEK_FLASH.maxTokens,
			inputModalities: [...DEEPSEEK_FLASH.input],
		},
	];
}

/** DSH 顶栏模型的本地表（id/name/vision），adapter 动态目录只做补充。 */
export function dshModelChoices(): { id: string; name: string; provider: string; vision: boolean }[] {
	return [
		{
			id: DEEPSEEK_FLASH.id,
			name: DEEPSEEK_FLASH.name,
			provider: DEEPSEEK_PROVIDER,
			vision: DEEPSEEK_FLASH.input.includes("image"),
		},
	];
}

/** 一条退役路由规则（数据；id 可写 "id" 或 "provider/id"）。 */
export interface RetiredRouteRule {
	/** 完整引用 "provider/id"，或省略 provider 的裸 id（那就不分服务商匹配）。 */
	id: string;
	replacedBy?: string;
	effectiveAt?: string;
	reason?: string;
}

/**
 * 生效的路由规则：退役列表 + 别名映射。由设置面板编辑（settings.retiredModelRoutes /
 * modelRouteAliases），缺省 = 出厂默认。**纯数据**，改它不需要动代码或重新发版。
 */
export interface ModelRoutingRules {
	retired: string[];
	aliases: Record<string, string>;
}

/** 出厂默认规则（官方核对日见 OFFICIAL_ALIGNMENT）。 */
export function defaultModelRoutingRules(): ModelRoutingRules {
	const retired: string[] = [];
	const aliases: Record<string, string> = {};
	for (const route of DEFAULT_RETIRED_DEEPSEEK_ROUTES) {
		// 默认规则里的 id 属于 deepseek 服务商，这里写成完整引用，避免误伤同名模型。
		const ref = `${DEEPSEEK_PROVIDER}/${route.id}`;
		retired.push(ref);
		if (route.replacedBy) aliases[ref] = `${DEEPSEEK_PROVIDER}/${route.replacedBy}`;
	}
	return { retired, aliases };
}

/**
 * 归一化用户填写的规则：去空行/去重/去首尾空格，别名只保留「有意义的映射」。
 * @GOTCHA 空 retired 是**合法且有意义**的（= 不隐藏任何路由），不能用空值兜回默认。
 */
export function normalizeModelRoutingRules(input: Partial<ModelRoutingRules> | null | undefined): ModelRoutingRules {
	const retired: string[] = [];
	const seen = new Set<string>();
	for (const raw of Array.isArray(input?.retired) ? input!.retired : []) {
		const id = String(raw ?? "").trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		retired.push(id);
	}
	const aliases: Record<string, string> = {};
	for (const [from, to] of Object.entries(input?.aliases ?? {})) {
		const k = String(from ?? "").trim();
		const v = String(to ?? "").trim();
		if (!k || !v || k === v) continue;
		aliases[k] = v;
	}
	return { retired, aliases };
}

/** 规则的完整引用口径：裸 id 匹配任意服务商，含 "/" 的按 provider/id 精确匹配。 */
function matchesRule(ref: string, provider: string, id: string): boolean {
	return ref.includes("/") ? ref === `${provider}/${id}` : ref === id;
}

/** 该路由是否被规则判为「退役/隐藏」（历史绑定仍能经 getModel 解析，只是不出现在选择器）。 */
export function isRetiredRoute(provider: string, id: string, rules: ModelRoutingRules): boolean {
	return rules.retired.some((ref) => matchesRule(ref, provider, id));
}

/** 退役别名 → 在售 id；用于恢复历史会话时把旧选择规范化到同一服务模型。 */
export function canonicalRouteId(provider: string, id: string, rules: ModelRoutingRules): string {
	const ref = `${provider}/${id}`;
	const mapped = rules.aliases[ref] ?? rules.aliases[id];
	if (!mapped) return id;
	return mapped.includes("/") ? mapped.slice(mapped.indexOf("/") + 1) : mapped;
}

/**
 * 过滤可选路由：被规则判为退役的 id 不再暴露给选择器（历史绑定仍能通过 getModel 解析）。
 * 规则默认取出厂默认（deepseek 官方退役路由）。
 */
export function filterRoutableModels<T extends { provider: string; id: string }>(
	models: readonly T[],
	rules: ModelRoutingRules = defaultModelRoutingRules(),
): T[] {
	if (rules.retired.length === 0) return [...models];
	return models.filter((m) => !isRetiredRoute(m.provider, m.id, rules));
}
