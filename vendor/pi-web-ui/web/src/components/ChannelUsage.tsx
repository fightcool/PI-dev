/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelSettings.tsx（挂载点：渠道设置页的「按渠道用量」）,
 *            components/UsageHistory.tsx（同一份 usageHistory 状态的另一个消费端）,
 *            use-chat.ts（channelApi.queryUsageHistory / state.usageHistory）,
 *            server/dev-con/usage-history.ts（按渠道聚合口径）
 *   📖 docs/DEV-CON-PROPOSAL.md §8 P4（跨渠道/时间用量；只读聚合）
 *   @CONTRACT 只读：用 channelApi.queryUsageHistory("channel", window) 取聚合，不写任何配置。
 *             未归属/未知价格/未上报用量都如实展示，绝不当成 0。
 *   @GOTCHA usageHistory 是**全局共享**状态：用量详情面板可能刚用别的 groupBy 覆盖它。
 *           这里只在 history.groupBy === "channel" 时渲染行，否则显示「正在读取」而不是错位的数字。
 *   @GOTCHA 「该渠道没有记录」显示为「—」而不是 0：0 请求与「没有读到记录」不是一回事。
 *   @WHY 每个渠道一行（含未归属行），因为用户抱怨的正是「渠道没有自己的用量统计」。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import type { UiChannelInfo } from "../types";
import { useT } from "../i18n";
import type { UsageHistoryMsg, UsageHistoryWindow } from "../use-chat";

const WINDOWS: UsageHistoryWindow[] = ["today", "7d", "30d", "all"];

const formatTokens = (n: number): string =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const formatCost = (n: number): string => (n === 0 ? "0" : n < 0.01 ? n.toFixed(4) : n.toFixed(2));

type Row = UsageHistoryMsg["rows"][number];

/** 每个渠道一行：配置里的渠道（缺记录 = —）+ 历史里出现的其他 key（删除/未归属）。 */
function buildRows(channels: UiChannelInfo[], historyRows: Row[]): { key: string; label: string; row: Row | null }[] {
	const byKey = new Map(historyRows.map((r) => [r.key, r]));
	const rows = channels.map((c) => ({ key: c.id, label: c.displayName, row: byKey.get(c.id) ?? null }));
	const known = new Set(channels.map((c) => c.id));
	for (const r of historyRows) if (!known.has(r.key)) rows.push({ key: r.key, label: "", row: r });
	return rows;
}

/**
 * 「按渠道用量」：时间窗 + 每渠道的请求数/Token/费用/最近使用。
 * 未归属行与未知价格、未上报用量都显式标注（复用既有的 i18n 键，口径与用量历史一致）。
 */
export function ChannelUsage({
	channels,
	history,
	onQuery,
}: {
	channels: UiChannelInfo[];
	history: UsageHistoryMsg | null;
	onQuery: (groupBy: "channel", window: UsageHistoryWindow) => number;
}) {
	const t = useT();
	const [window, setWindow] = useState<UsageHistoryWindow>("7d");
	// 打开即拉一次；时间窗变化按新口径重查（服务端按 UTC 切分）。
	useEffect(() => {
		onQuery("channel", window);
	}, [window, onQuery]);
	// 共享状态可能被用量详情面板覆盖成别的 groupBy（见 @GOTCHA）。
	const ready = history?.ok && history.groupBy === "channel" ? history : null;
	const rows = ready ? buildRows(channels, ready.rows) : [];
	const label = (entry: { key: string; label: string }): string =>
		entry.label || (entry.key === "unattributed" ? t("channelUnattributed") : `${t("channelUnattributed")} · ${entry.key}`);

	return (
		<div className="chan-usage">
			<div className="chan-form-title">{t("channelUsageTitle")}</div>
			<div className="chan-usage-controls">
				{WINDOWS.map((w) => (
					<button
						key={w}
						type="button"
						className={`chan-btn${w === window ? " primary" : ""}`}
						// 点当前时间窗 = 重新查询（没有第二次状态变化就不会触发 effect）。
						onClick={() => (w === window ? onQuery("channel", w) : setWindow(w))}
					>
						{t(`usageWindow_${w}` as Parameters<typeof t>[0])}
					</button>
				))}
			</div>
			{!ready ? (
				<div className="usage-empty">{t("usageHistoryLoading")}</div>
			) : rows.length === 0 ? (
				<div className="usage-empty">{t("usageHistoryEmpty")}</div>
			) : (
				<>
					<table className="chan-usage-table">
						<thead>
							<tr>
								<th>{t("channelFooter")}</th>
								<th>{t("usageColRequests")}</th>
								<th>{t("usageColInput")}</th>
								<th>{t("usageColOutput")}</th>
								<th>{t("usageColTotal")}</th>
								<th>{t("usageColCost")}</th>
								<th>{t("channelUsageLastUsed")}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((entry) => {
								const row = entry.row;
								if (!row) {
									// 没有记录 ≠ 0 用量：整行显示「—」（见 @GOTCHA）。
									return (
										<tr key={entry.key} className="chan-usage-empty-row">
											<td>{label(entry)}</td>
											<td colSpan={6}>{t("channelUsageNoRecords")}</td>
										</tr>
									);
								}
								return (
									<tr key={entry.key}>
										<td>{label(entry)}</td>
										<td>{row.requests}</td>
										<td>{formatTokens(row.input)}</td>
										<td>{formatTokens(row.output)}</td>
										<td>{formatTokens(row.total)}</td>
										<td>
											{formatCost(row.cost)}
											{(row.unreportedRequests ?? 0) > 0 && (
												<span className="usage-unknown-price" title={t("usageCostBasisTip")}>
													{" "}
													{t("usageHistoryUnreported", { n: row.unreportedRequests })}
												</span>
											)}
											{(row.unpricedRequests ?? 0) > 0 && (
												<span className="usage-unknown-price" title={t("usageCostBasisTip")}>
													{" "}
													{t("usageHistoryUnpriced", { n: row.unpricedRequests })}
												</span>
											)}
										</td>
										<td>{row.lastAt ? new Date(row.lastAt).toLocaleString() : "—"}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					<div className="usage-cost-note">
						{t("usageHistoryWindowNote")}
						{ready.truncated && ` · ${t("usageHistoryTruncated")}`}
					</div>
				</>
			)}
		</div>
	);
}
