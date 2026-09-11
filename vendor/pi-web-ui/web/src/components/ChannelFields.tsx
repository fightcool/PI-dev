/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelForm.tsx（渠道表单）, components/ChannelAccountQuery.tsx（模板编辑器）
 *   📖 docs/DEV-CON-PROPOSAL.md §6（渠道设置页）
 *   @CONTRACT 纯受控字段：只回传字符串，不认识渠道/协议类型，也不发任何命令。
 *   @WHY 从 ChannelForm 抽出：表单字段被模板编辑器复用，留在一起会让 ChannelForm 超过 300 行。
 *   @GOTCHA 下拉框的空值一律是「disabled 占位项」，否则浏览器会默认选中第一项并静默改配置。
 * ──────────────────────────────────────────────────
 */
import type { ReactNode } from "react";

/** 单行文本字段（受控；值原样回传，不做 trim —— 前缀里的空格有意义）。 */
export function TextField({
	label,
	value,
	ph,
	onChange,
	hint,
}: {
	label: string;
	value: string;
	ph?: string;
	onChange: (v: string) => void;
	hint?: string;
}) {
	return (
		<label className="field">
			<span className="field-label">{label}</span>
			<input value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)} />
			{hint && <span className="field-hint">{hint}</span>}
		</label>
	);
}

/** 下拉字段。空值必须是 `<option value="" disabled>` 占位项（见 @GOTCHA）。 */
export function SelectField({
	label,
	value,
	onChange,
	children,
	hint,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	children: ReactNode;
	hint?: string;
}) {
	return (
		<label className="field">
			<span className="field-label">{label}</span>
			<select value={value} onChange={(e) => onChange(e.target.value)}>
				{children}
			</select>
			{hint && <span className="field-hint">{hint}</span>}
		</label>
	);
}

/** 多行 JSON 文本框（等宽；校验由调用方负责并展示错误）。 */
export function TextAreaField({
	label,
	value,
	ph,
	onChange,
	rows = 4,
}: {
	label: string;
	value: string;
	ph?: string;
	onChange: (v: string) => void;
	rows?: number;
}) {
	return (
		<label className="field">
			<span className="field-label">{label}</span>
			<textarea className="chan-json" rows={rows} value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)} />
		</label>
	);
}
