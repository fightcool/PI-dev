/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/JevSettings.tsx（唯一挂载点：设置面板「Jev 决策门禁」分区）,
 *            jev-decision.ts（协议类型 + 校验/格式化辅助）,
 *            GatewayUsageBlock.tsx（网关自报用量的展示口径：本文件只复用，不另写一套）,
 *            use-chat.ts（jev_status / jev_probe_result → ChatState.jev）,
 *            server/dev-con/jev-model.ts（UiJevRuntimeStatus / UiJevDecision 的产出方）
 *   @CONTRACT 只读展示：不发起任何配置写入。余额行显示的是**网关自报用量**
 *             （GatewayUsageBlock，与状态栏/用量面板同一份读数）。
 *   @GOTCHA 取不到的字段一律显示「—」或明确文案，不用 0 顶替：0 次失败与「没读到」是两件事。
 *   @WHY 命题清单默认只显示一行摘要，展开才看判定口径；自检结果把 checks 逐项分数、判定理由、
 *        审计（模型/令牌/费用/缓存）全部摊开 —— 「非黑盒」的最低要求是让运营者看到真实回包。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FiAlertTriangle, FiCheck } from "react-icons/fi";
import { useT } from "../i18n";
import type { UiJevDecision, UiJevProposition, UiJevRuntimeStatus } from "../types";
import type { JevConfigResultMsg, JevProbeResultMsg, JevStatusMsg } from "../use-chat";
import { GatewayUsageBlock, type GatewayUsageState } from "./GatewayUsageBlock";
import { formatCostOrDash } from "../gateway-usage";
import {
	brief,
	cacheClearHint,
	cacheSourceLabel,
	diskHitLabel,
	formatMs,
	formatScore,
	outcomeLabelKey,
	pickError,
	pickReason,
	prettyJson,
} from "../jev-decision";

/** 运行状态：总调用 / 三分支 / 失败 / token / 费用 / 缓存 / 平均耗时 + 最近一次错误。 */
export function JevRuntimeCards({
	runtime,
	locale,
}: {
	runtime: UiJevRuntimeStatus | null | undefined;
	/** 最近一次错误是双语原文，按界面语言选（与回执同一口径）。 */
	locale: string;
}) {
	const t = useT();
	if (!runtime) return <p className="set-hint">{t("settingsJevRuntimeEmpty")}</p>;
	// 费用口径与用量面板同源（web/src/gateway-usage.ts 的 formatUsd）；服务端没给价格时显示「—」，
	// 不写 0（0 会被读成「免费」）。
	const cost = formatCostOrDash(runtime.cost);
	const cards: { title: string; value: string }[] = [
		{ title: t("settingsJevTotalCalls"), value: String(runtime.total) },
		{ title: t("settingsJevOutcomeApprove"), value: String(runtime.approve) },
		{ title: t("settingsJevOutcomeBlock"), value: String(runtime.block) },
		{ title: t("settingsJevOutcomeReview"), value: String(runtime.review) },
		{ title: t("settingsJevFailures"), value: String(runtime.failed) },
		{ title: t("settingsJevCacheHits"), value: String(runtime.cacheHits) },
		// 磁盘命中单列：进程内命中与跨进程/CI 的持久命中不是一件事（协议里 diskHits 是必填字段）。
		{ title: diskHitLabel(locale), value: String(runtime.diskHits ?? 0) },
		{ title: t("usageColInput"), value: String(runtime.inputTokens) },
		{ title: t("usageColOutput"), value: String(runtime.outputTokens) },
		{ title: t("usageColCost"), value: cost || "—" },
		{ title: t("settingsJevAvgElapsed"), value: formatMs(runtime.avgElapsedMs) },
	];
	return (
		<>
			{/* 服务端还没记录过任何调用时先说一句人话：下面那些 0 是事实（服务端确实报 0），
			   不是为了好看编出来的。 */}
			{runtime.total === 0 && runtime.failed === 0 && <p className="set-hint">{t("settingsJevRuntimeEmpty")}</p>}
			<div className="resources-cards">
				{cards.map((c) => (
					<div className="resource-card" key={c.title}>
						<div className="resource-title">{c.title}</div>
						<div className="resource-value">{c.value}</div>
					</div>
				))}
			</div>
			{/* 最近一次错误：服务端给双语原文 + 时间 + code（保留原始 code，便于对照日志）。 */}
			{runtime.lastError && (
				<div className="chan-warn">
					{t("settingsJevLastError")}
					{"：["}
					{runtime.lastError.code}
					{"] "}
					{pickError(runtime.lastError, locale)}
					{" · "}
					{new Date(runtime.lastError.at).toLocaleString()}
				</div>
			)}
			{/* 清空缓存的入口只有 CLI：缓存是派生数据，不为它新开一条 WS 消息/服务端接口。 */}
			<p className="set-hint">{cacheClearHint(locale)}</p>
		</>
	);
}

/** 命题清单：一行摘要 + 展开看 instructions / criteria（让运营者看懂它在判什么）。 */
export function JevPropositionList({ propositions }: { propositions: UiJevProposition[] }) {
	const t = useT();
	const [open, setOpen] = useState<string | null>(null);
	if (propositions.length === 0) return <p className="set-hint">{t("settingsJevPropositionsEmpty")}</p>;
	return (
		<div className="set-list">
			{propositions.map((p) => {
				const expanded = open === p.id;
				return (
					<div className="set-row" key={p.id}>
						<div className="set-row-info">
							<div className="set-row-name">{p.id}</div>
							{expanded ? (
								<>
									<p className="set-hint">
										{t("settingsJevPropositionInstructions")}：{p.instructions || "—"}
									</p>
									<p className="set-hint">
										{t("settingsJevPropositionTrue")}：{p.criteria.true || "—"}
									</p>
									<p className="set-hint">
										{t("settingsJevPropositionFalse")}：{p.criteria.false || "—"}
									</p>
								</>
							) : (
								<div className="set-row-desc">{brief(p.instructions)}</div>
							)}
						</div>
						<button type="button" className="set-btn-mini" onClick={() => setOpen(expanded ? null : p.id)}>
							{expanded ? t("collapseSection") : t("expandSection")}
						</button>
					</div>
				);
			})}
		</div>
	);
}

/**
 * 余额行：**复用网关自报用量**（同一个数字口径、同一套状态色，见 GatewayUsageBlock）。
 * @WHY 以前这里自己去找「配了账户查询的渠道」——多渠道时代的产物；单网关接入后余额只有一个
 *   来源（网关自己的账单接口），再留一条并行查询路径就是两份真相、两个可能不一致的数字。
 * @CONTRACT Jev 用的模型如果不在网关上，GatewayUsageBlock 会明确标注读数归属
 *   （gatewayUsageMismatch），不假装这是 Jev 那个服务商的余额。
 */
export function JevBalance({
	gatewayUsage,
	providerId,
	onRefresh,
}: {
	gatewayUsage: GatewayUsageState;
	providerId: string;
	/** 手动刷新（force）。 */
	onRefresh: () => void;
}) {
	return <GatewayUsageBlock state={gatewayUsage} activeProvider={providerId} onRefresh={onRefresh} />;
}

/**
 * 三条回包的回执区（状态读取失败 / 保存结果 / 自检结果）。
 * @CONTRACT 成功与失败都要看得见：保存被拒必须带服务端双语原因，不能静默失败。
 * @WHY 单独一个组件：JevSettings 的表单部分本来已经很长（≤300 行红线），回包展示又是
 *   「只读展示服务端事实」的同类工作，与 JevRuntimeView 同源。
 */
export function JevReceipts({
	status,
	saveResult,
	probe,
	locale,
}: {
	status: JevStatusMsg | null;
	saveResult: JevConfigResultMsg | null;
	probe: JevProbeResultMsg | null;
	locale: string;
}) {
	const t = useT();
	const statusError = status && !status.ok ? pickError(status, locale) : "";
	const saveApplied = saveResult?.ok === true && saveResult.phase === "applied";
	return (
		<>
			{statusError && (
				<div className="chan-receipt">
					<FiAlertTriangle />
					<span>
						{t("settingsJevStatusFailed")}：{statusError}
					</span>
				</div>
			)}
			{saveResult && (
				<div className={`chan-receipt${saveApplied ? " ok" : ""}`}>
					{saveApplied ? <FiCheck /> : <FiAlertTriangle />}
					<span>
						{saveApplied ? t("settingsJevSaved") : `${t("settingsJevRejected")}：${pickError(saveResult, locale)}`}
					</span>
				</div>
			)}
			{probe && <JevProbeResultView result={probe} locale={locale} />}
		</>
	);
}

/** 自检回包的判定结果：结论 + 理由 + 每项命题的分数（非黑盒的核心）。 */
function JevDecisionView({ decision, locale }: { decision: UiJevDecision; locale: string }) {
	const t = useT();
	const checks = Object.entries(decision.checks);
	const audit = decision.audit;
	return (
		<>
			<div className="chan-account-row">
				<span className="field-label">{t("settingsJevProbeDecision")}</span>
				<span className="chan-meta">{t(outcomeLabelKey(decision.outcome))}</span>
				<span className="chan-meta">{pickReason(decision, locale)}</span>
			</div>
			{checks.length > 0 && (
				<div className="chan-account-row">
					<span className="field-label">{t("settingsJevProbeChecks")}</span>
					{checks.map(([name, score]) => (
						<span className="chan-meta" key={name}>
							{name}={formatScore(score)}
						</span>
					))}
				</div>
			)}
			{/* 审计：这次调用用的是哪个模型/供应商、花了多少 token 与费用、是否命中缓存。 */}
			<div className="chan-account-row">
				<span className="field-label">{t("settingsJevProbeAudit")}</span>
				<span className="chan-meta">
					{audit.model ?? "—"} · {audit.provider ?? "—"} · {formatMs(audit.elapsedMs)} · {t("usageColInput")}{" "}
					{audit.inputTokens ?? "—"} / {t("usageColOutput")} {audit.outputTokens ?? "—"} · {t("usageColCost")}{" "}
					{formatCostOrDash(audit.cost)} · {cacheSourceLabel(audit.cache, locale, t)}
				</span>
			</div>
		</>
	);
}

/**
 * 「测试连接」回包：成功显示结论/理由/逐项分数/审计 + 原始 JSON，失败显示 error/errorEn。
 * 「能不能真的跑通、跑出了什么」全在这里 —— 这是运营者判断门禁是否可用的唯一依据。
 */
export function JevProbeResultView({ result, locale }: { result: JevProbeResultMsg; locale: string }) {
	const t = useT();
	const decision = result.decision;
	if (!result.ok || !decision) {
		const error = pickError(result, locale) || pickError(decision ?? {}, locale);
		return (
			<div className="chan-receipt">
				<FiAlertTriangle />
				<span>{error || t("settingsJevStatusFailed")}</span>
			</div>
		);
	}
	return (
		<>
			<div className={`chan-receipt${decision.error ? "" : " ok"}`}>
				{decision.error ? <FiAlertTriangle /> : <FiCheck />}
				<span>
					{t("settingsJevProbeOk")}
					{decision.error ? ` · ${pickError(decision, locale)}` : ""}
				</span>
			</div>
			<JevDecisionView decision={decision} locale={locale} />
			{/* 原始回包：认不出的字段也不隐藏（运营者要能看到服务端到底回了什么）。 */}
			<pre className="chan-json">{prettyJson(decision)}</pre>
		</>
	);
}
