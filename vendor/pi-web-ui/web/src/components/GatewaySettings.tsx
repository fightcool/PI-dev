/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/SettingsModal.tsx（唯一挂载点：设置 → 网关）,
 *            components/GatewayUsageBlock.tsx（同一份用量的展示口径）,
 *            use-chat.ts（getGateway / saveGateway / refreshProviderModels）,
 *            server/model-admin.ts（getGateway / saveGateway 的实现）,
 *            server/dev-con/gateway-config.ts（谁是网关 / 重复接入的判定）
 *   📖 docs/NEWAPI-GATEWAY.md §2–§4（单网关模型、配置怎么写、用量怎么读）
 *   @CONTRACT 整个面板只有三件事：**一个地址**、**一把密钥**、**一份从网关读来的模型清单**。
 *             不出现「服务商」这个词，也不让用户在多个入口之间选择（旧多渠道模型的
 *             失败模式见 docs/history/dev-con/）。
 *   @GOTCHA 密钥的语义是「留空 = 不修改」：否则用户只改地址就会把密钥清掉（旧实现踩过）。
 *             要清除必须显式勾选「清除已保存的密钥」——一个空输入框不能同时表示两件事。
 *   @GOTCHA 模型清单的**唯一**来源是网关自己的 /models（服务端拿着密钥去读，密钥不出服务端）。
 *             读取是**合并**：只新增不删除（刷新不会把用户手工补的模型抹掉）。
 *   @GOTCHA 表单只在「用户没改过」时跟随服务端回包：否则保存后的重新读取会把正在输入的内容冲掉。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FiAlertTriangle, FiCheck, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import type { ClientMessage, UiModelConfigEntry, UiProviderConfig } from "../types";
import type { ChatState, OpsApi } from "../use-chat";
import { useT } from "../i18n";
import { GatewayUsageBlock } from "./GatewayUsageBlock";

/** 网关可用的接口协议（与 server/protocol.ts 的 uiProvider 注释同一口径）。 */
const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

/** 能力标注的档位全集（与 SDK 的 EXTENDED_THINKING_LEVELS、ModelThinking 的 THINKING_VALUES 同源）。 */
const CAP_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type CapLevel = (typeof CAP_LEVELS)[number];

/** 能力标注表单里的一行。数值用字符串承载：空串 = 清除该键（绝不落成 0）。 */
interface CapRow {
	id: string;
	reasoning: boolean;
	/** 只有动过的字段才显式提交：未动过且盘上也未声明的字段保持缺省，
	 *  让服务端的已知能力回填继续接管（显式 false 会挡住回填）。 */
	reasoningTouched: boolean;
	vision: boolean;
	visionTouched: boolean;
	/** 勾选的档位；levelsTouched=false 时不提交映射（盘上手工映射原样保留）。 */
	levels: Set<CapLevel>;
	levelsTouched: boolean;
	contextWindow: string;
	maxTokens: string;
}

/** 数值输入 → 提交值：空串/非法一律不写该键（绝不落成 0）。 */
function numberOrUndefined(raw: string): number | undefined {
	const text = raw.trim();
	if (!text) return undefined;
	const value = Number(text);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** 现有条目 → 初始勾选集，口径与 SDK getSupportedThinkingLevels 一致：
 *  无映射时 off..high 默认支持、xhigh/max 需显式映射；null = 不提供。 */
function supportedLevelsOf(entry: UiModelConfigEntry): Set<CapLevel> {
	const map = entry.thinkingLevelMap;
	if (!map) return new Set<CapLevel>(["off", "minimal", "low", "medium", "high"]);
	const out = new Set<CapLevel>();
	for (const level of CAP_LEVELS) {
		const mapped = map[level];
		if (mapped === null) continue;
		if (mapped === undefined && (level === "xhigh" || level === "max")) continue;
		out.add(level);
	}
	return out;
}

function capRowOf(entry: UiModelConfigEntry): CapRow {
	return {
		id: entry.id,
		reasoning: entry.reasoning === true,
		reasoningTouched: false,
		vision: (entry.input ?? []).includes("image"),
		visionTouched: false,
		levels: supportedLevelsOf(entry),
		levelsTouched: false,
		contextWindow: entry.contextWindow ? String(entry.contextWindow) : "",
		maxTokens: entry.maxTokens ? String(entry.maxTokens) : "",
	};
}

/** 勾选集 → 显式映射：off 勾选 = 缺省键（SDK 默认支持），未勾 = null；
 *  其余档勾选 = 同名值（简化标注不表达改名映射），未勾 = null。 */
function levelMapOf(levels: Set<CapLevel>): Record<string, string | null> {
	const map: Record<string, string | null> = {};
	if (!levels.has("off")) map.off = null;
	for (const level of CAP_LEVELS) {
		if (level === "off") continue;
		map[level] = levels.has(level) ? level : null;
	}
	return map;
}

/** 表单行 → 提交条目。基线（base）来自服务端读到的条目：
 *  未动过且盘上存在的字段回显原值（replace 合并不会清掉），未动过且盘上也没有的键不写。 */
function capEntryOf(row: CapRow, base: UiModelConfigEntry | undefined): UiModelConfigEntry {
	const contextWindow = numberOrUndefined(row.contextWindow);
	const maxTokens = numberOrUndefined(row.maxTokens);
	return {
		id: row.id,
		...(base?.name ? { name: base.name } : {}),
		...(row.reasoningTouched || base?.reasoning !== undefined ? { reasoning: row.reasoning } : {}),
		...(row.visionTouched || base?.input !== undefined
			? { input: row.vision ? ["text", "image"] : ["text"] }
			: {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		// 推理关闭时档位集合无意义（SDK 直接返回 ["off"]），不提交映射。
		...(row.levelsTouched && row.reasoning ? { thinkingLevelMap: levelMapOf(row.levels) } : {}),
	};
}

/** 显示名兜底：过滤时也按服务端读到的 name 匹配。 */
function baseNameOf(config: { models: UiModelConfigEntry[] } | undefined, id: string): string | undefined {
	return config?.models.find((m) => m.id === id)?.name;
}

export function GatewaySettings({
	gateway,
	gatewayUsage,
	activeProvider,
	refreshProviderResult,
	settings,
	opsApi,
	send,
}: {
	/** 网关配置与保存回执（chat.gateway）。 */
	gateway: ChatState["gateway"];
	/** 网关自报用量（chat.gatewayUsage）。 */
	gatewayUsage: ChatState["gatewayUsage"];
	/** 当前生效模型所属服务商（标注用量读数归属）。 */
	activeProvider: string | null;
	/** 「从网关读取模型清单」的回包（chat.refreshProviderResult，按 reqId 匹配）。 */
	refreshProviderResult: ChatState["refreshProviderResult"];
	/** 客户端设置（读 hiddenModels：哪些模型被收起来了）。 */
	settings: ChatState["settings"];
	opsApi: OpsApi;
	/** 只用于删除重复接入（delete_model_config）；保存走 opsApi。 */
	send: (msg: ClientMessage) => boolean;
}) {
	const t = useT();
	const chatSettings = settings ?? { hiddenModels: [] };
	const gw = gateway;
	const config = gw.config;
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState<string>(PROTOCOLS[0]);
	const [apiKey, setApiKey] = useState("");
	const [clearKey, setClearKey] = useState(false);
	/** 用户改过表单后就不再被服务端回包覆盖（见头部 @GOTCHA）。 */
	const dirtyRef = useRef(false);
	const [saving, setSaving] = useState(false);
	/** 「已保存」只对**本次面板会话里我自己那次保存**成立：共享状态里的 saveOk 会跨会话残留
	 *  （reducer 不清它），打开面板就显示「已保存」是假信息。 */
	const [saved, setSaved] = useState(false);
	/** 待写入的 reqId：只有保存成功的那个 reqId 才触发重新读取。 */
	const pendingRef = useRef<number | null>(null);
	const [probeReqId, setProbeReqId] = useState<number | null>(null);

	// ── 模型能力标注（推理/识图/思考档位/窗口）──────────────────────────────
	/** 与顶部连接表单分开的编辑状态：各自的 dirty 与 pending 互不干扰。 */
	const [capRows, setCapRows] = useState<CapRow[]>([]);
	const capDirtyRef = useRef(false);
	const [capSaving, setCapSaving] = useState(false);
	const [capSaved, setCapSaved] = useState(false);
	const capPendingRef = useRef<number | null>(null);
	const [capError, setCapError] = useState("");
	const [capServerError, setCapServerError] = useState("");
	const [capFilter, setCapFilter] = useState("");

	// 打开面板即读一次（配置不是快照的一部分：它属于 models.json，按需读）。
	useEffect(() => {
		opsApi.getGateway();
	}, [opsApi]);

	useEffect(() => {
		if (!config || dirtyRef.current) return;
		setBaseUrl(config.baseUrl ?? "");
		setApi(config.api ?? PROTOCOLS[0]);
		setApiKey("");
		setClearKey(false);
	}, [config]);

	// 能力行同样只在「用户没改过」时跟随服务端回包（同顶部表单的 @GOTCHA）。
	useEffect(() => {
		if (!config || capDirtyRef.current) return;
		setCapRows(config.models.map(capRowOf));
	}, [config]);

	// 保存成功后重新读取（服务端会归一化/回填能力，界面不自己猜结果）。
	useEffect(() => {
		if (gw.saveOk === null) return;
		setSaving(false);
		setCapSaving(false);
		if (gw.saveOk === false) {
			// 失败时把归属理清：能力标注那次保存的失败只显示在能力区，不冒充连接表单的错误。
			if (capPendingRef.current !== null) {
				capPendingRef.current = null;
				setCapServerError(gw.saveError ?? "");
			}
			return;
		}
		if (capPendingRef.current !== null) {
			capPendingRef.current = null;
			capDirtyRef.current = false;
			setCapSaved(true);
			opsApi.getGateway();
			return;
		}
		if (pendingRef.current !== null) {
			pendingRef.current = null;
			dirtyRef.current = false;
			opsApi.getGateway();
			opsApi.queryGatewayUsage(undefined, true);
		}
	}, [gw.saveOk, gw.saveError, opsApi]);

	/** 关掉的模型（选择器里不显示）。与设置面板同一份（settings.hiddenModels），点一下即保存。 */
	const serverHidden = useMemo(() => new Set(chatSettings.hiddenModels ?? []), [chatSettings.hiddenModels]);
	/** 乐观值：点下去立刻变色，等服务器把设置推回来就丢掉（否则连点两下会用旧值算下一状态）。 */
	const [optimisticHidden, setOptimisticHidden] = useState<Set<string> | null>(null);
	useEffect(() => {
		setOptimisticHidden(null);
	}, [chatSettings.hiddenModels]);
	const hiddenHere = optimisticHidden ?? serverHidden;
	const toggleModel = (id: string) => {
		const key = `${config?.providerId}/${id}`;
		const next = new Set(hiddenHere);
		if (next.has(key) || next.has(id)) {
			next.delete(key);
			next.delete(id);
		} else {
			next.add(key);
		}
		setOptimisticHidden(next);
		send({ type: "set_settings", hiddenModels: [...next] });
	};

	/** 模型清单读取结果（refreshProviderResult 按 reqId 匹配）。 */
	const probe = refreshProviderResult && refreshProviderResult.reqId === probeReqId ? refreshProviderResult : null;
	useEffect(() => {
		if (probe?.ok) opsApi.getGateway();
	}, [probe?.ok, probe?.reqId, opsApi]);

	const modelCount = config?.models.length ?? 0;
	const modelNames = useMemo(() => (config?.models ?? []).map((m) => m.id).filter(Boolean), [config]);

	const save = () => {
		if (saving) return;
		setSaving(true);
		setSaved(false);
		pendingRef.current = opsApi.saveGateway({
			baseUrl: baseUrl.trim(),
			api,
			// 留空且没勾「清除」= 不修改密钥（见头部 @GOTCHA）。
			...(clearKey ? { apiKey: "" } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
		});
	};

	const probeModels = () => {
		if (!config) return;
		setProbeReqId(opsApi.refreshProviderModels(config.providerId));
	};

	// ── 能力标注：行编辑与提交 ─────────────────────────────────────────────
	const patchCapRow = (id: string, next: Partial<CapRow>) => {
		capDirtyRef.current = true;
		setCapRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)));
	};
	const toggleCapLevel = (id: string, level: CapLevel) => {
		setCapRows((prev) =>
			prev.map((r) => {
				if (r.id !== id) return r;
				const levels = new Set(r.levels);
				if (levels.has(level)) levels.delete(level);
				else levels.add(level);
				return { ...r, levels, levelsTouched: true };
			}),
		);
		capDirtyRef.current = true;
	};

	const saveCapabilities = () => {
		if (capSaving || !config) return;
		const invalid = capRows.find((r) => r.reasoning && r.levelsTouched && r.levels.size === 0);
		if (invalid) {
			setCapError(t("gatewayCapLevelRequired", { id: invalid.id }));
			return;
		}
		setCapError("");
		setCapServerError("");
		setCapSaving(true);
		setCapSaved(false);
		// 提交是整表替换：行 + 基线兜底。行间没出现的新模型（如刚探测进来的）
		// 原样回显，绝不能因为这次保存把它们从清单里挤掉。
		const baseById = new Map(config.models.map((m) => [m.id, m]));
		const rowIds = new Set(capRows.map((r) => r.id));
		const models = [
			...capRows.map((r) => capEntryOf(r, baseById.get(r.id))),
			...config.models.filter((m) => !rowIds.has(m.id)).map((m) => ({ ...m })),
		];
		capPendingRef.current = opsApi.saveGateway({ models });
	};

	const q = capFilter.trim().toLowerCase();
	const listedCapRows = q
		? capRows.filter((r) => r.id.toLowerCase().includes(q) || (baseNameOf(config, r.id) ?? "").toLowerCase().includes(q))
		: capRows;

	const removeDuplicate = (providerId: string) => {
		if (!window.confirm(t("gatewayDupRemoveConfirm", { id: providerId }))) return;
		send({ type: "delete_model_config", providerId });
		// 删除是异步落盘 + 推快照；稍后再读一次配置（不阻塞界面）。
		setTimeout(() => opsApi.getGateway(), 600);
	};

	return (
		<div className="set-section gw-settings">
			<div className="set-section-title">{t("gatewaySettingsTitle")}</div>
			<p className="set-hint">{t("gatewaySettingsIntro")}</p>
			{/* 当前网关是谁：有注册名就用它，没有就显示存储键 —— 重复接入时这两行是分辨依据。 */}
			{config && (
				<p className="set-hint gw-current">
					{t("gatewayCurrent")}：{config.name ?? config.providerId}
					{config.name ? ` · ${config.providerId}` : ""}
				</p>
			)}

			{/* 首次配置 / 读取失败：都走同一张表单，不另做一个「空态页面」。 */}
			{gw.ok === false && !config && <p className="gw-usage-error">{gw.error ?? t("gatewayLoadFailed")}</p>}

			{/* 运行时拒绝了这份配置：**整个 models.json 不生效**，所以任何「看着正常」都是假象。
			    必须放在最上面、用警示色，并原样带上 SDK 的话（它指到具体模型与字段）。 */}
			{gw.runtimeError && (
				<div className="gw-dup">
					<div className="gw-dup-head">
						<FiAlertTriangle /> {t("gatewayRuntimeError")}
					</div>
					<p className="set-hint">{t("gatewayRuntimeErrorHint")}</p>
					<pre className="gw-runtime-error">{gw.runtimeError}</pre>
				</div>
			)}

			<div className="gw-field">
				<span className="field-label">{t("gatewayBaseUrl")}</span>
				<input
					className="chan-input"
					type="text"
					value={baseUrl}
					placeholder={t("gatewayBaseUrlPh")}
					onChange={(e) => {
						dirtyRef.current = true;
						setBaseUrl(e.target.value);
					}}
				/>
			</div>

			<div className="gw-field">
				<span className="field-label">{t("gatewayProtocol")}</span>
				<select
					className="chan-select"
					value={api}
					onChange={(e) => {
						dirtyRef.current = true;
						setApi(e.target.value);
					}}
				>
					{PROTOCOLS.map((p) => (
						<option key={p} value={p}>
							{p}
						</option>
					))}
				</select>
				<span className="set-hint">{t("gatewayProtocolHint")}</span>
			</div>

			<div className="gw-field">
				<span className="field-label">{t("gatewayApiKey")}</span>
				<input
					className="chan-input"
					type="password"
					autoComplete="off"
					value={apiKey}
					disabled={clearKey}
					placeholder={config?.hasApiKey ? t("gatewayApiKeyKeep") : t("gatewayApiKeyPh")}
					onChange={(e) => {
						dirtyRef.current = true;
						setApiKey(e.target.value);
					}}
				/>
				<label className="gw-check">
					<input
						type="checkbox"
						checked={clearKey}
						onChange={(e) => {
							dirtyRef.current = true;
							setClearKey(e.target.checked);
							if (e.target.checked) setApiKey("");
						}}
					/>
					{t("gatewayApiKeyClear")}
				</label>
				{config?.hasApiKey && !clearKey && <span className="set-hint">{t("gatewayApiKeySaved")}</span>}
			</div>

			{/* 保存 / 结果：按钮与结论放在一起，失败原因不另起弹窗。 */}
			<div className="gw-actions">
				<button type="button" className="chan-btn primary" onClick={save} disabled={saving || !baseUrl.trim()}>
					{saving ? t("gatewaySaving") : t("gatewaySave")}
				</button>
				{saved && !saving && (
					<span className="gw-ok">
						<FiCheck /> {t("gatewaySaved")}
					</span>
				)}
				{gw.saveOk === false && pendingRef.current === null && (
					<span className="gw-usage-error">
						<FiAlertTriangle /> {t("gatewaySaveFailed", { error: gw.saveError ?? "" })}
					</span>
				)}
			</div>

			{/* 模型清单：来源是网关自己（只读 + 合并式刷新），不在这里手工编辑。 */}
			<div className="gw-field">
				<span className="field-label">
					{t("gatewayModels")}{" "}
					<span className="gw-count">
						{t("gatewayModelsEnabled", { on: String(modelNames.length - hiddenHere.size), total: String(modelCount) })}
					</span>
				</span>
				<p className="set-hint">{t("gatewayModelsToggleHint")}</p>
				<div className="gw-models">
					{modelNames.length === 0 ? (
						<span className="set-hint">{t("gatewayModelsEmpty")}</span>
					) : (
						modelNames.map((id) => {
							const off = hiddenHere.has(`${config?.providerId}/${id}`) || hiddenHere.has(id);
							return (
								<button
									key={id}
									type="button"
									className={`gw-model-chip${off ? " off" : ""}`}
									title={off ? t("gatewayModelEnable") : t("gatewayModelDisable")}
									onClick={() => toggleModel(id)}
								>
									{off ? "○" : "●"} {id}
								</button>
							);
						})
					)}
				</div>
				<div className="gw-actions">
					<button type="button" className="chan-btn" onClick={probeModels} disabled={!config}>
						<FiRefreshCw /> {t("gatewayModelsProbe")}
					</button>
					{probe && (
						<span className={probe.ok ? "gw-ok" : "gw-usage-error"}>
							{probe.ok
								? t("gatewayModelsProbed", { added: String(probe.added ?? 0), total: String(probe.total ?? 0) })
								: t("gatewayModelsProbeFailed", { error: probe.error ?? "" })}
						</span>
					)}
				</div>
				<span className="set-hint">{t("gatewayModelsHint")}</span>
			</div>

			{/* 模型能力标注：网关 /models 只报 id，推理/识图/档位在这里补齐（新模型自助打标，不改代码）。 */}
			<div className="gw-field">
				<span className="field-label">{t("gatewayCapTitle")}</span>
				<p className="set-hint">{t("gatewayCapIntro")}</p>
				{modelCount === 0 ? (
					<span className="set-hint">{t("gatewayCapEmpty")}</span>
				) : (
					<>
						<input
							className="chan-input gw-cap-filter"
							type="text"
							placeholder={t("gatewayCapFilterPh")}
							value={capFilter}
							onChange={(e) => setCapFilter(e.target.value)}
						/>
						<div className="gw-cap-list">
							{listedCapRows.map((row) => (
								<div key={row.id} className="gw-cap-row">
									<span className="gw-cap-id" title={row.id}>
										{row.id}
									</span>
									<label className="gw-cap-check">
										<input
											type="checkbox"
											checked={row.reasoning}
											onChange={(e) => patchCapRow(row.id, { reasoning: e.target.checked, reasoningTouched: true })}
										/>
										{t("reasoning")}
									</label>
									<label className="gw-cap-check">
										<input
											type="checkbox"
											checked={row.vision}
											onChange={(e) => patchCapRow(row.id, { vision: e.target.checked, visionTouched: true })}
										/>
										{t("vision")}
									</label>
									<div className="gw-cap-levels" title={t("gatewayCapLevelsHint")}>
										{CAP_LEVELS.map((lv) => (
											<button
												key={lv}
												type="button"
												className={`gw-cap-level${row.levels.has(lv) ? " on" : ""}`}
												disabled={!row.reasoning}
												onClick={() => toggleCapLevel(row.id, lv)}
											>
												{t(`thinking.${lv}`)}
											</button>
										))}
									</div>
									<input
										className="chan-input gw-cap-num"
										type="number"
										placeholder={t("gatewayCapContext")}
										value={row.contextWindow}
										onChange={(e) => patchCapRow(row.id, { contextWindow: e.target.value })}
									/>
									<input
										className="chan-input gw-cap-num"
										type="number"
										placeholder={t("gatewayCapMaxTokens")}
										value={row.maxTokens}
										onChange={(e) => patchCapRow(row.id, { maxTokens: e.target.value })}
									/>
								</div>
							))}
						</div>
						<div className="gw-actions">
							<button type="button" className="chan-btn primary" onClick={saveCapabilities} disabled={capSaving || !config}>
								{capSaving ? t("gatewaySaving") : t("gatewayCapSave")}
							</button>
							{capSaved && !capSaving && (
								<span className="gw-ok">
									<FiCheck /> {t("gatewaySaved")}
								</span>
							)}
							{capError && (
								<span className="gw-usage-error">
									<FiAlertTriangle /> {capError}
								</span>
							)}
							{capServerError && (
								<span className="gw-usage-error">
									<FiAlertTriangle /> {t("gatewaySaveFailed", { error: capServerError })}
								</span>
							)}
						</div>
						<span className="set-hint">{t("gatewayCapLevelsHint")}</span>
					</>
				)}
			</div>

			{/* 用量：与面板/状态栏同一份口径（GatewayUsageBlock 是唯一实现）。 */}
			<GatewayUsageBlock
				state={gatewayUsage}
				activeProvider={activeProvider}
				onRefresh={() => opsApi.queryGatewayUsage(config?.providerId, true)}
			/>

			{/* 重复接入：只提示 + 给一键删除，绝不自动删（配置是用户的东西）。 */}
			{gw.duplicates.length > 0 && (
				<div className="gw-dup">
					<div className="gw-dup-head">
						<FiAlertTriangle /> {t("gatewayDupTitle")}
					</div>
					<p className="set-hint">
						{t("gatewayDupHint", {
							ids: gw.duplicates.map((d) => d.providerId).join("、"),
							count: String(gw.duplicates.reduce((n, d) => n + d.modelCount, 0)),
						})}
					</p>
					<div className="gw-dup-list">
						{gw.duplicates.map((d) => (
							<span key={d.providerId} className="gw-dup-row">
								<span className="gw-dup-id">{d.providerId}</span>
								<span className="set-hint">{d.baseUrl ?? ""}</span>
								<button type="button" className="chan-btn danger" onClick={() => removeDuplicate(d.providerId)}>
									<FiTrash2 /> {t("gatewayDupRemove")}
								</button>
							</span>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
