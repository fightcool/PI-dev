/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelSettings.tsx（唯一挂载点：新建/编辑渠道档案）,
 *            components/ChannelModelWhitelist.tsx（模型白名单勾选）,
 *            components/ChannelAccountQuery.tsx（账户查询模板 + accountPayloadOf 校验）,
 *            components/ChannelFields.tsx（字段控件）, channel-models.ts（白名单 id 口径）,
 *            server/dev-con/channel-config.ts（channel_save 校验：id/名称/服务商/凭据/白名单）,
 *            use-chat.ts（channelModelsResult 状态 + fetch_channel_models 出帧）
 *   @GOTCHA 「获取接口清单」的结果按 providerId 归属：换服务商后旧结果必须丢弃（否则会把
 *           别的服务商的模型塞进白名单）。
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道档案只存引用、不存密钥）, §6（设置页校验）
 *   @CONTRACT 只提交 channel_save 的 payload；凭据按名称引用（null = 跟随服务商 active key）。
 *   @ASSUME channel_state 不下发 extra 里的 mapping/items/method/prefix，因此**没动过账户配置
 *           就不提交 extra**（深合并不存在，浅合并会整体替换）；动过则由 accountPayloadOf 整体生成。
 *   @GOTCHA 白名单里的 id 是「服务商内部 id」：换服务商必须清空（旧 id 在新服务商下无意义），
 *           否则用户会看到「限定 N 个模型」但一个模型都不出现。
 *   @GOTCHA 新建时 id 可填（服务端生成缺省值），编辑时 id 只读——它是绑定键，
 *           改掉会让已有对话绑定变成孤儿（服务端也按 id 匹配）。
 *   @GOTCHA 模型 id 用 bareModelId（只剥第一个 provider 前缀），"openrouter/vendor/model" 不会剥错。
 *   @WHY 账户「测试查询」不被允许：写配置来测试会让失败验证污染真实档案；保存后由行内
 *        「查询账户」命令验证（channel_query_account，只读）。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import type { ChannelSaveInput } from "../use-chat";
import type { ModelInfo, ProviderKeyInfo, UiChannelInfo, UiModelConfigEntry } from "../types";
import { useT } from "../i18n";
import { ChannelModelWhitelist } from "./ChannelModelWhitelist";
import { ChannelAccountQuery, accountPayloadOf, type AccountPreset } from "./ChannelAccountQuery";
import { SelectField, TextField } from "./ChannelFields";

/** 「跟随服务商当前密钥」在 <select> 里的哨兵值（空值留给 disabled 占位项）。 */
export const FOLLOW_ACTIVE = "__active";

/** 新建/编辑表单草稿（凭据按名称；credentialKeyName=null = 跟随 active key）。 */
export interface ChannelDraft {
	/** 绑定键：已有渠道的 id；null = 新建（此时看 idInput）。 */
	id: string | null;
	/** 新建时可编辑的 id（留空 = 服务端生成）；编辑时只读展示。 */
	idInput: string;
	displayName: string;
	providerId: string;
	endpointId: string;
	credentialKeyName: string | null;
	accountRef: string;
	/** 模型白名单（服务商内部 id）；空数组 = 不限。 */
	models: string[];
	enabled: boolean;
	/** 账户查询配置（kind 为空 = 不查询；见 ChannelAccountQuery.tsx）。 */
	accountKind: string;
	accountUrl: string;
	accountMethod: string;
	accountApiKeyHeader: string;
	accountApiKeyPrefix: string;
	accountBody: string;
	accountMappingJson: string;
	accountItemsJson: string;
	accountUnit: string;
	accountScale: string;
	/** 账户查询专用凭据名（网关控制台令牌；留空 = 用渠道模型凭据）。 */
	accountCredentialKeyName: string;
}

export function channelDraftOf(c: UiChannelInfo | null, fallbackProvider: string): ChannelDraft {
	// channel_state 现在**完整回显**账户配置（含 method/apiKeyHeader/apiKeyPrefix/body/mapping/items），
	// 因此编辑已存模板时可以正确回填；仍保留默认值兜底：空串在服务端语义里是「不加前缀」，
	// 留空会静默改坏一个能用的配置，所以缺字段时回落到服务端默认值。
	const hasAccount = Boolean(c?.account);
	const echo = (c?.account ?? {}) as Record<string, unknown>;
	const echoText = (key: string): string => (typeof echo[key] === "string" ? (echo[key] as string) : "");
	const echoJson = (key: string): string => (echo[key] && typeof echo[key] === "object" ? JSON.stringify(echo[key], null, 2) : "");
	return {
		id: c?.id ?? null,
		idInput: c?.id ?? "",
		displayName: c?.displayName ?? "",
		providerId: c?.providerId ?? fallbackProvider,
		endpointId: c?.endpointId ?? "",
		credentialKeyName: c?.credentialRef?.keyName ?? null,
		accountRef: c?.accountRef ?? "",
		models: c?.models ?? [],
		enabled: c?.enabled ?? true,
		accountKind: echoText("kind"),
		accountUrl: echoText("url"),
		accountMethod: echoText("method") || "GET",
		accountApiKeyHeader: echoText("apiKeyHeader") || (hasAccount ? "authorization" : ""),
		accountApiKeyPrefix: typeof echo.apiKeyPrefix === "string" ? echo.apiKeyPrefix : hasAccount ? "Bearer " : "",
		accountBody: echoText("body"),
		accountMappingJson: echoJson("mapping"),
		accountItemsJson: echoJson("items"),
		accountUnit: echoText("unit"),
		accountScale: typeof echo.scale === "number" ? String(echo.scale) : "",
		accountCredentialKeyName: echoText("credentialKeyName"),
	};
}

/** 渠道 id 规则与服务端一致（channel-model.ts 的 isValidChannelId）：2–48 位小写/数字/连字符。 */
const isValidChannelId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{1,47}$/.test(id);

/**
 * 渠道新建/编辑表单。由 ChannelSettings 以 key 重挂载，所以内部状态总是从 draft 初始化。
 * 校验：id 格式、账户接口 URL（http(s) 或 {baseUrl} 模板）、换算比例、JSON 字段；其余交给服务端回执。
 */
export function ChannelForm({
	draft,
	providerIds,
	providerKeys,
	models,
	accountPresets,
	onFetchChannelModels,
	channelModelsResult,
	onSave,
	onCancel,
}: {
	draft: ChannelDraft;
	providerIds: string[];
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** 模型目录（白名单勾选源）。 */
	models: ModelInfo[];
	/** 服务端下发的账户查询预设（一键填充）。 */
	accountPresets?: AccountPreset[];
	/** 「获取接口清单」：请求服务端按该服务商的 baseUrl 探测 /models（密钥不出服务端）。 */
	onFetchChannelModels?: (providerId: string, keyName: string | null, reqId: number) => void;
	/** 上一次探测结果（按 reqId + providerId 匹配，见 use-chat 的 channelModelsResult）。 */
	channelModelsResult?: {
		reqId: number;
		providerId: string;
		ok: boolean;
		models?: UiModelConfigEntry[];
		baseUrl?: string;
		error?: string;
	} | null;
	onSave: (payload: ChannelSaveInput) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [form, setForm] = useState(draft);
	const [error, setError] = useState<string | null>(null);
	/** 账户配置是否被改过：没改过就不提交 extra（见 @ASSUME）。 */
	const [accountTouched, setAccountTouched] = useState(false);
	const set = (patch: Partial<ChannelDraft>) => setForm((d) => ({ ...d, ...patch }));
	const knownKeys = providerKeys[form.providerId] ?? [];

	// 「获取接口清单」：reqId 自增（并发/重复点击时只认最后一次），结果按 providerId 过滤，
	// 换了服务商就丢弃过期结果（旧服务商的模型 id 在新服务商下没有意义）。
	const reqSeq = useRef(0);
	const [pendingReq, setPendingReq] = useState<number | null>(null);
	const [fetchErr, setFetchErr] = useState<string | null>(null);
	useEffect(() => {
		if (!channelModelsResult || pendingReq === null || channelModelsResult.reqId !== pendingReq) return;
		setPendingReq(null);
		setFetchErr(channelModelsResult.ok ? null : (channelModelsResult.error ?? ""));
	}, [channelModelsResult, pendingReq]);
	/** 属于当前服务商的那次结果（其他服务商的过期结果一律当没有）。 */
	const fetchResult =
		channelModelsResult && channelModelsResult.providerId === form.providerId ? channelModelsResult : null;
	const fetchModels = fetchResult?.ok ? fetchResult.models : undefined;
	const fetchState = onFetchChannelModels
		? {
				busy: pendingReq !== null,
				ok: fetchErr !== null ? false : fetchResult ? true : null,
				baseUrl: fetchResult?.baseUrl,
				error: fetchErr ?? undefined,
			}
		: undefined;
	const fetchFromEndpoint = () => {
		if (!onFetchChannelModels || !form.providerId || pendingReq !== null) return;
		const reqId = ++reqSeq.current;
		setFetchErr(null);
		setPendingReq(reqId);
		onFetchChannelModels(form.providerId, form.credentialKeyName, reqId);
	};

	const submit = () => {
		const newId = form.idInput.trim();
		if (!form.id && newId && !isValidChannelId(newId)) return setError(t("channelIdInvalid"));
		const account = accountPayloadOf(form, t);
		if (account.error) return setError(account.error);
		const payload: ChannelSaveInput = {
			// 编辑：id 是绑定键，原样送回（只读）；新建：可填，留空让服务端生成。
			...(form.id ? { id: form.id } : newId ? { id: newId } : {}),
			displayName: form.displayName.trim(),
			providerId: form.providerId,
			...(form.endpointId.trim() ? { endpointId: form.endpointId.trim() } : {}),
			credentialRef: form.credentialKeyName ? { providerId: form.providerId, keyName: form.credentialKeyName } : null,
			accountRef: form.accountRef.trim() || null,
			// 白名单始终提交（空数组 = 不限，必须能显式清空）。
			models: form.models,
			enabled: form.enabled,
			...(account.account && accountTouched ? { extra: { account: account.account } } : {}),
		};
		onSave(payload);
	};

	return (
		<div className="chan-form">
			<div className="chan-form-title">{form.id ? t("channelEditTitle") : t("channelAdd")}</div>
			<TextField
				label={t("channelDisplayName")}
				value={form.displayName}
				ph={t("channelDisplayNamePh")}
				onChange={(v) => set({ displayName: v })}
			/>
			<label className="field">
				<span className="field-label">{t("channelId")}</span>
				{form.id ? (
					<input value={form.id} readOnly />
				) : (
					<input value={form.idInput} placeholder={t("channelIdPh")} onChange={(e) => set({ idInput: e.target.value })} />
				)}
				{form.id && <span className="field-hint">{t("channelIdLocked")}</span>}
			</label>
			<SelectField
				label={t("channelProvider")}
				value={form.providerId}
				// 换服务商 = 白名单 id 失效（它们是服务商内部 id），必须清空（见 @GOTCHA）。
				onChange={(v) => set({ providerId: v, credentialKeyName: null, models: [] })}
			>
				<option value="" disabled>
					{t("channelProviderPh")}
				</option>
				{providerIds.map((id) => (
					<option key={id} value={id}>
						{id}
					</option>
				))}
				{/* 服务商已不存在（providerMissing）时保留原值，否则下拉会静默变成空选择。 */}
				{form.providerId && !providerIds.includes(form.providerId) && (
					<option value={form.providerId}>{form.providerId}</option>
				)}
			</SelectField>
			<SelectField
				label={t("channelCredentialKey")}
				value={form.credentialKeyName ?? FOLLOW_ACTIVE}
				onChange={(v) => set({ credentialKeyName: v === FOLLOW_ACTIVE ? null : v })}
			>
				<option value={FOLLOW_ACTIVE}>{t("channelFollowActiveKey")}</option>
				{knownKeys.map((k) => (
					<option key={k.name} value={k.name}>
						{k.name}
						{k.active ? " ●" : ""}
					</option>
				))}
				{form.credentialKeyName && !knownKeys.some((k) => k.name === form.credentialKeyName) && (
					<option value={form.credentialKeyName}>{form.credentialKeyName}</option>
				)}
			</SelectField>
			<TextField
				label={t("channelEndpoint")}
				value={form.endpointId}
				ph={t("channelEndpointPh")}
				onChange={(v) => set({ endpointId: v })}
			/>
			<ChannelModelWhitelist
				models={models}
				providerId={form.providerId}
				value={form.models}
				onChange={(next) => set({ models: next })}
				onFetchModels={onFetchChannelModels ? fetchFromEndpoint : undefined}
				fetchModels={fetchModels}
				fetchState={fetchState}
			/>
			<TextField
				label={t("channelAccountRef")}
				value={form.accountRef}
				ph={t("channelAccountRefPh")}
				onChange={(v) => set({ accountRef: v })}
			/>
			<p className="set-hint">{t("channelAccountHint")}</p>
			<ChannelAccountQuery
				draft={form}
				presets={accountPresets}
				onChange={set}
				onTouch={() => setAccountTouched(true)}
			/>
			<label className="chan-enable">
				<input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
				{t("channelEnabledLabel")}
			</label>
			{error && <div className="chan-warn">{error}</div>}
			<div className="chan-form-actions">
				<button type="button" className="chan-btn" onClick={onCancel}>
					{t("cancel")}
				</button>
				<button
					type="button"
					className="chan-btn primary"
					disabled={!form.displayName.trim() || !form.providerId}
					onClick={submit}
				>
					{t("save")}
				</button>
			</div>
		</div>
	);
}
