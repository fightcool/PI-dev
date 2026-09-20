/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/FooterBar.tsx (打开本面板的触发点 + 有效渠道显示),
 *            use-chat.ts (channelState.channels 用于把 channelId 解析成显示名),
 *            channel-account.ts（formatAmount = 全局唯一金额口径；余额/已用两行经
 *            balanceTextOf/usedTextOf 走它，与 chip、设置页渠道行同数字）
 *   📖 docs/DEV-CON-PROPOSAL.md §7（请求/运行/会话口径、渠道归属、未知归属诚实地标未归属）
 *   @CONTRACT 只读展示。归属按「请求发出时」记录的 channelId 展示——渠道改名/删除不会把旧用量
 *             挪到新渠道；channelId 缺失一律显示「未归属」，解析不到名字时显示原 id 而不是猜名字。
 *   @GOTCHA 缓存读写只来自 SDK 的真实字段；为 0 时整行不渲染（不显示误导性的 0）。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useRef } from "react";
import { cacheMetrics } from "../cache-stats";
import type { UiChannelInfo, UiState, UiUsageAttribution, UiUsageRecord } from "../types";
import { useT, type Translate } from "../i18n";
import type { UsageHistoryMsg, UsageHistoryWindow } from "../use-chat";
import {
	accountStateView,
	BALANCE_REFRESH_MS,
	balanceTextOf,
	isAccountQueryFailed,
	type ChannelAccountView,
	topupUrlOf,
	usedTextOf,
} from "../channel-account";
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

/**
 * 用量详情面板：请求/本轮/会话口径 + 缓存读写（非零才显示）+ 按来源/渠道/模型的归属表。
 * 由底栏的令牌项点开（overlay，不占用输入区）。
 */
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

export function UsageDetail({
	tokens,
	cost,
	attribution,
	recentRequests,
	usageHistory,
	onQueryUsageHistory,
	runId,
	channels,
	accountView,
	onRetryAccount,
}: {
	tokens: UiState["stats"]["tokens"];
	cost: number;
	attribution?: UiUsageAttribution[];
	/** §7 最近若干条逐请求记录（时间 + 计价依据）。 */
	recentRequests?: UiUsageRecord[];
	/** P4：用量历史（跨渠道/项目/时间）；null = 尚未查询。 */
	usageHistory?: UsageHistoryMsg | null;
	onQueryUsageHistory?: (groupBy: UsageHistoryMsg["groupBy"], window: UsageHistoryWindow) => void;
	runId?: string | null;
	channels: UiChannelInfo[];
	/** 当前对话对应渠道的账户快照（chip 点开就看这里；主界面只说「余额未知」，细节在这里）。 */
	accountView?: ChannelAccountView;
	/** 手动重试余额查询（连续失败后自动刷新会降级成慢速探测，点一下立即恢复）。 */
	onRetryAccount?: (channelId: string) => void;
}) {
	const t = useT();
	// 面板一打开就补一次（手机后台会把定时器挂起，回到前台不一定有 visibilitychange）。
	// @CONTRACT 只在「打开这一刻」查一次：快照后面再变也不会反复打接口（服务端另有 10 秒限频）。
	const accountChannel = accountView?.channel ?? null;
	const accountStatus = accountView?.account;
	const accountFreshRef = useRef(false);
	accountFreshRef.current =
		accountStatus?.status === "ok" && Date.now() - (accountStatus.checkedAt ?? 0) < BALANCE_REFRESH_MS;
	const queryAccountRef = useRef(onRetryAccount);
	queryAccountRef.current = onRetryAccount;
	useEffect(() => {
		if (!accountChannel || accountFreshRef.current) return;
		queryAccountRef.current?.(accountChannel.id);
	}, [accountChannel]);
	const request = tokens.request ?? tokens;
	const run = tokens.run ?? tokens;
	/** 会话级缓存指标：与底部状态栏同一个 cacheMetrics（单一口径，不另算一套）。 */
	const sessionCache = cacheMetrics(tokens);
	const rows = attribution ?? [];
	const requests = recentRequests ?? [];
	// A07：没有任何归属记录但会话有用量时，明确说明「这些历史用量没有渠道归属」，
	// 而不是显示一张空表让人以为没花过 token（未知/缺失归属要诚实展示）。
	const unattributedHistory = rows.length === 0 && tokens.total > 0;
	/** 渠道列：记录里的 channelId 优先解析成显示名；解析不到就显示原 id（绝不猜名字）。 */
	const channelCell = (row: UiUsageAttribution) => {
		if (!row.channelId) return <span className="usage-unattributed">{t("channelUnattributed")}</span>;
		const known = channels.find((c) => c.id === row.channelId);
		// 渠道已被删除/改名：显示的只能是当时记录的原 id，并明确标为未归属，不显示成正常渠道。
		if (!known)
			return (
				<span className="usage-unknown-channel" title={t("channelUnknownTip")}>
					{t("channelUnattributed")} · {row.channelId}
				</span>
			);
		return (
			<span>
				{known.displayName}
				{row.credentialKeyName && <span className="usage-key">{row.credentialKeyName}</span>}
			</span>
		);
	};
	/**
	 * 渠道账户区：主界面只说「余额未知」，一切细节（余额/已用/查询时间/说明/原始报错）在这里。
	 * @CONTRACT 面向用户：标签用人话，说明用一句话；技术原因只在失败时附在后面。
	 *   stale 要分出两种：数据只是旧了（中性，给「刷新」）vs 上次查询失败（警示，给「重试」）。
	 */
	const accountSection = (() => {
		const view = accountView;
		const channel = view?.channel ?? null;
		if (!view || !channel) return null;
		const status = view.account;
		const used = usedTextOf(status);
		const state = accountStateView(status);
		const failed = isAccountQueryFailed(status);
		return (
			<div className="usage-account">
				<div className="usage-account-head">
					{t("channelAccountDetailTitle")}
					<span className="usage-account-channel">{channel.displayName}</span>
					<span className={`chan-acct ${status?.status ?? "unknown"} ${state.tone}`}>{t(state.labelKey)}</span>
				</div>
				<div className="usage-account-rows">
					<span>
						{t("channelAccountBalance")}：{balanceTextOf(status, t as (k: string) => string)}
					</span>
					{used !== null && (
						<span>
							{t("channelAccountUsed")}：{used}
						</span>
					)}
					{typeof status?.checkedAt === "number" && (
						<span>
							{t("channelAccountCheckedAt")}：{new Date(status.checkedAt).toLocaleString()}
						</span>
					)}
					{/* 让用户知道这是自动更新的，不用自己反复点。 */}
					<span className="usage-account-auto">{t("channelAccountAutoRefresh")}</span>
				</div>
				{state.tipKey && <div className="usage-account-note">{t(state.tipKey)}</div>}
				{(status?.note || status?.error) && (
					<div className="usage-account-note">
						{status?.note}
						{status?.note && status?.error ? " · " : ""}
						{status?.error}
					</div>
				)}
				{view.derived && <div className="usage-account-note">{t("channelBalanceDerived")}</div>}
				{/* 手动入口：失败时叫「重试」（自动刷新已降级），成功/数据旧时叫「刷新」——
				   不给用户一个「只能等自动刷新」的死角。 */}
				{(failed || state.tone === "aging" || state.tone === "unknown") && onRetryAccount && (
					<div className="usage-account-retry">
						{failed && <span>{t("channelAccountRetryHint")}</span>}
						<button type="button" className="usage-topup" onClick={() => onRetryAccount(channel.id)}>
							{failed ? t("channelAccountRetry") : t("channelAccountRefresh")}
						</button>
					</div>
				)}
			</div>
		);
	})();
	/** 「去充值」：标题右侧的直达链接（渠道配置了充值时地址才出现）。 */
	const topupUrl = topupUrlOf(accountView?.channel);
	return (
		<div className="usage-panel" onClick={(e) => e.stopPropagation()}>
			<div className="usage-panel-head">
				{t("usageDetail")}
				{runId && (
					<span className="usage-runid">
						{t("usageRunId")}: {runId}
					</span>
				)}
				{topupUrl && (
					<a className="usage-topup" href={topupUrl} target="_blank" rel="noopener noreferrer">
						{t("channelTopUp")}
					</a>
				)}
			</div>
			{accountSection}
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
							<th>{t("usageColChannel")}</th>
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
							<tr key={`${row.source}|${row.channelId ?? "-"}|${row.providerId}|${row.modelId}`}>
								<td>{t(SOURCE_LABELS[row.source] ?? "usageSourceSystem")}</td>
								<td>{channelCell(row)}</td>
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
								<th>{t("usageColChannel")}</th>
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
									<td>{requestsChannelCell(r, channels, t)}</td>
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
				<UsageHistory history={usageHistory ?? null} channels={channels} onQuery={onQueryUsageHistory} />
			)}
		</div>
	);
}

/**
 * 逐请求记录的渠道单元格：与聚合表同样的「不猜名字」规则 —— 记录里只有 channelId 引用，
 * 名字用当前渠道表解析；解析不到（已删除/改名）就只显示原 id 并标未归属，绝不写成本渠道。
 */
function requestsChannelCell(
	row: { channelId: string | null; credentialKeyName: string | null },
	channels: UiChannelInfo[],
	t: Translate,
) {
	if (!row.channelId) return <span className="usage-unattributed">{t("channelUnattributed")}</span>;
	const known = channels.find((c) => c.id === row.channelId);
	if (!known)
		return (
			<span className="usage-unknown-channel" title={t("channelUnknownTip")}>
				{t("channelUnattributed")} · {row.channelId}
			</span>
		);
	return (
		<span>
			{known.displayName}
			{row.credentialKeyName && <span className="usage-key">{row.credentialKeyName}</span>}
		</span>
	);
}
