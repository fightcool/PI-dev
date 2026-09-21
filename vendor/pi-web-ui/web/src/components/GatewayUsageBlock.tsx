/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/UsageDetail.tsx（用量面板的网关区）, components/GatewaySettings.tsx（设置 → 网关）,
 *            components/FooterBar.tsx（状态栏网关项的点开内容）, web/src/gateway-usage.ts（数字口径）,
 *            use-chat.ts（state.gatewayUsage）
 *   📖 docs/NEWAPI-GATEWAY.md §4（网关自报 vs 本地估算：为什么不能相加）
 *   @CONTRACT 只显示**网关自报**的数字；拿不到就说拿不到（unsupported / 未报告 / 失败原因），
 *             绝不补零、绝不用本地估算顶上。
 *   @GOTCHA 「不是网关」与「网关连不上」必须分开说：前者是永久事实（直连上游没有账单接口），
 *             后者值得重试。服务端用 unsupported 标志区分，界面不得靠文案字符串判断。
 *   @GOTCHA 读数默认是**累计**（windowDays 缺省）：该部署忽略日期窗口（实测见文档），
 *             写成「近 30 天」就是替网关说谎。
 * ──────────────────────────────────────────────────
 */
import { FiAlertCircle, FiRefreshCw } from "react-icons/fi";
import type { UiGatewayUsage } from "../types";
import { gatewayUsageBelongsTo, gatewayUsageFacts, isGatewayUsageStale } from "../gateway-usage";
import { useT } from "../i18n";

export interface GatewayUsageState {
	ok: boolean | null;
	usage?: UiGatewayUsage;
	error?: string;
	/** 该服务商没有账单接口（永久事实，不是故障）。 */
	unsupported?: boolean;
	/** 查询进行中。 */
	busy?: boolean;
}

/**
 * 网关自报用量区块（面板/设置共用）。
 * @WHY 单独抽出来的原因：同一份数字要在三处出现（状态栏、用量面板、设置页），
 *   三处各写一套格式与措辞必然漂移 —— 「已用 $0.0011」在一处、在另一处变「$0.00」。
 */
export function GatewayUsageBlock({
	state,
	activeProvider,
	onRefresh,
	refreshDisabled,
}: {
	state: GatewayUsageState;
	/** 当前生效模型所属服务商：读数不属于它就明确标注，不让用户误当成当前网关的数。 */
	activeProvider?: string | null;
	onRefresh?: () => void;
	refreshDisabled?: boolean;
}) {
	const t = useT();
	const usage = state.usage;
	const facts = gatewayUsageFacts(usage);
	const belongs = gatewayUsageBelongsTo(usage, activeProvider ?? null);
	const stale = usage ? isGatewayUsageStale(usage) : false;
	return (
		<div className="gw-usage">
			<div className="gw-usage-head">
				<span className="gw-usage-title">{t("gatewayUsageTitle")}</span>
				{onRefresh && (
					<button
						type="button"
						className="gw-usage-refresh"
						onClick={onRefresh}
						disabled={refreshDisabled || state.busy}
						title={t("gatewayUsageRefresh")}
					>
						<FiRefreshCw className={state.busy ? "spin" : undefined} />
						{state.busy ? t("gatewayUsageBusy") : t("gatewayUsageRefresh")}
					</button>
				)}
			</div>

			{/* 「不是网关」是永久事实：说清楚 + 不给重试（重试一万次也还是没有这个接口）。 */}
			{state.unsupported ? (
				<p className="set-hint gw-usage-note">{t("gatewayUsageUnsupported")}</p>
			) : state.ok === false && !usage ? (
				<p className="gw-usage-error">
					<FiAlertCircle /> {state.error ?? t("gatewayUsageFailed")}
				</p>
			) : !facts ? (
				<p className="set-hint gw-usage-note">{state.busy ? t("gatewayUsageBusy") : t("gatewayUsageNone")}</p>
			) : (
				<>
					<div className="gw-usage-figures">
						<span className="gw-usage-figure">
							<span className="gw-usage-label">{t("gatewayUsageUsed")}</span>
							<b>{facts.usedText ?? t("gatewayUsageNotReported")}</b>
						</span>
						{facts.limitText && (
							<span className="gw-usage-figure">
								<span className="gw-usage-label">{t("gatewayUsageLimit")}</span>
								<b>{facts.limitText}</b>
							</span>
						)}
						{facts.remainingText && (
							<span className="gw-usage-figure">
								<span className="gw-usage-label">{t("gatewayUsageRemaining")}</span>
								<b>{facts.remainingText}</b>
							</span>
						)}
					</div>
					<p className="set-hint gw-usage-note">
						{facts.scope === "window"
							? t("gatewayUsageScopeWindow", { days: String(facts.windowDays ?? "") })
							: t("gatewayUsageScopeCumulative")}
						{facts.unlimited ? ` · ${t("gatewayUsageUnlimited")}` : ""}
						{usage?.baseUrl ? ` · ${usage.baseUrl}` : ""}
						{facts.checkedAtText ? ` · ${t("gatewayUsageCheckedAt")} ${facts.checkedAtText}` : ""}
						{stale ? ` · ${t("gatewayUsageStale")}` : ""}
					</p>
					{!belongs && usage && (
						<p className="set-hint gw-usage-note">{t("gatewayUsageMismatch", { provider: usage.providerId })}</p>
					)}
					{/* 这一行是刻意的：两个数字看起来都像「花了多少钱」，混在一起看必然误读。 */}
					<p className="set-hint gw-usage-note">{t("gatewayUsageHint")}</p>
				</>
			)}
			{state.ok === false && !!usage && (
				<p className="gw-usage-error">
					<FiAlertCircle /> {state.error ?? t("gatewayUsageFailed")}
				</p>
			)}
		</div>
	);
}
