/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/JevFooterItem.tsx（底栏浮层：到期徽标 + 这一节）,
 *            components/JevSettings.tsx（设置面板：留痕开关下方的同一组事实 + 导出命令）,
 *            components/copy-button.tsx（复制交互直接复用，不引入新依赖）,
 *            server/protocol.ts（UiJevReviewStatus 的形状来源）,
 *            server/dev-con/jev-review.ts（40 条 / 7 天与「导出语料」的权威口径）
 *   @CONTRACT 只读展示服务端给的事实：pending / due / 条数 / 时间 / 阈值一律读回包，
 *             客户端**不自己算**（到期判定在服务端，两处算必然漂移）。
 *   @GOTCHA 旧服务端没有 runtime.review：判空由调用方做（本文件只接受已判空的对象）；
 *             阈值字段缺了就**不渲染**触发条件那一行，也不写死 40 / 7 —— 那是服务端常量
 *             （JEV_REVIEW_MIN_ENTRIES / JEV_REVIEW_MAX_AGE_MS），写死等于多一个事实源。
 *   @WHY 两条命令必须是可复制的 `<code>`：导出语料**只有** CLI 一条路（协议里没有「把样本内容
 *        上行」的消息，这是有意的——被审内容不上行）。导出与 ack 必须成对给出：只给导出，
 *        人会导完忘了确认，然后天天被提醒。
 * ──────────────────────────────────────────────────
 */
import { useT } from "../i18n";
import type { UiJevReviewStatus } from "../types";
import { CopyButton } from "./copy-button";

/**
 * 复盘命令（原样可复制；`npm run jev` 是仓库根的入口，见根 package.json）。
 * @GOTCHA 这两条字符串是 CLI 契约的一部分（scripts/jev-gate.ts）：`review` 退出码 0=到期 / 1=未到期；
 *   `ack` 只推进水位线，不删样本。
 */
export const JEV_REVIEW_EXPORT_CMD = "npm run jev -- review export --since 7d > corpus.week.jsonl";
export const JEV_REVIEW_ACK_CMD = "npm run jev -- review ack";

/** @MAGIC 一天的毫秒数：把 maxAgeMs 说成「天」（阈值是 7 天，不显示成 604800000）。 */
const DAY_MS = 24 * 60 * 60_000;

/**
 * 复盘事实：待复盘条数 / 其中转人工条数 / 最老一条时间 / 触发条件 + 两条命令。
 * @CONTRACT 标题由调用方渲染（底栏浮层与设置面板的标题层级不同），本组件只出事实与命令。
 */
export function JevReviewSection({ review }: { review: UiJevReviewStatus }) {
	const t = useT();
	const pending = review.pending ?? 0;
	const needsHuman = review.needsHumanLabel ?? 0;
	const thresholds = review.thresholds;
	// 阈值可能是旧 payload 里没有的字段：没有就不写这一行（见文件头 @GOTCHA）。
	const days = thresholds ? Math.round(thresholds.maxAgeMs / DAY_MS) : null;
	return (
		<>
			<div className="jev-verdicts jev-review-facts">
				<span>{t("footerJevReviewPending", { pending })}</span>
				{needsHuman > 0 && <span>{t("footerJevReviewNeedsHuman", { needsHuman })}</span>}
				{typeof review.oldestPendingAt === "number" && (
					<span>
						{t("footerJevReviewOldest")} {new Date(review.oldestPendingAt).toLocaleString()}
					</span>
				)}
			</div>
			{thresholds && days !== null && (
				<p className="set-hint">{t("footerJevReviewRule", { entries: thresholds.minEntries, days })}</p>
			)}
			<JevReviewCommands />
		</>
	);
}

/** 导出语料 / 导出后确认：两条命令各带一个复制按钮（复用 Markdown 与设置页同一个 CopyButton）。 */
export function JevReviewCommands() {
	const t = useT();
	return (
		<>
			<p className="set-hint">{t("footerJevReviewExportHint")}</p>
			<JevReviewCommand command={JEV_REVIEW_EXPORT_CMD} />
			<p className="set-hint">{t("footerJevReviewAckHint")}</p>
			<JevReviewCommand command={JEV_REVIEW_ACK_CMD} />
		</>
	);
}

/** 一行命令 + 复制按钮（.jev-review-cmd 自带 position:relative，给绝对定位的 .copy-btn 当锚点）。 */
function JevReviewCommand({ command }: { command: string }) {
	return (
		<div className="jev-review-cmd">
			<code>{command}</code>
			<CopyButton text={command} />
		</div>
	);
}
