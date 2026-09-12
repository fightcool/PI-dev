/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelSettings.tsx（唯一挂载点：渠道列表行）,
 *            components/ChannelForm.tsx（编辑草稿）, channel-models.ts（白名单摘要口径）,
 *            server/dev-con/channel-accounts.ts（账户状态语义）, server/protocol.ts（UiAccountStatus）
 *   📖 docs/DEV-CON-PROPOSAL.md §6（设置页列表）, §7（余额/配额状态）
 *   @CONTRACT 纯展示 + 四个回调（切换/查询/编辑/删除）；不直接发命令，密钥只以 keyName 出现。
 *   @GOTCHA failed/stale 必须显式展示且绝不显示为 0：stale 保留上次成功值与时间；
 *           unsupported 就是「没有可用查询方式」，不猜测余额。
 *   @GOTCHA 白名单摘要要写出来（限定 N 个 / 不限）：渠道「模型变少」必须能被解释。
 *   @WHY 从 ChannelSettings 抽出：列表行 + 账户状态占了大半篇幅，混在一起会让那个文件超长。
 * ──────────────────────────────────────────────────
 */
import { FiEdit3, FiTrash2 } from "react-icons/fi";
import type { UiAccountStatus, UiChannelInfo } from "../types";
import { useT } from "../i18n";

/** 账户状态行：failed/stale 明确标注，绝不把缺失值当成 0。 */
export function AccountStatusLine({ status }: { status: UiAccountStatus | undefined }) {
	const t = useT();
	if (!status) return null;
	const label =
		status.status === "ok"
			? t("channelAccountOk")
			: status.status === "stale"
				? t("channelAccountStale")
				: status.status === "failed"
					? t("channelAccountFailed")
					: t("channelAccountUnsupported");
	const bits: string[] = [];
	if (status.balance !== undefined)
		bits.push(`${t("channelAccountBalance")} ${status.balance}${status.unit ? ` ${status.unit}` : ""}`);
	const q = status.quota;
	if (q)
		bits.push(`${t("channelAccountKeyQuota")} ${q.remaining ?? q.limit ?? q.used ?? "—"}${q.unit ? ` ${q.unit}` : ""}`);
	if (status.checkedAt !== undefined)
		bits.push(`${t("channelAccountCheckedAt")} ${new Date(status.checkedAt).toLocaleString()}`);
	if (status.status === "stale") bits.push(t("channelAccountStaleTip"));
	// 多币种明细（如 DeepSeek 官方可能同时给 CNY/USD）：逐条展示，不做无依据相加。
	const breakdown = status.breakdown ?? [];
	return (
		<span className={`chan-acct ${status.status}`} title={status.error}>
			{label}
			{bits.length > 0 && ` · ${bits.join(" · ")}`}
			{breakdown.length > 1 &&
				breakdown.map((entry) => (
					<span key={entry.currency} className="chan-acct-detail">
						{" · "}
						{entry.currency} {entry.total}
						{(entry.granted > 0 || entry.toppedUp > 0) && `（${t("channelAccountGranted")} ${entry.granted} / ${t("channelAccountToppedUp")} ${entry.toppedUp}）`}
					</span>
				))}
			{status.note && <span className="chan-acct-note"> · {status.note}</span>}
		</span>
	);
}

/** 一个渠道行：引用信息 + 白名单摘要 + 缺失提示 + 启用/查询/编辑/删除。 */
export function ChannelRow({
	channel,
	account,
	querying,
	onToggle,
	onQuery,
	onEdit,
	onDelete,
}: {
	channel: UiChannelInfo;
	account: UiAccountStatus | undefined;
	querying: boolean;
	onToggle: () => void;
	onQuery: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const t = useT();
	// 老快照/夹具可能没有 models（见 channel-models.ts 的 @GOTCHA）：空 = 不限。
	const whitelist = channel.models ?? [];
	return (
		<div className={`chan-row${channel.enabled ? "" : " off"}`}>
			<div className="chan-row-main">
				<span className="chan-name">{channel.displayName}</span>
				<span className="chan-meta">
					{channel.providerId} · {channel.endpointId}
					{channel.credentialRef && ` · ${channel.credentialRef.keyName}`}
					{channel.accountRef && ` · ${channel.accountRef}`}
				</span>
				{/* 白名单摘要：「不限」必须是显式状态（空数组 = 列出该服务商全部模型）。 */}
				<span className="chan-models-summary">
					{whitelist.length > 0 ? t("channelModelsLimited", { n: whitelist.length }) : t("channelModelsUnrestricted")}
				</span>
				{channel.providerMissing && <span className="chan-warn">{t("channelProviderMissing")}</span>}
				{channel.keyMissing && <span className="chan-warn">{t("channelKeyMissing")}</span>}
			</div>
			<div className="chan-row-actions">
				<label className="chan-enable">
					<input type="checkbox" checked={channel.enabled} onChange={onToggle} />
					{t("channelEnabledLabel")}
				</label>
				<button type="button" className="chan-btn" disabled={querying} onClick={onQuery}>
					{querying ? t("channelQuerying") : t("channelQueryAccount")}
				</button>
				<button type="button" className="chan-btn" title={t("channelEdit")} onClick={onEdit}>
					<FiEdit3 />
				</button>
				<button type="button" className="chan-btn danger" title={t("delete")} onClick={onDelete}>
					<FiTrash2 />
				</button>
			</div>
			<AccountStatusLine status={account} />
		</div>
	);
}
