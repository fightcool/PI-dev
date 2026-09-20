/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/UsageDetail.tsx (令牌项点开的用量/归属面板), use-chat.ts (channelState / state.channelBinding)
 *   @COUPLED components/DirectoryPicker.tsx（工作目录选择器：浏览/新建/选定的唯一实现，
 *            左栏「＋ 新建项目」共用同一组件，行为不允许分叉）
 *   📖 docs/DEV-CON-PROPOSAL.md §6（状态栏：当前渠道/模型 + 用量）, §7（渠道归属）
 *   @CONTRACT 底栏只显示「有效」渠道与待生效标记；待生效不等于已生效，两者必须能同时看到。
 *   @GOTCHA 令牌项是按钮（点开明细），不要再把整行当成纯文本。
 * ──────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import type { UiChannelBinding } from "../types";
import type { ChatState , UsageHistoryMsg, UsageHistoryWindow } from "../use-chat";
import { useT } from "../i18n";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";
import { UsageDetail, formatTokens } from "./UsageDetail";
import { channelAccountView } from "../channel-account";
import { bindingCoversActiveModel } from "../channel-models";
import { DirectoryPicker } from "./DirectoryPicker";

interface FooterBarProps {
	chat: ChatState;
	/** P4：用量历史查询（只读）；未提供时用量详情不显示历史区。 */
	onQueryUsageHistory?: (groupBy: UsageHistoryMsg["groupBy"], window: UsageHistoryWindow) => number;
	/** 手动重试该渠道的余额查询（连续失败后自动刷新停止，重试恢复）。 */
	onRetryAccount?: (channelId: string) => void;
	/** 用量明细面板开合（提到 App 层：输入框工具条的「渠道余额」chip 也会打开它）。 */
	usageOpen?: boolean;
	onUsageOpenChange?: (open: boolean) => void;
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
export function FooterBar({ chat, send, onQueryUsageHistory, usageOpen: usageOpenProp, onUsageOpenChange, onRetryAccount }: FooterBarProps) {
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
	const run = s.tokens.run ?? s.tokens;
	const request = s.tokens.request ?? s.tokens;

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

	// -- DEV-CON 渠道账户：chip 与用量面板共用同一份派生（见 channel-account.ts）。
	const accountView = channelAccountView({
		channels: chat.channelState?.channels ?? [],
		accounts: chat.channelState?.accounts ?? [],
		binding: state.channelBinding,
		modelProvider: state.model?.provider ?? null,
	});

	// -- DEV-CON 渠道：只显示有效绑定（与待生效标记分开），名字从 channel_state 解析。
	// 绑定要与**实际在跑的模型**对得上才算生效（同口径见 channel-models.ts 的
	// bindingCoversActiveModel）：模型被渠道以外的路径换掉后，旧绑定不得继续冒充当前渠道。
	const channels = chat.channelState?.channels ?? [];
	const channelBinding = state.channelBinding ?? null;
	const storedBinding = channelBinding?.effective ?? null;
	const effectiveBinding =
		storedBinding &&
		bindingCoversActiveModel(
			channels.find((c) => c.id === storedBinding.channelId),
			storedBinding,
			state.model ? `${state.model.provider}/${state.model.id}` : null,
		)
			? storedBinding
			: null;
	const pendingBinding = channelBinding?.pending ?? null;
	const channelName = (sel: UiChannelBinding): string =>
		channels.find((c) => c.id === sel.channelId)?.displayName ?? sel.channelName ?? sel.channelId;

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

			{effectiveBinding && (
				<>
					<span
						className="status-item status-channel"
						title={t("channelFooterTip", { sel: `${channelName(effectiveBinding)} · ${effectiveBinding.modelId}` })}
					>
						{t("channelFooter")} {channelName(effectiveBinding)}
						{channelBinding?.source === "project" && (
							<span className="status-channel-src">{t("channelSourceProject")}</span>
						)}
						{channelBinding?.source === "instance" && (
							<span className="status-channel-src">{t("channelSourceInstance")}</span>
						)}
					</span>
					<span className="status-sep">·</span>
				</>
			)}
			{pendingBinding && (
				<>
					<span className="status-item status-channel-pending" title={t("channelPendingTip")}>
						⏳ {channelName(pendingBinding)} · {t("channelPendingBadge")}
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

			<button
				type="button"
				className={`status-item status-tokens${usageOpen ? " active" : ""}`}
				title={t("usageDetailTip")}
				onClick={() => setUsageOpen(!usageOpen)}
			>
				{t("tokensShort")} I/O/T {formatTokens(s.tokens.input)} / {formatTokens(s.tokens.output)} /{" "}
				{formatTokens(s.tokens.total)} · R {formatTokens(request.total)} · Run {formatTokens(run.total)}
			</button>
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

			{usageOpen && (
				<>
					<div className="status-cwd-backdrop" onClick={() => setUsageOpen(false)} />
					<UsageDetail
						tokens={s.tokens}
						cost={s.cost}
						attribution={s.attribution}
						recentRequests={s.recentRequests}
						usageHistory={chat.usageHistory}
						onQueryUsageHistory={onQueryUsageHistory}
						runId={s.runId}
						channels={channels}
						accountView={accountView}
						onRetryAccount={onRetryAccount}
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
