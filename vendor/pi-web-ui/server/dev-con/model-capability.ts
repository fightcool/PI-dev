/*
 * 🍞 AI Breadcrumb Navigation
 * @COUPLED server/model-admin.ts「writeModelConfig / upsertProviderFromChannel」,
 *          tests/unit/model-capability.test.ts, docs/MODEL-ROUTING.md
 * @CONTRACT 已知模型的能力回填（capability backfill）：
 *   有些渠道的 `/models` 只返回 `{id, object}`（RightCode 实测如此），
 *   于是 models.json 里只落下 `{"id":"gpt-6-astra"}` —— 没有 reasoning，
 *   也没有 thinkingLevelMap。SDK 的 getSupportedThinkingLevels() 对没有
 *   `reasoning` 的模型只返回 ["off"]，UI 就把低/中/高三档全部禁用，
 *   用户看到的是「思考强度选不了」，而不是「这个模型不支持思考」。
 *
 *   本模块按**模型 id** 从「本文件内置的已知能力表」补齐缺失字段：
 *   只在字段缺失时补，绝不覆盖用户已经填过的值（显式配置优先）。
 * @GOTCHA 只补 reasoning / thinkingLevelMap / contextWindow / input 这些
 *   「模型自身固有」的能力，不猜 cost（价格随渠道浮动，猜错会显示假花费）。
 * @SECURITY 纯数据 + 纯函数：不读密钥、不发请求、不落盘。
 */

/** 已知模型的能力定义（按 id 索引）。这些值来自各站点 `/models` 的完整响应
 *  或同模型在其它渠道已验证过的定义；缺省不代表「不支持」，只代表「未知」。 */
export interface KnownModelCapability {
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	contextWindow?: number;
	input?: string[];
}

/**
 * 已知模型能力表。
 * @CONTRACT 键是模型 id（不带 provider 前缀）；同名模型在不同网关下能力相同，
 *   因此这张表是跨 provider 共享的 —— 这正是「同一个 gpt-6-astra，CCTQ 能选档位、
 *   RightCode 选不了」的修法：两边都按同一份能力定义补齐。
 * @GOTCHA 只登记**已核实**的模型。拿不准就不要写进来：宁可让 UI 显示「未知」，
 *   也不要给一个错的 reasoning，那会让用户在假档位上跑。
 */
export const KNOWN_MODEL_CAPABILITIES: Record<string, KnownModelCapability> = {
	"gpt-6-astra": {
		reasoning: true,
		// xhigh/max 是明文档位（网关接受并映射），off/minimal 显式置空 = 不提供。
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		contextWindow: 1_050_000,
		input: ["text", "image"],
	},
	"gpt-5.6-sol": {
		reasoning: true,
		contextWindow: 1_000_000,
		input: ["text", "image"],
	},
	"gpt-5.5": {
		reasoning: true,
		contextWindow: 400_000,
		input: ["text", "image"],
	},
	"gpt-5.3-codex-spark": {
		reasoning: true,
		input: ["text", "image"],
	},
	"codex-auto-review": {
		reasoning: true,
		input: ["text"],
	},
	"claude-opus-5": {
		reasoning: true,
		contextWindow: 200_000,
		input: ["text", "image"],
	},
	"claude-sonnet-5": {
		reasoning: true,
		contextWindow: 200_000,
		input: ["text", "image"],
	},
};

/** 查表：命中返回能力定义，未登记返回 undefined（= 未知，不猜）。 */
export function knownCapabilityOf(modelId: string): KnownModelCapability | undefined {
	const id = (modelId ?? "").trim();
	if (!id) return undefined;
	return KNOWN_MODEL_CAPABILITIES[id];
}

/** 模型条目：至少带 id，其余能力字段可选。回填函数按这个形状读写。 */
export interface ModelCapabilityEntry extends Record<string, unknown> {
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	contextWindow?: number;
	input?: string[];
}

/**
 * 用已知能力补齐模型条目的缺失字段（**不覆盖已有值**）。
 * @WHY 渠道表单的「获取接口清单」拿不到 reasoning 时，会写下一个只有 id 的条目；
 *   补在写入路径上，等于无论从哪条路径（表单/渠道/刷新目录）写进来都能补上。
 * @CONTRACT 返回新对象：入参不被修改。已显式填过的字段一律保留原值，
 *   包括显式的 `reasoning: false`（用户说这个模型不支持，就尊重）。
 * @GOTCHA `false` 与 `undefined` 必须区分：`reasoning: false` 是显式声明，
 *   不能被回填成 true；只有 undefined（字段缺失）才补。
 */
export function backfillModelCapability(entry: ModelCapabilityEntry): ModelCapabilityEntry {
	const cap = knownCapabilityOf(entry?.id);
	if (!cap) return { ...entry };
	const out: ModelCapabilityEntry = { ...entry };
	// reasoning：只有「未声明」才补（false 是显式声明，必须保留）。
	if (out.reasoning === undefined && cap.reasoning !== undefined) out.reasoning = cap.reasoning;
	// thinkingLevelMap：未填才补，已有映射表原样保留。
	if (out.thinkingLevelMap === undefined && cap.thinkingLevelMap !== undefined) out.thinkingLevelMap = { ...cap.thinkingLevelMap };
	if (out.contextWindow === undefined && cap.contextWindow !== undefined) out.contextWindow = cap.contextWindow;
	if (out.input === undefined && cap.input !== undefined) out.input = [...cap.input];
	return out;
}
