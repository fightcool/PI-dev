import { memo, useEffect, useState, useCallback, useRef } from "react";
import {
	FiCheck,
	FiChevronDown,
	FiChevronUp,
	FiChevronsLeft,
	FiEdit2,
	FiFolder,
	FiMessageSquare,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import type { ConversationSummary, ProjectSummary, SessionSummary } from "../types";
import type { ConnStatus } from "../use-chat";
import { useT } from "../i18n";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  this entire panel during streaming instead of re-reconciling the file tree
 *  and conversation lists on every delta. Add a prop here when adding a chat
 *  field usage — TypeScript enforces it at the call site. */
interface LeftPanelProps {
	ready: boolean;
	status: ConnStatus;
	cwd: string;
	sessionFile: string | null;
	conversations: ConversationSummary[];
	sessions: SessionSummary[];
	projects: ProjectSummary[];
	activeConversationId: string;
	send: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions" }
			| { type: "list_projects" }
			| { type: "switch_session"; path: string }
			| { type: "switch_conversation"; id: string }
			| { type: "set_cwd"; path: string }
			| { type: "remove_project"; path: string }
			| { type: "delete_session"; path: string }
			| { type: "rename_session"; path: string; name: string }
			| { type: "rename_conversation"; id: string; name: string }
			| { type: "dismiss_conversation"; id: string },
	) => boolean;
	/** True while the panel is actually on screen (desktop: always; mobile:
	 *  only while the drawer is open). Drives lazy loading of the session
	 *  list + recent projects — both scan session files on disk. */
	active: boolean;
	/** Desktop: show the collapse button (mobile drawers close via the topbar). */
	collapsible?: boolean;
	/** Fired when the user clicks the collapse button. */
	onToggleCollapse?: () => void;
}

function formatModified(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface ConvGroup {
	cwd: string;
	isCurrent: boolean;
	convs: ConversationSummary[];
}

/** Group the (now cross-project) running-conversation list by workspace,
 *  current project first, others in stable path order. Lets the left panel
 *  disambiguate same-titled chats across projects and shows where each
 *  background run lives. */
function groupConversations(list: ConversationSummary[], currentCwd: string): ConvGroup[] {
	const byId = new Map(list.map((c) => [c.id, c]));
	const byCwd = new Map<string, ConversationSummary[]>();
	for (const c of list) {
		// A child with an overridden cwd still belongs under its parent's project.
		const groupCwd = c.parentId ? (byId.get(c.parentId)?.cwd ?? c.cwd) : c.cwd;
		const arr = byCwd.get(groupCwd) ?? [];
		arr.push(c);
		byCwd.set(groupCwd, arr);
	}
	const groups: ConvGroup[] = [...byCwd.entries()].map(([cwd, convs]) => ({
		cwd,
		isCurrent: cwd === currentCwd,
		convs,
	}));
	groups.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
	return groups;
}

const LS_COLLAPSE_PROJECTS = "pi-web-ui:lp-collapse-projects";
const LS_COLLAPSE_CONVS = "pi-web-ui:lp-collapse-convs";
const LS_COLLAPSE_SESSIONS = "pi-web-ui:lp-collapse-sessions";

function useCollapsed(key: string, defaultCollapsed = false): [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(() => {
		try {
			const v = localStorage.getItem(key);
			if (v === "1") return true;
			if (v === "0") return false;
		} catch {}
		return defaultCollapsed;
	});
	const toggle = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(key, next ? "1" : "0");
			} catch {}
			return next;
		});
	}, [key]);
	return [collapsed, toggle];
}

/* VSCode 风格可拖拽分割：展开区的 flex-grow 权重持久化，折叠区不占空间 */
const LS_LP_SIZES = "pi-web-ui:lp-sizes";
type LpWeights = { projects: number; convs: number; sessions: number };
const DEFAULT_LP_WEIGHTS: LpWeights = { projects: 1, convs: 1, sessions: 1 };
function loadLpWeights(): LpWeights {
	try {
		const raw = localStorage.getItem(LS_LP_SIZES);
		if (raw) {
			const p = JSON.parse(raw) as Partial<LpWeights>;
			return {
				projects: typeof p.projects === "number" && p.projects > 0 ? p.projects : 1,
				convs: typeof p.convs === "number" && p.convs > 0 ? p.convs : 1,
				sessions: typeof p.sessions === "number" && p.sessions > 0 ? p.sessions : 1,
			};
		}
	} catch {}
	return { ...DEFAULT_LP_WEIGHTS };
}

export const LeftPanel = memo(function LeftPanel({
	ready,
	status,
	cwd,
	sessionFile,
	conversations,
	sessions,
	projects,
	activeConversationId,
	send,
	active,
	collapsible,
	onToggleCollapse,
}: LeftPanelProps) {
	const t = useT();
	const currentFile = sessionFile;
	const currentCwd = cwd;
	const [confirmDel, setConfirmDel] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [collapseProjects, toggleProjects] = useCollapsed(LS_COLLAPSE_PROJECTS, false);
	const [collapseConvs, toggleConvs] = useCollapsed(LS_COLLAPSE_CONVS, false);
	const [collapseSessions, toggleSessions] = useCollapsed(LS_COLLAPSE_SESSIONS, false);

	const panelRef = useRef<HTMLElement>(null);
	const [weights, setWeights] = useState<LpWeights>(() => loadLpWeights());
	useEffect(() => {
		try {
			localStorage.setItem(LS_LP_SIZES, JSON.stringify(weights));
		} catch {}
	}, [weights]);

	const createSashHandler = useCallback(
		(aboveKey: keyof LpWeights, belowKey: keyof LpWeights) => (e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const target = e.currentTarget;
			const startY = e.clientY;
			const start = { ...weights };
			const panel = panelRef.current;
			if (!panel) return;
			const headerH = 32; // .lp-section-title 高度（与 styles.css 中 .lp-section.collapsed 对齐）
			const minPx = 72;
			const visibleMeta = [
				{ key: "projects" as const, visible: projects.length > 0, collapsed: collapseProjects },
				{ key: "convs" as const, visible: conversations.length > 0, collapsed: collapseConvs },
				{ key: "sessions" as const, visible: true, collapsed: collapseSessions },
			].filter((s) => s.visible);
			const collapsedCount = visibleMeta.filter((s) => s.collapsed).length;
			const expandedKeys = visibleMeta.filter((s) => !s.collapsed).map((s) => s.key);
			const totalWeight = expandedKeys.reduce((sum, k) => sum + (start[k] ?? 1), 0) || 1;
			const available = Math.max(120, panel.clientHeight - collapsedCount * headerH);
			const pairTotal = (start[aboveKey] ?? 1) + (start[belowKey] ?? 1);
			const minWeight = (minPx / available) * totalWeight;
			target.classList.add("dragging");
			document.body.classList.add("lp-resizing");
			const onMove = (ev: PointerEvent) => {
				const deltaY = ev.clientY - startY;
				const deltaW = (deltaY / available) * totalWeight;
				let nextAbove = (start[aboveKey] ?? 1) + deltaW;
				const maxW = pairTotal - minWeight;
				nextAbove = Math.max(minWeight, Math.min(maxW, nextAbove));
				const nextBelow = pairTotal - nextAbove;
				setWeights((prev) => ({ ...prev, [aboveKey]: nextAbove, [belowKey]: nextBelow }));
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				target.classList.remove("dragging");
				document.body.classList.remove("lp-resizing");
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[weights, projects.length, conversations.length, collapseProjects, collapseConvs, collapseSessions],
	);

	useEffect(() => {
		if (!active || !ready || status !== "open") return;
		if (!cwd) return;
		send({ type: "list_sessions" });
		send({ type: "list_projects" });
	}, [active, ready, status, cwd, send]);

	const displayName = (s: SessionSummary): string => {
		const title = s.name || s.firstMessage.trim();
		return title.length > 0 ? title : t("emptyChat");
	};

	const projectName = (path: string): string => path.split(/[\\/]/).pop() || path;

	const delButton = (key: string, hint: string, confirmHint: string, onConfirm: () => void, icon?: React.ReactNode) => {
		const armed = confirmDel === key;
		return (
			<button
				type="button"
				className={`lp-del ${armed ? "confirm" : ""}`}
				title={armed ? confirmHint : hint}
				onClick={(e) => {
					e.stopPropagation();
					if (armed) {
						setConfirmDel(null);
						onConfirm();
					} else {
						setConfirmDel(key);
					}
				}}
			>
				{armed ? <FiCheck /> : (icon ?? <FiTrash2 />)}
			</button>
		);
	};

	const sectionHeader = (title: string, collapsed: boolean, onToggle: () => void, count?: number) => (
		<button
			type="button"
			className="lp-section-title panel-section-title"
			onClick={onToggle}
			title={collapsed ? t("expandSection") : t("collapseSection")}
		>
			<span className="lp-section-title-text">
				{title}
				{count !== undefined ? ` (${count})` : ""}
			</span>
			<span className="lp-section-chevron">{collapsed ? <FiChevronDown /> : <FiChevronUp />}</span>
		</button>
	);

	// 归一化权重：单展开时强制 flex=1 填满；多展开时按权重比例均值归一，避免 0.539 这类小数导致容器留空
	const visibleMetaForFlex = [
		{ key: "projects" as const, visible: projects.length > 0, collapsed: collapseProjects },
		{ key: "convs" as const, visible: conversations.length > 0, collapsed: collapseConvs },
		{ key: "sessions" as const, visible: true, collapsed: collapseSessions },
	].filter((s) => s.visible);
	const expandedForFlex = visibleMetaForFlex.filter((s) => !s.collapsed);
	const totalWeightForFlex = expandedForFlex.reduce((sum, k) => sum + (weights[k.key] ?? 1), 0) || 1;
	const effFlex = (k: keyof LpWeights) => {
		if (expandedForFlex.length <= 1) return 1;
		const w = weights[k] ?? 1;
		return (w / totalWeightForFlex) * expandedForFlex.length;
	};

	return (
		<aside ref={panelRef as React.RefObject<HTMLDivElement>} className="panel panel-left lp-panel">
			{collapsible && onToggleCollapse && (
				<button type="button" className="panel-collapse-btn" title={t("collapsePanel")} onClick={onToggleCollapse}>
					<FiChevronsLeft />
				</button>
			)}
			{/* Recent projects — collapsible, flex share */}
			{projects.length > 0 && (
				<div
					className={`lp-section panel-projects ${collapseProjects ? "collapsed" : ""}`}
					style={!collapseProjects ? { flex: `${effFlex("projects")} 1 0px` } : undefined}
				>
					{sectionHeader(t("recentProjects"), collapseProjects, toggleProjects, projects.length)}
					{!collapseProjects && (
						<div className="lp-section-body projects-scroll">
							{projects.map((p) => {
								const active = currentCwd === p.path;
								return (
									<div
										className="lp-row"
										key={p.path}
										onMouseLeave={() => setConfirmDel((k) => (k === `proj:${p.path}` ? null : k))}
									>
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
										{delButton(`proj:${p.path}`, t("deleteProject"), t("deleteProjectConfirm"), () =>
											send({ type: "remove_project", path: p.path }),
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}
			{/* sash: projects ↔ next */}
			{projects.length > 0 && !collapseProjects && (conversations.length > 0 ? !collapseConvs : !collapseSessions) && (
				<div
					className="lp-sash"
					onPointerDown={createSashHandler("projects", conversations.length > 0 ? "convs" : "sessions")}
					onDoubleClick={() => setWeights({ ...DEFAULT_LP_WEIGHTS })}
					title={t("dragToResize")}
				/>
			)}

			{/* Running conversations — collapsible, flex share. Hidden when empty to keep old layout expectations. */}
			{conversations.length > 0 && (
				<div
					className={`lp-section lp-section-convs panel-convs ${collapseConvs ? "collapsed" : ""}`}
					style={!collapseConvs ? { flex: `${effFlex("convs")} 1 0px` } : undefined}
				>
					{sectionHeader(t("runningConversations"), collapseConvs, toggleConvs, conversations.length)}
					{!collapseConvs && (
						<div className="lp-section-body convs-scroll">
							{groupConversations(conversations, cwd).map((g) => (
								<div key={g.cwd} className="panel-conv-group">
									{!g.isCurrent && (
										<div className="panel-conv-group-title" title={g.cwd}>
											{projectName(g.cwd)}
										</div>
									)}
									{(() => {
										const byId = new Map(g.convs.map((x) => [x.id, x]));
										const kids = new Map<string, ConversationSummary[]>();
										const roots: ConversationSummary[] = [];
										for (const x of g.convs) {
											if (x.parentId && byId.has(x.parentId)) {
												const arr = kids.get(x.parentId) ?? [];
												arr.push(x);
												kids.set(x.parentId, arr);
											} else roots.push(x);
										}
										const rows: { c: ConversationSummary; depth: number }[] = [];
										const seen = new Set<string>();
										const append = (c: ConversationSummary, depth: number) => {
											if (seen.has(c.id)) return;
											seen.add(c.id);
											rows.push({ c, depth });
											for (const child of kids.get(c.id) ?? []) append(child, depth + 1);
										};
										for (const root of roots) append(root, 0);
										for (const orphan of g.convs) append(orphan, 0);
										return rows.map(({ c, depth }) => {
											const active = activeConversationId === c.id;
											return (
												<div
													className={`lp-row${depth > 0 ? " lp-sub" : ""}`}
													key={c.id}
													style={depth > 0 ? { marginLeft: depth * 18 } : undefined}
													onMouseLeave={() => setConfirmDel((k) => (k === `conv:${c.id}` ? null : k))}
												>
													<button
														type="button"
														className={`session-item ${active ? "active" : ""}`}
														title={`${c.title}${g.isCurrent ? "" : ` — ${g.cwd}`}`}
														onClick={() => {
															if (!active) send({ type: "switch_conversation", id: c.id });
														}}
													>
														<FiMessageSquare className="session-icon" />
														<span className="session-info">
															{renaming === `conv:${c.id}` ? (
																<input
																	autoFocus
																	className="session-rename-input"
																	value={renameDraft}
																	placeholder={t("renameSessionPlaceholder")}
																	onClick={(e) => e.stopPropagation()}
																	onChange={(e) => setRenameDraft(e.target.value)}
																	onKeyDown={(e) => {
																		e.stopPropagation();
																		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
																			const name = renameDraft.trim();
																			if (name) send({ type: "rename_conversation", id: c.id, name });
																			setRenaming(null);
																		} else if (e.key === "Escape") {
																			setRenaming(null);
																		}
																	}}
																	onBlur={() => setRenaming(null)}
																/>
															) : (
																<span className="session-title">
																	{c.isSubagent && <span className="subagent-badge">{t("subagentBadge")}</span>}
																	{c.title}
																	{c.error && (
																		<span
																			className="conv-error-badge"
																			title={t("convErrorBadge", { error: c.error })}
																		/>
																	)}
																</span>
															)}
															{renaming === `conv:${c.id}` ? null : (
																<span className="session-sub">
																	{active ? t("current") : t("messageCount", { n: c.messageCount })}
																</span>
															)}
														</span>
														{c.isStreaming && <span className="conv-streaming" title={t("streaming")} />}
													</button>
													<button
														type="button"
														className="lp-del lp-rename"
														title={t("renameSession")}
														onClick={(e) => {
															e.stopPropagation();
															setConfirmDel(null);
															setRenameDraft(c.title);
															setRenaming(`conv:${c.id}`);
														}}
													>
														<FiEdit2 />
													</button>
													{!c.isStreaming &&
														!active &&
														delButton(
															`conv:${c.id}`,
															t("dismissConversation"),
															t("dismissConversationConfirm"),
															() => send({ type: "dismiss_conversation", id: c.id }),
															<FiX />,
														)}
													{c.isStreaming && (
														<span
															className="lp-row-stalled"
															title={t("streaming")}
															style={{ position: "absolute", right: 28, top: "50%", transform: "translateY(-50%)" }}
														/>
													)}
												</div>
											);
										});
									})()}
								</div>
							))}
						</div>
					)}
				</div>
			)}
			{/* sash: convs ↔ sessions */}
			{conversations.length > 0 && !collapseConvs && !collapseSessions && (
				<div
					className="lp-sash"
					onPointerDown={createSashHandler("convs", "sessions")}
					onDoubleClick={() => setWeights({ ...DEFAULT_LP_WEIGHTS })}
					title={t("dragToResize")}
				/>
			)}

			{/* History sessions — collapsible, flex share, takes remaining */}
			<div
				className={`lp-section lp-section-sessions panel-sessions ${collapseSessions ? "collapsed" : ""}`}
				style={!collapseSessions ? { flex: `${effFlex("sessions")} 1 0px` } : undefined}
			>
				{sectionHeader(t("historySessions"), collapseSessions, toggleSessions, sessions.length)}
				{!collapseSessions && (
					<div className="lp-section-body sessions-scroll">
						{sessions.length === 0 && <div className="panel-empty">{t("noHistory")}</div>}
						{sessions.map((s) => {
							const active = currentFile === s.path;
							return (
								<div
									className="lp-row"
									key={s.path}
									onMouseLeave={() => setConfirmDel((k) => (k === `sess:${s.path}` ? null : k))}
								>
									<button
										type="button"
										className={`session-item ${active ? "active" : ""}`}
										title={s.path}
										onClick={() => {
											if (renaming) return;
											if (!active) send({ type: "switch_session", path: s.path });
										}}
									>
										<FiMessageSquare className="session-icon" />
										<span className="session-info">
											{renaming === s.path ? (
												<input
													autoFocus
													className="session-rename-input"
													value={renameDraft}
													placeholder={t("renameSessionPlaceholder")}
													onClick={(e) => e.stopPropagation()}
													onChange={(e) => setRenameDraft(e.target.value)}
													onKeyDown={(e) => {
														e.stopPropagation();
														if (e.key === "Enter" && !e.nativeEvent.isComposing) {
															const name = renameDraft.trim();
															if (name) send({ type: "rename_session", path: s.path, name });
															setRenaming(null);
														} else if (e.key === "Escape") {
															setRenaming(null);
														}
													}}
													onBlur={() => setRenaming(null)}
												/>
											) : (
												<span className="session-title">{displayName(s)}</span>
											)}
											{renaming === s.path ? null : (
												<span className="session-sub">
													{active ? t("current") : t("messageCount", { n: s.messageCount })}
													{s.source === "tui" && (
														<span className="session-src" title={t("tuiTip")}>
															TUI
														</span>
													)}
												</span>
											)}
										</span>
										<span className="session-time">{formatModified(s.modified)}</span>
									</button>
									<button
										type="button"
										className="lp-del lp-rename"
										title={t("renameSession")}
										onClick={(e) => {
											e.stopPropagation();
											setConfirmDel(null);
											setRenameDraft(s.name ?? "");
											setRenaming(s.path);
										}}
									>
										<FiEdit2 />
									</button>
									{delButton(`sess:${s.path}`, t("deleteSession"), t("deleteSessionConfirm"), () =>
										send({ type: "delete_session", path: s.path }),
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</aside>
	);
});
