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
 *   @CONTRACT 纯函数：输入一段（时间 + 主体 + 失败标记 + 输入 token）滚动样本 → 该触发的失败告警。
 *             不读盘、不发通知、不改状态，冷却由调用方执行（与 ops-alerts.ts 一致）。
 *   @WHY 为什么要专门告警「失败」而不是只看费用：网关搞流（stream 半途断开）时请求照旧计费
 *        输入 token、产出为空 —— 钱一直在烧，但界面上「请求数/费用」看起来完全正常，
 *        除非把失败单独统计，否则这类损失永远不会自己浮出来。
 *   @GOTCHA 只统计 stopReason=error（网关/传输故障）。用户主动中止（aborted）不算：
 *           那是有意为之，把它算成故障会让告警变成噪声，也会误导服务商判断。
 *   @GOTCHA 告警主体是 `provider:<id>`（渠道概念已移除）：多供应商直连时代曾经优先渠道、
 *           回落服务商；现在凭据与用量归属都只到服务商/模型这一层。
 *   @MAGIC 默认阈值：窗口 30 分钟、至少 5 次失败、失败率 ≥ 5%、冷却 60 分钟、每主体单独冷却。
 *         失败率下限避免「2 次里 1 次失败」就报警；次数下限避免低频主体的偶然失败刷屏。
 *         另外要求窗口内**确实烧掉了输入 token**（wastedInput > 0）：告警说的是白烧（钱），
 *         而不是所有失败。用真实历史（11351 条 assistant 消息 / 283 条失败，2026-09-10 ~ 09-18）
 *         回测过这个口径，见表。
 *   @MAGIC 阈值余量也是回测出来的：真实事故（uu-api）30 分钟窗峰值 31 条计费失败，
 *         次数下限取 5 留了 ~6 倍余量；其余服务商历史上计费失败为 0，不会误报。
 *
 *   回测（同一份历史，套用不同口径——窗口/失败率/冷却相同）：
 *
 *   | 口径 | 会触发的告警 | 实际含义 |
 *   | --- | --- | --- |
 *   | 所有 `error` | cctq 4 次 + CCQTCC 1 次 + rightcode 2 次 + uu-api 7 次 | **7 次是噪声**：全是零计费失败（额度不足 403、请求前就被拒），文案会写成「白烧约 0 输入 token」 |
 *   | 只认计费输入（本实现） | uu-api 7 次 / 6.95M token | 全部是真白烧，与线上事故一一对应 |
 *
 *   额度不足这类失败**本来就有可见的出口**（会话里的报错卡 + 余额面板），再报一次
 *   只会让「白烧」这个信号贬值；而掐流恰恰是「请求数与费用看上去完全正常」的那种，
 *   只能靠这个告警。
 * ──────────────────────────────────────────────────
 */

/** 一个请求样本（调用方只传它真的知道的事实；缺时间/主体的样本直接丢弃）。 */
export interface FailureSample {
	at: number;
	/**
	 * 告警主体（由调用方决定语义）：`provider:<id>`。null = 不知道是哪个服务商，
	 * 不参与告警（没有可操作的对象可指）。
	 */
	subjectKey: string | null;
	/** 该主体的展示名，仅用于告警文案。 */
	subjectLabel?: string;
	/** stopReason === "error"。 */
	failed: boolean;
	/** 该请求计费的输入 token（miss + 读缓存 + 写缓存）。 */
	input: number;
}

export interface FailureAlert {
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

export const FAILURE_WINDOW_MS = 30 * 60_000;
export const FAILURE_MIN_FAILURES = 5;
export const FAILURE_MIN_RATE = 0.05;
export const FAILURE_COOLDOWN_MS = 60 * 60_000;

export interface FailureAlertInputs {
	samples: readonly FailureSample[];
	/** 上次触发时间（ms），键为 FailureAlert.key；缺省视为从未触发。 */
	lastFired?: Record<string, number>;
	now?: number;
	windowMs?: number;
	minFailures?: number;
	minRate?: number;
	cooldownMs?: number;
}

/**
 * 判定本次应触发的失败告警（不修改输入）。
 * 窗口外的样本、无主体的样本、以及未越过「失败次数 + 失败率 + 确实烧掉输入 token」
 * 三重阈值的主体都不产生告警。
 *
 * @WHY 为什么单独要求 wastedInput > 0：白烧 = 「已经计费了输入 token 却没产出可用输出」。
 *      零计费的失败（额度不足 403、请求前就被网关拒掉）不是白烧，而且它们本身就有可见出口
 *      （报错卡 + 余额面板），拿它们报警只会让这个信号贬值：文案会变成「白烧约 0 输入 token」。
 */
export function evaluateFailureAlerts(input: FailureAlertInputs): FailureAlert[] {
	const now = input.now ?? Date.now();
	const windowMs = input.windowMs ?? FAILURE_WINDOW_MS;
	const minFailures = input.minFailures ?? FAILURE_MIN_FAILURES;
	const minRate = input.minRate ?? FAILURE_MIN_RATE;
	const cooldown = input.cooldownMs ?? FAILURE_COOLDOWN_MS;
	const lastFired = input.lastFired ?? {};

	const bySubject = new Map<string, { label: string; requests: number; failed: number; wastedInput: number }>();
	for (const sample of input.samples) {
		if (!Number.isFinite(sample?.at) || !sample.subjectKey) continue;
		if (sample.at < now - windowMs) continue;
		const entry = bySubject.get(sample.subjectKey) ?? {
			label: sample.subjectLabel ?? sample.subjectKey,
			requests: 0,
			failed: 0,
			wastedInput: 0,
		};
		entry.requests += 1;
		if (sample.failed) {
			entry.failed += 1;
			entry.wastedInput += Math.max(0, sample.input || 0);
		}
		if (sample.subjectLabel) entry.label = sample.subjectLabel;
		bySubject.set(sample.subjectKey, entry);
	}

	const alerts: FailureAlert[] = [];
	for (const [subjectKey, entry] of bySubject) {
		if (entry.requests === 0 || entry.failed < minFailures) continue;
		const rate = entry.failed / entry.requests;
		if (rate < minRate) continue;
		// 只有真的烧掉了输入 token 才算「白烧」（见函数头 @WHY）。
		if (entry.wastedInput <= 0) continue;
		const key = `failure:${subjectKey}`;
		const firedAt = lastFired[key];
		if (typeof firedAt === "number" && now - firedAt < cooldown) continue;
		alerts.push({
			key,
			subjectKey,
			subjectLabel: entry.label,
			requests: entry.requests,
			failed: entry.failed,
			wastedInput: entry.wastedInput,
			rate,
		});
	}
	// 稳定顺序（失败多的在前），便于测试与文案可复现。
	return alerts.sort((a, b) => b.failed - a.failed || a.subjectKey.localeCompare(b.subjectKey));
}
