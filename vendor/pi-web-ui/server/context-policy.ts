/**
 * context-policy.ts — 系统级上下文策略（一处配置，全模型生效）。
 *
 * 形状与默认值照抄业界惯例，不自己发明规则。依据是本机 Codex 的**源码**（openai/codex）：
 *
 * | Codex 的位置 | 含义 | 本项目对应 |
 * | --- | --- | --- |
 * | `models-manager/models.json` → `context_window: 272000` | **预算窗口**（gpt-6-astra / gpt-5.6-sol 等；同族 `max_context_window` 是 872000） | `models.json` 的 `contextWindow`（我们保留供应商宣传值，预算改由本策略给） |
 * | `models-manager/src/model_info.rs:133` → `effective_context_window_percent: 95` | 有效窗口 = 声明窗口 × 95% → **272000 × 95% = 258400** | `effectiveWindowPercent`（默认 95） |
 * | `model_info.rs:29-30` → `config.model_auto_compact_token_limit` 覆盖模型默认值 | **系统级绝对上限**（一处配置，全模型生效） | `autoCompactTokenLimit` |
 * | `core/src/session/context_window.rs:84,101-108` | `context_window × percent/100`，再与上限比较决定何时压缩 | 本模块的 `resolveContextBudget()` |
 *
 * 结论：业界对这些模型的实跑有效窗口是 **~258k**，而不是供应商宣传的 1M；模型物理上限
 * （872k/1M）单独记录、不参与日常决策。
 *
 * pi 只有一个窗口字段、判据是 `contextTokens > contextWindow - reserveTokens`，因此这里把
 * 「有效窗口」换算成 reserve 交回去：
 *
 *   有效窗口 = floor(真实窗口 × effectiveWindowPercent / 100)
 *   触发点   = min(autoCompactTokenLimit ?? 有效窗口, 有效窗口)
 *   reserveTokens = 真实窗口 − 触发点
 *
 * 这样模型窗口保持真实（pi 的「静默溢出」判定不会误报），策略却单独可控。
 * 配置位置：`<agentDir>/context-policy.json`（缺失/非法时用默认值）；只读、按 mtime 热生效。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const CONTEXT_POLICY_FILE = "context-policy.json";

export interface ContextPolicy {
	/** 有效窗口占声明窗口的百分比（Codex: effective_context_window_percent，默认 95）。 */
	effectiveWindowPercent: number;
	/** 压缩触发的绝对 token 上限（Codex: model_auto_compact_token_limit）；null = 只用有效窗口。 */
	autoCompactTokenLimit: number | null;
	/** 覆盖「压缩后保留最近原文」的 token 数；null = 跟随 settings.json 的 compaction.keepRecentTokens。 */
	keepRecentTokens: number | null;
	/** 豁免绝对上限的模型（写 `deepseek-flash` 或 `deepseek/deepseek-flash`）；命中则只用有效窗口。
	 *  默认空 = 全模型统一。需要「真读长材料」的那一个模型列进来即可，不必为其它模型逐个配置。 */
	exemptModels: string[];
	/** 人类可读说明，写进日志便于回溯当时用的是哪版策略。 */
	note?: string;
}

/** 与 Codex 默认一致：95% 有效窗口、不设绝对上限（= 用有效窗口触发）。 */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
	effectiveWindowPercent: 95,
	autoCompactTokenLimit: null,
	keepRecentTokens: null,
	exemptModels: [],
};

/**
 * 照抄 Codex 对同族模型的实跑预算：272000 × 95% = 258400。
 * 想复现「业界惯例」的体验就把它写进 context-policy.json —— 一处生效，全模型跟随
 * （小窗口模型会被 `有效窗口` 自动保护，不会被这个绝对值反噬）。
 */
export const CODEX_EQUIVALENT_TOKEN_LIMIT = 258_400;

export interface ContextBudget {
	/** 模型声明的（真实）窗口。 */
	realWindow: number;
	/** 有效窗口 = 真实窗口 × 百分比。 */
	effectiveWindow: number;
	/** 实际触发压缩的 token 数。 */
	triggerTokens: number;
	/** 交给 pi 的 reserveTokens（= realWindow − triggerTokens）。 */
	reserveTokens: number;
	/** 是否被绝对上限收口（false = 由有效窗口决定）。 */
	cappedByLimit: boolean;
	/** 是否命中了 exemptModels 豁免（只用有效窗口，绝对上限不生效）。 */
	exempt: boolean;
}

const isPositiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** 校验并归一化外部配置；非法字段回落默认值（策略问题不该让服务起不来）。 */
export function normalizeContextPolicy(raw: unknown): ContextPolicy {
	const source = (raw ?? {}) as Record<string, unknown>;
	const percent = source.effectiveWindowPercent;
	const limit = source.autoCompactTokenLimit;
	const keep = source.keepRecentTokens;
	const exempt = source.exemptModels;
	// 百分比限在 1–100：>100 会算出比真实窗口还大的有效窗口，那是配置错误。
	const normalizedPercent =
		typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100
			? Math.floor(percent)
			: DEFAULT_CONTEXT_POLICY.effectiveWindowPercent;
	return {
		effectiveWindowPercent: normalizedPercent,
		autoCompactTokenLimit: limit === null || limit === undefined ? null : isPositiveInt(limit) ? limit : DEFAULT_CONTEXT_POLICY.autoCompactTokenLimit,
		keepRecentTokens: keep === null || keep === undefined ? null : isPositiveInt(keep) ? keep : DEFAULT_CONTEXT_POLICY.keepRecentTokens,
		exemptModels: Array.isArray(exempt)
			? [...new Set(exempt.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()))]
			: DEFAULT_CONTEXT_POLICY.exemptModels,
		...(typeof source.note === "string" && source.note.trim() ? { note: source.note.trim() } : {}),
	};
}

/**
 * 由真实窗口与策略算出触发点。
 *
 * reserveTokens = 真实窗口 − 触发点，所以它天然可能很大（触发点越小它越大）；这正是 pi 的
 * 判据需要的形状，不能再去钳制它——否则触发点会被抬高（试过把 reserve 夹到窗口一半：
 * 1,050,000 窗口 + 258,400 上限会被抬回 525,000）。只需保证触发点在 [1, 窗口−1]。
 *
 * @GOTCHA 副作用：pi 用同一个 reserve 给摘要预留输出上限（`min(0.8 × reserve, maxTokens)`），
 *   所以绝对上限设得越小时这个上限越松（不影响摘要实际长度，长度由提示词决定）。
 */
export function resolveContextBudget(
	realWindow: number | null | undefined,
	policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
	/** 当前模型标识（`<provider>/<id>`；也接受裸 id）——用于 exemptModels 匹配。 */
	modelKey?: string,
): ContextBudget | undefined {
	if (typeof realWindow !== "number" || !Number.isFinite(realWindow) || realWindow <= 0) return undefined;
	const effectiveWindow = Math.max(1, Math.floor((realWindow * policy.effectiveWindowPercent) / 100));
	const exempt = matchesExempt(policy, modelKey);
	const cappedByLimit = !exempt && policy.autoCompactTokenLimit !== null && policy.autoCompactTokenLimit < effectiveWindow;
	const wanted = cappedByLimit ? policy.autoCompactTokenLimit! : effectiveWindow;
	const trigger = Math.max(1, Math.min(wanted, realWindow - 1));
	return { realWindow, effectiveWindow, triggerTokens: trigger, reserveTokens: realWindow - trigger, cappedByLimit, exempt };
}

/** 豁免匹配：接受 `provider/id` 与裸 `id` 两种写法（大小写不敏感）。 */
function matchesExempt(policy: ContextPolicy, modelKey: string | undefined): boolean {
	if (!modelKey || policy.exemptModels.length === 0) return false;
	const full = modelKey.toLowerCase();
	const bare = full.includes("/") ? full.slice(full.indexOf("/") + 1) : full;
	return policy.exemptModels.some((entry) => {
		const needle = entry.toLowerCase();
		return needle === full || needle === bare;
	});
}

/** 人读描述（日志/诊断）。 */
export function describeContextBudget(budget: ContextBudget | undefined, policy: ContextPolicy): string {
	if (!budget) return "context-policy: 窗口未知 → 交给 settings.json 的 reserveTokens";
	const percent = ((budget.triggerTokens / budget.realWindow) * 100).toFixed(0);
	const source = budget.cappedByLimit
		? `绝对上限 ${policy.autoCompactTokenLimit}`
		: budget.exempt
			? `豁免（exemptModels）→ 有效窗口 ${budget.effectiveWindow}`
			: `有效窗口 ${budget.effectiveWindow}（${policy.effectiveWindowPercent}%）`;
	return `context-policy: 窗口 ${budget.realWindow}，触发于 ${budget.triggerTokens}（占窗口 ${percent}%；来源：${source}），reserve=${budget.reserveTokens}`;
}

/** 按 mtime 缓存的策略加载器：文件改了立即生效，没改不重复读盘。 */
export function makeContextPolicyLoader(agentDir: string): () => ContextPolicy {
	const path = join(agentDir, CONTEXT_POLICY_FILE);
	let cachedAt = -1;
	let cached: ContextPolicy = DEFAULT_CONTEXT_POLICY;
	return () => {
		let mtime: number;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			cachedAt = -1;
			cached = DEFAULT_CONTEXT_POLICY;
			return cached;
		}
		if (mtime === cachedAt) return cached;
		try {
			cached = normalizeContextPolicy(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			cached = DEFAULT_CONTEXT_POLICY;
		}
		cachedAt = mtime;
		return cached;
	};
}
