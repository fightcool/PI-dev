/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ChannelAccountModal.tsx（账户查询设置弹窗）,
 *            components/ChannelForm.tsx（渠道新建/编辑弹窗）,
 *            components/ChannelSettings.tsx（两者的唯一挂载点）,
 *            styles.css（.chan-dialog / .chan-dialog-body / .chan-dialog-foot / .chan-section）
 *   📖 docs/DEV-CON-PROPOSAL.md §6（设置页）
 *   @CONTRACT 纯壳：只管「浮层 + 无障碍 + 键盘 + 滚动区 + 固定页脚」，不认识渠道字段，也不发命令。
 *   @WHY 抽出来的原因是**同一个面板里两种交互**：账户查询已经是弹窗（ESC/遮罩/焦点圈都有），
 *        渠道编辑却是内联长列（要滚整页找保存按钮、没有 ESC、没有分组）。两者共用这个壳，
 *        才能保证"同一个面板里所有编辑入口的行为一致"。
 *   @GOTCHA 焦点圈用捕获阶段监听：设置页自己也有快捷键，冒泡阶段会被它先吃掉。
 *   @ASSUME 调用方按 key 重挂载（不同渠道 = 不同 key），所以内部状态只从 props 初始化一次。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useRef, type ReactNode } from "react";
import { FiChevronDown, FiChevronRight, FiX } from "react-icons/fi";

/** 可聚焦元素选择器（焦点圈用；与其他弹窗同一口径）。 */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * 渠道面板统一弹窗壳：遮罩点击关闭、ESC 关闭、Tab 焦点不外逃、内容区独立滚动、
 * 页脚（取消/保存）**固定可见**——长表单不必滚到底才找到保存。
 */
export function ChannelDialog({
	title,
	subtitle,
	titleId,
	className,
	children,
	footer,
	onClose,
	/** 打开即落焦的元素（如 JSON 文本框）；缺省聚焦弹窗内第一个可聚焦元素。 */
	initialFocusRef,
}: {
	title: string;
	subtitle?: string;
	titleId: string;
	/** 附加类名（控制宽度：账户弹窗窄、渠道表单宽）。 */
	className?: string;
	children: ReactNode;
	footer: ReactNode;
	onClose: () => void;
	initialFocusRef?: { current: HTMLElement | HTMLTextAreaElement | null };
}) {
	const boxRef = useRef<HTMLDivElement>(null);

	// ESC 关闭 + Tab 焦点不逃出弹窗（捕获阶段：不让底层面板的快捷键先吃掉按键）。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
				return;
			}
			if (e.key !== "Tab") return;
			const box = boxRef.current;
			if (!box) return;
			const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex !== -1);
			if (items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement as HTMLElement | null;
			const inside = !!active && box.contains(active);
			if (e.shiftKey && (!inside || active === first)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (!inside || active === last)) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	// 打开即落焦：调用方指定的元素优先，否则第一个可聚焦元素（键盘用户不用先 Tab 一圈）。
	useEffect(() => {
		if (initialFocusRef?.current) {
			initialFocusRef.current.focus();
			return;
		}
		const box = boxRef.current;
		box?.querySelectorAll<HTMLElement>(FOCUSABLE)[0]?.focus();
		// initialFocusRef 是 ref 对象（身份稳定），故意不进依赖：只在挂载时落焦一次。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div
				className={`modal chan-dialog${className ? ` ${className}` : ""}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				ref={boxRef}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="modal-head chan-dialog-head">
					<h2 id={titleId}>{title}</h2>
					{subtitle && <span className="chan-meta">{subtitle}</span>}
					<button type="button" className="modal-close" aria-label={title} onClick={onClose}>
						<FiX />
					</button>
				</div>
				<div className="chan-dialog-body">{children}</div>
				<div className="chan-dialog-foot">{footer}</div>
			</div>
		</div>
	);
}

/**
 * 可折叠分区：把长表单切成「常用的展开、进阶的收起」。
 * @WHY 渠道编辑原来是 12 个字段一条直列（显示名/id/连接方式/服务商 id/地址/协议/密钥/鉴权头/
 *      凭据/端点/白名单/账户引用…），用户要在一列里自己找关系。分组后默认只看到必填项。
 */
export function ChannelSection({
	title,
	hint,
	summary,
	open,
	onToggle,
	children,
}: {
	title: string;
	hint?: string;
	/** 折叠时显示的一行摘要（让用户不展开也知道里面配了什么）。 */
	summary?: string;
	open: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<section className={`chan-section${open ? " open" : ""}`}>
			<button type="button" className="chan-section-head" aria-expanded={open} onClick={onToggle}>
				{open ? <FiChevronDown /> : <FiChevronRight />}
				<span className="chan-section-title">{title}</span>
				{!open && summary && <span className="chan-meta">{summary}</span>}
			</button>
			{open && (
				<div className="chan-section-body">
					{hint && <p className="set-hint">{hint}</p>}
					{children}
				</div>
			)}
		</section>
	);
}
