/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelSettings.tsx（唯一挂载点：渠道行的「模型信息」入口）,
 *            components/ChannelDialog.tsx（弹窗壳：头/体/脚三段，只有 body 滚）,
 *            components/ChannelFields.tsx（字段控件）,
 *            server/model-admin.ts writeModelConfig（落盘：MANAGED_PROVIDER_KEYS 之外的键原样保留）,
 *            server/protocol.ts（save_model_config / UiProviderConfig / UiModelConfigEntry）
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道面板是服务商与模型的唯一入口）
 *   @WHY 2026-09-17 用户反馈：模型下拉页脚还留着「⚙ 管理模型」入口，而渠道配置早已全在
 *        「设置 → 渠道」。两个入口改同一批东西是交叉管理的根源。撤那个入口之前，必须先把它
 *        **唯一不可替代**的能力搬过来：模型的显示名 / 上下文窗口 / 最大输出 / 推理 / 识图。
 *   @CONTRACT 只提交 save_model_config（整份 provider 配置）：
 *        - apiKey **不回传也不提交**（留空 = 服务端保留已存密钥，见 writeModelConfig）；
 *        - cost / thinkingLevelMap / compat / headers 等本表单不认识的键由服务端原样保留
 *          （writeModelConfig 的 unmanagedEntries），所以这里绝不需要、也绝不能回传它们。
 *   @GOTCHA 模型 id 是主键：改 id 等于「删旧模型 + 建新模型」，会让已绑定该 id 的渠道白名单
 *        与历史会话失配，所以 id 只读。要换 id 请在渠道白名单里加新 id。
 *   @GOTCHA 数值字段用 `??` 判空而不是 `||`：contextWindow 允许清空（留空 = 不写该键），
 *        用 `||` 会把 0 和空串混为一谈。空串在提交时被过滤掉，不会写成 0。
 * ──────────────────────────────────────────────────
 */
import { useState } from "react";
import type { UiModelConfigEntry, UiProviderConfig } from "../types";
import { useT } from "../i18n";
import { ChannelDialog } from "./ChannelDialog";

/** 表单里的一行（数值统一用字符串承载：空串 = 不写该键，见 @GOTCHA）。 */
interface MetaRow {
	id: string;
	name: string;
	reasoning: boolean;
	vision: boolean;
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

/** models.json 的条目 → 表单行。 */
function rowOf(entry: UiModelConfigEntry): MetaRow {
	return {
		id: entry.id,
		name: entry.name ?? "",
		reasoning: entry.reasoning === true,
		vision: (entry.input ?? []).includes("image"),
		contextWindow: entry.contextWindow ? String(entry.contextWindow) : "",
		maxTokens: entry.maxTokens ? String(entry.maxTokens) : "",
	};
}

/** 表单行 → 提交条目（只带真正有值的键，让服务端的保留逻辑接管其余）。 */
function entryOf(row: MetaRow): UiModelConfigEntry {
	const contextWindow = numberOrUndefined(row.contextWindow);
	const maxTokens = numberOrUndefined(row.maxTokens);
	return {
		id: row.id,
		...(row.name.trim() ? { name: row.name.trim() } : {}),
		reasoning: row.reasoning,
		// input 是数组：识图 = ["text","image"]，否则 ["text"]（显式写出，别让 SDK 猜）。
		input: row.vision ? ["text", "image"] : ["text"],
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
	};
}

/**
 * 模型信息编辑（显示名 / 上下文窗口 / 最大输出 / 推理 / 识图）。
 * 这是原「管理模型」面板唯一不可替代的能力，现在挂在渠道行上——服务商与模型同一处管理。
 */
export function ChannelModelMeta({
	provider,
	onSave,
	onClose,
}: {
	/** 该渠道服务商在 models.json 里的配置（只有自定义服务商才有）。 */
	provider: UiProviderConfig;
	onSave: (config: UiProviderConfig) => void;
	onClose: () => void;
}) {
	const t = useT();
	const [rows, setRows] = useState<MetaRow[]>(() => (provider.models ?? []).map(rowOf));
	const [query, setQuery] = useState("");
	const patch = (id: string, next: Partial<MetaRow>) =>
		setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)));
	const q = query.trim().toLowerCase();
	const listed = q ? rows.filter((r) => r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : rows;

	const submit = () => {
		// apiKey 故意不提交：服务端留空即保留（提交空串会被当成「保留」，但显式不带更清楚）。
		onSave({
			providerId: provider.providerId,
			...(provider.name ? { name: provider.name } : {}),
			...(provider.api ? { api: provider.api } : {}),
			...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
			...(provider.authHeader ? { authHeader: true } : {}),
			models: rows.map(entryOf),
		});
	};

	return (
		<ChannelDialog
			title={`${t("channelModelMetaTitle")} · ${provider.providerId}`}
			subtitle={provider.baseUrl || undefined}
			titleId="chan-model-meta-title"
			className="chan-form-dialog"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="chan-btn" onClick={onClose}>
						{t("cancel")}
					</button>
					<button type="button" className="chan-btn primary" disabled={rows.length === 0} onClick={submit}>
						{t("save")}
					</button>
				</>
			}
		>
			<p className="set-hint">{t("channelModelMetaHint")}</p>
			{rows.length > 3 && (
				<input
					className="chan-models-search"
					type="text"
					value={query}
					placeholder={t("channelModelsSearchPh")}
					onChange={(e) => setQuery(e.target.value)}
				/>
			)}
			{rows.length === 0 && <p className="set-hint">{t("channelModelMetaEmpty")}</p>}
			{listed.map((row) => (
				<div className="chan-meta-row" key={row.id}>
					{/* id 只读：它是主键，改了等于删旧建新（见 @GOTCHA）。 */}
					<div className="chan-meta-id">{row.id}</div>
					<label className="field">
						<span className="field-label">{t("channelModelMetaName")}</span>
						<input value={row.name} placeholder={row.id} onChange={(e) => patch(row.id, { name: e.target.value })} />
					</label>
					<div className="chan-meta-nums">
						<label className="field">
							<span className="field-label">{t("channelModelMetaContext")}</span>
							<input
								type="number"
								min="0"
								value={row.contextWindow}
								placeholder={t("channelModelMetaUnset")}
								onChange={(e) => patch(row.id, { contextWindow: e.target.value })}
							/>
						</label>
						<label className="field">
							<span className="field-label">{t("channelModelMetaMaxTokens")}</span>
							<input
								type="number"
								min="0"
								value={row.maxTokens}
								placeholder={t("channelModelMetaUnset")}
								onChange={(e) => patch(row.id, { maxTokens: e.target.value })}
							/>
						</label>
					</div>
					<div className="chan-meta-flags">
						<label className="chan-enable">
							<input
								type="checkbox"
								checked={row.reasoning}
								onChange={(e) => patch(row.id, { reasoning: e.target.checked })}
							/>
							{t("reasoning")}
						</label>
						<label className="chan-enable">
							<input type="checkbox" checked={row.vision} onChange={(e) => patch(row.id, { vision: e.target.checked })} />
							{t("vision")}
						</label>
					</div>
				</div>
			))}
			{rows.length > 0 && listed.length === 0 && <p className="set-hint">{t("channelModelsNoMatch")}</p>}
		</ChannelDialog>
	);
}
