/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/FooterBar.tsx（底栏工作目录入口，placement="footer"）,
 *            components/DirectoryPickerNewFolder.tsx（文件夹名输入行）,
 *            components/directory-picker-path.ts（路径纯函数：parentOf/browseQuery/createParent…）,
 *            components/LeftPanelProjects.tsx（左栏「＋ 新建项目」入口触发者）,
 *            app/app-dialogs.tsx（新建项目入口 placement="modal" 的挂载点）,
 *            styles.css（.cwd-picker / .cwd-list / .cwd-picker-modal）,
 *            server/files-service.ts（complete_path / make_dir 的服务端实现与 MACHINE_ROOT）
 *   📖 ../../../docs/STRUCTURE.md（工作区与 cwd 的生命周期）
 *   @WHY 目录选择器原来内联在 FooterBar 里（唯一入口藏在底栏路径上），左栏「最近项目」
 *        没有新建入口，0 个项目时整块还不渲染 —— 新用户找不到任何新建项目的入口。
 *        抽成独立组件后底栏与左栏共用同一套浏览/新建/选择交互，行为不会分叉。
 *        路径纯函数与「文件夹名输入行」各自再分文件（本组件曾 387 行，超 300 行红线）。
 *   @CONTRACT 本组件只发三种消息（类型取自 protocol.ts 的 ClientMessage，不再手抄一份联合）：
 *        complete_path（列目录）、make_dir（建目录）、set_cwd（选定）。它不认识项目元数据 ——
 *        「项目」当前就是一个目录（见 protocol.ts ProjectSummary）。
 *   @GOTCHA openAfterCreate 不用 setTimeout 猜 mkdir 是否完成：make_dir 与 set_cwd 都是
 *        `void`（服务端不等待），先发 set_cwd 会撞上 fs.stat 失败。改为等**刷新后的目录列表**
 *        里出现该目录（服务端列表就是证据）再 set_cwd。
 *   @BUGFIX 2026-09-20：路径输入框只改 draft，而「新建文件夹」建在 browsePath 下 ——
 *        弹窗里先输入父目录再建项目时，目录会默默建到**旧目录**里（浏览器 E2E 抛出来的）。
 *        修法：弹窗形态的 Enter = 定位到该目录（不切 cwd），且创建前把“看起来是目录的
 *        draft”当作父目录（createParent）；底栏形态的 Enter 仍然是切工作目录。
 *   @BUGFIX 同日的另一处：弹窗用 document 捕获阶段监听 ESC，抢在文件夹名输入行之前处理，
 *        于是「按 ESC 想收起输入行」会关掉整个弹窗。改为弹窗容器上的冒泡处理
 *        （输入行自己 stopPropagation 就能拦下），并删掉全局监听。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { FiFolder, FiX } from "react-icons/fi";
import type { ClientMessage } from "../types";
import { useT } from "../i18n";
import { NewFolderForm } from "./DirectoryPickerNewFolder";
import {
	browseQuery,
	createParent,
	findCreatedDir,
	isExistingDir,
	MACHINE_ROOT,
	normalizePath,
	parentOf,
	type PathCompletion,
} from "./directory-picker-path";

/** 本组件发出的三种协议消息（从 ClientMessage 取，避免与 protocol.ts 各写一份）。 */
type PickerMessage = Extract<ClientMessage, { type: "complete_path" | "set_cwd" | "make_dir" }>;

interface DirectoryPickerProps {
	/** 当前工作目录：打开时定位到这里，选中它时不重复发 set_cwd。 */
	cwd: string;
	/** 服务端 path_completions 的最新结果（目录与文件混合，内部只用目录）。 */
	completions: PathCompletion[];
	send: (msg: PickerMessage) => boolean;
	onClose: () => void;
	/** "footer"：底栏上方的浮层（默认，保持底栏原样）；"modal"：居中弹窗（新建项目入口）。 */
	placement?: "footer" | "modal";
	/** 弹窗标题（placement="modal" 时显示在头部）。 */
	title?: string;
	/** 一行说明（新建项目入口用来讲清「建完即打开」）。 */
	hint?: string;
	/** 新建文件夹成功后把它作为工作目录打开（＝新建项目），并关闭选择器。 */
	openAfterCreate?: boolean;
	/** 打开时直接展开「文件夹名称」输入行（新建项目入口的主要动作就是建目录）。 */
	newFolderOpen?: boolean;
}

/**
 * 目录选择器：浏览（进入/上级/此电脑）、Tab 补全、新建文件夹、选定为工作目录。
 * 底栏与左栏「＋ 新建项目」共用同一实例逻辑，只有落位与默认动作不同。
 */
export function DirectoryPicker({
	cwd,
	completions,
	send,
	onClose,
	placement = "footer",
	title,
	hint,
	openAfterCreate = false,
	newFolderOpen = false,
}: DirectoryPickerProps) {
	const t = useT();
	const isModal = placement === "modal";
	// 服务端 cwd 是原生分隔符（Windows 下带反斜杠），选择器内部统一用 "/"，
	// 否则 parentOf 按 "/" 切分会直接返回 null，↑ 按钮一开始就是禁用的。
	const [browsePath, setBrowsePath] = useState(() => cwd.replace(/\\/g, "/"));
	const [draft, setDraft] = useState(() => cwd.replace(/\\/g, "/"));
	const [showNew, setShowNew] = useState(newFolderOpen);
	/** Tab 补全的当前候选下标（-1 = 未选中，Tab 从头开始）。 */
	const [compIndex, setCompIndex] = useState(-1);
	/** openAfterCreate 的等待目标：在刷新后的列表里出现即打开。 */
	const [pendingCreate, setPendingCreate] = useState<{ parent: string; name: string } | null>(null);
	/** 「创建并打开」超时未见新目录 → 提示创建没成功（服务端 notice 之外的就地反馈）。 */
	const [createFailed, setCreateFailed] = useState(false);

	/** 目录选择器只用目录候选（文件是噪音；要精确路径可直接在输入框里打）。 */
	const dirs = completions.filter((c) => c.type === "dir");
	/** 新建时真正落在哪个父目录（路径框优先，见 createParent 的 @GOTCHA）。 */
	const createBase = createParent(draft, browsePath);

	// 打开与切目录时列目录（防抖）。
	useEffect(() => {
		const timer = setTimeout(() => {
			send({ type: "complete_path", path: browseQuery(browsePath) });
		}, 60);
		return () => clearTimeout(timer);
	}, [browsePath, send]);

	// 输入草稿 ≠ 当前浏览目录（正在打字）时，按草稿请求补全供 Tab 接受 ——
	// 换盘符（输入 D:）与任意路径的增量补全都走这里。
	useEffect(() => {
		if (draft === browsePath) return;
		const timer = setTimeout(() => {
			send({ type: "complete_path", path: draft });
		}, 150);
		return () => clearTimeout(timer);
	}, [draft, browsePath, send]);

	/** 选定工作目录并关闭。机器根是虚拟层，不能作工作目录。 */
	const commit = (path: string) => {
		const trimmed = path.trim();
		if (trimmed === MACHINE_ROOT) return;
		if (trimmed && normalizePath(trimmed) !== normalizePath(cwd)) send({ type: "set_cwd", path: trimmed });
		onClose();
	};

	// 新建后自动打开：等服务端刷新的列表里出现该目录再 set_cwd（见文件头 @GOTCHA）。
	useEffect(() => {
		if (!pendingCreate) return;
		const created = findCreatedDir(dirs, pendingCreate.parent, pendingCreate.name);
		if (created) {
			setPendingCreate(null);
			commit(created);
			return;
		}
		// 等不到新目录 = 创建没成功（服务端 notice 里已有原因）。就地给一句提示，
		// 免得弹窗只是静静地停在那里（原先只有 5s 后静默解除等待）。
		const timer = setTimeout(() => {
			setPendingCreate(null);
			setCreateFailed(true);
		}, 5000);
		return () => clearTimeout(timer);
		// commit 依赖 send/cwd/onClose，均在一次打开内稳定；只跟 pendingCreate 与列表联动。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingCreate, dirs]);

	/** 建目录（或直接打开已存在的同名目录）。 */
	const createFolder = (name: string) => {
		setCreateFailed(false);
		if (isExistingDir(dirs, createBase, name)) {
			// 已存在 = 用户意图「用这个目录」，直接打开；不发 make_dir，也不谎称“已创建”。
			commit(`${browseQuery(createBase)}${name}`);
			return;
		}
		send({ type: "make_dir", path: `${browseQuery(createBase)}${name}` });
		// make_dir 没有直接回执 —— 稍后刷新列表（openAfterCreate 也靠这次刷新拿到证据）。
		setTimeout(() => {
			send({ type: "complete_path", path: browseQuery(createBase) });
		}, 80);
		if (openAfterCreate) setPendingCreate({ parent: createBase, name });
		else setShowNew(false);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			onClose();
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			// 弹窗（新建项目）：Enter = 定位到该目录，因为接下来要在它里面建项目；
			// 底栏：Enter = 切换工作目录（旧行为，有 left-panel-test.mjs 盘着）。
			if (isModal) {
				setBrowsePath(draft.trim());
				setCompIndex(-1);
			} else {
				commit(draft);
			}
		} else if (e.key === "Tab") {
			// Tab 补全：循环接受目录候选（换盘符也走这里——候选可能是 D: 盘）。
			if (dirs.length === 0) return;
			e.preventDefault();
			const idx = compIndex >= 0 ? (compIndex + 1) % dirs.length : 0;
			setCompIndex(idx);
			setDraft(dirs[idx].path);
			setBrowsePath(dirs[idx].path);
		}
	};

	const goTo = (path: string) => {
		setBrowsePath(path);
		setDraft(path);
		setCompIndex(-1);
	};

	const upPath = parentOf(browsePath);
	const atMachineRoot = browsePath === MACHINE_ROOT;

	const panel = (
		<div
			className={`cwd-picker${isModal ? " cwd-picker-modal" : ""}`}
			{...(isModal ? { role: "dialog", "aria-modal": true, "aria-label": title ?? t("cwdPickCurrent") } : {})}
			onClick={isModal ? (e) => e.stopPropagation() : undefined}
			// ESC 关弹窗走**冒泡**（不是全局捕获）：文件夹名输入行自己 stopPropagation 就能拦住，
			// 于是「ESC 收起输入行」不会连带把整个弹窗关掉。
			onKeyDown={
				isModal
					? (e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								onClose();
							}
						}
					: undefined
			}
		>
			{isModal && title && (
				<div className="cwd-picker-modal-head">
					<span className="cwd-picker-modal-title">{title}</span>
					<button type="button" className="cwd-up" title={t("close")} aria-label={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>
			)}
			{hint && <p className="cwd-picker-hint">{hint}</p>}
			<div className="cwd-picker-head">
				<span className="cwd-picker-title" title={atMachineRoot ? t("computer") : browsePath}>
					{atMachineRoot ? "💻" : <FiFolder />}
					<span>{atMachineRoot ? t("computer") : browsePath}</span>
				</span>
				<button type="button" className="cwd-up" disabled={atMachineRoot} title={t("computer")} onClick={() => goTo(MACHINE_ROOT)}>
					💻
				</button>
				<button type="button" className="cwd-up" disabled={!upPath} title={t("cwdGoUp")} onClick={() => upPath && goTo(upPath)}>
					↑ {t("cwdGoUp")}
				</button>
			</div>
			<div className="cwd-picker-row">
				<input
					className="status-cwd-input cwd-picker-input"
					value={draft}
					placeholder={t("enterPath")}
					spellCheck={false}
					onChange={(e) => {
						setDraft(e.target.value);
						setCompIndex(-1);
					}}
					onKeyDown={onKeyDown}
				/>
				<button
					type="button"
					className="cwd-choose-btn primary"
					title={t("cwdPickCurrent")}
					disabled={atMachineRoot}
					onClick={() => commit(browsePath)}
				>
					{t("cwdPickCurrent")}
				</button>
			</div>
			<div className="cwd-list">
				{dirs.length === 0 && <div className="cwd-empty">{t("cwdEmpty")}</div>}
				{dirs.map((d) => (
					<div key={d.path} className="cwd-item">
						<button type="button" className="cwd-enter" title={`${t("cwdEnter")} ${d.path}`} onClick={() => goTo(d.path)}>
							<FiFolder />
							<span className="cwd-name">{d.name}</span>
						</button>
						<button type="button" className="cwd-choose-btn" title={t("cwdChoose")} onClick={() => commit(d.path)}>
							{t("cwdChoose")}
						</button>
					</div>
				))}
			</div>
			<div className="cwd-picker-foot">
				{showNew ? (
					<NewFolderForm
						dirs={dirs}
						parent={createBase}
						openAfterCreate={openAfterCreate}
						pending={pendingCreate !== null}
						error={createFailed}
						onCreate={createFolder}
						onCancel={() => {
							setShowNew(false);
							setCreateFailed(false);
						}}
					/>
				) : (
					<button type="button" className="cwd-newbtn" onClick={() => setShowNew(true)}>
						＋ {t("cwdNewFolder")}
					</button>
				)}
			</div>
		</div>
	);

	if (isModal) {
		return (
			<div className="modal-backdrop cwd-picker-backdrop" onClick={onClose}>
				{panel}
			</div>
		);
	}
	return (
		<>
			{/* 点击空白处关闭（底栏浮层）。 */}
			<div className="status-cwd-backdrop" onClick={onClose} />
			{panel}
		</>
	);
}
