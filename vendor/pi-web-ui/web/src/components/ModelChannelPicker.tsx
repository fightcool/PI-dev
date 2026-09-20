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
 *   @CONTRACT 渠道的模型白名单（channel.models，provider 内部 id；空 = 不限）在这里生效：
 *             非空时只渲染白名单内的模型，并在渠道头上标注「限定 N 个模型」（避免「模型凭空少了」）。
 *             匹配口径见 channel-models.ts（只剥第一个 provider 前缀）。
 *   @GOTCHA 渠道/凭据都由服务端按名称回传；本组件永不接收也不渲染密钥正文或掩码。
 *   @GOTCHA 老快照/夹具可能没有 models 字段：一律按「不限」处理，绝不因缺字段把模型全藏起来。
 *   @CONTRACT 当前生效的渠道必须**整组高亮 + 置顶**：会话界面看不出在用哪个渠道，
 *             而这里原本只在模型行上打 active，几个渠道头长得一模一样。
 *   @CONTRACT 余额/已用只读已有快照（channelBalanceBrief），**打开下拉不触发任何查询**：
 *             否则一次就把所有供应商接口都打一遍（服务端 10 秒限频会直接挡掉）。
 *             未查询过就如实写「未查询」，没配账户查询的渠道那一格不显示——绝不拿 0 冒充。
 * ──────────────────────────────────────────────────
 */
import { useState } from "react";
import { FiRefreshCw, FiAlertTriangle, FiClock, FiCheckCircle } from "react-icons/fi";
import type { ModelInfo, UiAccountStatus, UiChannelBinding, UiChannelBindingView, UiChannelInfo } from "../types";
import { useI18n, useT } from "../i18n";
import {
	bindingCoversActiveModel,
	channelModels,
	hasModelWhitelist,
	inferChannelIdByModel,
	switcherChannels,
} from "../channel-models";
import { channelBalanceBrief } from "../channel-account";
import { DropdownItem } from "./Dropdown";
import type { ChannelCommandResult } from "../use-chat";

/**
 * 渠道头上的余额/已用一行。
 * @CONTRACT 只读快照（不发查询）；没配账户查询 → 什么都不渲染；配了但未查过 → 写「未查询」。
 */
function ChannelBalanceBits({ channel, accounts }: { channel: UiChannelInfo; accounts: UiAccountStatus[] }) {
	const t = useT();
	const brief = channelBalanceBrief(channel, accounts);
	if (!brief.configured) return null;
	if (!brief.queried) return <span className="chan-head-acct unknown">{t("channelAccountNotQueried")}</span>;
	return (
		<span className={`chan-head-acct ${brief.tone}`} title={t(brief.labelKey)}>
			{brief.balance ? `${t("channelAccountBalance")} ${brief.balance}` : t("channelAccountUnknownBalance")}
			{brief.used && ` · ${t("channelAccountKeyQuota")} ${brief.used}`}
		</span>
	);
}

/** 一个渠道的模型行（渠道分组 → 该渠道服务商下的模型）。 */
function ChannelGroup({
	channel,
	models,
	filter,
	effective,
	pending,
	currentByModel,
	activeModelId,
	keyName,
	accounts,
	onKeyChange,
	onPick,
}: {
	channel: UiChannelInfo;
	models: ModelInfo[];
	filter: string;
	effective: UiChannelBinding | null;
	pending: UiChannelBinding | null;
	/**
	 * 没有对话绑定时的回退：本渠道被认为当前，且实际生效的模型是这个 `provider/id`。
	 * @CONTRACT 非 null 时才用它标当前；与 effective 二选一，不叠加。
	 */
	currentByModel: string | null;
	/**
	 * Agent 当下实际在用的模型（`provider/id`）。
	 * @CONTRACT 哪个模型在跑以它为准；绑定只决定「属于哪个渠道」。绑定里的 modelId 是选择时
	 *   的快照，模型被渠道以外的路径换掉后（见 channel-state.ts 的 @GOTCHA）它不再是事实，
	 *   拿它画 ✓ 会把勾标在已经没在跑的模型上。
	 */
	activeModelId: string | null;
	keyName: string | null;
	/** 账户快照（只读）：渠道头的余额/已用摘要。 */
	accounts: UiAccountStatus[];
	onKeyChange: (keyName: string | null) => void;
	onPick: (credentialKeyName: string | null, model: ModelInfo) => void;
}) {
	const t = useT();
	// 为什么不可用 —— 明确的理由，而不是静默把渠道藏起来（§5：失败/不可用必须可解释）。
	// @CONTRACT 停用（!enabled）的渠道已被 ChannelModelList 过滤掉，这里的禁用分支是**防御**：
	//   任何直接调 ChannelGroup 的地方（或未来新增的调用方）都必须仍能拿到原因，不能白屏。
	const reason = channel.providerMissing
		? t("channelProviderMissing")
		: channel.keyMissing
			? t("channelKeyMissing")
			: !channel.enabled
				? t("channelDisabled")
				: null;
	// 白名单过滤在这里发生（空白名单 = 该服务商全部模型，行为与加白名单之前一致）。
	const rows = channelModels(models, channel, filter);
	// 当前正在使用的渠道：整组高亮（会话界面看不出用的是哪个渠道，见 @CONTRACT）。
	// currentByModel 是「新对话尚未绑定」时的回退（见它的 @WHY）。
	const isCurrent = effective ? effective.channelId === channel.id : currentByModel !== null;
	const isPendingChannel = !isCurrent && pending?.channelId === channel.id;
	// 命名凭据子组：每个 key 一个 chip + 「跟随服务商当前密钥」(= credentialKeyName null)。
	const keyOptions: { value: string | null; label: string; active?: boolean }[] = [
		...channel.keys.map((k) => ({ value: k.keyName as string | null, label: k.keyName, active: k.active })),
		{ value: null, label: t("channelFollowActiveKey") },
	];
	return (
		<div className={`chan-group${isCurrent ? " current" : ""}${isPendingChannel ? " pending" : ""}`}>
			<div className={`chan-head${reason ? " disabled" : ""}${isCurrent ? " current" : ""}`}>
				{/* 选中标记放在渠道名前：不依赖颜色就能分辨（无障碍）。 */}
				{isCurrent && (
					<span className="chan-head-current" title={t("channelInUseTip")}>
						<FiCheckCircle /> {t("channelInUse")}
					</span>
				)}
				<span className="chan-name">{channel.displayName}</span>
				<span className="chan-provider">{channel.providerId}</span>
				{/* 余额/已用：选模型时的重要参考（只读快照，不发查询）。 */}
				{!reason && <ChannelBalanceBits channel={channel} accounts={accounts} />}
				{/* 白名单生效时给出提示：否则用户会把「模型变少」当成加载失败（见 @CONTRACT）。 */}
				{!reason && hasModelWhitelist(channel) && (
					<span className="chan-whitelist">{t("channelModelsLimited", { n: (channel.models ?? []).length })}</span>
				)}
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
						const inThisChannel = effective ? effective.channelId === channel.id : currentByModel !== null;
						// 模型侧的事实：agent 实际在用的模型优先，拿不到时才退回绑定/反推里的值。
						const runningModel = activeModelId ?? (effective ? effective.modelId : currentByModel);
						const isActive = inThisChannel && runningModel === m.id;
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
 * @CONTRACT 当前生效的渠道置顶（其余保持传入顺序，不重排）：渠道多了以后，「正在用哪个」
 *   不应该需要滴到列表中间去找。
 * @CONTRACT **停用的渠道不在这里出现**（switcherChannels）：用户自己关掉的就不该再占位；
 *   服务商缺失/凭据缺失的渠道仍然列出并写清原因（那是要他去修的问题）。
 */
export function ChannelModelList({
	channels,
	models,
	filter,
	binding,
	accounts = [],
	activeModelId = null,
	onSelect,
}: {
	channels: UiChannelInfo[];
	models: ModelInfo[];
	filter: string;
	binding: UiChannelBindingView | null | undefined;
	/** 账户快照（channel_state.accounts）；缺省空数组 = 渠道头不显示余额。 */
	accounts?: UiAccountStatus[];
	/**
	 * Agent 当下实际在用的模型（`provider/id`，即 ModelThinking 的 currentModelId）。
	 * @WHY 渠道绑定是按对话存的：新建对话还没有绑定时 binding.effective 为 null，
	 *   但输入区 chip 上已经显示着模型名 —— 只看 binding 会变成「有模型却没任何高亮」。
	 *   所以 binding 缺失时回退到它，与非渠道模式的当前项判定同一口径。
	 */
	activeModelId?: string | null;
	onSelect: (channelId: string, credentialKeyName: string | null, modelId: string) => void;
}) {
	const [keySel, setKeySel] = useState<Record<string, string | null>>({});
	// 停用的渠道不进切换器（用户自己关的；理由见 channel-models.ts 的 switcherChannels）。
	// 当前绑定/生效渠道即使被停用也 **不** 例外显示：输入区的状态 chip 依旧会说出它在用哪个渠道。
	const visible = switcherChannels(channels);
	// 绑定只在**仍然描述当下模型**时才当有效（模型被渠道以外的路径换掉后它只是旧快照，
	// 服务端会清掉它，界面不能抢在它之前把旧渠道标成「正在使用」——见 bindingCoversActiveModel）。
	const storedEffective = binding?.effective ?? null;
	const effective = storedEffective
		? bindingCoversActiveModel(
				channels.find((c) => c.id === storedEffective.channelId),
				storedEffective,
				activeModelId,
			)
			? storedEffective
			: null
		: null;
	// 当前渠道：优先用对话绑定；没绑定时（新对话）用实际生效模型反推（见 inferChannelIdByModel）。
	const inferredId = effective ? null : inferChannelIdByModel(visible, models, activeModelId);
	const currentId = effective?.channelId ?? inferredId;
	// 只把当前渠道提到最前，其余顺序原样保留（稳定排序，不让列表每次打开都变样）。
	const ordered = currentId
		? [...visible].sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId))
		: visible;
	return (
		<>
			{ordered.map((c) => {
				// 默认凭据 = 渠道档案里已配置的命名凭据；否则跟随服务商 active key。
				const keyName = c.id in keySel ? keySel[c.id] : (c.credentialRef?.keyName ?? null);
				return (
					<ChannelGroup
						key={c.id}
						channel={c}
						models={models}
						filter={filter}
						effective={effective}
						pending={binding?.pending ?? null}
						currentByModel={currentId === c.id && !effective ? activeModelId : null}
						activeModelId={activeModelId}
						keyName={keyName}
						accounts={accounts}
						onKeyChange={(next) => setKeySel((prev) => ({ ...prev, [c.id]: next }))}
						onPick={(credentialKeyName, m) => onSelect(c.id, credentialKeyName, m.id)}
					/>
				);
			})}
		</>
	);
}

/** 「渠道名 · 模型」的紧凑标签（模型 id 去掉 provider 前缀）。
 * @CONTRACT `activeModelId` 已知时用它（agent 实际在跑的模型）；绑定里的 modelId 只是选择时的
 *   快照，模型被渠道以外的路径换掉后拿它当标签就会「芯片说 claude-opus-5，实际跑 deepseek」。 */
function selectionLabel(channels: UiChannelInfo[], sel: UiChannelBinding, activeModelId?: string | null): string {
	const name = channels.find((c) => c.id === sel.channelId)?.displayName ?? sel.channelName ?? sel.channelId;
	const ref = activeModelId || sel.modelId;
	const model = ref.split("/").slice(1).join("/") || ref;
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
	activeModelId,
	onRefresh,
}: {
	binding: UiChannelBindingView | null | undefined;
	channels: UiChannelInfo[];
	/** 最新一次 channel_select 的回执（由调用方按 commandId 匹配）。 */
	receipt?: ChannelCommandResult | null;
	/** Agent 实际在用的模型（`provider/id`）：已知时用它标「渠道 · 模型」，见 selectionLabel。 */
	activeModelId?: string | null;
	onRefresh: () => void;
}) {
	const t = useT();
	const { locale } = useI18n();
	// 绑定要与实际在跑的模型对得上才算「生效」（口径与选择器一致，见 bindingCoversActiveModel）。
	const stored = binding?.effective ?? null;
	const effective =
		stored &&
		bindingCoversActiveModel(
			channels.find((c) => c.id === stored.channelId),
			stored,
			activeModelId,
		)
			? stored
			: null;
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
					{selectionLabel(channels, effective, activeModelId)}
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
