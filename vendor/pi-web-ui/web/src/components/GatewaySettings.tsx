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
import type { ClientMessage, UiProviderConfig } from "../types";
import type { ChatState, OpsApi } from "../use-chat";
import { useT } from "../i18n";
import { GatewayUsageBlock } from "./GatewayUsageBlock";

/** 网关可用的接口协议（与 server/protocol.ts 的 uiProvider 注释同一口径）。 */
const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

export function GatewaySettings({
	gateway,
	gatewayUsage,
	activeProvider,
	refreshProviderResult,
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
	opsApi: OpsApi;
	/** 只用于删除重复接入（delete_model_config）；保存走 opsApi。 */
	send: (msg: ClientMessage) => boolean;
}) {
	const t = useT();
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

	// 保存成功后重新读取（服务端会归一化/回填能力，界面不自己猜结果）。
	useEffect(() => {
		if (gw.saveOk === null) return;
		setSaving(false);
		if (gw.saveOk && pendingRef.current !== null) {
			pendingRef.current = null;
			dirtyRef.current = false;
			opsApi.getGateway();
			opsApi.queryGatewayUsage(undefined, true);
		}
	}, [gw.saveOk, gw.saveError, opsApi]);

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
					{t("gatewayModels")} <span className="gw-count">{t("gatewayModelsCount", { n: String(modelCount) })}</span>
				</span>
				<div className="gw-models">
					{modelNames.length === 0 ? (
						<span className="set-hint">{t("gatewayModelsEmpty")}</span>
					) : (
						modelNames.map((id) => (
							<span key={id} className="gw-model-chip">
								{id}
							</span>
						))
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
