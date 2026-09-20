/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/FooterBar.tsx（唯一挂载点：缓存命中项之后、消息数之前）,
 *            components/JevRuntimeView.tsx（**复用** JevRuntimeCards：面板与设置页同一份数字）,
 *            components/UsageDetail.tsx（浮层外壳与关闭行为对齐：.usage-panel + .status-cwd-backdrop）,
 *            jev-footer.ts（最近结论的推断：计数差 → 三态；本组件不自己猜）,
 *            jev-decision.ts（outcomeLabelKey / pickError / formatScore 的复用来源）,
 *            use-chat.ts（ChatState.jev.status）,
 *            app/App.tsx（onOpenSettings → dialogs.setSettingsOpen(true)）
 *   @CONTRACT 只读展示。逐条命题分数以设置面板为准：status.runtime 不带分数，所以这里只报
 *             三态计数 + 失败数，并明确指向设置面板，**不用 0 顶替**「没读到」。
 *   @GOTCHA 浮层是 <footer> 的子节点（position:fixed），所以 .statusbar 不能整块 display:none
 *             （会把它一起藏掉）——与 UsageDetail 同一条约束，见 FooterBar 头部 @GOTCHA。
 *   @WHY 最近结论由服务端推送的计数差推断（见 jev-footer.ts）：推送只带聚合数，没有「上一次结论」
 *        字段；能唯一归因才显示，否则显示「—」。
 * ──────────────────────────────────────────────────
 */
import { useState } from "react";
import { useI18n, useT } from "../i18n";
import type { JevStatusMsg } from "../use-chat";
import type { UiJevGateConfig } from "../types";
import { formatScore, outcomeLabelKey, pickError } from "../jev-decision";
import { useLastJevOutcome, verdictTone } from "../jev-footer";
import { JevRuntimeCards } from "./JevRuntimeView";

/**
 * 底栏 Jev 门禁项：最简显示最近结论（三态上色），点开浮层看完整信息。
 * @CONTRACT 状态栏只显示最近一次结论；三态计数/失败数在 title 与浮层里，逐条分数在设置面板。
 */
export function JevFooterItem({
	status,
	onOpenSettings,
}: {
	/** 最近一次 jev_status（服务端主动推送的 reqId:0 与设置面板的回包是同一份存储，都能渲染）。 */
	status: JevStatusMsg | null;
	/** 打开设置面板（由 App 注入 dialogs.setSettingsOpen；未注入时不显示入口）。 */
	onOpenSettings?: () => void;
}) {
	const t = useT();
	const { locale } = useI18n();
	const [open, setOpen] = useState(false);
	// 读取失败的回包没有 status：此时按「无数据」渲染，错误原文进浮层（不在状态栏报错刷屏）。
	const payload = status?.ok ? status.status : undefined;
	const runtime = payload?.runtime ?? null;
	const config = payload?.config ?? null;
	const outcome = useLastJevOutcome(runtime);
	const empty = !runtime || runtime.total === 0;
	const tone = verdictTone(outcome);
	const error = status && !status.ok ? pickError(status, locale) : "";
	// title 的三态计数取不到就写「—」：0 与「没读到」是两件事（同 JevRuntimeView 口径）。
	const count = (v: number | undefined) => (typeof v === "number" ? String(v) : "—");
	const tip = t("footerJevTip", {
		approve: count(runtime?.approve),
		block: count(runtime?.block),
		review: count(runtime?.review),
		failed: count(runtime?.failed),
	});
	return (
		<>
			<button
				type="button"
				className={`status-item status-item-clickable status-jev${open ? " active" : ""}`}
				title={tip}
				onClick={() => setOpen((v) => !v)}
			>
				{empty ? (
					t("footerJevEmpty")
				) : (
					<>
						{t("footerJev")} <b className={`jev-verdict ${tone}`}>{outcome ? t(outcomeLabelKey(outcome)) : "—"}</b>
					</>
				)}
			</button>
			{/* 分隔符与其它状态项一致；放在组件内让 FooterBar 只多一行挂载点。 */}
			<span className="status-sep">·</span>
			{open && (
				<>
					{/* 与 UsageDetail 同一关闭行为：透明 backdrop 点击关闭，浮层自身 fixed 定位。 */}
					<div className="status-cwd-backdrop" onClick={() => setOpen(false)} />
					<div className="usage-panel jev-panel" onClick={(e) => e.stopPropagation()}>
						<div className="usage-panel-head">
							{/* 浮层标题：直接复用设置分区的名字（门禁的详情就是它），不另造一个同义词。 */}
							{t("settingsJev")}
							{onOpenSettings && (
								<button
									type="button"
									className="usage-topup"
									onClick={() => {
										setOpen(false);
										onOpenSettings();
									}}
								>
									{t("settingsTitle")}
								</button>
							)}
						</div>
						{error && <div className="chan-warn">{error}</div>}
						{/* 运行状态卡：与设置面板「Jev 决策门禁」共用同一组件 → 同一份数字。 */}
						<JevRuntimeCards runtime={runtime} locale={locale} />
						<div className="usage-attr-title">{t("footerJevLastDecision")}</div>
						{runtime ? (
							<div className="jev-verdicts">
								<span>
									{t("settingsJevOutcomeApprove")} <b>{runtime.approve}</b>
								</span>
								<span>
									{t("settingsJevOutcomeBlock")} <b>{runtime.block}</b>
								</span>
								<span>
									{t("settingsJevOutcomeReview")} <b>{runtime.review}</b>
								</span>
								<span>
									{t("settingsJevFailures")} <b>{runtime.failed}</b>
								</span>
							</div>
						) : (
							<p className="set-hint">{t("settingsJevRuntimeEmpty")}</p>
						)}
						{/* status.runtime 不带逐条命题分数：如实说明分数在设置面板，不用 0/DOM 假造。 */}
						<p className="set-hint">{t("footerJevDetail")}</p>
						{config && <JevConfigFacts config={config} />}
					</div>
				</>
			)}
		</>
	);
}

/** 当前生效配置的只读展示（阈值 / 端点 / 模型 / 开关）；缺字段写「—」，不猜。 */
function JevConfigFacts({ config }: { config: UiJevGateConfig }) {
	const t = useT();
	return (
		<>
			<div className="usage-attr-title">{t("settingsJevThresholdsTitle")}</div>
			<div className="chan-account-row">
				<span className="field-label">{t("settingsJevApproveAt")}</span>
				<span className="chan-meta">{formatScore(config.thresholds?.approveAt)}</span>
				<span className="field-label">{t("settingsJevBlockAt")}</span>
				<span className="chan-meta">{formatScore(config.thresholds?.blockAt)}</span>
			</div>
			<div className="chan-account-row">
				<span className="field-label">{t("settingsJevEndpoint")}</span>
				<span className="chan-meta">{config.endpoint || "—"}</span>
			</div>
			<div className="chan-account-row">
				<span className="field-label">{t("settingsJevModel")}</span>
				<span className="chan-meta">{config.model || "—"}</span>
				<span className="field-label">{t("settingsJevEnable")}</span>
				<span className="chan-meta">{config.enabled ? t("settingsEnabled") : t("settingsDisabled")}</span>
			</div>
		</>
	);
}
