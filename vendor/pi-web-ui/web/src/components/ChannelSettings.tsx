/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelRow.tsx (列表行 + 账户状态), components/ChannelForm.tsx (新建/编辑表单),
 *            components/ChannelUsage.tsx (按渠道用量),
 *            components/SettingsModal.tsx (挂载为「渠道」分区 + 传 usageHistory),
 *            app/app-dialogs.tsx (channelApi),
 *            use-chat.ts (channelApi.saveChannel/deleteChannel/setChannelDefault/queryChannelAccount),
 *            channel-models.ts (白名单口径), server/dev-con/channel-service.ts + channel-accounts.ts,
 *            server/model-admin.ts fetchChannelModels（/models 探测：密钥只在服务端解析）
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道档案/默认值/revision 冲突）, §6（设置页）, §7（余额/配额状态）
 *   @CONTRACT 只提交 channel_save / channel_delete / channel_set_default / channel_query_account；
 *             凭据只按 provider-keys.json 的名称引用，密钥正文永不进入本组件。
 *   @GOTCHA 启用切换 / 任何行内保存都必须带上 models（白名单）：channel_save 是整体替换，
 *           少带字段就等于把白名单清空（这是之前「渠道改不动」的一部分）。
 *   @GOTCHA 每条命令都要有回执展示（成功/失败/冲突），否则删除/切换看起来像「点了没反应」。
 *   @ASSUME channel_state 的渠道视图不下发 extra，也不下发 mapping/items：编辑时只有在用户
 *           动过账户配置（ChannelForm 的 touched）时才提交 extra，避免静默覆盖。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { FiAlertTriangle, FiCheck, FiPlus, FiRefreshCw } from "react-icons/fi";
import type { ChannelApi, ChannelCommandResult, ChannelStateMsg, UsageHistoryMsg } from "../use-chat";
import type { ModelInfo, ProviderKeyInfo, UiChannelInfo } from "../types";

/** 渠道表单「获取接口清单」的结果（use-chat 的 channelModelsResult）。 */
export interface ChannelModelsResult {
	reqId: number;
	providerId: string;
	ok: boolean;
	models?: import("../types").UiModelConfigEntry[];
	baseUrl?: string;
	error?: string;
}
import { useI18n, useT } from "../i18n";
import { channelAllowsModel } from "../channel-models";
import { ChannelRow } from "./ChannelRow";
import { ChannelForm, channelDraftOf, type ChannelDraft } from "./ChannelForm";
import { ChannelUsage } from "./ChannelUsage";

/** 回执对应的用户动作（回执协议本身不带 op 字段，由提交方记住）。 */
type OpKey = "channelOpSave" | "channelOpDelete" | "channelOpToggle" | "channelOpDefault";

/** 项目/实例默认：选渠道 + 该渠道服务商的模型（白名单生效），再设为/清除默认。 */
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
	issue: (commandId: string | null, op: OpKey) => void;
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
	const selected = usable.find((c) => c.id === channelId);
	// 渠道白名单非空时，默认模型也只能从白名单里选（服务端 channel_select 同样会拒绝越界模型）。
	const rows = models.filter((m) => (!selected || m.provider === selected.providerId) && channelAllowsModel(selected, m.id));
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
				{rows.map((m) => (
					<option key={m.id} value={m.id}>
						{m.name}
					</option>
				))}
			</select>
			{selected && (selected.models ?? []).length > 0 && (
				<span className="chan-meta">{t("channelModelsLimited", { n: (selected.models ?? []).length })}</span>
			)}
			{/* 不传 credentialKeyName：服务端按渠道档案的默认凭据解析（避免 UI 二次猜测）。 */}
			<button
				type="button"
				className="chan-btn"
				disabled={!channelId || !modelId}
				onClick={() => issue(api.setChannelDefault(scope, { channelId, modelId }), "channelOpDefault")}
			>
				{t("channelSetDefault")}
			</button>
			<button
				type="button"
				className="chan-btn"
				disabled={!current}
				onClick={() => issue(api.setChannelDefault(scope, null), "channelOpDefault")}
			>
				{t("channelClearDefault")}
			</button>
		</div>
	);
}

/**
 * DEV-CON 渠道设置面板：渠道列表（白名单摘要 + 账户状态与查询）、新建/编辑表单、
 * 项目/实例默认、按渠道用量（只读聚合）。自包含：所有数据经 props 传入，
 * 变更只走 channelApi（服务端 revision 复核 + 回执）。
 */
export function ChannelSettings({
	channelState,
	channelResults,
	channelApi,
	providerIds,
	providerKeys,
	models,
	usageHistory,
	onFetchChannelModels,
	channelModelsResult,
}: {
	channelState: ChannelStateMsg | null;
	channelResults: Record<string, ChannelCommandResult>;
	channelApi: ChannelApi;
	/** 可选服务商 id（由 models + providers 派生，调用方去重排序）。 */
	providerIds: string[];
	providerKeys: Record<string, ProviderKeyInfo[]>;
	models: ModelInfo[];
	/** P4 用量历史（与用量详情面板共享同一份状态；本面板只用按渠道分组）。 */
	usageHistory: UsageHistoryMsg | null;
	/** 渠道表单「获取接口清单」：服务端按 baseUrl 探测 /models（密钥不出服务端）。 */
	onFetchChannelModels?: (providerId: string, keyName: string | null, reqId: number) => void;
	/** 上一次探测结果（透传给表单，见 use-chat 的 channelModelsResult）。 */
	channelModelsResult?: ChannelModelsResult | null;
}) {
	const t = useT();
	const { locale } = useI18n();
	const channels = channelState?.channels ?? [];
	const accounts = channelState?.accounts ?? [];
	/** 表单草稿：null = 未在编辑（列表视图）。 */
	const [draft, setDraft] = useState<ChannelDraft | null>(null);
	const [querying, setQuerying] = useState<{ commandId: string; channelId: string } | null>(null);
	/** 本面板发起的最近一条命令：只展示它的回执（冲突时给刷新入口）。 */
	const [lastCommand, setLastCommand] = useState<{ id: string; op: OpKey | null } | null>(null);
	const issue = (commandId: string | null, op: OpKey | null = null) => {
		if (commandId) setLastCommand({ id: commandId, op });
	};
	const receipt = lastCommand ? channelResults[lastCommand.id] : undefined;
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
	/**
	 * 行内保存（切换启用等）必须带上全部字段：channel_save 是整体替换，
	 * 少带 models 会把白名单清空（见 @GOTCHA）。
	 */
	const saveInputOf = (c: UiChannelInfo, patch: { enabled: boolean }) => ({
		id: c.id,
		displayName: c.displayName,
		providerId: c.providerId,
		endpointId: c.endpointId,
		credentialRef: c.credentialRef,
		accountRef: c.accountRef,
		models: c.models ?? [],
		enabled: patch.enabled,
	});

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
			{/* 成功回执也要显示：否则删除/切换看起来像「点了没反应」（见 @GOTCHA）。 */}
			{receipt?.ok && lastCommand?.op && (
				<div className="chan-receipt ok">
					<FiCheck />
					<span>
						{t(lastCommand.op)} · {receipt.phase === "pending" ? t("channelPendingBadge") : t("channelCommandOk")}
					</span>
				</div>
			)}
			{channels.length === 0 && <p className="set-hint">{t("channelListEmpty")}</p>}
			{channels.map((c) => (
				<ChannelRow
					key={c.id}
					channel={c}
					account={accountFor(c)}
					querying={querying?.channelId === c.id}
					onToggle={() => issue(channelApi.saveChannel(saveInputOf(c, { enabled: !c.enabled })), "channelOpToggle")}
					onQuery={() => {
						const commandId = channelApi.queryChannelAccount(c.id);
						if (commandId) setQuerying({ commandId, channelId: c.id });
						// 账户结果由 AccountStatusLine 呈现，这里不覆盖成功回执（只展示失败原因）。
						issue(commandId);
					}}
					onEdit={() => setDraft(channelDraftOf(c, c.providerId))}
					onDelete={() => {
						if (!window.confirm(t("channelDeleteConfirm", { name: c.displayName }))) return;
						issue(channelApi.deleteChannel(c.id), "channelOpDelete");
					}}
				/>
			))}
			{draft && (
				<ChannelForm
					key={draft.id ?? "new"}
					draft={draft}
					providerIds={providerIds}
					providerKeys={providerKeys}
					models={models}
					accountPresets={channelState?.accountPresets}
					onFetchChannelModels={onFetchChannelModels}
					channelModelsResult={channelModelsResult}
					onSave={(payload) => {
						issue(channelApi.saveChannel(payload), "channelOpSave");
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
			<ChannelUsage channels={channels} history={usageHistory} onQuery={channelApi.queryUsageHistory} />
		</div>
	);
}
