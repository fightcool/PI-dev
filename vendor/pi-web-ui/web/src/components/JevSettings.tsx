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
 *           唯一例外是 thresholds.perProposition：它走**逐项补丁**（只提交用户改过的项，
 *           整项留空 = 发 null 删除），整块回写会盖掉别的客户端刚设的独立阈值。
 *   @GOTCHA 逐判定项区块**不能**用 .set-list/.set-row 类名：命题清单区块的浏览器断言按
 *           `.set-list .set-row` 计数，复用类名会让两边互相污染（见 tests/jev/browser-ui.mjs §7）。
 *           同理不能用 “approve threshold” 这种与全局阈值 label 重合的字串做行内 label。
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
	UiJevThresholds,
	UiJevThresholdsInput,
} from "../types";
import { JevBalance, JevPropositionList, JevReceipts, JevRuntimeCards } from "./JevRuntimeView";
import {
	brief,
	checkEndpoint,
	checkPropositionDraft,
	checkThresholds,
	configInputOf,
	credentialProblem,
	draftOf,
	effectiveDraftThresholds,
	effectiveThresholds,
	formatLimit,
	formatScore,
	isDriftingModelAlias,
	JEV_DEFAULT_PROVIDER_ID,
	JEV_KNOWN_MODELS,
	isJevModelId,
	jevConfigSaveMessage,
	jevProbeMessage,
	jevStatusMessage,
	parseThreshold,
	propositionDraftOf,
	propositionThresholdsPatch,
	type EffectiveThresholds,
	type JevDraft,
	type JevPropositionDrafts,
} from "../jev-decision";

/** 拦住保存的文案 key（与 blockReason 一一对应）。 */
type SaveBlockKey =
	| "settingsJevThresholdsInvalid"
	| "settingsJevPerPropositionInvalid"
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
	/** 逐判定项草稿：**只有用户改过的项**才进这个 map（未出现的项不提交，见 jev-decision.ts）。 */
	const [propDrafts, setPropDrafts] = useState<JevPropositionDrafts>({});
	const view = draft ?? (config ? draftOf(config) : null);
	const reqRef = useRef({ status: 0, save: 0, probe: 0 });
	const [busy, setBusy] = useState<null | "status" | "save" | "probe">(null);
	/** 就地新建密钥：名 + 值。**值只活到发出那一顺**，不回显、不入草稿、不进日志。 */
	const [newKeyName, setNewKeyName] = useState("");
	const [newKeyValue, setNewKeyValue] = useState("");
	/** 等回包把新密钥名带回来的目标（到了就自动选上，见下面的 effect）。 */
	const [pendingKeyName, setPendingKeyName] = useState<string | null>(null);

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
			// 逐判定项草稿同步清空：新基线是回执里的 config，未编辑的项跟着它走。
			setPropDrafts({});
		}
	}, [busy, jev.config]);
	useEffect(() => {
		if (busy === "probe" && jev.probe?.reqId === reqRef.current.probe) setBusy(null);
	}, [busy, jev.probe?.reqId]);

	const providerId = view?.providerId ?? null;
	/** 可选服务商 = 已有密钥的 + 已注册的（与 SettingsModal 的 channelProviderIds 同口径）：
	 *  新实例一个密钥都没存时 providerKeys 里没有 openrouter，下拉会是空的。 */
	const providerIds = useMemo(
		() =>
			[...new Set([...Object.keys(providerKeys), ...providers.map((p) => p.id), providerId ?? ""])]
				.filter(Boolean)
				.sort(),
		[providerKeys, providers, providerId],
	);
	/** Jev 的 Decisions API 只由 OpenRouter 提供：把它排到第一个。原本按字母排在第 30 位
	 *  （46 项里绝大多数未配置），实测没人找得到它 —— 这就是「我不知道在哪配」。 */
	const orderedProviderIds = useMemo(() => {
		if (!providerIds.includes(JEV_DEFAULT_PROVIDER_ID)) return providerIds;
		return [JEV_DEFAULT_PROVIDER_ID, ...providerIds.filter((id) => id !== JEV_DEFAULT_PROVIDER_ID)];
	}, [providerIds]);
	const knownKeys = providerId ? (providerKeys[providerId] ?? []) : [];
	/** 选了服务商但一个密钥都没存：能选到，但得先去建密钥。 */
	const keyMissing = !!providerId && knownKeys.length === 0;
	/** 存着的密钥名已不在列表里（删除/改名）：照原样显示，否则会静默变成别的密钥（门禁用哪把钥匙不能猜）。 */
	const keyStale = !!view?.keyName && !knownKeys.some((k) => k.name === view.keyName);
	/** @GOTCHA Jev 的模型**不在**服务商的对话模型目录里（Decisions API 专用，实测 models.json
	 *  里 "jev" 零匹配）。所以下拉列的是「产品已知的 Jev 模型 + 目录里真像 Jev 的条目」，
	 *  而不是那一大堆能用 chat/completions 但叫不动 Decisions API 的模型。 */
	const modelOptions = useMemo(() => {
		const fromCatalog = models.filter((m) => isJevModelId(m.id)).map((m) => m.id);
		return [...new Set([...JEV_KNOWN_MODELS, ...fromCatalog])];
	}, [models]);
	/** 当前填的模型看起来不是 Jev：几乎必定调不通（见上面 @GOTCHA）。 */
	const notJevModel = !!view && view.model.trim() !== "" && !isJevModelId(view.model);
	const approveAt = view ? parseThreshold(view.approveAt) : null;
	const blockAt = view ? parseThreshold(view.blockAt) : null;
	const check = checkThresholds(approveAt, blockAt);
	const propositions = status?.status?.propositions ?? [];
	/**
	 * 逐判定项的**回显底稿**：保存回执优先于 jev_status。
	 * @GOTCHA 保存后服务端**不**补推 jev_status，回执才是刚生效的权威值（且可能被归一化过）；
	 *   只读 status.config 的话，保存完输入框会退回保存前的值，连「清除」按钮的可用性也错了
	 *   （明明有独立阈值却显示成没有）——与文件头那条 @GOTCHA 同一个坑，这里同样要避开。
	 */
	const appliedThresholds: UiJevThresholds | undefined =
		jev.config?.ok && jev.config.phase === "applied" && jev.config.config
			? jev.config.config.thresholds
			: config?.thresholds;
	/**
	 * 逐判定项的就地校验：留空按**全局值补齐**后必须 0 ≤ 拦截 < 放行。
	 * @WHY 全局阈值本身就不合法时这里不报（上面那条理由已经在说同一件事，不重复刷屏）。
	 */
	const invalidPropositions =
		approveAt === null || blockAt === null
			? []
			: propositions
					.filter((p) => propDrafts[p.id] && !checkPropositionDraft(propDrafts[p.id], { approveAt, blockAt }))
					.map((p) => p.id);
	const drifting = !!view && isDriftingModelAlias(view.model);
	/**
	 * 拦住保存的那一条理由（null = 可保存）。
	 * @WHY 只展示一条：同时列四条各说各的不如只给当前最该修的那条。服务端仍会再校一次，
	 *   rejected 回执照旧显示——前端校验只为省一轮往返。
	 */
	const blockReason: SaveBlockKey | null =
		!view || approveAt === null || blockAt === null || !check.ok
			? "settingsJevThresholdsInvalid"
			: invalidPropositions.length > 0
				? "settingsJevPerPropositionInvalid"
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
	/** 服务端回显的独立阈值 → 输入框初值（没配的项两侧都是空串 = 继承全局）。 */
	const serverPropRow = (id: string) => propositionDraftOf(appliedThresholds?.perProposition?.[id]);
	/** 这一项当前有没有落盘的独立阈值（决定「清除」能不能点）。 */
	const hasPropOverride = (id: string) => !!appliedThresholds?.perProposition?.[id];
	/**
	 * 逐判定项输入：首次编辑时以**服务端回显值**起底，之后跟着本地草稿走（与 JevDraft 同一策略）。
	 * @GOTCHA 不要用「整个 propDrafts 置为回显值」的写法：那等于把全部项都标成「改过」，保存时就会整块回写。
	 */
	const editProp = (id: string, field: "approveAt" | "blockAt", value: string) => {
		setPropDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? serverPropRow(id)), [field]: value } }));
	};
	/** 清除 = 该项整体回到「继承全局」：提交时按协议发 `{ id: null }`（删除磁盘上的独立阈值）。 */
	const clearProp = (id: string) => {
		setPropDrafts((d) => ({ ...d, [id]: { approveAt: "", blockAt: "" } }));
	};
	/**
	 * 某一项当前实际生效的阈值口径：未编辑的项直接读服务端**回显**，编辑过的看草稿。
	 * @CONTRACT 不在客户端重新推导数值（见 jev-decision.ts 的 effectiveThresholds / resolvePropositionThresholds 同源性）。
	 */
	const effectiveFor = (id: string): EffectiveThresholds | null => {
		if (approveAt === null || blockAt === null) return null;
		const local = propDrafts[id];
		if (local) return effectiveDraftThresholds(local, { approveAt, blockAt });
		return effectiveThresholds(id, appliedThresholds ?? { approveAt, blockAt });
	};
	/** 换服务商 = 旧密钥名无意义，必须清空（不做静默沿用）；有当前密钥就默认选上。 */
	const selectProvider = (next: string) => {
		const active = (providerKeys[next] ?? []).find((k) => k.active);
		patch({ providerId: next, keyName: active?.name ?? null });
	};

	/** 新密钥名一旦出现在清单里就自动选上（不让「建好了还要自己再选一次」卡住人）。 */
	useEffect(() => {
		if (!pendingKeyName) return;
		if (!knownKeys.some((k) => k.name === pendingKeyName)) return;
		// 直接改草稿（等价于 patch，但不把非稳定的函数放进依赖）。draft===null 时以服务端值起底。
		setDraft((d) => {
			const base = d ?? (config ? draftOf(config) : null);
			return base ? { ...base, keyName: pendingKeyName } : base;
		});
		setPendingKeyName(null);
		setNewKeyName("");
	}, [pendingKeyName, knownKeys, config]);

	/**
	 * 就地建密钥：复用既有 add_provider_key（还是同一份 provider-keys.json，不新增事实源）。
	 * @GOTCHA 密钥值只活到发出这一顺：发完立即清空输入框，不入草稿、不回显。
	 */
	const createKey = () => {
		const provider = view?.providerId.trim();
		const value = newKeyValue.trim();
		if (!provider || !value) return;
		const name = newKeyName.trim();
		send({ type: "add_provider_key", provider, apiKey: value, name: name || undefined });
		setNewKeyValue("");
		setPendingKeyName(name || null);
		// 服务端建完不补推清单（与既有面板同做法），自己再拉一次。
		send({ type: "list_provider_keys" });
	};

	const save = () => {
		// blockReason 已保证阈值合法；这里再判一次 null 只为让类型收窄（不用断言）。
		if (!view || blockReason !== null || approveAt === null || blockAt === null) return;
		const thresholds: UiJevThresholdsInput = { approveAt, blockAt };
		// 只提交用户改过的项；一项都没改就不带 perProposition（服务端会原样保留磁盘上的值）。
		const propPatch = propositionThresholdsPatch(propDrafts);
		if (propPatch) thresholds.perProposition = propPatch;
		reqRef.current.save += 1;
		setBusy("save");
		send(jevConfigSaveMessage(reqRef.current.save, configInputOf(view, thresholds)));
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
						// 否则光 refresh 只更新了 status，表单仍停在草稿上（与文案不符）。逐判定项草稿同理。
						setDraft(null);
						setPropDrafts({});
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
								<select value={view.providerId} onChange={(e) => selectProvider(e.target.value)}>
									<option value="" disabled>
										{t("settingsJevCredentialProvider")}
									</option>
									{orderedProviderIds.map((id) => (
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
						{/* 没密钥就地建：Jev 只能走 OpenRouter，再让人从「管理模型」那个面板绕一圈没必要
						    （实测没人找得到 —— 那个面板的标题叫「管理模型」）。 */}
						{keyMissing && (
							<div className="jev-newkey">
								<p className="set-hint">{t("settingsJevCredentialMissing")}</p>
								<div className="form-grid">
									<label className="field">
										<span className="field-label">{t("settingsJevNewKeyName")}</span>
										<input
											value={newKeyName}
											placeholder={t("settingsJevNewKeyNamePh")}
											onChange={(e) => setNewKeyName(e.target.value)}
										/>
									</label>
									<label className="field">
										<span className="field-label">{t("settingsJevNewKeyValue")}</span>
										<input
											type="password"
											value={newKeyValue}
											placeholder={t("settingsJevNewKeyValuePh")}
											autoComplete="off"
											onChange={(e) => setNewKeyValue(e.target.value)}
										/>
									</label>
								</div>
								<div className="chan-account-row">
									<button
										type="button"
										className="chan-btn primary"
										disabled={!newKeyValue.trim() || newKeyName.trim() === ""}
										onClick={createKey}
									>
										<FiSave /> {t("settingsJevNewKeyCreate")}
									</button>
									<span className="set-hint">{t("settingsJevNewKeyHint")}</span>
								</div>
							</div>
						)}
						{/* 一个服务商都选不出来时，同样给出可执行的一步，而不是空下拉。 */}
						{providerIds.length === 0 && <p className="set-hint">{t("settingsJevCredentialMissing")}</p>}
						{keyStale && <p className="set-hint">{t("settingsJevCredentialStale")}</p>}
						{/* 未绑定：给一个一键选上 OpenRouter 的动作，不让「先选服务商」成为一道坑。 */}
						{view.providerId === "" && (
							<div className="chan-account-row">
								<span className="set-hint">{t("settingsJevCredentialUnset")}</span>
								{providerIds.includes(JEV_DEFAULT_PROVIDER_ID) && (
									<button type="button" className="chan-btn" onClick={() => selectProvider(JEV_DEFAULT_PROVIDER_ID)}>
										<FiKey /> {t("settingsJevUseOpenRouter")}
									</button>
								)}
							</div>
						)}
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
								{modelOptions.map((id) => (
									<option key={id} value={id}>
										{id}
									</option>
								))}
							</select>
						</div>
						<p className="set-hint">{t("settingsJevModelPinHint")}</p>
						<p className="set-hint">{t("settingsJevModelCatalogHint")}</p>
						{notJevModel && (
							<div className="chan-warn">
								<FiAlertTriangle /> {t("settingsJevModelNotJevWarn")}
							</div>
						)}
						{drifting && (
							<div className="chan-warn">
								<FiAlertTriangle /> {t("settingsJevModelLatestWarn")}
							</div>
						)}
					</div>

					{/* ---- 阈值（抖动带宽是这里最容易配错的地方）。这两个值是**全局默认**：
					      逐判定项可用下面的独立阈值覆盖，没覆盖的项一律走这里。 ---- */}
					<div className="chan-conn">
						<div className="chan-account-row">
							<span className="field-label">{t("settingsJevThresholdsTitle")}</span>
							<span className="chan-meta">{t("settingsJevGlobalDefault")}</span>
						</div>
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

					{/* ---- 逐判定项阈值：实测三个命题的分数区间整体错开，单一全局阈值结构上不可能同时合适 ---- */}
					<div className="chan-conn">
						<span className="field-label">{t("settingsJevPerPropositionTitle")}</span>
						<p className="set-hint">{t("settingsJevPerPropositionHint")}</p>
						{propositions.length === 0 ? (
							<p className="set-hint">{t("settingsJevPropositionsEmpty")}</p>
						) : (
							<div className="jev-prop-list">
								{propositions.map((p) => {
									const local = propDrafts[p.id];
									// 未编辑的项显示服务端回显值（有独立阈值就是覆盖值，否则就是空 = 继承）。
									const row = local ?? serverPropRow(p.id);
									const effective = effectiveFor(p.id);
									const hasOverride = hasPropOverride(p.id);
									const invalid = invalidPropositions.includes(p.id);
									return (
										<div className="jev-prop-row" key={p.id} data-prop-id={p.id}>
											<div className="jev-prop-info">
												{/* 判定语句截断到一行，title 放全文（与命题清单同一份服务端文本）。 */}
												<div className="jev-prop-name" title={p.instructions}>
													{p.id}
												</div>
												<div className="jev-prop-desc" title={p.instructions}>
													{brief(p.instructions)}
												</div>
											</div>
											<label className="jev-prop-field">
												<span className="jev-prop-label">{t("settingsJevPerPropositionApprove")}</span>
												<input
													type="number"
													min={0}
													max={1}
													step={0.01}
													value={row.approveAt}
													placeholder={t("settingsJevPerPropositionInherit")}
													aria-label={`${p.id} ${t("settingsJevPerPropositionApprove")}`}
													onChange={(e) => editProp(p.id, "approveAt", e.target.value)}
												/>
											</label>
											<label className="jev-prop-field">
												<span className="jev-prop-label">{t("settingsJevPerPropositionBlock")}</span>
												<input
													type="number"
													min={0}
													max={1}
													step={0.01}
													value={row.blockAt}
													placeholder={t("settingsJevPerPropositionInherit")}
													aria-label={`${p.id} ${t("settingsJevPerPropositionBlock")}`}
													onChange={(e) => editProp(p.id, "blockAt", e.target.value)}
												/>
											</label>
											{/* 生效阈值：显示「这一项到底按多少判」，未覆盖的项就是全局值。 */}
											{effective && (
												<span className="chan-meta">
													{effective.scoped
														? t("settingsJevPerPropositionScoped")
														: t("settingsJevPerPropositionInherit")}{" "}
													{formatScore(effective.approveAt)} / {formatScore(effective.blockAt)}
												</span>
											)}
											<button
												type="button"
												className="set-btn-mini"
												// 本来就没有独立阈值且没改过：清除是空操作，不发无意义的删除帧。
												disabled={!hasOverride && !local}
												onClick={() => clearProp(p.id)}
											>
												{t("settingsJevPerPropositionClear")}
											</button>
											{invalid && <span className="chan-warn">{t("settingsJevPerPropositionInvalid")}</span>}
										</div>
									);
								})}
							</div>
						)}
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
