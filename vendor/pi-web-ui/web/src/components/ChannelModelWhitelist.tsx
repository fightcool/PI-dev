/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelForm.tsx（唯一挂载点：渠道表单的模型白名单）,
 *            channel-models.ts（bareModelId 的 provider 前缀口径）,
 *            components/ModelChannelPicker.tsx + ChannelSettings.tsx（白名单的消费端）,
 *            server/dev-con/channel-model.ts（白名单存的是 provider 内部 id）
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道只暴露你要用的模型）
 *   @CONTRACT 受控组件：value 是 provider 内部 id 列表；空数组 = 不限（UI 必须显式写出这句）。
 *   @GOTCHA 已经勾选但**不在当前模型目录**里的 id（模型下线/改名）必须继续显示并保持勾选，
 *           否则用户一保存就悄悄把白名单条目删掉了。
 * @PERF 聚合网关可能有几百个模型：列表滚动 + 本地搜索，不做「每输入一个字符就请求」。
 * ──────────────────────────────────────────────────
 */
import { useMemo, useState } from "react";
import type { ModelInfo } from "../types";
import { useT } from "../i18n";
import { bareModelId } from "../channel-models";

/**
 * 模型白名单勾选表：搜索 + 全选/清空 + 计数。
 * 「不限」是一个**显式状态**（一个都不勾），而不是让人猜空的含义。
 */
export function ChannelModelWhitelist({
	models,
	providerId,
	value,
	onChange,
}: {
	models: ModelInfo[];
	/** 当前选中的服务商（换服务商时白名单必须由调用方清空，见 ChannelForm）。 */
	providerId: string;
	value: string[];
	onChange: (next: string[]) => void;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	/** 该服务商的全部模型（provider 内部 id，去重）。 */
	const available = useMemo(() => {
		const seen = new Set<string>();
		const rows: { id: string; name: string }[] = [];
		for (const m of models) {
			if (m.provider !== providerId) continue;
			const id = bareModelId(m.id);
			if (!id || seen.has(id)) continue;
			seen.add(id);
			rows.push({ id, name: m.name });
		}
		return rows;
	}, [models, providerId]);
	// 已勾选但目录里没有的 id：保留展示（见 @GOTCHA），否则保存即丢。
	const unknown = useMemo(() => {
		const known = new Set(available.map((r) => r.id));
		return value.filter((id) => !known.has(id));
	}, [value, available]);
	const q = query.trim().toLowerCase();
	const listed = q ? available.filter((r) => r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : available;
	const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

	return (
		<div className="chan-models">
			<div className="chan-models-head">
				<span className="field-label">{t("channelModels")}</span>
				<span className="chan-models-count">
					{value.length === 0 ? t("channelModelsUnrestricted") : t("channelModelsSelected", { n: value.length })}
				</span>
				<button
					type="button"
					className="chan-btn"
					disabled={listed.length === 0}
					onClick={() => onChange([...new Set([...value, ...listed.map((r) => r.id)])])}
				>
					{t("channelModelsSelectAll")}
				</button>
				<button type="button" className="chan-btn" disabled={value.length === 0} onClick={() => onChange([])}>
					{t("channelModelsClear")}
				</button>
			</div>
			<input
				className="chan-models-search"
				type="text"
				value={query}
				placeholder={t("channelModelsSearchPh")}
				onChange={(e) => setQuery(e.target.value)}
			/>
			<div className="chan-models-list">
				{available.length === 0 && unknown.length === 0 && <p className="set-hint">{t("channelModelsNoProvider")}</p>}
				{listed.map((row) => (
					<label key={row.id} className="chan-model-row">
						<input type="checkbox" checked={value.includes(row.id)} onChange={() => toggle(row.id)} />
						<span className="chan-model-name">{row.name}</span>
						<span className="chan-model-id">{row.id}</span>
					</label>
				))}
				{unknown.map((id) => (
					<label key={id} className="chan-model-row unknown">
						<input type="checkbox" checked onChange={() => toggle(id)} />
						<span className="chan-model-name">{id}</span>
						<span className="chan-model-id">{t("channelModelsUnknown")}</span>
					</label>
				))}
				{available.length > 0 && listed.length === 0 && <p className="set-hint">{t("channelModelsNoMatch")}</p>}
			</div>
			<p className="set-hint">{t("channelModelsHint")}</p>
		</div>
	);
}
