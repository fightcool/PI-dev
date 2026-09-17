/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../agent-service.ts（记录样本 + 周期判定 + notice）,
 *            usage-history.ts（同一份“失败”口径）, ../../lib/usage/token-usage.mjs
 *            （`isFailedStopReason` 是口径的唯一实现，本模块不再自己判 stopReason）
 *   📖 docs/DEV-CON-PROPOSAL.md §8 P4 候选「更多监控」
 *   @CONTRACT 纯函数：输入一段（时间 + 渠道 + 失败标记 + 输入 token）滚动样本 → 该触发的
 *             渠道失败告警。不读盘、不发通知、不改状态，冷却由调用方执行（与 ops-alerts.ts 一致）。
 *   @WHY 为什么要专门告警「失败」而不是只看费用：网关搞流（stream 半途断开）时请求照旧计费
 *        输入 token、产出为空 —— 钱一直在烧，但界面上「请求数/费用」看起来完全正常，
 *        除非把失败单独统计，否则这类损失永远不会自己浮出来。
 *   @GOTCHA 只统计 stopReason=error（渠道/传输故障）。用户主动中止（aborted）不算：
 *           那是有意为之，把它算成故障会让告警变成噪声，也会误导渠道判断。
 *   @GOTCHA 告警主体由调用方给（channel:<id> 优先，无渠道绑定时回落 provider:<id>）：
 *           实测大量请求 channelId=null，只认渠道会让告警对最严重的白烧完全沉默。
 *   @MAGIC 默认阈值：窗口 30 分钟、至少 5 次失败、失败率 ≥ 5%、冷却 60 分钟、每渠道单独冷却。
 *         失败率下限避免「2 次里 1 次失败」就报警；次数下限避免低频渠道的偶然失败刷屏。
 * ──────────────────────────────────────────────────
 */

/** 一个请求样本（调用方只传它真的知道的事实；缺时间/主体的样本直接丢弃）。 */
export interface FailureSample {
	at: number;
	/**
	 * 告警主体（由调用方决定语义）：优先渠道 `channel:<id>`，没有渠道绑定时回落到
	 * `provider:<id>`。null = 两者都不知道，不参与告警（没有可操作的对象可指）。
	 * @WHY 不能只按渠道计：实测大量请求没有渠道绑定（记录里 channelId=null），
	 * 只认渠道的话告警会对最严重的白烧完全沉默。
	 */
	subjectKey: string | null;
	/** 该主体的展示名，仅用于告警文案。 */
	subjectLabel?: string;
	/** stopReason === "error"。 */
	failed: boolean;
	/** 该请求计费的输入 token（miss + 读缓存 + 写缓存）。 */
	input: number;
}

export interface ChannelFailureAlert {
	/** 冷却用的稳定键（由 subjectKey 派生）。 */
	key: string;
	subjectKey: string;
	subjectLabel: string;
	/** 窗口内的请求数与失败数。 */
	requests: number;
	failed: number;
	/** 窗口内失败请求白烧掉的输入 token。 */
	wastedInput: number;
	/** 失败率（0..1）。 */
	rate: number;
}

export const CHANNEL_FAILURE_WINDOW_MS = 30 * 60_000;
export const CHANNEL_FAILURE_MIN_FAILURES = 5;
export const CHANNEL_FAILURE_MIN_RATE = 0.05;
export const CHANNEL_FAILURE_COOLDOWN_MS = 60 * 60_000;

export interface ChannelFailureAlertInputs {
	samples: readonly FailureSample[];
	/** 上次触发时间（ms），键为 ChannelFailureAlert.key；缺省视为从未触发。 */
	lastFired?: Record<string, number>;
	now?: number;
	windowMs?: number;
	minFailures?: number;
	minRate?: number;
	cooldownMs?: number;
}

/**
 * 判定本次应触发的渠道失败告警（不修改输入）。
 * 窗口外的样本、无主体的样本、以及未越过「失败次数 + 失败率」双阈值的渠道都不产生告警。
 */
export function evaluateChannelFailureAlerts(input: ChannelFailureAlertInputs): ChannelFailureAlert[] {
	const now = input.now ?? Date.now();
	const windowMs = input.windowMs ?? CHANNEL_FAILURE_WINDOW_MS;
	const minFailures = input.minFailures ?? CHANNEL_FAILURE_MIN_FAILURES;
	const minRate = input.minRate ?? CHANNEL_FAILURE_MIN_RATE;
	const cooldown = input.cooldownMs ?? CHANNEL_FAILURE_COOLDOWN_MS;
	const lastFired = input.lastFired ?? {};

	const bySubject = new Map<string, { label: string; requests: number; failed: number; wastedInput: number }>();
	for (const sample of input.samples) {
		if (!Number.isFinite(sample?.at) || !sample.subjectKey) continue;
		if (sample.at < now - windowMs) continue;
		const entry = bySubject.get(sample.subjectKey) ?? { label: sample.subjectLabel ?? sample.subjectKey, requests: 0, failed: 0, wastedInput: 0 };
		entry.requests += 1;
		if (sample.failed) {
			entry.failed += 1;
			entry.wastedInput += Math.max(0, sample.input || 0);
		}
		if (sample.subjectLabel) entry.label = sample.subjectLabel;
		bySubject.set(sample.subjectKey, entry);
	}

	const alerts: ChannelFailureAlert[] = [];
	for (const [subjectKey, entry] of bySubject) {
		if (entry.requests === 0 || entry.failed < minFailures) continue;
		const rate = entry.failed / entry.requests;
		if (rate < minRate) continue;
		const key = `channel-failure:${subjectKey}`;
		const firedAt = lastFired[key];
		if (typeof firedAt === "number" && now - firedAt < cooldown) continue;
		alerts.push({ key, subjectKey, subjectLabel: entry.label, requests: entry.requests, failed: entry.failed, wastedInput: entry.wastedInput, rate });
	}
	// 稳定顺序（失败多的在前），便于测试与文案可复现。
	return alerts.sort((a, b) => b.failed - a.failed || a.subjectKey.localeCompare(b.subjectKey));
}
