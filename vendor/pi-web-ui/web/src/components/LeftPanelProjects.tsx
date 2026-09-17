/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/LeftPanel.tsx（唯一挂载点，负责折叠权重与 sash），
 *            components/DirectoryPicker.tsx（＋ 新建项目打开的选择器），
 *            server/protocol.ts（ProjectSummary / list_projects / set_cwd / remove_project），
 *            styles.css（.panel-projects / .lp-projects-new / .lp-projects-empty）
 *   📖 ../../../docs/STRUCTURE.md（workspace 生命周期：项目=目录）
 *   @WHY 2026-09-20：这个区块以前 `projects.length > 0` 才渲染，于是**0 个项目的新用户
 *        整块看不到**，而唯一的新建入口藏在底栏路径里 —— 用户合理地认为「系统没有新建项目功能」。
 *        现在标题常显，标题右侧有「＋ 新建项目」，空态里再放一次入口。
 *   @CONTRACT 「项目」在协议里就是一个目录（ProjectSummary 只有 path + lastUsed），
 *        所以新建 = 建目录 + set_cwd，本组件不臆造项目元数据；重命名同理暂不提供
 *        （目录改名会牵连会话归档目录、projectModels、渠道密钥绑定，属后续切片）。
 * ──────────────────────────────────────────────────
 */
import { FiFolder, FiFolderPlus } from "react-icons/fi";
import type { ProjectSummary } from "../types";
import { useT } from "../i18n";

/** 目录名即项目名（协议里没有独立名字字段）。 */
export function projectName(path: string): string {
	return path.split(/[\\/]/).pop() || path;
}

interface LeftPanelProjectsProps {
	projects: ProjectSummary[];
	/** 当前工作目录：用来高亮 active 行并阻止重复 set_cwd。 */
	cwd: string;
	collapsed: boolean;
	/** 区块标题（含计数）由 LeftPanel 统一渲染，保证三块外观一致。 */
	header: React.ReactNode;
	send: (msg: { type: "set_cwd"; path: string } | { type: "remove_project"; path: string }) => boolean;
	/** 打开目录选择器（新建项目）。由 App 层持有，因为选择器要用 chat.pathCompletions。 */
	onNewProject: () => void;
	/** 「从最近项目移出」的二次确认按钮（LeftPanel 的共用实现）。 */
	renderRemoveButton: (project: ProjectSummary) => React.ReactNode;
	/** 行的时间戳格式化（LeftPanel 的共用实现）。 */
	formatModified: (ts: number) => string;
	onRowLeave: (key: string) => void;
}

/** 左栏「最近项目」区块：列出项目、切换项目、新建项目、从列表移出。 */
export function LeftPanelProjects({
	projects,
	cwd,
	collapsed,
	header,
	send,
	onNewProject,
	renderRemoveButton,
	formatModified,
	onRowLeave,
}: LeftPanelProjectsProps) {
	const t = useT();
	return (
		<>
			<div className="lp-section-head-row">
				{header}
				{/* @GOTCHA 入口必须在标题行里（不是列表内），否则列表为空时它跟着消失 —— 那正是原来的 bug。 */}
				<button
					type="button"
					className="lp-projects-new"
					title={t("newProjectTip")}
					aria-label={t("newProject")}
					onClick={(e) => {
						e.stopPropagation();
						onNewProject();
					}}
				>
					<FiFolderPlus />
				</button>
			</div>
			{!collapsed && (
				<div className="lp-section-body projects-scroll">
					{projects.length === 0 && (
						<div className="lp-projects-empty">
							<p className="panel-empty">{t("noProjects")}</p>
							<button type="button" className="cwd-newbtn" onClick={onNewProject}>
								＋ {t("newProject")}
							</button>
						</div>
					)}
					{projects.map((p) => {
						const active = cwd === p.path;
						return (
							<div className="lp-row" key={p.path} onMouseLeave={() => onRowLeave(`proj:${p.path}`)}>
								<button
									type="button"
									className={`project-item ${active ? "active" : ""}`}
									title={p.path}
									onClick={() => {
										if (!active) send({ type: "set_cwd", path: p.path });
									}}
								>
									<FiFolder className="project-icon" />
									<span className="project-info">
										<span className="project-name">{projectName(p.path)}</span>
										<span className="project-path">{p.path}</span>
									</span>
									<span className="project-time">{formatModified(p.lastUsed)}</span>
								</button>
								{renderRemoveButton(p)}
							</div>
						);
					})}
				</div>
			)}
		</>
	);
}
