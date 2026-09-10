/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelForm.tsx (新建/编辑表单), components/SettingsModal.tsx (挂载为「渠道」分区),
 *            app/app-dialogs.tsx (channelApi),
 *            use-chat.ts (channelApi.saveChannel/deleteChannel/setChannelDefault/queryChannelAccount),
 *            server/dev-con/channel-service.ts + channel-accounts.ts (校验、revision、账户状态语义)
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道档案/默认值/revision 冲突）, §6（设置页）, §7（余额/配额状态）
 *   @CONTRACT 只提交 channel_save / channel_delete / channel_set_default / channel_query_account；
 *             凭据只按 provider-keys.json 的名称引用，密钥正文永不进入本组件。
 *   @GOTCHA failed/stale 必须显式展示且绝不显示为 0：stale 保留上次成功值与时间；
 *           unsupported 就是「没有可用查询方式」，不猜测余额。
 *   @ASSUME channel_state 的渠道视图不下发 extra（服务端 channelViews 只给引用字段），
 *           因此编辑时账户接口字段留空并「不提交 extra」＝保持服务端已有配置，而不是清空它。
 *   @WHY 账户接口用独立字段（kind/url/unit/scale）而不是原始 JSON 文本框：提交前能逐项校验，
 *        也不会把人工粘贴的 JSON 里的密钥字段悄悄写进渠道元数据（服务端同样拒绝）。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { FiAlertTriangle, FiEdit3, FiPlus, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import type { ChannelApi, ChannelCommandResult, ChannelStateMsg } from "../use-chat";
import type { ModelInfo, ProviderKeyInfo, UiAccountStatus, UiChannelInfo } from "../types";
import { useI18n, useT } from "../i18n";
import { ChannelForm, channelDraftOf, type ChannelDraft } from "./ChannelForm";

/** 账户状态行：failed/stale 明确标注，绝不把缺失值当成 0。 */
function AccountStatusLine({ status }: { status: UiAccountStatus | undefined }) {
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
	return (
		<span className={`chan-acct ${status.status}`} title={status.error}>
			{label}
			{bits.length > 0 && ` · ${bits.join(" · ")}`}
		</span>
	);
}

function ChannelRow({
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
	return (
		<div className={`chan-row${channel.enabled ? "" : " off"}`}>
			<div className="chan-row-main">
				<span className="chan-name">{channel.displayName}</span>
				<span className="chan-meta">
					{channel.providerId} · {channel.endpointId}
					{channel.credentialRef && ` · ${channel.credentialRef.keyName}`}
					{channel.accountRef && ` · ${channel.accountRef}`}
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

/** 项目/实例默认：选渠道 + 该渠道服务商的模型，再设为/清除默认。 */
function DefaultRow({
	scope,
	label,
	current,
	channels,
	models,
	api,
	issue,
}: {
	scope: "instance" | "project";
	label: string;
	current: { channelId: string; modelId: string } | null;
	channels: UiChannelInfo[];
	models: ModelInfo[];
	api: ChannelApi;
	issue: (commandId: string | null) => void;
}) {
	const t = useT();
	const [channelId, setChannelId] = useState(current?.channelId ?? "");
	const [modelId, setModelId] = useState(current?.modelId ?? "");
	useEffect(() => {
		setChannelId(current?.channelId ?? "");
		setModelId(current?.modelId ?? "");
	}, [current?.channelId, current?.modelId]);
	// 只有可用渠道能被设为默认（禁用/服务商缺失/凭据丢失的渠道服务端也会拒绝）。
	const usable = channels.filter((c) => c.enabled && !c.providerMissing && !c.keyMissing);
	const providerId = usable.find((c) => c.id === channelId)?.providerId;
	return (
		<div className="chan-default-row">
			<span className="chan-default-label">{label}</span>
			<span className="chan-meta">
				{current ? `${current.channelId} · ${current.modelId}` : t("channelDefaultNone")}
			</span>
			<select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
				<option value="" disabled>
					{t("channelDefaultChannel")}
				</option>
				{usable.map((c) => (
					<option key={c.id} value={c.id}>
						{c.displayName}
					</option>
				))}
			</select>
			<select value={modelId} onChange={(e) => setModelId(e.target.value)}>
				<option value="" disabled>
					{t("channelDefaultModel")}
				</option>
				{models
					.filter((m) => !providerId || m.provider === providerId)
					.map((m) => (
						<option key={m.id} value={m.id}>
							{m.name}
						</option>
					))}
			</select>
			{/* 不传 credentialKeyName：服务端按渠道档案的默认凭据解析（避免 UI 二次猜测）。 */}
			<button
				type="button"
				className="chan-btn"
				disabled={!channelId || !modelId}
				onClick={() => issue(api.setChannelDefault(scope, { channelId, modelId }))}
			>
				{t("channelSetDefault")}
			</button>
			<button
				type="button"
				className="chan-btn"
				disabled={!current}
				onClick={() => issue(api.setChannelDefault(scope, null))}
			>
				{t("channelClearDefault")}
			</button>
		</div>
	);
}

/**
 * DEV-CON 渠道设置面板：渠道列表（含账户状态与查询）、新建/编辑表单、项目/实例默认。
 * 自包含：所有数据经 props 传入，变更只走 channelApi（服务端 revision 复核 + 回执）。
 */
export function ChannelSettings({
	channelState,
	channelResults,
	channelApi,
	providerIds,
	providerKeys,
	models,
}: {
	channelState: ChannelStateMsg | null;
	channelResults: Record<string, ChannelCommandResult>;
	channelApi: ChannelApi;
	/** 可选服务商 id（由 models + providers 派生，调用方去重排序）。 */
	providerIds: string[];
	providerKeys: Record<string, ProviderKeyInfo[]>;
	models: ModelInfo[];
}) {
	const t = useT();
	const { locale } = useI18n();
	const channels = channelState?.channels ?? [];
	const accounts = channelState?.accounts ?? [];
	/** 表单草稿：null = 未在编辑（列表视图）。 */
	const [draft, setDraft] = useState<ChannelDraft | null>(null);
	const [querying, setQuerying] = useState<{ commandId: string; channelId: string } | null>(null);
	/** 本面板发起的最近一条命令：只展示它的回执（冲突时给刷新入口）。 */
	const [lastCommand, setLastCommand] = useState<string | null>(null);
	const issue = (commandId: string | null) => {
		if (commandId) setLastCommand(commandId);
	};
	const receipt = lastCommand ? channelResults[lastCommand] : undefined;
	// 查询回执一到就结束「查询中…」（失败同样结束，状态由 accounts 显式呈现）。
	useEffect(() => {
		if (querying && channelResults[querying.commandId]) setQuerying(null);
	}, [querying, channelResults]);

	/** 服务端账户快照以 `accountRef || channel.id` 为键（channel-accounts.ts），此处同样回退。 */
	const accountFor = (c: UiChannelInfo) => accounts.find((a) => a.accountRef === (c.accountRef || c.id));
	const receiptText = receipt
		? locale !== "zh" && receipt.errorEn
			? receipt.errorEn
			: (receipt.error ?? receipt.errorEn ?? "")
		: "";

	return (
		<div className="chan-settings">
			<div className="chan-settings-head">
				<button
					type="button"
					className="chan-btn primary"
					onClick={() => setDraft(channelDraftOf(null, providerIds[0] ?? ""))}
				>
					<FiPlus /> {t("channelAdd")}
				</button>
				<button type="button" className="chan-btn" onClick={() => channelApi.listChannels()}>
					<FiRefreshCw /> {t("bgTaskRefresh")}
				</button>
			</div>
			{receipt && !receipt.ok && (
				<div className={`chan-receipt${receipt.phase === "conflict" ? " conflict" : ""}`}>
					<FiAlertTriangle />
					<span>{receipt.phase === "conflict" ? t("channelConflict") : receiptText || t("channelRejected")}</span>
					{receipt.phase === "conflict" && (
						<button type="button" className="chan-btn" onClick={() => channelApi.listChannels()}>
							{t("channelRefresh")}
						</button>
					)}
				</div>
			)}
			{channels.length === 0 && <p className="set-hint">{t("channelListEmpty")}</p>}
			{channels.map((c) => (
				<ChannelRow
					key={c.id}
					channel={c}
					account={accountFor(c)}
					querying={querying?.channelId === c.id}
					onToggle={() =>
						issue(
							channelApi.saveChannel({
								id: c.id,
								displayName: c.displayName,
								providerId: c.providerId,
								endpointId: c.endpointId,
								credentialRef: c.credentialRef,
								accountRef: c.accountRef,
								enabled: !c.enabled,
							}),
						)
					}
					onQuery={() => {
						const commandId = channelApi.queryChannelAccount(c.id);
						if (commandId) setQuerying({ commandId, channelId: c.id });
						issue(commandId);
					}}
					onEdit={() => setDraft(channelDraftOf(c, c.providerId))}
					onDelete={() => {
						if (!window.confirm(t("channelDeleteConfirm", { name: c.displayName }))) return;
						issue(channelApi.deleteChannel(c.id));
					}}
				/>
			))}
			{draft && (
				<ChannelForm
					key={draft.id ?? "new"}
					draft={draft}
					providerIds={providerIds}
					providerKeys={providerKeys}
					onSave={(payload) => {
						issue(channelApi.saveChannel(payload));
						setDraft(null);
					}}
					onCancel={() => setDraft(null)}
				/>
			)}
			<div className="chan-defaults">
				<DefaultRow
					scope="instance"
					label={t("channelInstanceDefault")}
					current={channelState?.instanceDefault ?? null}
					channels={channels}
					models={models}
					api={channelApi}
					issue={issue}
				/>
				<DefaultRow
					scope="project"
					label={t("channelProjectDefault")}
					current={channelState?.projectDefault ?? null}
					channels={channels}
					models={models}
					api={channelApi}
					issue={issue}
				/>
				<p className="set-hint">{t("channelDefaultsHint")}</p>
			</div>
		</div>
	);
}
