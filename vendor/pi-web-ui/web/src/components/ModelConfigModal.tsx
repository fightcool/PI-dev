/* 🍞 @COUPLED server/model-admin.ts（saveModelConfig/writeModelConfig 契约）, server/protocol.ts
 *   （ProviderStatus / set_settings.hiddenBuiltinProviders）, web/src/app/app-dialogs.tsx,
 *   components/ChannelForm.tsx（服务商连接的唯一入口）
 *   @CONTRACT 本面板只做两件事：① 内置服务商的多密钥管理（增/启/删）；② 内置服务商与
 *   models.json 服务商的只读对照 + 隐藏/恢复。
 *   @GOTCHA 内置服务商来自 pi 运行时注册表，无法真正卸载：「删除」= 记进
 *   hiddenBuiltinProviders 并清密钥，仅控制本面板是否展示（渠道/模型选择器不受影响）。
 *   @WHY 2026-09-12 方案 B：自定义服务商的增/删/改一律在「设置 → 渠道 → 服务商连接」——
 *   两个面板都能写 models.json 是「多个入口交叉管理」的根源，那条路径已从这里移除。
 *   📖 docs/DEV-CON-PROPOSAL.md §4 */
import { useEffect, useState } from "react";
import { FiCheck, FiPlus, FiRotateCcw, FiTrash2, FiX } from "react-icons/fi";
import type { ClientMessage, ProviderKeyInfo, ProviderStatus, UiProviderConfig } from "../types";
import { useT } from "../i18n";

interface ModelConfigModalProps {
	send: (msg: ClientMessage) => boolean;
	/** Custom providers from agentDir/models.json. */
	providers: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providerStatus: ProviderStatus[];
	/** Stored API keys per built-in provider (masked). */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** 用户「删除」的内置服务商 id（= 本列表不再展示；可在底部「已隐藏」恢复）。
	 *  来自 settings.hiddenBuiltinProviders（服务端持久化 + 全局共享）。 */
	hiddenProviders: string[];
	onClose: () => void;
}

export function ModelConfigModal({
	send,
	providers,
	providerStatus,
	providerKeys,
	hiddenProviders,
	onClose,
}: ModelConfigModalProps) {
	const t = useT();
	/** 已隐藏的内置服务商是否展开（仅在本次弹窗会话内有效）。 */
	const [showHidden, setShowHidden] = useState(false);
	/** Inline "add key" input per built-in provider (secondary key value). */
	const [addKeys, setAddKeys] = useState<Record<string, string>>({});
	const [addKeyNames, setAddKeyNames] = useState<Record<string, string>>({});
	const [addKeyBusy, setAddKeyBusy] = useState<string | null>(null);

	// Fresh config when the modal opens.
	useEffect(() => {
		send({ type: "list_models_config" });
		send({ type: "list_providers" });
		send({ type: "list_provider_keys" });
	}, [send]);

	/** Add an API key to a built-in provider's key list (the first key added
	 *  becomes active; further ones stay inactive until a model under that key
	 *  is clicked in the picker). No model list is ever copied. */
	const addKey = (p: ProviderStatus) => {
		const key = (addKeys[p.id] ?? "").trim();
		if (!key || addKeyBusy) return;
		setAddKeyBusy(p.id);
		send({
			type: "add_provider_key",
			provider: p.id,
			apiKey: key,
			name: (addKeyNames[p.id] ?? "").trim() || undefined,
		});
		setTimeout(() => {
			setAddKeyBusy(null);
			setAddKeys((k) => ({ ...k, [p.id]: "" }));
			setAddKeyNames((n) => ({ ...n, [p.id]: "" }));
			send({ type: "list_providers" });
			send({ type: "list_provider_keys" });
		}, 1500);
	};

	/** Make a stored API key the ACTIVE one for a built-in provider, by NAME. */
	const activateKey = (providerId: string, keyName: string) => {
		send({ type: "activate_provider_key", provider: providerId, keyName });
		send({ type: "list_provider_keys" });
	};

	/** Remove a stored API key by NAME; if it was active, the first remaining key takes over. */
	const removeKey = (providerId: string, keyName: string) => {
		if (!window.confirm(t("removeKeyConfirm"))) return;
		send({ type: "remove_provider_key", provider: providerId, keyName });
		send({ type: "list_provider_keys" });
	};

	/** Clear a built-in provider's STORED key (source "stored") — the provider
	 *  returns to unconfigured and its models leave the picker. */
	const clearBuiltinKey = (id: string) => {
		if (window.confirm(t("clearKeyConfirm", { id }))) {
			send({ type: "clear_provider_api_key", provider: id });
		}
	};

	/** 已被「删除」的内置服务商 id 集合（服务端持久化 + 全局共享）。 */
	const hidden = new Set(hiddenProviders);
	/** models.json 里声明过的服务商：它们也会出现在运行时注册表里，所以「内置」
	 *  区块同样会列出它们。这类不要给「删除（隐藏）」——真正的删除在下面的
	 *  自定义区块里，隐藏只会造成「两个地方各有一个删除按钮」的困惑。 */
	const customIds = new Set(providers.map((p) => p.providerId));
	/** 内置列表里还显示的那些。 */
	const visibleStatus = providerStatus.filter((p) => !hidden.has(p.id));
	/** 隐藏行按 id 集合列出：即使运行时不再注册该服务商，也能从这里恢复，
	 *  不会变成永远看不见的幽灵项。 */
	const hiddenRows = [...hidden].map((id) => ({
		id,
		name: providerStatus.find((p) => p.id === id)?.name ?? id,
	}));

	/** 写回隐藏集合（纯 UI 偏好，走 set_settings —— 不触发 runtime reload）。 */
	const setHidden = (ids: string[]) => send({ type: "set_settings", hiddenBuiltinProviders: ids });

	/** 「删除」内置服务商 = 从列表移除（持久化隐藏）+ 清掉已保存的密钥。
	 *  内置服务商是 pi 运行时注册表的一部分，删不掉；密钥才是「它还能不能被用
	 *  到」的开关（残留密钥会让它继续出现在模型选择器/视觉桥里）。 */
	const removeBuiltinProvider = (p: ProviderStatus) => {
		const keys = providerKeys[p.id] ?? [];
		const hasStoredKey = keys.length > 0 || p.source === "stored";
		const ok = window.confirm(
			hasStoredKey
				? t("hideProviderConfirmKeys", { name: p.name, id: p.id, n: keys.length })
				: t("hideProviderConfirm", { name: p.name, id: p.id }),
		);
		if (!ok) return;
		if (hasStoredKey) send({ type: "clear_provider_api_key", provider: p.id });
		setHidden([...hidden, p.id]);
	};

	const restoreBuiltinProvider = (id: string) => setHidden([...hidden].filter((x) => x !== id));

	/** 一键清理的目标：既没配置、也没有密钥、更没有来源（环境变量/运行时）的内置
	 *  服务商。内置注册表动辄 40+ 个，绝大多数永远用不上——逐个删除仍是操作成本。 */
	const unconfigured = visibleStatus.filter(
		(p) => !customIds.has(p.id) && !p.configured && !p.source && (providerKeys[p.id] ?? []).length === 0,
	);
	const removeUnconfigured = () => {
		if (unconfigured.length === 0) return;
		if (!window.confirm(t("hideUnconfiguredConfirm", { n: unconfigured.length }))) return;
		setHidden([...hidden, ...unconfigured.map((p) => p.id)]);
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal model-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<h2>{t("manageModelsTitle")}</h2>
				</div>

				<>
					<div className="model-modal-fixed-hint model-modal-hint-row">
						<div className="form-section-title">
							{t("builtinProviders")} <em className="section-hint">{t("hintKeyOnly")}</em>
						</div>
						{unconfigured.length > 1 && (
							<button type="button" className="btn sm danger" onClick={removeUnconfigured}>
								<FiTrash2 /> {t("deleteUnconfigured", { n: unconfigured.length })}
							</button>
						)}
					</div>
					<div className="model-modal-body">
						<div className="provider-list">
							{providerStatus.length === 0 && <div className="dd-loading">{t("loading")}</div>}
							{providerStatus.length > 0 && visibleStatus.length === 0 && (
								<div className="dd-loading">{t("allProvidersHidden")}</div>
							)}
							{visibleStatus.map((p) => {
								const pkeys = providerKeys[p.id] ?? [];
								return (
									<div className="provider-row provider-key-row" key={p.id}>
										<div className="provider-key-head">
											<div className="provider-info">
												<span className="provider-name">{p.name}</span>
												<span className="provider-sub">
													{p.id}
													{p.configured && <span className="auth-badge">{t("configuredBadge")}</span>}
													{p.source && !p.configured && <span className="auth-badge dim">{p.source}</span>}
												</span>
											</div>
											<div className="provider-actions">
												{p.source === "stored" && (
													<button
														type="button"
														className="btn sm danger"
														title={t("clearKeyTitle")}
														onClick={() => clearBuiltinKey(p.id)}
													>
														<FiTrash2 /> {t("clearKey")}
													</button>
												)}
												{!customIds.has(p.id) && (
													<button
														type="button"
														className="iconbtn danger"
														title={t("hideProviderTitle")}
														onClick={() => removeBuiltinProvider(p)}
													>
														<FiTrash2 />
													</button>
												)}
											</div>
										</div>
										<div className="provider-keys">
											{pkeys.length === 0 && <div className="provider-key-empty">{t("noKeyYet")}</div>}
											{pkeys.map((k) => (
												<div className={`provider-key-item ${k.active ? "active" : ""}`} key={k.name}>
													<span className="provider-key-dot">{k.active ? "●" : "○"}</span>
													<span className="provider-key-label">{k.name}</span>
													{!k.active && (
														<button
															type="button"
															className="iconbtn"
															title={t("activateKey")}
															onClick={() => activateKey(p.id, k.name)}
														>
															<FiCheck />
														</button>
													)}
													<button
														type="button"
														className="iconbtn danger"
														title={t("removeKey")}
														onClick={() => removeKey(p.id, k.name)}
													>
														<FiTrash2 />
													</button>
												</div>
											))}
											<div className="provider-add-key">
												<input
													type="text"
													className="key-input key-input-name"
													placeholder={t("keyNamePh")}
													value={addKeyNames[p.id] ?? ""}
													onChange={(e) => setAddKeyNames((k) => ({ ...k, [p.id]: e.target.value }))}
												/>
												<input
													type="password"
													className="key-input key-input-value"
													placeholder={t("addKeyPlaceholder")}
													value={addKeys[p.id] ?? ""}
													onChange={(e) => setAddKeys((k) => ({ ...k, [p.id]: e.target.value }))}
												/>
												<button
													type="button"
													className="btn primary sm"
													disabled={!(addKeys[p.id] ?? "").trim() || addKeyBusy === p.id}
													onClick={() => addKey(p)}
												>
													<FiPlus /> {addKeyBusy === p.id ? t("savingKey") : t("addKey")}
												</button>
											</div>
										</div>
									</div>
								);
							})}
						</div>

						{/* 已删除（隐藏）的内置服务商：默认收起，展开可逐个恢复。 */}
						{hiddenRows.length > 0 && (
							<>
								<div className="provider-hidden-bar">
									<span className="modal-desc">{t("hiddenProviders", { n: hiddenRows.length })}</span>
									<button type="button" className="set-btn-mini" onClick={() => setShowHidden((v) => !v)}>
										{showHidden ? t("hiddenCollapse") : t("hiddenExpand")}
									</button>
								</div>
								{showHidden && (
									<div className="provider-list">
										{hiddenRows.map((h) => (
											<div className="provider-row provider-hidden-row" key={h.id}>
												<div className="provider-info">
													<span className="provider-name">{h.name}</span>
													<span className="provider-sub">{h.id}</span>
												</div>
												<button
													type="button"
													className="btn sm"
													title={t("restoreProviderTitle")}
													onClick={() => restoreBuiltinProvider(h.id)}
												>
													<FiRotateCcw /> {t("restoreProvider")}
												</button>
											</div>
										))}
									</div>
								)}
							</>
						)}

						<div className="form-section-title">{t("customProviders")}</div>
						<p className="modal-desc">{t("customDesc")}</p>
						{providers.length === 0 && <div className="dd-loading">{t("noCustomProviders")}</div>}
						<div className="provider-list">
							{providers.map((p) => (
								<div className="provider-row" key={p.providerId}>
									<div className="provider-info">
										<span className="provider-name">{p.providerId}</span>
										<span className="provider-sub">
											{p.api ?? "—"}
											{p.baseUrl ? ` · ${p.baseUrl}` : ""}
											{p.models.length > 0 && ` · ${t("modelsCount", { n: p.models.length })}`}
										</span>
									</div>
									{/* 方案 B：自定义服务商不再在这里增删改 —— 连接/密钥/模型都在
									    「设置 → 渠道」的「服务商连接」里管理（单一入口）。这里只读展示，
									    方便对照模型目录。 */}
									<div className="provider-actions">
										<span className="provider-managed">{t("customManagedInChannels")}</span>
									</div>
								</div>
							))}
						</div>
					</div>
					<div className="modal-actions">
						{/* 唯一入口：设置 → 渠道 → 新增渠道 → 服务商连接（会一并写 models.json）。 */}
						<p className="modal-desc">{t("customAddInChannels")}</p>
					</div>
				</>
			</div>
		</div>
	);
}
