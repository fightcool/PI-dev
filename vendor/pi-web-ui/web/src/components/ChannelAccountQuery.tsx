/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelForm.tsx（挂载点 + 提交时调用 accountPayloadOf）,
 *            components/ChannelFields.tsx（字段控件）, components/ChannelSettings.tsx（查询账户）,
 *            server/dev-con/account-template.ts（模板字段/默认值的唯一事实源）,
 *            server/protocol.ts（channel_state.accountPresets 下发预设）
 *   📖 docs/DEV-CON-PROPOSAL.md §7（余额/配额：单位、查询时间、失败状态）, §8 P3
 *   @CONTRACT 生成的 extra.account 结构 = account-template.ts 的 AccountTemplate：
 *             { kind:"template", url, method, apiKeyHeader, apiKeyPrefix, body, mapping, items, unit, scale, credentialKeyName }。
 *   @WHY 三个写死的适配器（DeepSeek/网关/OpenRouter）曾经是用户改不动的「死功能」：
 *        现在它们只是**预设**，URL/方法/鉴权/字段映射都能改；服务端仍按同一套有界基建查询。
 *   @GOTCHA 服务端对 extra.account 是**浅合并**（channel-config.ts 只覆盖 extra.account 整个对象），
 *           而 channel_state 只回显 kind/url/unit/scale/credentialKeyName —— 已存的 mapping/items/
 *           method/prefix 不会下发。所以「没动过账户配置就不提交 extra」（见 ChannelForm 的 touched），
 *           一旦动过就是整体覆盖，并且必须显式提示用户（channelTemplateOverwrite）。
 *   @GOTCHA apiKeyPrefix="" 与「不填」语义不同：服务端把 undefined 当默认 "Bearer "，
 *           空串才是「不加前缀」。这里原样提交文本框内容，绝不用 trim 悄悄改写。
 *   @GOTCHA URL 里允许 {baseUrl} 占位（服务端渲染后再校验 http(s)），所以前端校验必须放行它。
 * ──────────────────────────────────────────────────
 */
import { useState } from "react";
import type { Translate } from "../i18n";
import { useT } from "../i18n";
import type { ChannelDraft } from "./ChannelForm";
import { SelectField, TextAreaField, TextField } from "./ChannelFields";

/** 服务端下发的账户查询预设（一键填充到模板编辑器）。 */
export type AccountPreset = { id: string; label: string; description: string; template: Record<string, unknown> };

/** 模板字段的服务端默认值（account-template.ts：header 默认 authorization、prefix 默认 "Bearer "）。 */
export const DEFAULT_API_KEY_HEADER = "authorization";
export const DEFAULT_API_KEY_PREFIX = "Bearer ";

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/** 文本字段安全取值（预设模板是 Record<string, unknown>）。 */
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const jsonText = (v: unknown): string => (v && typeof v === "object" ? JSON.stringify(v, null, 2) : "");

/** 预设模板 → 表单补丁（用户可继续修改；kind 固定为 template）。 */
export function draftFromTemplate(template: Record<string, unknown>): Partial<ChannelDraft> {
	// 预设可以指向内置适配器（openai-gateway 这类）：它们自带回退逻辑，不能一律压成 template。
	const kind = typeof template.kind === "string" && template.kind.trim() ? template.kind.trim() : "template";
	return {
		accountKind: kind,
		accountUrl: str(template.url),
		accountMethod: template.method === "POST" ? "POST" : "GET",
		accountApiKeyHeader: str(template.apiKeyHeader) || DEFAULT_API_KEY_HEADER,
		accountApiKeyPrefix: typeof template.apiKeyPrefix === "string" ? template.apiKeyPrefix : DEFAULT_API_KEY_PREFIX,
		accountBody: str(template.body),
		accountMappingJson: jsonText(template.mapping),
		accountItemsJson: jsonText(template.items),
		accountUnit: str(template.unit),
		accountScale: typeof template.scale === "number" ? String(template.scale) : "",
		accountTopupUrl: str(template.topupUrl),
	};
}

/** 解析 JSON 对象字段：空 = 不配置；非法 JSON / 非对象 → 可读错误（绝不静默提交坏配置）。 */
function parseJsonObject(raw: string, label: string, t: Translate): { value?: Record<string, unknown>; error?: string } {
	const text = raw.trim();
	if (!text) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { error: t("channelJsonInvalid", { field: label, err: (err as Error).message }) };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: t("channelJsonNotObject", { field: label }) };
	return { value: parsed as Record<string, unknown> };
}

/**
 * 校验并把草稿转成 extra.account。
 * 返回 `{}` 表示「不提交 extra」（kind 为空 = 不查询，服务端已有配置保持不变）。
 */
export function accountPayloadOf(draft: ChannelDraft, t: Translate): { account?: Record<string, unknown>; error?: string } {
	const kind = draft.accountKind.trim();
	if (!kind) return {};
	const url = draft.accountUrl.trim();
	if (kind === "template" && !url) return { error: t("channelAccountUrlRequired") };
	// {baseUrl} 占位由服务端渲染后才校验 http(s)，这里必须放行（见 @GOTCHA）。
	if (url && !isHttpUrl(url) && !url.includes("{baseUrl}")) return { error: t("channelUrlInvalid") };
	const scaleRaw = draft.accountScale.trim();
	const scale = scaleRaw ? Number(scaleRaw) : undefined;
	if (scaleRaw && !(scale !== undefined && Number.isFinite(scale) && scale > 0)) return { error: t("channelScaleInvalid") };
	const mapping = parseJsonObject(draft.accountMappingJson, t("channelAccountMapping"), t);
	if (mapping.error) return { error: mapping.error };
	const items = parseJsonObject(draft.accountItemsJson, t("channelAccountItems"), t);
	if (items.error) return { error: items.error };
	if (items.value && typeof items.value.path !== "string") return { error: t("channelItemsPathRequired") };
	const body = draft.accountBody.trim();
	if (body) {
		try {
			JSON.parse(body);
		} catch (err) {
			return { error: t("channelJsonInvalid", { field: t("channelAccountBody"), err: (err as Error).message }) };
		}
	}
	const account: Record<string, unknown> = { kind };
	if (url) account.url = url;
	account.method = draft.accountMethod === "POST" ? "POST" : "GET";
	// 空 header 退回服务端默认值；prefix 原样提交（"" = 不加前缀，见 @GOTCHA）。
	account.apiKeyHeader = draft.accountApiKeyHeader.trim() || DEFAULT_API_KEY_HEADER;
	account.apiKeyPrefix = draft.accountApiKeyPrefix;
	if (body) account.body = draft.accountBody;
	if (mapping.value) account.mapping = mapping.value;
	if (items.value) account.items = items.value;
	if (draft.accountUnit.trim()) account.unit = draft.accountUnit.trim();
	if (scale !== undefined) account.scale = scale;
	if (draft.accountCredentialKeyName.trim()) account.credentialKeyName = draft.accountCredentialKeyName.trim();
	// 充值链接会当 href 渲染：只允许 http(s)（服务端也会再校验一次，这里是即刻反馈）。
	const topup = draft.accountTopupUrl.trim();
	if (topup) {
		const resolved = topup.replaceAll("{baseUrl}", "https://x");
		if (!isHttpUrl(resolved)) return { error: t("channelUrlInvalid") };
		account.topupUrl = topup;
	}
	return { account };
}

/**
 * 账户查询配置编辑器（预设 + 模板字段 + JSON 映射）。
 * 纯受控：所有改动经 onChange 回写草稿，并由调用方在提交时用 accountPayloadOf 再校验一次。
 */
export function ChannelAccountQuery({
	draft,
	presets,
	onChange,
	onTouch,
}: {
	draft: ChannelDraft;
	/** 服务端下发的预设；缺省 = 没有预设（仍可手填模板）。 */
	presets: AccountPreset[] | undefined;
	onChange: (patch: Partial<ChannelDraft>) => void;
	/** 标记「账户配置被改过」——调用方据此决定是否提交 extra（见 @GOTCHA）。 */
	onTouch: () => void;
}) {
	const t = useT();
	const [presetId, setPresetId] = useState("");
	const { error } = accountPayloadOf(draft, t);
	const preset = presets?.find((p) => p.id === presetId);
	const set = (patch: Partial<ChannelDraft>) => {
		onChange(patch);
		onTouch();
	};
	/** 切到模板方式时补上服务端默认的鉴权头/前缀（否则空串会被当成「不加前缀」）。 */
	const switchKind = (kind: string) => {
		const defaults: Partial<ChannelDraft> = {};
		if (kind === "template") {
			if (!draft.accountApiKeyHeader.trim()) defaults.accountApiKeyHeader = DEFAULT_API_KEY_HEADER;
			if (!draft.accountApiKeyPrefix) defaults.accountApiKeyPrefix = DEFAULT_API_KEY_PREFIX;
		}
		set({ accountKind: kind, ...defaults });
	};

	return (
		<div className="chan-account">
			<div className="chan-form-title">{t("channelAccountKind")}</div>
			<SelectField
				label={t("channelAccountPreset")}
				value={presetId}
				onChange={(id) => {
					const next = presets?.find((p) => p.id === id);
					setPresetId(id);
					if (next) set(draftFromTemplate(next.template));
				}}
				hint={preset?.description ?? t("channelAccountTemplateHint")}
			>
				<option value="" disabled>
					{t("channelAccountPresetPh")}
				</option>
				{(presets ?? []).map((p) => (
					<option key={p.id} value={p.id} title={p.description}>
						{p.label}
					</option>
				))}
			</SelectField>
			<SelectField label={t("channelAccountMode")} value={draft.accountKind} onChange={switchKind}>
				<option value="" disabled>
					{t("channelAccountModeNone")}
				</option>
				<option value="template">{t("channelAccountModeTemplate")}</option>
				{/* 内置适配器：只用渠道那把 API token，自动探测账单/额度接口，比手写模板更省事。 */}
				<option value="openai-gateway">{t("channelAccountModeGateway")}</option>
				{/* 其它旧配置的 kind 保留可选，避免编辑一次就把兼容适配器改成模板。 */}
				{draft.accountKind &&
					draft.accountKind !== "template" &&
					draft.accountKind !== "openai-gateway" && (
						<option value={draft.accountKind}>{t("channelAccountModeLegacy")}</option>
					)}
			</SelectField>
			{draft.accountKind && (
				<>
					<TextField
						label={t("channelAccountUrl")}
						value={draft.accountUrl}
						ph="https://… 或 {baseUrl}/api/user/self"
						onChange={(v) => set({ accountUrl: v })}
					/>
					<SelectField label={t("channelAccountMethod")} value={draft.accountMethod} onChange={(v) => set({ accountMethod: v })}>
						<option value="GET">GET</option>
						<option value="POST">POST</option>
					</SelectField>
					<TextField
						label={t("channelAccountHeader")}
						value={draft.accountApiKeyHeader}
						ph={DEFAULT_API_KEY_HEADER}
						onChange={(v) => set({ accountApiKeyHeader: v })}
					/>
					<TextField
						label={t("channelAccountPrefix")}
						value={draft.accountApiKeyPrefix}
						ph={t("channelAccountPrefixPh")}
						onChange={(v) => set({ accountApiKeyPrefix: v })}
					/>
					<TextField
						label={t("channelAccountCredential")}
						value={draft.accountCredentialKeyName}
						ph={t("channelAccountCredentialPh")}
						onChange={(v) => set({ accountCredentialKeyName: v })}
					/>
					<TextField label={t("channelAccountUnit")} value={draft.accountUnit} onChange={(v) => set({ accountUnit: v })} />
					{/* 充值直达：显示在「用量详情」标题右侧，点开余额即可去充值。 */}
					<TextField
						label={t("channelAccountTopupUrl")}
						value={draft.accountTopupUrl}
						ph={t("channelAccountTopupUrlPh")}
						hint={t("channelAccountTopupHint")}
						onChange={(v) => set({ accountTopupUrl: v })}
					/>
					<TextField
						label={t("channelAccountScale")}
						value={draft.accountScale}
						ph={t("channelAccountScalePh")}
						onChange={(v) => set({ accountScale: v })}
					/>
					{draft.accountMethod === "POST" && (
						<TextAreaField
							label={t("channelAccountBody")}
							value={draft.accountBody}
							onChange={(v) => set({ accountBody: v })}
							ph={t("channelAccountJsonPh")}
						/>
					)}
					<TextAreaField
						label={t("channelAccountMapping")}
						value={draft.accountMappingJson}
						onChange={(v) => set({ accountMappingJson: v })}
						ph={t("channelAccountJsonPh")}
					/>
					<TextAreaField
						label={t("channelAccountItems")}
						value={draft.accountItemsJson}
						onChange={(v) => set({ accountItemsJson: v })}
						ph={t("channelAccountJsonPh")}
					/>
					<p className="set-hint">{t("channelAccountPlaceholders")}</p>
					{draft.id && <p className="set-hint">{t("channelTemplateOverwrite")}</p>}
				</>
			)}
			{error && <div className="chan-warn">{error}</div>}
		</div>
	);
}
