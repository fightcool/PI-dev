/* 🍞 @COUPLED web/src/components/ChatInput.tsx（唯一挂载点）, web/src/use-chat.ts
 * @CONTRACT 模型目录是**网关的**模型清单（服务端已收窄，见 dev-con/gateway-config.ts）：
 *   平铺列表 —— 没有服务商侧栏、没有命名密钥、也不显示服务商名（单网关实例下这些都是噪声，
 *   用户只有一个入口要选）。
 * @GOTCHA 搜索词过滤后也要有「没有匹配的模型」提示：没有这行用户只会看到一个空列表。 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FiCpu, FiSearch, FiZap } from "react-icons/fi";
import type { ModelInfo, UiState } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { useT } from "../i18n";
import { loadModelUsage, sortByUsage } from "../model-usage";

/** Messages this component sends (a subset shared by TopBar and ChatInput). */
export type ModelThinkingMsg =
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string };

const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;


/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below keeps
 *  both toolbars idle during streaming. */
interface Props {
	state: Pick<UiState, "model" | "thinkingLevel" | "availableThinkingLevels"> | null;
	models: ModelInfo[];
	modelsLoading: boolean;
	send: (msg: ModelThinkingMsg) => boolean;
	/** Compact triggers for narrow toolbars (mobile input row). */
	compact?: boolean;
}

/** Model picker + thinking-level picker. Rendered in the composer toolbar
 * inside the input box (ChatInput .composer-tools). Menus open upward because
 * the input bar sits at the bottom of the window. */
export const ModelThinking = memo(function ModelThinking({
	state,
	models,
	modelsLoading,
	send,
	compact = false,
}: Props) {
	const t = useT();
	const model = state?.model;

	// snapshot model.id is the bare id; list ids are "provider/id".
	const currentModelId = model ? `${model.provider}/${model.id}` : null;
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	// 模型下拉的搜索过滤（网关的模型清单可能不短，长列表没有过滤就只能靠肉眼找）。
	const [modelFilter, setModelFilter] = useState("");
	// 使用次数（模型下拉按此排序）：每次打开时重新读取 localStorage，保证最新。
	const [usage, setUsage] = useState<Record<string, number>>({});
	// 模型列表滚动容器（打开时自动聚焦当前选择的模型）。
	const modelScrollRef = useRef<HTMLDivElement>(null);
	// 弹窗宽度锁定：打开时测量一次内容自然宽度（最宽需要），之后搜索/筛选
	// 内容变窄也不再回缩，避免弹窗来回变化。关闭时复位，下次打开重新测量。
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuWidth, setMenuWidth] = useState<number | null>(null);
	useEffect(() => {
		if (!modelOpen) {
			setMenuWidth(null);
			return;
		}
		// 列表未就绪时先不锁定（保持自然宽度），等列表到达后再测量锁定。
		if (models.length === 0) return;
		const id = requestAnimationFrame(() => {
			const el = menuRef.current;
			if (!el) return;
			setMenuWidth(el.offsetWidth);
		});
		return () => cancelAnimationFrame(id);
	}, [modelOpen, models.length]);
	useEffect(() => {
		if (modelOpen) setUsage(loadModelUsage());
	}, [modelOpen]);
	useEffect(() => {
		if (!modelOpen) setModelFilter("");
	}, [modelOpen]);
	// 按使用次数降序（次数相同保持原有顺序，不重排未用过的模型）。
	const sortedModels = useMemo(() => sortByUsage(models, usage), [models, usage]);
	const filteredModels = useMemo(() => {
		const q = modelFilter.trim().toLowerCase();
		if (!q) return sortedModels;
		return sortedModels.filter(
			(m) => m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
		);
	}, [sortedModels, modelFilter]);
	// Local loading flag for the model dropdown (list arrives via props.models).
	const [reqLoading, setReqLoading] = useState(false);

	// Model-supported thinking levels (snapshot). The SDK clamps any request
	// outside this set — unsupported levels must be disabled, not silently
	// snapped (that's what made the level look "impossible to change").
	// Empty/absent → unknown, keep everything enabled.
	const supportedThinking =
		state?.availableThinkingLevels && state.availableThinkingLevels.length > 0
			? new Set(state.availableThinkingLevels)
			: null;
	const thinkingLevels: {
		value: string;
		label: string;
		supported: boolean;
	}[] = THINKING_VALUES.map((v) => ({
		value: v,
		label: t(`thinking.${v}`),
		supported: supportedThinking ? supportedThinking.has(v) : true,
	}));
	const thinkingLabel = (level: string): string => thinkingLevels.find((l) => l.value === level)?.label ?? level;

	// Lazily fetch the model list when the dropdown opens for the first time.
	useEffect(() => {
		if (modelOpen && models.length === 0 && !reqLoading && !modelsLoading) {
			setReqLoading(true);
			send({ type: "list_models" });
		}
	}, [modelOpen, models.length, reqLoading, modelsLoading, send]);
	useEffect(() => {
		if (models.length > 0) setReqLoading(false);
	}, [models.length]);

	// 打开时自动把当前选择的模型滚入可视区域（聚焦选择中的模型）。列表可能
	// 在打开后才到达（首次 list_models 尚未返回），故也监听 models.length。
	useEffect(() => {
		if (!modelOpen) return;
		const el = modelScrollRef.current?.querySelector<HTMLElement>(".dd-item.active");
		el?.scrollIntoView({ block: "nearest" });
	}, [modelOpen, currentModelId, models.length]);

	return (
		<>
			<Dropdown
				trigger={
					<>
						<FiCpu />
						<span className="chip-model">{model ? model.name : t("selectModel")}</span>
						{!compact && model?.vision && (
							<span className="chip-vision" title={t("vision")}>
								🖼
							</span>
						)}
					</>
				}
				open={modelOpen}
				onOpenChange={setModelOpen}
				menuClassName="dd-menu-model"
				menuRef={menuRef}
				menuStyle={menuWidth != null ? { width: menuWidth } : undefined}
				direction="up"
			>
				<div className="dd-header">{t("availableModels")}</div>
				<div className="dd-search-row">
					<FiSearch />
					<input
						className="dd-search"
						type="text"
						placeholder={t("searchModels")}
						value={modelFilter}
						onChange={(e) => setModelFilter(e.target.value)}
					/>
				</div>
				{/* 平铺模型列表：单网关实例下只有一份目录，侧栏/分组只会增加噪声。 */}
				<div className="dd-model-body">
					<div className="dd-model-scroll" ref={modelScrollRef}>
						{(reqLoading || modelsLoading) && <div className="dd-loading">{t("loading")}</div>}
						{models.length === 0 && !reqLoading && !modelsLoading && <div className="dd-loading">{t("noModels")}</div>}
						{filteredModels.length === 0 && models.length > 0 && (
							<div className="dd-loading">{t("noModelMatches")}</div>
						)}
						{filteredModels.map((m) => (
							<DropdownItem
								key={m.id}
								active={currentModelId === m.id}
								onClick={() => {
									if (currentModelId !== m.id) send({ type: "set_model", modelId: m.id });
									setModelOpen(false);
								}}
							>
								<span className="dd-model-cell">
									<span className="dd-model-name">{m.name}</span>
									<span className="dd-model-meta">
										{(usage[m.id] ?? 0) > 0 && (
											<span className="dd-model-usage">{t("modelUsedCount", { n: usage[m.id] })}</span>
										)}
										{(m.reasoning || m.vision) && (
											<span className="dd-model-badges">
												{m.reasoning && <span className="dd-model-badge">{t("reasoning")}</span>}
												{m.vision && <span className="dd-model-badge">{t("vision")}</span>}
											</span>
										)}
									</span>
								</span>
							</DropdownItem>
						))}
					</div>
				</div>
				{/* Fixed footer — refresh never scrolls away.
				    @WHY 2026-09-17 撑掉了「⚙ 管理模型」：模型名称/上下文窗口等元数据由服务端的
				    模型目录（models.json）决定，这里只负责挑一个在跑的模型。 */}
				<div className="dd-footer">
					<button type="button" className="dd-refresh" onClick={() => send({ type: "list_models" })}>
						{t("refreshModels")}
					</button>
				</div>
			</Dropdown>

			<Dropdown
				trigger={
					<>
						<FiZap />
						<span className="chip-sub">
							{t("thinkingChip", {
								level: state ? thinkingLabel(state.thinkingLevel) : "—",
							})}
						</span>
					</>
				}
				open={thinkingOpen}
				onOpenChange={setThinkingOpen}
				direction="up"
			>
				<div className="dd-header">{t("thinkingLevel")}</div>
				{thinkingLevels.map((l) => (
					<DropdownItem
						key={l.value}
						active={state?.thinkingLevel === l.value}
						disabled={!l.supported}
						title={l.supported ? undefined : t("thinkingUnsupported")}
						onClick={() => {
							if (state?.thinkingLevel !== l.value) {
								send({ type: "set_thinking", level: l.value });
							}
							setThinkingOpen(false);
						}}
					>
						{l.label}
					</DropdownItem>
				))}
			</Dropdown>
		</>
	);
});
