/* 🍞 AI Breadcrumb — @COUPLED web/src/use-chat.ts（queryUsageHistory / state.usageHistory）,
 *   web/src/components/UsageDetail.tsx（面板内嵌本组件）, server/dev-con/usage-history.ts（聚合口径）
 * 📖 docs/DEV-CON-PROPOSAL.md §8 P4 首个切片（跨渠道/项目/时间历史）
 * @CONTRACT 只读展示服务端聚合结果：分组键是记录里的引用，未知/缺失按「未归属」显示，
 *   未知价格按「未知价格」显示（不是 0），触到扫描上限时明确标注结果不完整。
 */
import { memo, useEffect, useState } from "react";
import type { UiChannelInfo } from "../types";
import { useT } from "../i18n";
import type { UsageHistoryMsg, UsageHistoryWindow } from "../use-chat";

const GROUPS: UsageHistoryMsg["groupBy"][] = ["channel", "project", "model", "source", "day"];
const WINDOWS: UsageHistoryWindow[] = ["today", "7d", "30d", "all"];

const formatTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const formatCost = (n: number): string => (n === 0 ? "0" : n < 0.01 ? n.toFixed(4) : n.toFixed(2));

export const UsageHistory = memo(function UsageHistory({
	history,
	channels,
	onQuery,
}: {
	history: UsageHistoryMsg | null;
	channels: UiChannelInfo[];
	onQuery: (groupBy: UsageHistoryMsg["groupBy"], window: UsageHistoryWindow) => void;
}) {
	const t = useT();
	const [groupBy, setGroupBy] = useState<UsageHistoryMsg["groupBy"]>("channel");
	const [window, setWindow] = useState<UsageHistoryWindow>("7d");
	// 打开面板即拉一次；分组/时间窗变化时按新口径重查（服务端每天切分按 UTC）。
	useEffect(() => {
		onQuery(groupBy, window);
	}, [groupBy, window, onQuery]);

	/** 分组键 → 可读标签；渠道/项目缺名字时只显示原值，绝不猜。 */
	const label = (key: string): string => {
		if (key === "unattributed") return t("channelUnattributed");
		if (groupBy === "channel") return channels.find((c) => c.id === key)?.displayName ?? `${t("channelUnattributed")} · ${key}`;
		return key;
	};

	return (
		<div className="usage-history">
			<div className="usage-attr-title">{t("usageHistoryTitle")}</div>
			<div className="usage-history-controls">
				<span className="usage-history-group">
					{GROUPS.map((g) => (
						<button key={g} type="button" className={`chan-btn${g === groupBy ? " primary" : ""}`} onClick={() => setGroupBy(g)}>
							{t(`usageGroup_${g}` as Parameters<typeof t>[0])}
						</button>
					))}
				</span>
				<span className="usage-history-window">
					{WINDOWS.map((w) => (
						<button key={w} type="button" className={`chan-btn${w === window ? " primary" : ""}`} onClick={() => setWindow(w)}>
							{t(`usageWindow_${w}` as Parameters<typeof t>[0])}
						</button>
					))}
				</span>
			</div>
			{!history ? (
				<div className="usage-empty">{t("usageHistoryLoading")}</div>
			) : !history.ok ? (
				<div className="usage-empty">{history.error ?? t("usageHistoryUnavailable")}</div>
			) : history.rows.length === 0 ? (
				<div className="usage-empty">{t("usageHistoryEmpty")}</div>
			) : (
				<>
					<table className="usage-attr usage-history-table">
						<thead>
							<tr>
								<th>{t(`usageGroup_${history.groupBy}` as Parameters<typeof t>[0])}</th>
								<th>{t("usageColRequests")}</th>
								<th>{t("usageColInput")}</th>
								<th>{t("usageColOutput")}</th>
								<th>{t("usageColTotal")}</th>
								<th>{t("usageColCost")}</th>
							</tr>
						</thead>
						<tbody>
							{history.rows.map((row) => (
								<tr key={row.key}>
									<td title={row.key}>{label(row.key)}</td>
									<td>{row.requests}</td>
									<td>{formatTokens(row.input)}</td>
									<td>{formatTokens(row.output)}</td>
									<td>{formatTokens(row.total)}</td>
									<td>
										{formatCost(row.cost)}
										{row.unpricedRequests > 0 && (
											<span className="usage-unknown-price" title={t("usageCostBasisTip")}>
												{" "}
												{t("usageHistoryUnpriced", { n: row.unpricedRequests })}
											</span>
										)}
									</td>
								</tr>
							))}
							<tr className="usage-history-total">
								<td>{t("usageHistoryTotals")}</td>
								<td>{history.totals.requests}</td>
								<td>{formatTokens(history.totals.input)}</td>
								<td>{formatTokens(history.totals.output)}</td>
								<td>{formatTokens(history.totals.total)}</td>
								<td>{formatCost(history.totals.cost)}</td>
							</tr>
						</tbody>
					</table>
					<div className="usage-cost-note">
						{t("usageHistoryWindowNote")}
						{history.truncated && ` · ${t("usageHistoryTruncated")}`}
						{history.skipped > 0 && ` · ${t("usageHistorySkipped", { n: history.skipped })}`}
					</div>
				</>
			)}
		</div>
	);
});
