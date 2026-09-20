/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/SettingsModal.tsx（挂载为「Jev 决策门禁」分区 + 传 chat.jev）,
 *            components/JevRuntimeView.tsx（运行状态 / 命题 / 余额 / 自检回包展示）,
 *            jev-decision.ts（视图模型 + 解码 + 出站消息）,
 *            use-chat.ts（jev_* 回包 → ChatState.jev）,
 *            server/dev-con/jev-*.ts（服务端权威：jev_status / jev_config_save / jev_probe）
 *   @CONTRACT 密钥只按名称引用：下拉来源是既有的 providerKeys（provider-keys.json），本组件
 *             从不接收、不存储、不回显密钥正文；需要新密钥时只给「内置服务商与密钥」入口。
 *   @GOTCHA 草稿策略：draft === null 时显示服务端生效值（状态回包到达就跟着走），用户一编辑就
 *             固定为本地草稿 —— 否则每次 status 回包都会把正在输入的内容盖掉。改完保存或点
 *             「重新载入」才回到服务端值。
 *   @GOTCHA 保存提交的是**整份配置**（含服务端限制字段原样回传）：少带字段等于把它清空。
 *   @ASSUME 出站消息直接是协议成员（`jev_status` / `jev_config_save` / `jev_probe`，见 protocol.ts），
 *            保存是服务端读-合并-写：只提交界面拥有的字段。
 *   @WHY 阈值必须给出解释文案：Jev 同一输入的概率抖动可达 ~0.08，双阈值之间的空白带是「转人工」
 *        区，收窄到 0.5 附近会让同一请求时通时拦 —— 这是运营者最容易配错、又最难自察的地方。
 * ──────────────────────────────────────────────────
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiAlertTriangle, FiKey, FiPlay, FiRefreshCw, FiSave } from "react-icons/fi";
import { useI18n, useT } from "../i18n";
import type { ChannelApi, JevUiState } from "../use-chat";
import type {
	ClientMessage,
	ModelInfo,
	ProviderKeyInfo,
	ProviderStatus,
	UiAccountStatus,
	UiChannelInfo,
} from "../types";
import { JevBalance, JevPropositionList, JevReceipts, JevRuntimeCards } from "./JevRuntimeView";
import {
	checkEndpoint,
	checkThresholds,
	configInputOf,
	credentialProblem,
	draftOf,
	formatLimit,
	isDriftingModelAlias,
	jevConfigSaveMessage,
	jevProbeMessage,
	jevStatusMessage,
	parseThreshold,
	type JevDraft,
} from "../jev-decision";

/** 拦住保存的文案 key（与 blockReason 一一对应）。 */
type SaveBlockKey =
	| "settingsJevThresholdsInvalid"
	| "settingsJevEndpointInvalid"
	| "settingsJevModelRequired"
	| "settingsJevKeyNameRequired";

/** 设置面板「Jev 决策门禁」分区：总开关 / 凭据 / 渠道 / 阈值 / 余额 / 运行状态 / 自检 / 保存。 */
export function JevSettings({
	jev,
	send,
	channelApi,
	providerKeys,
	providers,
	models,
	channels,
	accounts,
	onOpenProviderKeys,
}: {
	jev: JevUiState;
	send: (msg: ClientMessage) => boolean;
	channelApi: ChannelApi;
	/** 命名密钥（按服务商分组；只有名称 + 是否 active）。 */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** 已注册服务商（与渠道面板同一数据源）：还没存密钥的服务商也要能选，否则无从下手。 */
	providers: ProviderStatus[];
	models: ModelInfo[];
	channels: UiChannelInfo[];
	accounts: UiAccountStatus[];
	onOpenProviderKeys: () => void;
}) {
	const t = useT();
	const { locale } = useI18n();
	const status = jev.status;
	const config = status?.status?.config ?? null;
	// 草稿：null = 未编辑（跟着服务端生效值走），见文件头 @GOTCHA。
	const [draft, setDraft] = useState<JevDraft | null>(null);
	const view = draft ?? (config ? draftOf(config) : null);
	const reqRef = useRef({ status: 0, save: 0, probe: 0 });
	const [busy, setBusy] = useState<null | "status" | "save" | "probe">(null);

	/** 拉一次运行状态（只读；回包按 reqId 匹配，见下面三个 effect）。 */
	const refresh = useCallback(() => {
		reqRef.current.status += 1;
		setBusy("status");
		send(jevStatusMessage(reqRef.current.status));
	}, [send]);
	// 分区每次打开都会重新挂载（SettingsModal 只渲染当前分区）→ 打开即拉一次。
	useEffect(() => {
		refresh();
	}, [refresh]);
	// 回包按 reqId 匹配：只认自己发出去的那一次，避免把上一次的结果当成这次。
	useEffect(() => {
		if (busy === "status" && status?.reqId === reqRef.current.status) setBusy(null);
	}, [busy, status?.reqId]);
	useEffect(() => {
		if (busy !== "save" || jev.config?.reqId !== reqRef.current.save) return;
		setBusy(null);
		// 生效后以**保存回执里的 config** 作为新基线：服务端是读-合并-写，且可能做过归一化，
		// 回执里的 config 才是权威值。注意不能简单地 setDraft(null) —— 那会退回到**上一次
		// jev_status** 的旧配置（服务端保存后并不会补推 jev_status），实测表现为「回执说已生效，
		// 但输入框回到保存前的值」。
		if (jev.config.ok && jev.config.phase === "applied") {
			setDraft(jev.config.config ? draftOf(jev.config.config) : null);
		}
	}, [busy, jev.config]);
	useEffect(() => {
		if (busy === "probe" && jev.probe?.reqId === reqRef.current.probe) setBusy(null);
	}, [busy, jev.probe?.reqId]);

	const providerId = view?.providerId ?? null;
	// 可选服务商 = 已有密钥的 + 已注册的（与 SettingsModal 的 channelProviderIds 同口径）：
	// 新实例一个密钥都没存时 providerKeys 里没有 openrouter，下拉会是空的。
	const providerIds = useMemo(
		() =>
			[...new Set([...Object.keys(providerKeys), ...providers.map((p) => p.id), providerId ?? ""])]
				.filter(Boolean)
				.sort(),
		[providerKeys, providers, providerId],
	);
	const knownKeys = providerId ? (providerKeys[providerId] ?? []) : [];
	/** 选了服务商但一个密钥都没存：能选到，但得先去建密钥。 */
	const keyMissing = !!providerId && knownKeys.length === 0;
	/** 存着的密钥名已不在列表里（删除/改名）：照原样显示，否则会静默变成别的密钥（门禁用哪把钥匙不能猜）。 */
	const keyStale = !!view?.keyName && !knownKeys.some((k) => k.name === view.keyName);
	/** 该服务商在既有模型目录里的模型（渠道/模型选择器的同一数据源）。 */
	const modelOptions = useMemo(
		() => (providerId ? models.filter((m) => m.provider === providerId) : models),
		[models, providerId],
	);
	const approveAt = view ? parseThreshold(view.approveAt) : null;
	const blockAt = view ? parseThreshold(view.blockAt) : null;
	const check = checkThresholds(approveAt, blockAt);
	const drifting = !!view && isDriftingModelAlias(view.model);
	/**
	 * 拦住保存的那一条理由（null = 可保存）。
	 * @WHY 只展示一条：同时列四条各说各的不如只给当前最该修的那条。服务端仍会再校一次，
	 *   rejected 回执照旧显示——前端校验只为省一轮往返。
	 */
	const blockReason: SaveBlockKey | null =
		!view || approveAt === null || blockAt === null || !check.ok
			? "settingsJevThresholdsInvalid"
			: !checkEndpoint(view.endpoint)
				? "settingsJevEndpointInvalid"
				: !view.model.trim()
					? "settingsJevModelRequired"
					: credentialProblem(view)
						? "settingsJevKeyNameRequired"
						: null;
	const patch = (p: Partial<JevDraft>) => {
		if (!view) return;
		setDraft({ ...view, ...p });
	};

	const save = () => {
		// blockReason 已保证阈值合法；这里再判一次 null 只为让类型收窄（不用断言）。
		if (!view || blockReason !== null || approveAt === null || blockAt === null) return;
		reqRef.current.save += 1;
		setBusy("save");
		send(jevConfigSaveMessage(reqRef.current.save, configInputOf(view, { approveAt, blockAt })));
	};
	const probe = () => {
		reqRef.current.probe += 1;
		setBusy("probe");
		send(jevProbeMessage(reqRef.current.probe));
	};

	return (
		<div className="chan-settings">
			<div className="chan-settings-head">
				<button
					type="button"
					className="chan-btn"
					onClick={() => {
						// 「重新载入」按文件头 @GOTCHA 的约定回到服务端值：必须一并丢弃本地草稿，
						// 否则光 refresh 只更新了 status，表单仍停在草稿上（与文案不符）。
						setDraft(null);
						refresh();
					}}
					disabled={busy === "status"}
				>
					<FiRefreshCw /> {busy === "status" ? t("loading") : t("settingsJevReload")}
				</button>
				<button
					type="button"
					className="chan-btn primary"
					onClick={save}
					disabled={!view || blockReason !== null || busy === "save"}
				>
					<FiSave /> {t("settingsJevSave")}
				</button>
				<button type="button" className="chan-btn" onClick={probe} disabled={busy === "probe"}>
					<FiPlay /> {busy === "probe" ? t("settingsJevProbeRunning") : t("settingsJevProbe")}
				</button>
			</div>
			<p className="set-hint">{t("settingsJevProbeHint")}</p>

			{/* 回包展示（状态 / 保存 / 自检）在 JevRuntimeView 里：只读展示服务端事实，与运行状态同源。 */}
			<JevReceipts status={status} saveResult={jev.config} probe={jev.probe} locale={locale} />
			{!view && <p className="set-hint">{t("settingsJevStatusMissing")}</p>}

			{view && (
				<>
					<label className="chan-enable">
						<input type="checkbox" checked={view.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
						{t("settingsJevEnable")}
					</label>
					<p className="set-hint">{t("settingsJevEnableHint")}</p>

					{/* ---- 凭据：只按名称引用（密钥正文永不出服务端） ---- */}
					<div className="chan-conn">
						<span className="field-label">{t("settingsJevCredentialTitle")}</span>
						<div className="form-grid">
							<label className="field">
								<span className="field-label">{t("settingsJevCredentialProvider")}</span>
								<select
									value={view.providerId}
									// 换服务商 = 旧密钥名无意义，必须清空（不做静默沿用）；有当前密钥就默认选上。
									onChange={(e) => {
										const next = e.target.value;
										const active = (providerKeys[next] ?? []).find((k) => k.active);
										patch({ providerId: next, keyName: active?.name ?? null });
									}}
								>
									<option value="" disabled>
										{t("settingsJevCredentialProvider")}
									</option>
									{providerIds.map((id) => (
										<option key={id} value={id}>
											{id}
										</option>
									))}
								</select>
							</label>
							<label className="field">
								<span className="field-label">{t("settingsJevCredentialKeyName")}</span>
								{/* 服务端只接受明确名称的密钥引用（不存在「跟随当前密钥」），所以这里给空占位而不是跟随选项。 */}
								<select
									value={view.keyName ?? ""}
									disabled={!providerId}
									onChange={(e) => patch({ keyName: e.target.value || null })}
								>
									<option value="" disabled>
										{t("settingsJevCredentialKeyPlaceholder")}
									</option>
									{knownKeys.map((k) => (
										<option key={k.name} value={k.name}>
											{k.name}
											{k.active ? " ●" : ""}
										</option>
									))}
									{/* 密钥名已不存在（改名/删除）时保留原值，否则下拉会静默选到别的密钥。 */}
									{keyStale && <option value={view.keyName ?? ""}>{view.keyName}</option>}
								</select>
							</label>
						</div>
						<p className="set-hint">{t("settingsJevCredentialHint")}</p>
						<div className="chan-account-row">
							<span className="field-label">{t("settingsJevCredentialBound")}</span>
							<span className="chan-meta">
								{config?.credentialRef
									? `${config.credentialRef.providerId} / ${config.credentialRef.keyName || "—"}`
									: t("settingsJevCredentialNone")}
							</span>
							<button type="button" className="chan-btn" onClick={onOpenProviderKeys}>
								<FiKey /> {t("channelProviderKeysEntry")}
							</button>
						</div>
						{/* 选了服务商但没密钥（或根本选不出服务商）时，给出可执行的一步，而不是空下拉。 */}
						{(keyMissing || providerIds.length === 0) && (
							<p className="set-hint">{t("settingsJevCredentialMissing")}</p>
						)}
						{keyStale && <p className="set-hint">{t("settingsJevCredentialStale")}</p>}
						{view.providerId === "" && <p className="set-hint">{t("settingsJevCredentialUnset")}</p>}
					</div>

					{/* ---- 调用渠道 ---- */}
					<div className="chan-conn">
						<span className="field-label">{t("settingsJevChannelTitle")}</span>
						<label className="field">
							<span className="field-label">{t("settingsJevEndpoint")}</span>
							<input
								value={view.endpoint}
								placeholder={t("settingsJevEndpointPh")}
								onChange={(e) => patch({ endpoint: e.target.value })}
							/>
						</label>
						<label className="field">
							<span className="field-label">{t("settingsJevModel")}</span>
							<input
								value={view.model}
								placeholder={t("settingsJevModelPh")}
								onChange={(e) => patch({ model: e.target.value })}
							/>
						</label>
						<div className="chan-model-add">
							<select value="" onChange={(e) => e.target.value && patch({ model: e.target.value })}>
								<option value="" disabled>
									{t("settingsJevModelPick")}
								</option>
								{modelOptions.map((m) => (
									<option key={`${m.provider}/${m.id}`} value={m.id}>
										{m.name}
									</option>
								))}
							</select>
						</div>
						<p className="set-hint">{t("settingsJevModelPinHint")}</p>
						{drifting && (
							<div className="chan-warn">
								<FiAlertTriangle /> {t("settingsJevModelLatestWarn")}
							</div>
						)}
					</div>

					{/* ---- 阈值（抖动带宽是这里最容易配错的地方） ---- */}
					<div className="chan-conn">
						<span className="field-label">{t("settingsJevThresholdsTitle")}</span>
						<div className="form-grid">
							<label className="field">
								<span className="field-label">{t("settingsJevApproveAt")}</span>
								<input
									type="number"
									min={0}
									max={1}
									step={0.01}
									value={view.approveAt}
									onChange={(e) => patch({ approveAt: e.target.value })}
								/>
							</label>
							<label className="field">
								<span className="field-label">{t("settingsJevBlockAt")}</span>
								<input
									type="number"
									min={0}
									max={1}
									step={0.01}
									value={view.blockAt}
									onChange={(e) => patch({ blockAt: e.target.value })}
								/>
							</label>
						</div>
						<p className="set-hint">{t("settingsJevThresholdsHint")}</p>
						{blockReason && (
							<div className="chan-receipt">
								<FiAlertTriangle />
								<span>{t(blockReason)}</span>
							</div>
						)}
						{/* 阈值合法但不合建议（带宽过窄）只给警告，不拦保存（服务端只要求 blockAt < approveAt）。 */}
						{!blockReason && check.narrow && (
							<div className="chan-warn">
								<FiAlertTriangle /> {t("settingsJevThresholdsHint")}
							</div>
						)}
						<div className="set-mode-row">
							<span className="set-field-label">{t("settingsJevLimitsTitle")}</span>
							<span className="chan-meta">
								{t("settingsJevTimeout")} {formatLimit(config?.timeoutMs)}
							</span>
							<span className="chan-meta">
								{t("settingsJevCacheTtl")} {formatLimit(config?.cacheTtlMs)}
							</span>
							<span className="chan-meta">
								{t("settingsJevMinInterval")} {formatLimit(config?.minIntervalMs)}
							</span>
						</div>
					</div>

					{/* ---- 余额：复用渠道账户查询适配器（不另写余额接口） ---- */}
					<JevBalance channels={channels} accounts={accounts} providerId={view.providerId} channelApi={channelApi} />

					{/* ---- 运行状态 + 命题清单 ---- */}
					<div className="set-section-title">{t("settingsJevRuntimeTitle")}</div>
					<JevRuntimeCards runtime={status?.status?.runtime} locale={locale} />
					<div className="set-section-title">{t("settingsJevPropositionsTitle")}</div>
					<p className="set-hint">{t("settingsJevPropositionsHint")}</p>
					<JevPropositionList propositions={status?.status?.propositions ?? []} />
				</>
			)}
		</div>
	);
}
