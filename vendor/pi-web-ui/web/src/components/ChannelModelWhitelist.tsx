/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelForm.tsx（唯一挂载点：渠道表单的模型白名单；「获取接口清单」
 *            的 onFetchModels/fetchModels/fetchState 由它传入 → use-chat 的 channelModelsResult）,
 *            server/model-admin.ts fetchChannelModels（服务端解析密钥后探测 <baseUrl>/models）,
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
import type { ModelInfo, UiModelConfigEntry } from "../types";
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
	onFetchModels,
	fetchModels,
	fetchState,
	canFetchWithoutProvider = false,
}: {
	models: ModelInfo[];
	/** 当前选中的服务商（换服务商时白名单必须由调用方清空，见 ChannelForm）。 */
	providerId: string;
	value: string[];
	onChange: (next: string[]) => void;
	/** 「获取接口清单」：按服务商探测 <baseUrl>/models（密钥在服务端解析，见 use-chat）。
	 *  缺省 = 不显示该按钮（DSH 等没有模型目录的引擎）。 */
	onFetchModels?: () => void;
	/** 接口（/models）返回的候选模型；与注册表合并展示（接口独有的带「接口」标记）。 */
	fetchModels?: UiModelConfigEntry[];
	/** 探测状态（进行中 / 上次结果）。 */
	fetchState?: { busy: boolean; ok: boolean | null; baseUrl?: string; error?: string };
	/** 允许在 providerId 为空时也探测：新建服务商还没注册，探测走浏览器的 fetch_models。 */
	canFetchWithoutProvider?: boolean;
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
	/** 接口（/models）返回但注册表里没有的 id：也算候选，标记来源便于判断。
	 *  @GOTCHA 这里**不能**再套 bareModelId：接口返回的就是「服务商内部 id」口径
	 *  （聚合网关是 "openrouter/vendor/model"，普通服务商是 "deepseek-chat"），
	 *  再剥一层前缀会存进一个永远匹配不上目录的 id。注册表侧的 available 已经是
	 *  剥过前缀的内部 id，两者直接按字符串比对去重。 */
	const fromApi = useMemo(() => {
		const known = new Set(available.map((r) => r.id));
		const seen = new Set<string>();
		const rows: { id: string; name: string }[] = [];
		for (const m of fetchModels ?? []) {
			const id = (m.id ?? "").trim();
			if (!id || known.has(id) || seen.has(id)) continue;
			seen.add(id);
			rows.push({ id, name: m.name ?? "" });
		}
		return rows;
	}, [available, fetchModels]);
	/** 下拉里总共可勾选的候选 = 注册表 + 接口返回。 */
	const candidates = useMemo(() => [...available, ...fromApi], [available, fromApi]);
	const q = query.trim().toLowerCase();
	const listed = q
		? candidates.filter((r) => r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
		: candidates;
	const apiIds = new Set(fromApi.map((r) => r.id));
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
				{onFetchModels && (
					<button
						type="button"
						className="chan-btn primary"
						title={t("channelModelsFetchTip")}
						disabled={(!providerId && !canFetchWithoutProvider) || fetchState?.busy}
						onClick={onFetchModels}
					>
						{fetchState?.busy ? t("channelModelsFetching") : t("channelModelsFetch")}
					</button>
				)}
			</div>
			{/* 接口探测回执：成功要写清「哪个地址」返回了多少个，失败直接露原文（服务端已本地化）。 */}
			{onFetchModels && fetchState && fetchState.ok !== null && (
				<p className={`chan-models-fetch ${fetchState.ok ? "ok" : "err"}`}>
					{fetchState.ok
						? t("channelModelsFetched", { n: fetchModels?.length ?? 0, baseUrl: fetchState.baseUrl ?? "" })
						: t("channelModelsFetchFailed", { msg: fetchState.error ?? "" })}
				</p>
			)}
			<input
				className="chan-models-search"
				type="text"
				value={query}
				placeholder={t("channelModelsSearchPh")}
				onChange={(e) => setQuery(e.target.value)}
			/>
			<div className="chan-models-list">
				{candidates.length === 0 && unknown.length === 0 && <p className="set-hint">{t("channelModelsNoProvider")}</p>}
				{listed.map((row) => (
					<label
						key={row.id}
						className="chan-model-row"
						// 接口独有的 id 不在本地模型目录里：勾了它，除非先在「管理模型」里把该服务商
						// 补齐，否则该渠道仍选不到这个模型——这一点挂在 tooltip 上，不占版面。
						title={apiIds.has(row.id) ? `${t("channelModelsFromApi")} · ${t("channelModelsUnknown")}` : undefined}
					>
						<input type="checkbox" checked={value.includes(row.id)} onChange={() => toggle(row.id)} />
						{/* 接口行常常只有 id（端点不返回 display_name）——名字槽回落成 id，别留空。 */}
						<span className="chan-model-name">{row.name || (apiIds.has(row.id) ? row.id : "")}</span>
						{apiIds.has(row.id) && <span className="chan-model-src">{t("channelModelsFromApi")}</span>}
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
				{candidates.length > 0 && listed.length === 0 && <p className="set-hint">{t("channelModelsNoMatch")}</p>}
			</div>
			<p className="set-hint">{t("channelModelsHint")}</p>
		</div>
	);
}
