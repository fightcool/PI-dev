/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/FooterBar.tsx (打开本面板的触发点 + 有效渠道显示),
 *            use-chat.ts (channelState.channels 用于把 channelId 解析成显示名)
 *   📖 docs/DEV-CON-PROPOSAL.md §7（请求/运行/会话口径、渠道归属、未知归属诚实地标未归属）
 *   @CONTRACT 只读展示。归属按「请求发出时」记录的 channelId 展示——渠道改名/删除不会把旧用量
 *             挪到新渠道；channelId 缺失一律显示「未归属」，解析不到名字时显示原 id 而不是猜名字。
 *   @GOTCHA 缓存读写只来自 SDK 的真实字段；为 0 时整行不渲染（不显示误导性的 0）。
 * ──────────────────────────────────────────────────
 */
import type { UiChannelInfo, UiState, UiUsageAttribution } from "../types";
import { useT } from "../i18n";

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
export function UsageDetail({
	tokens,
	cost,
	attribution,
	runId,
	channels,
}: {
	tokens: UiState["stats"]["tokens"];
	cost: number;
	attribution?: UiUsageAttribution[];
	runId?: string | null;
	channels: UiChannelInfo[];
}) {
	const t = useT();
	const request = tokens.request ?? tokens;
	const run = tokens.run ?? tokens;
	const rows = attribution ?? [];
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
								<td>{row.source}</td>
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
		</div>
	);
}
