/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ModelThinking.tsx (rendered inside its model dropdown + next to its trigger),
 *            use-chat.ts (channelApi/selectChannel + channelResults 回执),
 *            server/dev-con/channel-service.ts (channel_select 的校验/回执契约)
 *   📖 docs/DEV-CON-PROPOSAL.md §5（切换与待生效）, §6（选择器：有效/待生效/命名凭据）
 *   @CONTRACT 只在「已配置渠道」时由 ModelThinking 渲染；没有渠道时该组件完全不出现，
 *             模型下拉保持原有行为（零回归）。点击模型 → channel_select(渠道+key+模型) 一次提交。
 *   @WHY 模型列表按渠道分组、命名凭据作为「子组」用 chips 呈现，而不是每个 key 复制一份模型：
 *        渠道+key+模型是一组合命令（§4），复制模型行会让「点一次到底用哪把 key」变得不可解释。
 *   @GOTCHA 渠道/凭据都由服务端按名称回传；本组件永不接收也不渲染密钥正文或掩码。
 * ──────────────────────────────────────────────────
 */
import { useState } from "react";
import { FiRefreshCw, FiAlertTriangle, FiClock } from "react-icons/fi";
import type { ModelInfo, UiChannelBinding, UiChannelBindingView, UiChannelInfo } from "../types";
import { useI18n, useT } from "../i18n";
import { DropdownItem } from "./Dropdown";
import type { ChannelCommandResult } from "../use-chat";

/** 一个渠道的模型行（渠道分组 → 该渠道服务商下的模型）。 */
function ChannelGroup({
	channel,
	models,
	filter,
	effective,
	pending,
	keyName,
	onKeyChange,
	onPick,
}: {
	channel: UiChannelInfo;
	models: ModelInfo[];
	filter: string;
	effective: UiChannelBinding | null;
	pending: UiChannelBinding | null;
	keyName: string | null;
	onKeyChange: (keyName: string | null) => void;
	onPick: (credentialKeyName: string | null, model: ModelInfo) => void;
}) {
	const t = useT();
	// 为什么不可用 —— 明确的理由，而不是静默把渠道藏起来（§5：失败/不可用必须可解释）。
	const reason = channel.providerMissing
		? t("channelProviderMissing")
		: channel.keyMissing
			? t("channelKeyMissing")
			: !channel.enabled
				? t("channelDisabled")
				: null;
	const q = filter.trim().toLowerCase();
	const rows = models.filter(
		(m) =>
			m.provider === channel.providerId &&
			(!q ||
				m.name.toLowerCase().includes(q) ||
				m.provider.toLowerCase().includes(q) ||
				m.id.toLowerCase().includes(q)),
	);
	// 命名凭据子组：每个 key 一个 chip + 「跟随服务商当前密钥」(= credentialKeyName null)。
	const keyOptions: { value: string | null; label: string; active?: boolean }[] = [
		...channel.keys.map((k) => ({ value: k.keyName as string | null, label: k.keyName, active: k.active })),
		{ value: null, label: t("channelFollowActiveKey") },
	];
	return (
		<div className="chan-group">
			<div className={`chan-head${reason ? " disabled" : ""}`}>
				<span className="chan-name">{channel.displayName}</span>
				<span className="chan-provider">{channel.providerId}</span>
				{reason && <span className="chan-reason">{reason}</span>}
			</div>
			{!reason && (
				<>
					<div className="chan-keys">
						<span className="chan-keys-label">{t("channelKeyLabel")}</span>
						{keyOptions.map((opt) => (
							<button
								type="button"
								key={opt.value ?? "__active"}
								className={`chan-key${keyName === opt.value ? " active" : ""}`}
								onClick={() => onKeyChange(opt.value)}
							>
								{opt.label}
								{opt.value !== null && opt.active && <span className="chan-key-dot">●</span>}
							</button>
						))}
					</div>
					{rows.map((m) => {
						const isActive = effective?.channelId === channel.id && effective.modelId === m.id;
						const isPending = pending?.channelId === channel.id && pending.modelId === m.id;
						return (
							<DropdownItem
								key={m.id}
								active={isActive}
								onClick={() => onPick(keyName, m)}
								title={isPending ? t("channelPendingTip") : undefined}
							>
								<span className="dd-model-cell">
									<span className="dd-model-name">{m.name}</span>
									<span className="dd-model-meta">
										<span className="dd-model-provider">{m.provider}</span>
										{isPending && (
											<span className="chan-pending-tag">
												<FiClock /> {t("channelPendingBadge")}
											</span>
										)}
										{(m.reasoning || m.vision) && (
											<span className="dd-model-badges">
												{m.reasoning && <span className="dd-model-badge">{t("reasoning")}</span>}
												{m.vision && <span className="dd-model-badge">{t("vision")}</span>}
											</span>
										)}
									</span>
								</span>
							</DropdownItem>
						);
					})}
					{rows.length === 0 && <div className="dd-loading">{t("channelNoModels")}</div>}
				</>
			)}
		</div>
	);
}

/**
 * 渠道分组模型列表（放在 .dd-model-scroll 内）。
 * 凭据子组选择保存在本组件：渠道+key+模型一次提交，不存在「UI 已换、实际未换」。
 */
export function ChannelModelList({
	channels,
	models,
	filter,
	binding,
	onSelect,
}: {
	channels: UiChannelInfo[];
	models: ModelInfo[];
	filter: string;
	binding: UiChannelBindingView | null | undefined;
	onSelect: (channelId: string, credentialKeyName: string | null, modelId: string) => void;
}) {
	const [keySel, setKeySel] = useState<Record<string, string | null>>({});
	return (
		<>
			{channels.map((c) => {
				// 默认凭据 = 渠道档案里已配置的命名凭据；否则跟随服务商 active key。
				const keyName = c.id in keySel ? keySel[c.id] : (c.credentialRef?.keyName ?? null);
				return (
					<ChannelGroup
						key={c.id}
						channel={c}
						models={models}
						filter={filter}
						effective={binding?.effective ?? null}
						pending={binding?.pending ?? null}
						keyName={keyName}
						onKeyChange={(next) => setKeySel((prev) => ({ ...prev, [c.id]: next }))}
						onPick={(credentialKeyName, m) => onSelect(c.id, credentialKeyName, m.id)}
					/>
				);
			})}
		</>
	);
}

/** 「渠道名 · 模型」的紧凑标签（模型 id 去掉 provider 前缀）。 */
function selectionLabel(channels: UiChannelInfo[], sel: UiChannelBinding): string {
	const name = channels.find((c) => c.id === sel.channelId)?.displayName ?? sel.channelName ?? sel.channelId;
	const model = sel.modelId.split("/").slice(1).join("/") || sel.modelId;
	return `${name} · ${model}`;
}

/**
 * 选择器旁的状态：当前有效绑定 +（若已受理）待生效徽标 + 默认来源说明 + 最新回执错误。
 * 只在真的有渠道/绑定时渲染，避免给没有渠道功能的实例增加噪音。
 */
export function ChannelStatusChips({
	binding,
	channels,
	receipt,
	onRefresh,
}: {
	binding: UiChannelBindingView | null | undefined;
	channels: UiChannelInfo[];
	/** 最新一次 channel_select 的回执（由调用方按 commandId 匹配）。 */
	receipt?: ChannelCommandResult | null;
	onRefresh: () => void;
}) {
	const t = useT();
	const { locale } = useI18n();
	const effective = binding?.effective ?? null;
	const pending = binding?.pending ?? null;
	if (!effective && !pending && !receipt) return null;
	const receiptText = receipt
		? locale !== "zh" && receipt.errorEn
			? receipt.errorEn
			: (receipt.error ?? receipt.errorEn ?? "")
		: "";
	return (
		<span className="chip-channel-state">
			{effective && (
				<span className="chan-chip effective" title={t("channelEffectiveTip", { sel: effective.modelId })}>
					{selectionLabel(channels, effective)}
					{binding?.source === "project" && <span className="chan-chip-src">{t("channelSourceProject")}</span>}
					{binding?.source === "instance" && <span className="chan-chip-src">{t("channelSourceInstance")}</span>}
				</span>
			)}
			{pending && (
				<span className="chan-chip pending" title={t("channelPendingTip")}>
					<FiClock /> {selectionLabel(channels, pending)} · {t("channelPendingBadge")}
				</span>
			)}
			{receipt && !receipt.ok && (
				<span className={`chan-chip error${receipt.phase === "conflict" ? " conflict" : ""}`} title={receiptText}>
					<FiAlertTriangle />
					{receipt.phase === "conflict" ? t("channelConflict") : receiptText || t("channelRejected")}
					{receipt.phase === "conflict" && (
						<button type="button" className="chan-refresh" title={t("channelRefresh")} onClick={onRefresh}>
							<FiRefreshCw />
						</button>
					)}
				</span>
			)}
		</span>
	);
}
