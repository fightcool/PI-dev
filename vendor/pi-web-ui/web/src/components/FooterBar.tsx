import { useEffect, useRef, useState } from "react";
import { FiFolder } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";

interface FooterBarProps {
	chat: ChatState;
	send: (
		msg:
			{ type: "complete_path"; path: string } | { type: "set_cwd"; path: string } | { type: "make_dir"; path: string },
	) => boolean;
}

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
const MACHINE_ROOT = "@root";

/**
 * Compact status bar: connection, context usage, cost, session, queue, and the
 * workspace path — click the path to open a directory picker (browse into
 * folders, go up, create folders, or pick one as the working directory).
 */
export function FooterBar({ chat, send }: FooterBarProps) {
	const t = useT();
	const state = chat.state;
	const [editing, setEditing] = useState(false);
	/** Directory currently shown in the picker (absolute, "/"-separated). */
	const [browsePath, setBrowsePath] = useState("");
	/** Free-form path input (still available for typing exact paths). */
	const [draft, setDraft] = useState("");
	/** "New folder" inline input state. */
	const [showNew, setShowNew] = useState(false);
	const [newName, setNewName] = useState("");
	/** Tab 补全的当前候选下标（-1 = 未选中，Tab 从头开始）。 */
	const [compIndex, setCompIndex] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const newInputRef = useRef<HTMLInputElement>(null);
	/** Completion list scoped to the picker: directories only (files are noise
	 *  for a working-directory selector; the free-form input covers files). */
	const dirs = chat.pathCompletions.filter((c) => c.type === "dir");

	/** Browse query with trailing separator so the server lists the WHOLE dir. */
	const browseQuery = (p: string) => (p.endsWith("/") ? p : p + "/");

	/** Parent of an absolute "/"-separated path; null at the filesystem root.
	 *  Windows 盘符根（"C:"）的父级是机器根 @root（盘符列表）；posix "/" 无父级。 */
	const parentOf = (p: string): string | null => {
		let s = p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
		if (s === MACHINE_ROOT || s === "/") return null;
		const i = s.lastIndexOf("/");
		if (i < 0) {
			// "/"、盘符根 "C:" 或裸名
			return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
		}
		if (i === 0) return "/"; // posix "/foo" → "/"
		const parent = s.slice(0, i);
		// Windows drive root resolves weirdly without the trailing slash.
		return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
	};

	// Debounced listing request while the picker is open.
	useEffect(() => {
		if (!editing) return;
		const t = setTimeout(() => {
			send({ type: "complete_path", path: browseQuery(browsePath) });
		}, 60);
		return () => clearTimeout(t);
	}, [browsePath, editing, send]);

	// 输入草稿 ≠ 当前浏览目录（正在打字）时，按草稿请求补全供 Tab 接受 ——
	// 换盘符（输入 D:）与任意路径的增量补全都走这里。
	useEffect(() => {
		if (!editing || draft === browsePath) return;
		const t = setTimeout(() => {
			send({ type: "complete_path", path: draft });
		}, 150);
		return () => clearTimeout(t);
	}, [draft, browsePath, editing, send]);

	// Live generation-speed samples (tokens/sec). Kept in a ref so pushing a
	// sample never triggers a re-render. The SDK only commits a turn's usage
	// counters at message_end, so `stats.tokens.output` is FLAT while streaming —
	// instead we estimate tokens from the in-flight message content (text +
	// thinking), which grows every token. Sample at most every 250ms; baseline
	// resets the moment streaming stops.
	const samplesRef = useRef<RateSample[]>([]);
	const streamingNow = state?.isStreaming ?? false;
	const streamEst = state?.streamingMessage ? estimateStreamTokens(state.streamingMessage.content) : 0;
	useEffect(() => {
		if (!streamingNow) {
			samplesRef.current = [];
			return;
		}
		const now = Date.now();
		const prev = samplesRef.current;
		const last = prev[prev.length - 1];
		if (last && now - last.t < 250) return; // throttle
		samplesRef.current = trimRateSamples([...prev, { t: now, out: streamEst }], now);
	}, [streamingNow, streamEst]);

	if (!state) return null;
	const s = state.stats;

	const cache = cacheMetrics(s.tokens);
	const hitPct = cache.hitRate * 100;
	const hitClass = cache.totalInput === 0 ? "" : cache.hitRate >= 0.7 ? "ok" : cache.hitRate >= 0.4 ? "mid" : "warn";
	const hitText = cache.totalInput > 0 ? `${hitPct.toFixed(1)}%` : "—";
	const rate = streamingNow ? streamRate(samplesRef.current) : 0;

	const connClass = chat.ready ? "ok" : "busy";
	const connLabel = chat.ready ? t("connected") : t("connecting");

	const context = s.contextUsage;
	const ctxText =
		context.tokens !== null && context.percent !== null
			? `${context.estimated ? "~" : ""}${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`
			: "—";
	const ctxPercent = context.percent ?? null;
	const ctxBarClass = ctxPercent === null ? "" : ctxPercent >= 80 ? "warn" : ctxPercent >= 50 ? "mid" : "ok";

	const queueTotal = state.queue.steering.length + state.queue.followUp.length;

	const startEdit = () => {
		// 服务端 cwd 是原生分隔符（Windows 下带反斜杠），选择器内部统一用 "/"，
		// 否则 parentOf 按 "/" 切分会直接返回 null，↑ 按钮一开始就是禁用的。
		const norm = state.cwd.replace(/\\/g, "/");
		setDraft(norm);
		setBrowsePath(norm);
		setShowNew(false);
		setNewName("");
		setEditing(true);
	};

	/** Toggle the working directory and close the picker. 机器根是虚拟层，不能作工作目录。 */
	const commit = (path: string) => {
		const trimmed = path.trim();
		if (trimmed === MACHINE_ROOT) return;
		if (trimmed && trimmed !== state.cwd) send({ type: "set_cwd", path: trimmed });
		setEditing(false);
	};

	/** Create a folder under the currently browsed directory. */
	const createFolder = () => {
		const name = newName.trim();
		if (!name) return;
		send({ type: "make_dir", path: `${browseQuery(browsePath)}${name}` });
		// make_dir has no direct response — refresh the listing shortly after.
		setTimeout(() => {
			send({ type: "complete_path", path: browseQuery(browsePath) });
		}, 80);
		setNewName("");
		setShowNew(false);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			setEditing(false);
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			commit(draft);
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

	const upPath = parentOf(browsePath);

	return (
		<footer className="statusbar">
			<span className={`status-dot ${connClass}`} title={connLabel} />
			<span className="status-item">{connLabel}</span>
			<span className="status-sep">·</span>

			{chat.engine && chat.engine !== "pi" && (
				<>
					<span
						className={`status-item engine-badge engine-${chat.engine}`}
						title={`${t("engineBadge")}: ${chat.engine}`}
					>
						{chat.engine === "dsh" ? "DSH" : chat.engine}
					</span>
					<span className="status-sep">·</span>
				</>
			)}

			<span className="status-item status-ctx" title={t("contextUsage")}>
				{t("context")}
				<span className={`ctx-bar ${ctxBarClass}`}>
					{ctxPercent !== null && <span className="ctx-bar-fill" style={{ width: `${Math.min(ctxPercent, 100)}%` }} />}
				</span>
				{ctxText}
			</span>
			<span className="status-sep">·</span>

			<span className="status-item" title={t("cumulativeCost")}>
				${formatCost(s.cost)}
			</span>
			<span className="status-sep">·</span>

			<span
				className="status-item status-cache"
				title={t("cacheHitTip", {
					read: formatTokens(cache.read),
					write: formatTokens(cache.write),
					miss: formatTokens(cache.miss),
					input: formatTokens(cache.totalInput),
				})}
			>
				{t("cacheHit")}
				<b className={`cache-pct ${hitClass}`}>{hitText}</b>
			</span>
			<span className="status-sep">·</span>

			<span className="status-item" title={t("sessionMessages")}>
				{t("messages")} {s.totalMessages}
			</span>

			{chat.statuses.length > 0 && (
				<>
					<span className="status-sep">·</span>
					<span className="status-item ext-status" title={t("pluginStatus")}>
						{chat.statuses.map((st) => st.text).join(" · ")}
					</span>
				</>
			)}

			{state.isStreaming && (
				<>
					<span className="status-sep">·</span>
					<span className="status-item working">
						<span className="working-spin" />
						{t("working")}
						{queueTotal > 0 && (
							<span className="status-queue">
								⏳ {queueTotal} {t("queued")}
							</span>
						)}
					</span>
					<span className="status-item status-rate" title={t("rateTip")}>
						{rate > 0 ? `${Math.round(rate)}${t("tps")}` : "…"}
					</span>
				</>
			)}

			{editing ? (
				<>
					{/* Click-away backdrop closes the picker. */}
					<div className="status-cwd-backdrop" onClick={() => setEditing(false)} />
					<div className="cwd-picker">
						<div className="cwd-picker-head">
							<span className="cwd-picker-title" title={browsePath === MACHINE_ROOT ? t("computer") : browsePath}>
								{browsePath === MACHINE_ROOT ? "💻" : <FiFolder />}
								<span>{browsePath === MACHINE_ROOT ? t("computer") : browsePath}</span>
							</span>
							<button
								type="button"
								className="cwd-up"
								disabled={browsePath === MACHINE_ROOT}
								title={t("computer")}
								onClick={() => {
									setBrowsePath(MACHINE_ROOT);
									setDraft(MACHINE_ROOT);
									setCompIndex(-1);
								}}
							>
								💻
							</button>
							<button
								type="button"
								className="cwd-up"
								disabled={!upPath}
								title={t("cwdGoUp")}
								onClick={() => {
									if (upPath) {
										setBrowsePath(upPath);
										setDraft(upPath);
										setCompIndex(-1);
									}
								}}
							>
								↑ {t("cwdGoUp")}
							</button>
						</div>
						<div className="cwd-picker-row">
							<input
								ref={inputRef}
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
								disabled={browsePath === MACHINE_ROOT}
								onClick={() => commit(browsePath)}
							>
								{t("cwdPickCurrent")}
							</button>
						</div>
						<div className="cwd-list">
							{dirs.length === 0 && <div className="cwd-empty">{t("cwdEmpty")}</div>}
							{dirs.map((d) => (
								<div key={d.path} className="cwd-item">
									<button
										type="button"
										className="cwd-enter"
										title={`${t("cwdEnter")} ${d.path}`}
										onClick={() => {
											setBrowsePath(d.path);
											setDraft(d.path);
											setCompIndex(-1);
										}}
									>
										<FiFolder />
										<span className="cwd-name">{d.name}</span>
									</button>
									<button
										type="button"
										className="cwd-choose-btn"
										title={t("cwdChoose")}
										onClick={() => commit(d.path)}
									>
										{t("cwdChoose")}
									</button>
								</div>
							))}
						</div>
						<div className="cwd-picker-foot">
							{showNew ? (
								<div className="cwd-newrow">
									<input
										ref={newInputRef}
										value={newName}
										autoFocus
										spellCheck={false}
										placeholder={t("cwdNewName")}
										onChange={(e) => setNewName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && !e.nativeEvent.isComposing) {
												e.preventDefault();
												createFolder();
											} else if (e.key === "Escape") {
												e.stopPropagation();
												setShowNew(false);
												setNewName("");
											}
										}}
									/>
									<button type="button" className="cwd-choose-btn primary" onClick={createFolder}>
										{t("cwdCreate")}
									</button>
									<button
										type="button"
										className="cwd-choose-btn"
										onClick={() => {
											setShowNew(false);
											setNewName("");
										}}
									>
										{t("cwdCancel")}
									</button>
								</div>
							) : (
								<button type="button" className="cwd-newbtn" onClick={() => setShowNew(true)}>
									＋ {t("cwdNewFolder")}
								</button>
							)}
						</div>
					</div>
				</>
			) : (
				<button
					type="button"
					className="status-item status-cwd"
					title={t("cwdTip", { path: state.cwd })}
					onClick={startEdit}
				>
					📁 {state.cwd}
				</button>
			)}
		</footer>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

function formatCost(cost: number): string {
	if (cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}
