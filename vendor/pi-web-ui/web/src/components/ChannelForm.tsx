/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelSettings.tsx (唯一挂载点：新建/编辑渠道档案),
 *            server/dev-con/channel-service.ts (channel_save 校验：id/名称/服务商/命名凭据)
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道档案只存引用、不存密钥）, §6（设置页校验）
 *   @CONTRACT 只提交 channel_save 的 payload；凭据按名称引用（null = 跟随服务商 active key）。
 *   @ASSUME channel_state 不下发 extra，因此账户接口字段留空 = 不提交 extra（保持服务端已有配置）。
 *   @WHY 账户接口用 kind/url/unit/scale 独立字段而非原始 JSON：提交前逐项校验，避免把密钥字段写进元数据。
 * ──────────────────────────────────────────────────
 */
import { useState } from "react";
import type { ChannelSaveInput } from "../use-chat";
import type { ProviderKeyInfo, UiChannelInfo } from "../types";
import { useT } from "../i18n";

/** 「跟随服务商当前密钥」在 <select> 里的哨兵值（空值留给 disabled 占位项）。 */
export const FOLLOW_ACTIVE = "__active";

/** 新建/编辑表单草稿（凭据按名称；credentialKeyName=null = 跟随 active key）。 */
export interface ChannelDraft {
	id: string | null;
	displayName: string;
	providerId: string;
	endpointId: string;
	credentialKeyName: string | null;
	accountRef: string;
	accountKind: string;
	accountUrl: string;
	accountUnit: string;
	accountScale: string;
	enabled: boolean;
}

export function channelDraftOf(c: UiChannelInfo | null, fallbackProvider: string): ChannelDraft {
	return {
		id: c?.id ?? null,
		displayName: c?.displayName ?? "",
		providerId: c?.providerId ?? fallbackProvider,
		endpointId: c?.endpointId ?? "",
		credentialKeyName: c?.credentialRef?.keyName ?? null,
		accountRef: c?.accountRef ?? "",
		accountKind: "",
		accountUrl: "",
		accountUnit: "",
		accountScale: "",
		enabled: c?.enabled ?? true,
	};
}

function TextField({
	label,
	value,
	ph,
	onChange,
}: {
	label: string;
	value: string;
	ph?: string;
	onChange: (v: string) => void;
}) {
	return (
		<label className="field">
			<span className="field-label">{label}</span>
			<input value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)} />
		</label>
	);
}

function SelectField({
	label,
	value,
	onChange,
	children,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	children: React.ReactNode;
}) {
	return (
		<label className="field">
			<span className="field-label">{label}</span>
			<select value={value} onChange={(e) => onChange(e.target.value)}>
				{children}
			</select>
		</label>
	);
}

/**
 * 渠道新建/编辑表单。由 ChannelSettings 以 key 重挂载，所以内部状态总是从 draft 初始化。
 * 校验：账户接口 URL 必须是 http(s)；换算比例必须是正数；其余交给服务端（回执会说明原因）。
 */
export function ChannelForm({
	draft,
	providerIds,
	providerKeys,
	onSave,
	onCancel,
}: {
	draft: ChannelDraft;
	providerIds: string[];
	providerKeys: Record<string, ProviderKeyInfo[]>;
	onSave: (payload: ChannelSaveInput) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [form, setForm] = useState(draft);
	const [error, setError] = useState<string | null>(null);
	const set = (patch: Partial<ChannelDraft>) => setForm((d) => ({ ...d, ...patch }));
	const knownKeys = providerKeys[form.providerId] ?? [];

	const submit = () => {
		const url = form.accountUrl.trim();
		const scaleRaw = form.accountScale.trim();
		const scale = scaleRaw ? Number(scaleRaw) : undefined;
		if (url && !/^https?:\/\//i.test(url)) return setError(t("channelUrlInvalid"));
		if (scaleRaw && !(scale !== undefined && Number.isFinite(scale) && scale > 0))
			return setError(t("channelScaleInvalid"));
		const kind = form.accountKind.trim();
		onSave({
			...(form.id ? { id: form.id } : {}),
			displayName: form.displayName.trim(),
			providerId: form.providerId,
			...(form.endpointId.trim() ? { endpointId: form.endpointId.trim() } : {}),
			credentialRef: form.credentialKeyName ? { providerId: form.providerId, keyName: form.credentialKeyName } : null,
			accountRef: form.accountRef.trim() || null,
			enabled: form.enabled,
			// 只填了账户接口时才提交 extra；留空 = 保持服务端已有配置（见 @ASSUME）。
			...(kind
				? {
						extra: {
							account: {
								kind,
								url,
								...(form.accountUnit.trim() ? { unit: form.accountUnit.trim() } : {}),
								...(scale ? { scale } : {}),
							},
						},
					}
				: {}),
		});
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
			<SelectField label={t("channelProvider")} value={form.providerId} onChange={(v) => set({ providerId: v })}>
				<option value="" disabled>
					{t("channelProviderPh")}
				</option>
				{providerIds.map((id) => (
					<option key={id} value={id}>
						{id}
					</option>
				))}
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
			<TextField
				label={t("channelAccountRef")}
				value={form.accountRef}
				ph={t("channelAccountRefPh")}
				onChange={(v) => set({ accountRef: v })}
			/>
			<p className="set-hint">{t("channelAccountHint")}</p>
			<TextField
				label={t("channelAccountKind")}
				value={form.accountKind}
				ph={t("channelAccountKindPh")}
				onChange={(v) => set({ accountKind: v })}
			/>
			<TextField
				label={t("channelAccountUrl")}
				value={form.accountUrl}
				ph="https://…"
				onChange={(v) => set({ accountUrl: v })}
			/>
			<TextField label={t("channelAccountUnit")} value={form.accountUnit} onChange={(v) => set({ accountUnit: v })} />
			<TextField
				label={t("channelAccountScale")}
				value={form.accountScale}
				ph={t("channelAccountScalePh")}
				onChange={(v) => set({ accountScale: v })}
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
