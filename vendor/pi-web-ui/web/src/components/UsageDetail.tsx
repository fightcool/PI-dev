/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/FooterBar.tsx (打开本面板的触发点 + 状态栏网关项),
 *            components/GatewayUsageBlock.tsx（网关自报用量：本面板与设置页共用同一实现）,
 *            components/UsageHistory.tsx（跨服务商/项目/时间的历史）
 *   📖 docs/NEWAPI-GATEWAY.md §4（两条费用口径为什么不能相加）
 *   @CONTRACT 只读展示。归属按**请求发出时**记录的 providerId 展示：解析不到名字就显示原 id，
 *             绝不按今天的配置猜（旧渠道时代的同名错误见 docs/P0-VERIFICATION.md）。
 *   @GOTCHA 本地估算（stats.cost）与网关自报（GatewayUsageBlock）是两个数字、两套来源：
 *             同屏展示时必须各自标注来源，**绝不相加**，也不要把其中一个说成另一个。
 *   @GOTCHA 缓存读写只来自 SDK 的真实字段；为 0 时整行不渲染（不显示误导性的 0）。
 * ──────────────────────────────────────────────────
 */
import { cacheMetrics } from "../cache-stats";
import type { UiState, UiUsageAttribution, UiUsageRecord } from "../types";
import { useT, type Translate } from "../i18n";
import type { UsageHistoryMsg, UsageHistoryWindow } from "../use-chat";
import type { GatewayUsageState } from "./GatewayUsageBlock";
import { GatewayUsageBlock } from "./GatewayUsageBlock";
import { UsageHistory } from "./UsageHistory";

/** 令牌数的人类可读格式（FooterBar 与明细表共用）。 */
export function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

/** 估算费用：不做币种猜测，只是把服务端给的数值按可读精度显示。 */
export function formatCost(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "0";
	if (n < 0.000001) return "<0.000001";
	return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** 一个用量口径（请求 / 本轮 / 会话）。 */
function ScopeRow({ label, tok }: { label: string; tok: { input: number; output: number; total: number } }) {
	return (
		<tr>
			<td>{label}</td>
			<td>{formatTokens(tok.input)}</td>
			<td>{formatTokens(tok.output)}</td>
			<td>{formatTokens(tok.total)}</td>
		</tr>
	);
}

// 来源标识符 → 文案键（服务端只发标识符；未知来源按「系统」显示，绝不猜具体来源）。
const SOURCE_LABELS: Record<string, Parameters<Translate>[0]> = {
	user: "usageSourceUser",
	retry: "usageSourceRetry",
	subagent: "usageSourceSubagent",
	compaction: "usageSourceCompaction",
	vision: "usageSourceVision",
	review: "usageSourceReview",
	wizard: "usageSourceWizard",
	probe: "usageSourceProbe",
	system: "usageSourceSystem",
};

/**
 * 服务商单元格：记录里只有 providerId。
 * @CONTRACT 有展示名就用展示名（models.json 里配的），没有就显示原 id —— 不猜、不翻译、不隐藏。
 */
function providerCell(providerId: string, names: Record<string, string> | undefined, t: Translate) {
	if (!providerId) return <span className="usage-unattributed">{t("usageUnattributed")}</span>;
	const name = names?.[providerId];
	return name ? <span title={providerId}>{name}</span> : <span className="usage-unknown-channel">{providerId}</span>;
}

export function UsageDetail({
	tokens,
	cost,
	attribution,
	recentRequests,
	usageHistory,
	onQueryUsageHistory,
	runId,
	gatewayUsage,
	activeProvider,
	providerNames,
	onRefreshGatewayUsage,
}: {
	tokens: UiState["stats"]["tokens"];
	cost: number;
	attribution?: UiUsageAttribution[];
	/** §7 最近若干条逐请求记录（时间 + 计价依据）。 */
	recentRequests?: UiUsageRecord[];
	/** P4：用量历史（跨服务商/项目/时间）；null = 尚未查询。 */
	usageHistory?: UsageHistoryMsg | null;
	onQueryUsageHistory?: (groupBy: UsageHistoryMsg["groupBy"], window: UsageHistoryWindow) => void;
	runId?: string | null;
	/** 网关自报用量（与本地估算并列展示，两者不得相加）。 */
	gatewayUsage: GatewayUsageState;
	/** 当前生效模型所属服务商（标注读数归属，见 GatewayUsageBlock）。 */
	activeProvider?: string | null;
	/** 服务商展示名（models.json 的 name）；缺省时显示 providerId。 */
	providerNames?: Record<string, string>;
	onRefreshGatewayUsage?: () => void;
}) {
	const t = useT();
	const request = tokens.request ?? tokens;
	const run = tokens.run ?? tokens;
	/** 会话级缓存指标：与底部状态栏同一个 cacheMetrics（单一口径，不另算一套）。 */
	const sessionCache = cacheMetrics(tokens);
	const rows = attribution ?? [];
	const requests = recentRequests ?? [];
	// A07：没有任何归属记录但会话有用量时，明确说明这些历史用量没有归属，
	// 而不是显示一张空表让人以为没花过 token（未知/缺失归属要诚实展示）。
	const unattributedHistory = rows.length === 0 && tokens.total > 0;
	return (
		<div className="usage-panel" onClick={(e) => e.stopPropagation()}>
			<div className="usage-panel-head">
				{t("usageDetail")}
				{runId && (
					<span className="usage-runid">
						{t("usageRunId")}: {runId}
					</span>
				)}
			</div>

			{/* 网关自报用量放在最上面：它是「账户还剩多少」的答案，本地估算回答的是另一个问题。 */}
			<GatewayUsageBlock state={gatewayUsage} activeProvider={activeProvider} onRefresh={onRefreshGatewayUsage} />

			<table className="usage-scope">
				<thead>
					<tr>
						<th />
						<th>{t("usageColInput")}</th>
						<th>{t("usageColOutput")}</th>
						<th>{t("usageColTotal")}</th>
					</tr>
				</thead>
				<tbody>
					<ScopeRow label={t("usageScopeRequest")} tok={request} />
					<ScopeRow label={t("usageScopeRun")} tok={run} />
					<ScopeRow label={t("usageScopeSession")} tok={tokens} />
				</tbody>
			</table>
			{(tokens.cacheRead > 0 || tokens.cacheWrite > 0) && (
				<div className="usage-cache">
					{tokens.cacheRead > 0 && (
						<span>
							{t("usageCacheRead")} <b>{formatTokens(tokens.cacheRead)}</b>
						</span>
					)}
					{tokens.cacheWrite > 0 && (
						<span>
							{t("usageCacheWrite")} <b>{formatTokens(tokens.cacheWrite)}</b>
						</span>
					)}
					{/* 命中率的忠实口径：read / (miss + read + write)，与底部状态栏同一个 cacheMetrics，
					    不是「各来源百分比的算术平均」（后者会被小样本条目拉偏）。 */}
					<span>
						{t("usageCacheMiss")} <b>{formatTokens(sessionCache.miss)}</b>
					</span>
					<span className="usage-cache-rate">
						{t("usageAvgCacheHitRate")}{" "}
						<b
							className={`cache-pct ${sessionCache.hitRate >= 0.7 ? "ok" : sessionCache.hitRate >= 0.4 ? "mid" : "warn"}`}
						>
							{(sessionCache.hitRate * 100).toFixed(1)}%
						</b>
					</span>
				</div>
			)}
			<div className="usage-cost">
				{t("usageCost")}: <b>{formatCost(cost)}</b>
				<span className="usage-cost-note">{t("usageCostNote")}</span>
			</div>
			<div className="usage-attr-title">{t("usageAttribution")}</div>
			{rows.length === 0 ? (
				<div className="usage-empty">{t("usageAttributionEmpty")}</div>
			) : (
				<table className="usage-attr">
					<thead>
						<tr>
							<th>{t("usageColSource")}</th>
							<th>{t("usageColProvider")}</th>
							<th>{t("usageColModel")}</th>
							<th>{t("usageColRequests")}</th>
							<th>{t("usageColInput")}</th>
							<th>{t("usageColOutput")}</th>
							<th>{t("usageColTotal")}</th>
							<th>{t("usageColCost")}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={`${row.source}|${row.providerId}|${row.modelId}`}>
								<td>{t(SOURCE_LABELS[row.source] ?? "usageSourceSystem")}</td>
								<td>{providerCell(row.providerId, providerNames, t)}</td>
								<td title={row.modelId}>{row.modelId}</td>
								<td>{row.requests}</td>
								<td>{formatTokens(row.input)}</td>
								<td>{formatTokens(row.output)}</td>
								<td>{formatTokens(row.total)}</td>
								<td>{formatCost(row.cost)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{unattributedHistory && (
				<div className="usage-empty" title={t("usageHistoryTip")}>
					{t("usageHistoryUnattributed")}
				</div>
			)}
			{requests.length > 0 && (
				<>
					<div className="usage-attr-title">{t("usageRecentTitle")}</div>
					<table className="usage-recent">
						<thead>
							<tr>
								<th>{t("usageColTime")}</th>
								<th>{t("usageColSource")}</th>
								<th>{t("usageColProvider")}</th>
								<th>{t("usageColModel")}</th>
								<th>{t("usageColTotal")}</th>
								<th>{t("usageColCost")}</th>
							</tr>
						</thead>
						<tbody>
							{requests.map((r: UiUsageRecord) => (
								<tr key={r.id}>
									<td>{new Date(r.at).toLocaleTimeString()}</td>
									<td>{t(SOURCE_LABELS[r.source] ?? "usageSourceSystem")}</td>
									<td>{providerCell(r.providerId, providerNames, t)}</td>
									<td title={r.modelId}>{r.modelId}</td>
									<td>{formatTokens(r.total)}</td>
									<td>
										{r.costBasis === "unknown" && r.total > 0 ? (
											<span className="usage-unknown-price" title={t("usageCostBasisTip")}>
												{t("usageUnknownPrice")}
											</span>
										) : (
											formatCost(r.cost)
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<div className="usage-cost-note">{t("usageCostBasisNote")}</div>
				</>
			)}
			{onQueryUsageHistory && (
				<UsageHistory history={usageHistory ?? null} providerNames={providerNames} onQuery={onQueryUsageHistory} />
			)}
		</div>
	);
}
