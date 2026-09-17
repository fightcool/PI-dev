/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/DirectoryPicker.tsx（唯一消费方：提供 parent/exists/openAfterCreate）,
 *            components/directory-picker-path.ts（createParent / isExistingDir）,
 *            styles.css（.cwd-newrow / .cwd-picker-hint-warn）
 *   @WHY 从 DirectoryPicker.tsx 抽出来（组件 387 行超 300 行红线）：这块自带输入态与
 *        三种语义（新建 / 已存在则打开 / 创建失败提示），本来就该是自己一块。
 *   @CONTRACT 自己只管「输入名字 + 触发」，建目录由父组件发 make_dir（协议单源留在父组件）。
 *   @GOTCHA ESC 只收起输入行（stopPropagation），不关整个选择器 —— 否则弹窗形态下
 *        用户按 ESC 想改个名字，整个「新建项目」都没了。
 * ──────────────────────────────────────────────────
 */
import { useState } from "react";
import { useT } from "../i18n";
import { isExistingDir, type PathCompletion } from "./directory-picker-path";

interface NewFolderFormProps {
	/** 当前目录列表（判断名字是否已经存在；存在就不发 make_dir，直接打开）。 */
	dirs: PathCompletion[];
	/** 当前将要落在哪个父目录（路径框优先，见 createParent）。 */
	parent: string;
	/** 建目录成功后把它作为工作目录打开（＝新建项目）。 */
	openAfterCreate: boolean;
	/** 创建中（等服务端列表确认）时禁用按钮，避免重复点击。 */
	pending: boolean;
	/** 上次创建失败要显示的提示（父组件在等不到新目录时置位）。 */
	error: boolean;
	onCreate: (name: string) => void;
	onCancel: () => void;
}

/** 「文件夹名称」输入行：新建 / 已存在直接打开，两种情况共用同一个输入框。 */
export function NewFolderForm({
	dirs,
	parent,
	openAfterCreate,
	pending,
	error,
	onCreate,
	onCancel,
}: NewFolderFormProps) {
	const t = useT();
	const [name, setName] = useState("");
	/** 名字在列表里已经是目录 → 这次点击是「打开」而不是「创建」（否则会谎称创建成功）。 */
	const exists = name.trim().length > 0 && isExistingDir(dirs, parent, name);

	const submit = () => {
		const trimmed = name.trim();
		if (!trimmed || pending) return;
		onCreate(trimmed);
	};

	const primaryLabel = exists ? t("cwdOpenExisting") : openAfterCreate ? t("cwdCreateAndOpen") : t("cwdCreate");

	return (
		<>
			<div className="cwd-newrow">
				<input
					value={name}
					autoFocus
					spellCheck={false}
					placeholder={t("cwdNewName")}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.nativeEvent.isComposing) {
							e.preventDefault();
							submit();
						} else if (e.key === "Escape") {
							// @GOTCHA 只收输入行：stopPropagation 挡住选择器的「ESC 关闭」。
							e.stopPropagation();
							onCancel();
						}
					}}
				/>
				<button type="button" className="cwd-choose-btn primary" disabled={pending} onClick={submit}>
					{primaryLabel}
				</button>
				<button type="button" className="cwd-choose-btn" onClick={onCancel}>
					{t("cwdCancel")}
				</button>
			</div>
			{/* 提示行讲清「这次点下去会发生什么」，避免把「打开已有目录」误当成「新建成功」。 */}
			{exists && (
				<p className="cwd-picker-hint cwd-hint-warn" title={parent}>
					{t("cwdExistsHint")}
				</p>
			)}
			{error && !exists && (
				<p className="cwd-picker-hint cwd-hint-warn" title={parent}>
					{t("cwdCreateFailed")}
				</p>
			)}
		</>
	);
}
