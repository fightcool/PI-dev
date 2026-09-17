/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelSettings.tsx（列表行入口：改完直接走 channel_save）,
 *            components/ChannelForm.tsx（新建/编辑渠道时的入口 + 草稿 accountKind/accountJson）,
 *            components/ChannelRow.tsx（「账户查询设置」按钮）, components/ChannelFields.tsx（TextAreaField）,
 *            server/dev-con/account-template.ts（声明式模板契约的事实源）,
 *            server/protocol.ts（channel_state.accountPresets 下发预设 + UiChannelInfo.account 回显）
 *   📖 docs/DEV-CON-PROPOSAL.md §7（余额/配额：单位、查询时间、失败状态）, §8 P3
 *   @CONTRACT 产出的 extra.account 就是**用户文本框里那份 JSON 原样**（解析后的对象）：
 *             { kind:"template", request:{url,method,headers}, map:{…}, invalidWhen:{…}, unit, topupUrl }。
 *             kind:"openai-gateway" = 内置探测适配器（不需要 request/map）；account:null = 不查询。
 *   @GOTCHA 占位符是**单花括号** {baseUrl} / {apiKey}。cc-switch 那套 {{baseUrl}} 在这里不会被替换，
 *           所以界面上必须写清楚（channelAccountPlaceholders），否则用户照抄 cc-switch 必然查不到余额。
 *   @GOTCHA 服务端对 extra.account 是**整体覆盖**（channel-config.ts 浅合并到 extra.account 这一键），
 *           所以保存 = 用这份 JSON 替换已存配置；必须显式提示（channelTemplateOverwrite）。
 *   @WHY 从「渠道表单最底部的多字段编辑器」改成独立弹窗 + 一份 JSON：字段编辑器要先选下拉才出现
 *        十几个输入框，用户既看不到全貌也没法整段粘贴；模板本身就是 JSON，直接编辑 JSON 最短路径。
 *   @ASSUME 弹窗按 key 重挂载（调用方给 key），所以内部状态只从 props 初始化一次。
 * ──────────────────────────────────────────────────
 */
import { useRef, useState } from "react";
import type { Translate } from "../i18n";
import { useT } from "../i18n";
import { SelectField, TextAreaField } from "./ChannelFields";
import { ChannelDialog } from "./ChannelDialog";

/** 服务端下发的账户查询预设（选中即把 template 格式化后填进文本框）。 */
export type AccountPreset = { id: string; label: string; description: string; template: Record<string, unknown> };

/** 查询方式：空 = 不查询；template = 声明式 JSON；openai-gateway = 内置探测适配器。 */
export type AccountKind = "" | "template" | "openai-gateway";

/** JSON 文本框行数（约 16 行 ≈ 一份完整模板不用滚动；用户还能纵向拉伸）。@MAGIC */
const JSON_ROWS = 16;

/** 文本框占位示例：就是契约里那份声明式模板（代码示例，不进 i18n）。 */
const TEMPLATE_EXAMPLE = `{
  "kind": "template",
  "request": { "url": "{baseUrl}/v1/usage", "method": "GET", "headers": { "Authorization": "Bearer {apiKey}" } },
  "map": { "isValid": "isValid", "remaining": "remaining ?? balance", "used": "usage.total.actual_cost", "unit": "unit" },
  "unit": "USD"
}`;

/** 账户配置 → 文本框内容（格式化 JSON；没有配置 = 空串）。 */
export function formatAccountJson(account: unknown): string {
	if (!account || typeof account !== "object" || Array.isArray(account)) return "";
	return JSON.stringify(account, null, 2);
}

/** 解析文本框内容：空 = 没填；非法 JSON / 非对象 → 原始 err.message（含行号信息）。 */
export function parseAccountJson(text: string): { value?: Record<string, unknown>; error?: string } {
	const raw = text.trim();
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { error: (err as Error).message };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "expected a JSON object" };
	return { value: parsed as Record<string, unknown> };
}

/** 模板里的接口地址（新契约 request.url；旧配置的顶层 url 也认，用于摘要展示）。 */
function urlOf(account: Record<string, unknown> | undefined): string {
	if (!account) return "";
	const req = account.request as { url?: unknown } | undefined;
	if (req && typeof req === "object" && typeof req.url === "string") return req.url;
	return typeof account.url === "string" ? account.url : "";
}

/**
 * 校验 + 生成 extra.account。
 * @CONTRACT `account: null` = 显式不查询（服务端整体覆盖成 null）；error 非空时调用方必须拦住保存。
 * @GOTCHA kind 收 string 而不是 AccountKind：旧配置可能是 openrouter 之类的历史 kind，
 *   原样透传才不会把一个能用的配置悄悄改写成 template（只有 template 才强制 request.url）。
 */
export function accountPayloadOf(
	input: { kind: string; json: string },
	t: Translate,
): { account?: Record<string, unknown> | null; error?: string } {
	if (!input.kind) return { account: null };
	const parsed = parseAccountJson(input.json);
	if (parsed.error) return { error: t("channelAccountJsonError", { err: parsed.error }) };
	// 网关探测不需要 request/map：文本框留空就只提交 kind（填了则沿用其中的 unit/topupUrl 等）。
	if (!parsed.value) {
		if (input.kind === "template") return { error: t("channelAccountUrlRequired") };
		return { account: { kind: input.kind } };
	}
	const account = { ...parsed.value, kind: input.kind };
	if (input.kind === "template" && !urlOf(account).trim()) return { error: t("channelAccountUrlRequired") };
	return { account };
}

/** 查询方式的短标签（列表行/表单摘要用；下拉里的长说明是另一组文案）。 */
export function accountKindLabel(kind: string, t: Translate): string {
	if (!kind) return t("channelAccountKindNone");
	if (kind === "template") return t("channelAccountKindTemplate");
	if (kind === "openai-gateway") return t("channelAccountKindGateway");
	return t("channelAccountKindOther", { kind });
}

/** 一行摘要：「方式 · 接口地址」（地址一眼可见；没有地址就只给方式）。 */
export function accountSummaryOf(input: { kind: string; json: string }, t: Translate): string {
	const label = accountKindLabel(input.kind, t);
	if (!input.kind) return label;
	const url = urlOf(parseAccountJson(input.json).value).trim();
	return url ? `${label} · ${url}` : label;
}

/**
 * 「账户查询设置」弹窗：查询方式（三选一）+ 预设一键填充 + 一份声明式 JSON。
 * 纯受控壳：不发任何命令，保存时把校验过的 extra.account 交给调用方（列表行直接存，
 * 新建/编辑表单则先写进草稿，随渠道一起保存）。
 */
export function ChannelAccountModal({
	title,
	kind: initialKind,
	json: initialJson,
	presets,
	showOverwrite,
	onSave,
	onClose,
}: {
	/** 标题（列表行带渠道名，表单里就是「账户查询设置」）。 */
	title: string;
	kind: string;
	json: string;
	/** 服务端下发的预设；缺省 = 没有预设（仍可手写/粘贴 JSON）。 */
	presets: AccountPreset[] | undefined;
	/** 已有渠道要提示「整体覆盖」；新建渠道没有已存配置，不提示。 */
	showOverwrite: boolean;
	onSave: (result: { kind: AccountKind; json: string; account: Record<string, unknown> | null }) => void;
	onClose: () => void;
}) {
	const t = useT();
	const [kind, setKind] = useState<AccountKind>(
		initialKind === "template" || initialKind === "openai-gateway" ? initialKind : initialKind ? "template" : "",
	);
	const [json, setJson] = useState(initialJson);
	const [presetId, setPresetId] = useState("");
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const { account, error } = accountPayloadOf({ kind, json }, t);

	const preset = presets?.find((p) => p.id === presetId);
	/** 选预设 = 把它的 template 以格式化 JSON 整体填进文本框（kind 跟随模板）。 */
	const applyPreset = (id: string) => {
		setPresetId(id);
		const next = presets?.find((p) => p.id === id);
		if (!next) return;
		const templateKind = typeof next.template.kind === "string" ? next.template.kind : "template";
		setKind(templateKind === "openai-gateway" ? "openai-gateway" : "template");
		setJson(formatAccountJson(next.template));
	};

	return (
		<ChannelDialog
			title={title}
			titleId="chan-account-modal-title"
			className="chan-account-modal"
			onClose={onClose}
			initialFocusRef={areaRef}
			footer={
				<>
					{error && <div className="chan-warn">{error}</div>}
					<button type="button" className="chan-btn" onClick={onClose}>
						{t("cancel")}
					</button>
					<button
						type="button"
						className="chan-btn primary"
						disabled={!!error}
						onClick={() => onSave({ kind, json, account: account ?? null })}
					>
						{t("save")}
					</button>
				</>
			}
		>
				<div className="chan-account-modes">
					<span className="field-label">{t("channelAccountMode")}</span>
					{(
						[
							["", "channelAccountModeNone"],
							["template", "channelAccountModeTemplate"],
							["openai-gateway", "channelAccountModeGateway"],
						] as const
					).map(([value, labelKey]) => (
						<label key={value || "none"}>
							<input type="radio" name="chan-account-kind" checked={kind === value} onChange={() => setKind(value)} />
							{t(labelKey)}
						</label>
					))}
				</div>
				{kind !== "" && (
					<>
						<SelectField
							label={t("channelAccountPreset")}
							value={presetId}
							onChange={applyPreset}
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
						{kind === "openai-gateway" && <p className="set-hint">{t("channelAccountGatewayNote")}</p>}
						<TextAreaField
							label={t("channelAccountJsonLabel")}
							value={json}
							onChange={setJson}
							ph={TEMPLATE_EXAMPLE}
							rows={JSON_ROWS}
							areaRef={areaRef}
						/>
						<p className="set-hint">{t("channelAccountPlaceholders")}</p>
					</>
				)}
			{showOverwrite && <p className="set-hint">{t("channelTemplateOverwrite")}</p>}
		</ChannelDialog>
	);
}
