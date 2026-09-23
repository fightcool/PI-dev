/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/UsageDetail.tsx (令牌项点开的用量/归属面板), use-chat.ts (state.gatewayUsage)
 *   @COUPLED components/GatewayUsageBlock.tsx（网关自报用量的展示口径，唯一实现）,
 *            web/src/gateway-usage.ts（金额格式与「这份读数属于哪个网关」的判定）
 *   @COUPLED components/JevFooterItem.tsx（缓存命中项之后的 Jev 门禁项：最简结论 + 点开浮层，
 *            浮层外壳与关闭行为与 UsageDetail 同口径）, jev-footer.ts（最近结论的推断）
 *   @COUPLED components/DirectoryPicker.tsx（工作目录选择器：浏览/新建/选定的唯一实现，
 *            左栏「＋ 新建项目」共用同一组件，行为不允许分叉）
 *   📖 docs/NEWAPI-GATEWAY.md §4（状态栏的网关项显示什么、为什么可能什么都不显示）
 *   @CONTRACT 网关项只在**有读数**时出现：读取失败、或该服务商没有账单接口时不占位 ——
 *             状态栏是常驻监视器，一个永远红着的项只会让人学会忽略它（原因在用量面板里说）。
 *   @GOTCHA 令牌项与网关项都是按钮（点开明细），不要再把整行当成纯文本。
 *   @GOTCHA Jev 项与用量面板都是 <footer> 的 position:fixed 子节点：整块 display:none 会连它们
 *            一起藏掉（见下面 statusbar 不参与收起的 @WHY）。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import type { ChatState, OpsApi } from "../use-chat";
import { useT } from "../i18n";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";
import { UsageDetail, formatTokens } from "./UsageDetail";
import { JevFooterItem } from "./JevFooterItem";
import { gatewayUsageFacts } from "../gateway-usage";
import { DirectoryPicker } from "./DirectoryPicker";

interface FooterBarProps {
	chat: ChatState;
	/** P4 运维 / 网关的只读查询（用量历史、网关用量）。 */
	opsApi: OpsApi;
	/** 用量明细面板开合（App 层受控）。 */
	usageOpen?: boolean;
	onUsageOpenChange?: (open: boolean) => void;
	/** 打开设置面板（App 注入 dialogs.setSettingsOpen）；Jev 浮层的「设置」入口用。 */
	onOpenSettings?: () => void;
	send: (
		msg:
			{ type: "complete_path"; path: string } | { type: "set_cwd"; path: string } | { type: "make_dir"; path: string },
	) => boolean;
}

/**
 * Compact status bar: connection, context usage, cost, session, queue, and the
 * workspace path — click the path to open a directory picker (browse into
 * folders, go up, create folders, or pick one as the working directory).
 */
export function FooterBar({ chat, opsApi, send, usageOpen: usageOpenProp, onUsageOpenChange, onOpenSettings }: FooterBarProps) {
	const t = useT();
	const state = chat.state;
	const [editing, setEditing] = useState(false);
	/** 用量明细面板：受控（App 层）——未传时回落为组件内状态，保证旧调用点行为不变。 */
	const [usageOpenLocal, setUsageOpenLocal] = useState(false);
	const usageOpen = usageOpenProp ?? usageOpenLocal;
	const setUsageOpen = onUsageOpenChange ?? setUsageOpenLocal;

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

	/** 服务商展示名（models.json 的 name）：归属表用它把 providerId 显示成人看得懂的名字。 */
	const providerNames = Object.fromEntries(
		chat.modelsConfig.filter((p) => p.name).map((p) => [p.providerId, p.name as string]),
	);

	// -- 网关自报用量：状态栏只显示**读数**（有数字才占位），失败与「不是网关」的原因在面板里说。
	const gatewayFacts = gatewayUsageFacts(chat.gatewayUsage.usage);
	const gatewayCurrent = chat.gatewayUsage.ok === true && gatewayFacts !== null;
	/** 状态栏文本：有额度就「已用 / 额度」，只有已用（不限额度或网关没报）就只写已用。 */
	const gatewayText =
		gatewayFacts === null
			? ""
			: gatewayFacts.limitText
				? `${gatewayFacts.usedText} / ${gatewayFacts.limitText}`
				: `${gatewayFacts.usedText}`;

	// -- 机器负载芯片：来源是 use-chat 的 5 秒轮询（chat.resources），与设置→系统同一份快照。
	const loadRes = chat.resources?.ok ? (chat.resources.snapshot ?? null) : null;
	const loadGib = (n: number | null) => (n === null ? "—" : `${(n / 1024 ** 3).toFixed(1)}G`);
	const loadMemWarn =
		loadRes !== null && loadRes.host.mem.totalBytes > 0 && loadRes.host.mem.usedBytes / loadRes.host.mem.totalBytes >= 0.85;

	const startEdit = () => {
		setEditing(true);
	};

	/**
	 * Status bar 不参与「底部控件自动收缩」（web/src/chrome-collapse.ts）。
	 *
	 * @WHY 这一条窄栏显示的是**即时监控**（连接/渠道、上下文占用、缓存命中率、实时速率），
	 *   输出刷屏或翻历史时正是用户盯着这些数字的时候，跟着收起等于把仪表盘关掉；而它本身
	 *   只占一行（~26px），收起省下的空间与代价不成比例。目标条与输入工具条照旧参与收起。
	 * @GOTCHA 用量详情面板是本组件的子节点（position:fixed）：即使以后再加收起逻辑，也不能
	 *   对 .statusbar 整块 display:none，否则会把那个浮层一起藏掉（旧实现因此只隐藏内部状态项）。
	 */
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

			{gatewayCurrent && (
				<>
					<button
						type="button"
						className={`status-item status-gateway status-item-clickable${usageOpen ? " active" : ""}`}
						title={`${t("gatewayUsageTitle")}\n${gatewayText}\n${t("gatewayChipTip")}`}
						onClick={() => {
							// 点开 = 既要看明细，也要拿最新数字（网关账单本身滞后几秒，见文档 §4）。
							opsApi.queryGatewayUsage(chat.gatewayUsage.usage?.providerId, true);
							setUsageOpen(true);
						}}
					>
						{t("gatewayChip")} <b>{gatewayText}</b>
					</button>
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

			{/* 机器负载：与设置→系统同一份快照（use-chat 每 5 秒轮询）。有读数才占位（同网关项契约）；
			    cpuPercent 首次采样为 null → 先显示「—」，下一轮（≤5s）补上。 */}
			{loadRes && (
				<>
					<span
						className="status-item status-load"
						title={`${t("loadTip")}\nload 1/5/15m: ${loadRes.host.loadAvg.map((v) => v.toFixed(2)).join(" / ")}\ncgroup: ${loadGib(loadRes.app.cgroup.currentBytes)}${
							loadRes.app.cgroup.maxBytes === null ? "" : ` / ${loadGib(loadRes.app.cgroup.maxBytes)}`
						}\n${new Date(loadRes.at).toLocaleTimeString()}`}
					>
						{t("loadCpu")}{" "}
						<b className={loadRes.host.cpuPercent !== null && loadRes.host.cpuPercent >= 80 ? "cache-pct warn" : undefined}>
							{loadRes.host.cpuPercent === null ? "—" : `${Math.round(loadRes.host.cpuPercent)}%`}
						</b>{" "}
						· {t("loadMem")}{" "}
						<b className={loadMemWarn ? "cache-pct warn" : undefined}>
							{loadGib(loadRes.host.mem.usedBytes)} / {loadGib(loadRes.host.mem.totalBytes)}
						</b>
					</span>
					<span className="status-sep">·</span>
				</>
			)}

			<button
				type="button"
				className={`status-item status-cache status-item-clickable${usageOpen ? " active" : ""}`}
				title={`${t("usageDetailTip")}\n${t("cacheHitTip", {
					read: formatTokens(cache.read),
					write: formatTokens(cache.write),
					miss: formatTokens(cache.miss),
					input: formatTokens(cache.totalInput),
				})}`}
				onClick={() => setUsageOpen(!usageOpen)}
			>
				{t("cacheHit")}
				<b className={`cache-pct ${hitClass}`}>{hitText}</b>
			</button>
			<span className="status-sep">·</span>

			{/* decision = 客户端手里最近一次真实决策回包（面板「测试连接」）；推送的运行态不带理由，见 JevFooterItem 头部 @GOTCHA。 */}
			<JevFooterItem
				status={chat.jev.status}
				decision={chat.jev.probe?.decision ?? null}
				onOpenSettings={onOpenSettings}
			/>

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

			{usageOpen && (
				<>
					<div className="status-cwd-backdrop" onClick={() => setUsageOpen(false)} />
					<UsageDetail
						tokens={s.tokens}
						cost={s.cost}
						attribution={s.attribution}
						recentRequests={s.recentRequests}
						usageHistory={chat.usageHistory}
						onQueryUsageHistory={opsApi.queryUsageHistory}
						runId={s.runId}
						gatewayUsage={chat.gatewayUsage}
						activeProvider={state.model?.provider ?? null}
						providerNames={providerNames}
						onRefreshGatewayUsage={() => opsApi.queryGatewayUsage(undefined, true)}
					/>
				</>
			)}

			{editing ? (
				<DirectoryPicker
					cwd={state.cwd}
					completions={chat.pathCompletions}
					send={send}
					onClose={() => setEditing(false)}
				/>
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
