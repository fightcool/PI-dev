/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/JevSettings.tsx（设置面板「Jev 决策门禁」分区：表单 + 动作）,
 *            components/JevRuntimeView.tsx（运行状态 / 命题 / 余额 / 自检结果的只读展示）,
 *            use-chat.ts（jev_* 回包 → ChatState.jev）,
 *            server/protocol.ts（UiJevGateConfig / UiJevRuntimeStatus / UiJevDecision …）,
 *            server/dev-con/jev-model.ts + jev-settings.ts + jev-gate.ts（服务端权威）
 *   @CONTRACT 纯前端工具：出站消息直接构造协议的 ClientMessage 成员（不 cast、不镜像类型）；
 *             wire 类型一律从 web/src/types.ts 再导出的 server/protocol.ts 引用。
 *             前端不持有 Jev 语义常量：endpoint/model 默认值由服务端下发（jev-model.ts 是唯一事实源），
 *             界面只在空值处显示语言包里的提示文案。
 *   @GOTCHA 密钥正文永远不进前端：UiJevGateConfig.credentialRef 只有 {providerId, keyName}，
 *             界面只显示名称；不要为「显示密钥」加任何兜底字段。
 *   @WHY 这里的校验（阈值顺序/别名）只是**遮挡明显错误**并给出解释：服务端 validateJevGateConfig
 *        才是权威（rejected 回执带双语原因）。所以前端不重复服务端的全部规则，只挑会让人白填一次的。
 * ──────────────────────────────────────────────────
 */
import type {
	ClientMessage,
	UiJevDecision,
	UiJevDecisionAudit,
	UiJevGateConfig,
	UiJevGateConfigInput,
	UiJevOutcome,
	UiJevThresholds,
} from "./types";

/* ------------------------------------------------------------------ */
/* 出站消息（协议成员直接构造）                                        */
/* ------------------------------------------------------------------ */

/** 只读状态：配置（已清洗）+ 运行聚合 + 可用命题。 */
export const jevStatusMessage = (reqId: number): ClientMessage => ({ type: "jev_status", reqId });

/**
 * 自检：服务端用一条内置命题真实打一次 Decisions 接口。
 * @CONTRACT 不带 state —— 服务端省略时用内置合成样本（jev-gate.ts 的 JEV_PROBE_STATE）。
 */
export const jevProbeMessage = (reqId: number): ClientMessage => ({ type: "jev_probe", reqId });

/**
 * 保存配置：只提交界面拥有的字段。
 * @CONTRACT 服务端是读-合并-写（jev-settings.ts），未给的字段不会被清空 —— 所以只读的
 *   timeoutMs/cacheTtlMs/minIntervalMs 不必回传（少一个「把服务端值覆盖成旧值」的机会）。
 */
export const jevConfigSaveMessage = (reqId: number, config: UiJevGateConfigInput): ClientMessage => ({
	type: "jev_config_save",
	reqId,
	config,
});

/* ------------------------------------------------------------------ */
/* 校验与格式化（纯函数）                                              */
/* ------------------------------------------------------------------ */

/**
 * 双阈值之间的最小带宽。
 * @MAGIC 0.16 = 2 × 0.08：Jev 对同一输入的输出概率抖动可达 ~0.08，空白带窄于两倍抖动时同一请求
 *   会在放行/拦下之间来回翻。这只是**界面警告**，服务端才是权威校验（它只要求 blockAt < approveAt）。
 */
export const JEV_MIN_THRESHOLD_BAND = 0.16;

/** 别名模型（`xxx-latest` / `xxx:latest`）= 供应商可以随时换实现的漂移风险。 */
export function isDriftingModelAlias(model: string): boolean {
	return /(^|[-/:._])latest$/i.test(model.trim());
}

/**
 * 看起来是 Typesafe Jev 模型（`typesafe/jev-1.13`、带日期的快照、或裸 `jev-1.x`）。
 * @WHY 用于两件事：在「从既有模型中选择」里只列真能用 Decisions API 的条目（Jev 不在
 *   服务商的对话模型目录里，那个目录里的 366 个 openrouter 模型一个都不是 Jev），
 *   以及当手填的模型不是 Jev 时给出警告 —— 否则选了对话模型只会在调用时报错。
 */
export function isJevModelId(model: string): boolean {
	return /(^|\/)jev[-.]?\d/i.test(model.trim());
}

/**
 * 已知可用的 Jev 模型。
 * @WHY Jev 是 Decisions API 专用模型，**不**出现在任何服务商的对话模型目录里
 *   （实测 `models.json` 里 "jev" 零匹配），所以这份清单只能由产品维护，
 *   不能从 models.json 推出来。下拉里永远至少有它，不会是个空壳。
 *   带日期的快照（`typesafe/jev-1.13-20260917`）写进输入框即可，不在这里枚举。
 */
export const JEV_KNOWN_MODELS: readonly string[] = ["typesafe/jev-1.13"];

export function parseThreshold(raw: string): number | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const v = Number(trimmed);
	return Number.isFinite(v) ? v : null;
}

export interface ThresholdCheck {
	/** 可以提交吗（服务端才是权威；这里只挡明显错的）。 */
	ok: boolean;
	/** 合法但不合建议：双阈值之间太窄（见 {@link JEV_MIN_THRESHOLD_BAND}）。 */
	narrow: boolean;
}

/**
 * 端点可用吗。
 * @COUPLED server/dev-con/jev-model.ts 的 validateJevGateConfig：endpoint 空 ⇒ 拒绝（默认值只在字段缺省时
 *   生效，空字符串不算缺省），且必须是 https。前端先挡一次，避免白填一轮；服务端仍是权威。
 */
export function checkEndpoint(endpoint: string): boolean {
	const v = endpoint.trim();
	return v !== "" && /^https:\/\//i.test(v);
}

/**
 * 凭据引用：服务端只接受**明确名称**（providerId + keyName 都非空）或 null。
 * @GOTCHA 不存在「跟随当前密钥」这种表示：选服务商但没选密钥名时，不能送 `keyName: ""`（服务端会拒绝），
 *   只能送 null（不绑定）——所以这种不一致状态在界面上直接拦住保存。
 */
export function credentialProblem(draft: { providerId: string; keyName: string | null }): boolean {
	return draft.providerId.trim() !== "" && !(draft.keyName ?? "").trim();
}

/** 与 server/dev-con/jev-model.ts 的 validateJevGateConfig 同口径（0~1 且 blockAt < approveAt）。 */
export function checkThresholds(approveAt: number | null, blockAt: number | null): ThresholdCheck {
	if (approveAt === null || blockAt === null) return { ok: false, narrow: false };
	const inRange = (v: number) => v >= 0 && v <= 1;
	if (!inRange(approveAt) || !inRange(blockAt)) return { ok: false, narrow: false };
	if (!(blockAt < approveAt)) return { ok: false, narrow: false };
	return { ok: true, narrow: approveAt - blockAt < JEV_MIN_THRESHOLD_BAND };
}

/** 耗时（毫秒；取不到显示「—」而不是 0）。 */
export function formatMs(v: number | null | undefined): string {
	return v === null || v === undefined || !Number.isFinite(v) ? "—" : `${Math.round(v)} ms`;
}

/** 只读限制文案：把毫秒数说成人话（1.5 s / 250 ms）。 */
export function formatLimit(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
	return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s` : `${ms} ms`;
}

/** 判定项分数（0~1；最多 3 位小数，避免「0.020000000000000004」这种噪声）。 */
export function formatScore(v: number | null | undefined): string {
	return v === null || v === undefined || !Number.isFinite(v) ? "—" : String(Number(v.toFixed(3)));
}

/**
 * 回包错误文案（与渠道面板同一口径：中文界面用 error，其余语言优先 errorEn）。
 * @CONTRACT 服务端两个字段都可能缺：都缺时返回空串，由调用方决定显示哪句兜底文案。
 */
export function pickError(res: { error?: string; errorEn?: string }, locale: string): string {
	return locale !== "zh" && res.errorEn ? res.errorEn : (res.error ?? res.errorEn ?? "");
}

/** 判定理由（UiJevDecision 自带双语）。 */
export function pickReason(decision: UiJevDecision, locale: string): string {
	return locale !== "zh" && decision.reasonEn ? decision.reasonEn : decision.reason;
}

/**
 * 磁盘持久缓存命中的标签（zh/en）。
 * @WHY 不往 i18n 词典里加键：`web/src/i18n*.ts` 与 `locales/` 由翻译流程拥有，
 *   本切片（缓存持久化）不碰它们；这里与 pickError / pickReason 同一双语选词口径。
 */
export function diskHitLabel(locale: string): string {
	return locale === "zh" ? "磁盘命中（持久缓存）" : "Disk hits (persistent)";
}

/** 清空磁盘缓存的操作提示（CLI 命令，服务端没开新接口）。 */
export function cacheClearHint(locale: string): string {
	return locale === "zh"
		? "决策缓存会落盘（跨进程/CI 复用）；清空：npm run jev -- cache clear"
		: "Decisions are cached on disk (reused across processes/CI); clear with: npm run jev -- cache clear";
}

/** 审计里的缓存来源文案：miss / hit 用既有词典键，disk 走本模块的双语常量。 */
export function cacheSourceLabel(
	cache: UiJevDecisionAudit["cache"],
	locale: string,
	t: (key: "settingsJevCacheHits" | "settingsJevCacheMiss") => string,
): string {
	if (cache === "disk") return diskHitLabel(locale);
	return cache === "hit" ? t("settingsJevCacheHits") : t("settingsJevCacheMiss");
}

/** 三态 → i18n key（放行 / 拦下 / 转人工）。 */
export function outcomeLabelKey(
	outcome: UiJevOutcome,
): "settingsJevOutcomeApprove" | "settingsJevOutcomeBlock" | "settingsJevOutcomeReview" {
	if (outcome === "approve") return "settingsJevOutcomeApprove";
	if (outcome === "block") return "settingsJevOutcomeBlock";
	return "settingsJevOutcomeReview";
}

/** 原始回包（缩进 JSON；不是对象就原样转字符串）。 */
export function prettyJson(v: unknown): string {
	try {
		return typeof v === "string" ? v : JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

/** 列表一行放不下全文时的摘要（展开看完整说明）。 */
export function brief(text: string, max = 88): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ------------------------------------------------------------------ */
/* 草稿 ↔ 配置                                                        */
/* ------------------------------------------------------------------ */

/** Jev 的默认服务商：Decisions API 与 `typesafe/jev-*` 模型都只由 OpenRouter 提供。 */
export const JEV_DEFAULT_PROVIDER_ID = "openrouter";

/** 表单草稿：阈值用字符串（允许输到一半的 "0." / ""），提交时才解析。 */
export interface JevDraft {
	enabled: boolean;
	endpoint: string;
	model: string;
	providerId: string;
	/** 命名的密钥名；null = 跟随服务商当前 active 密钥（协议里 credentialRef=null）。 */
	keyName: string | null;
	approveAt: string;
	blockAt: string;
}

export function draftOf(config: UiJevGateConfig): JevDraft {
	return {
		enabled: config.enabled,
		endpoint: config.endpoint,
		model: config.model,
		providerId: config.credentialRef?.providerId ?? "",
		keyName: config.credentialRef?.keyName ?? null,
		approveAt: String(config.thresholds.approveAt),
		blockAt: String(config.thresholds.blockAt),
	};
}

/** 草稿 → 保存载荷（只含界面拥有的字段，见 {@link jevConfigSaveMessage} 的 @CONTRACT）。 */
export function configInputOf(draft: JevDraft, thresholds: UiJevThresholds): UiJevGateConfigInput {
	const providerId = draft.providerId.trim();
	const keyName = (draft.keyName ?? "").trim();
	return {
		enabled: draft.enabled,
		endpoint: draft.endpoint.trim(),
		model: draft.model.trim(),
		// 两者都齐才送引用；只齐一半是界面上不允许保存的状态（见 credentialProblem）。
		credentialRef: providerId && keyName ? { providerId, keyName } : null,
		thresholds,
	};
}
