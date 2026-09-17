/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ModelThinking.tsx（余额 chip）, components/FooterBar.tsx（用量面板里的渠道账户区）,
 *            components/ChannelRow.tsx（设置页状态行，同用 accountStateView）,
 *            server/dev-con/channel-state.ts（channel_state.accounts 的快照键 = accountRef || channel.id）
 *   📖 docs/DEV-CON-PROPOSAL.md §7（余额与用量分开、不猜测）
 *   @BUGFIX 2026-09-14：`stale` 有两种含义（数据超过 TTL 没刷新 / 最近一次查询失败），以前共用
 *            一个「已过期」标签 —— 渠道明明在正常说话，用户却被一个报警式的红字追着问。现在按
 *            staleReason 分开：ttl 说「待刷新」（中性色），failed 才说「已过期」（警示色 + 重试）。
 *   @BUGFIX 2026-09-17：设置页渠道行把 `status.balance` / `q.remaining` 原始数字直接插进字符串，
 *            而 chip 与用量详情走 balanceTextOf/usedTextOf（两位小数）—— 同一个数字出现两套精度
 *            （`45.43301698` vs `45.43`）。现在**全局只有 {@link formatAmount} 一个金额口径**，
 *            三处都从它出数。同一次修复：那一行的「Used」标签实际显示的是 `remaining ?? limit ?? used`
 *            （标签说已用、值给剩余，还会和余额显示成同一个数）—— 已用与剩余现在各占一格，取不到就不显示。
 *   @CONTRACT 只读派生：把「当前对话在用哪个渠道」+「该渠道的账户状态」算成一处，供 chip 与详情面板共用，
 *             避免两处各写一遍（口径漂移会让 chip 与详情对不上，用户更懵）。
 *   @WHY 没有绑定时按当前模型的服务商匹配唯一渠道：clientId 在 sessionStorage（每标签页独立），
 *        重开标签页就丢绑定，但会话里的模型还在 —— 不给回退的话用户「明明在用这个渠道」却看不到任何账户信息。
 * ────────────────────────────────────────────────────────────────────────── */
import type { UiAccountStatus, UiChannelBindingView, UiChannelInfo } from "./types";

/** 渠道配的账户查询方式（kind 非空 = 配了）；未配则不展示任何账户信息。 */
export function accountKindOf(channel: UiChannelInfo | null | undefined): string {
	const account = channel?.account as { kind?: unknown } | null | undefined;
	return account && typeof account.kind === "string" ? account.kind : "";
}

export interface ChannelAccountView {
	/** 当前对话实际对应的渠道（绑定优先，其次是按模型服务商匹配到的唯一渠道）。 */
	channel: UiChannelInfo | null;
	/** 该渠道的账户快照（服务端 AccountRegistry；未查询过时为 undefined）。 */
	account: UiAccountStatus | undefined;
	/** true = 该对话没有渠道绑定，渠道是按当前模型的服务商匹配来的（详情里要如实说明）。 */
	derived: boolean;
}

/**
 * 当前对话对应的渠道 + 账户状态。
 * @CONTRACT 渠道优先取有效绑定；没有绑定时只在「该服务商恰有一个启用的、配了账户查询的渠道」时回退，
 *   候选多于一个返回 null（多义不猜）。
 */
export function channelAccountView(input: {
	channels: UiChannelInfo[];
	accounts: UiAccountStatus[];
	binding: UiChannelBindingView | null | undefined;
	modelProvider: string | null | undefined;
}): ChannelAccountView {
	const { channels, accounts, binding, modelProvider } = input;
	const bound = binding?.effective?.channelId ? (channels.find((c) => c.id === binding.effective?.channelId) ?? null) : null;
	const derived =
		bound || !modelProvider
			? null
			: (() => {
					const candidates = channels.filter((c) => c.providerId === modelProvider && c.enabled && accountKindOf(c) !== "");
					return candidates.length === 1 ? candidates[0] : null;
				})();
	const channel = bound ?? (derived as UiChannelInfo | null);
	if (!channel || accountKindOf(channel) === "") return { channel: null, account: undefined, derived: false };
	return {
		channel,
		account: accounts.find((a) => a.accountRef === (channel.accountRef || channel.id)),
		derived: !bound && !!derived,
	};
}

/**
 * **全局唯一的金额口径**：余额 chip、设置页渠道行、用量详情三处的每一个金额都必须过这里。
 * @CONTRACT
 *   - 取不到值（undefined / 非有限数）→ 返回空串，**由调用方决定说「未知」还是这一格不显示**
 *     （这个函数不认识文案，也不该替调用方编「0」出来）；
 *   - 整数不带小数点（`47` → `47`，账户接口给整数额度时别写成 `47.00`）；
 *   - 其余保留 2 位（`45.43301698` → `45.43`）；
 *   - 绝对值落在 (0, 0.005) 的极小值不写成 `0.00`：正数给 `<0.01`，负数给 `>-0.01`。
 *     @WHY `0.00` 会被读成「没钱了 / 没用量」，而 `-0.00` 更是既不像零也不像欠费；说清「比一分钱还小」
 *     才是实话。负数本身（欠费、网关记账倒挂）照常显示（`-12.35`），不做绝对值抹平。
 *   - 给了 unit 就拼 `值 单位`；值为空时 unit 也不出现。
 * @MAGIC 0.005 = 2 位小数的进位边界：≥ 它 toFixed(2) 就不再是 0.00。
 */
export function formatAmount(value: number | undefined, unit?: string): string {
	if (value === undefined || !Number.isFinite(value)) return "";
	const num = Number.isInteger(value)
		? String(value)
		: value > 0 && value < 0.005
			? "<0.01"
			: value < 0 && value > -0.005
				? ">-0.01"
				: value.toFixed(2);
	return unit ? `${num} ${unit}` : num;
}

/**
 * 余额的「人话」表达：有余额就给数值；拿不到余额就说「未知」——**绝不把接口字段名、HTTP 状态、
 * 控制台令牌这些开发者语言摆到用户面前**（那些放点击后的详情里）。
 * @CONTRACT 数字口径复用 {@link formatAmount}（chip 与设置页行必须是同一个数字）。
 */
export function balanceTextOf(account: UiAccountStatus | undefined, t: (k: string) => string): string {
	const text = formatAmount(account?.balance ?? account?.quota?.remaining, account?.unit);
	return text || t("channelAccountUnknownBalance");
}

/** 该账户快照给得出「已用」时的可读文本（没有则 null）。数字口径同 {@link formatAmount}。 */
export function usedTextOf(account: UiAccountStatus | undefined): string | null {
	const quota = account?.quota;
	return formatAmount(quota?.used, quota?.unit || account?.unit) || null;
}

/**
 * 设置页渠道行的「格」文本（顺序即显示顺序；空数组 = 只显示状态标签）。
 * @CONTRACT
 *   - 抽成纯函数是为了能在 node 环境单测这一行的口径（组件只负责把它们用 ` · ` 串起来）；
 *   - 每一格的数字都走 {@link formatAmount}；
 *   - **已用与剩余是两格**：已用只认 `quota.used`，剩余只认 `quota.remaining`，
 *     取不到就不显示那一格 —— 绝不用 `limit` 或另一个字段顶替（旧代码写成
 *     `remaining ?? limit ?? used`，结果标签写「Used」显示的却是剩余，还和余额撞成同一个数）。
 */
export function accountStatusBits(status: UiAccountStatus | undefined, t: (k: string) => string): string[] {
	if (!status) return [];
	const bits: string[] = [];
	const balance = formatAmount(status.balance, status.unit);
	if (balance) bits.push(`${t("channelAccountBalance")} ${balance}`);
	// 配额自带单位时优先用它（额度与余额可能不同币种/不同计量），否则退回账户单位。
	const quota = status.quota;
	const quotaUnit = quota?.unit || status.unit;
	const used = formatAmount(quota?.used, quotaUnit);
	if (used) bits.push(`${t("channelAccountKeyQuota")} ${used}`);
	const remaining = formatAmount(quota?.remaining, quotaUnit);
	if (remaining) bits.push(`${t("channelAccountRemaining")} ${remaining}`);
	if (status.checkedAt !== undefined) bits.push(`${t("channelAccountCheckedAt")} ${new Date(status.checkedAt).toLocaleString()}`);
	const tipKey = accountStateView(status).tipKey;
	if (tipKey) bits.push(t(tipKey));
	return bits;
}

/**
 * 该渠道的充值页地址（服务端已解析好 {baseUrl} 占位并校验过 http(s)，这里只做二次防线）。
 * @WHY 用户点开余额就看到「去充值」，不用自己去找供应商控制台。
 */
export function topupUrlOf(channel: UiChannelInfo | null | undefined): string | null {
	const raw = (channel?.account as { topupUrl?: unknown } | null | undefined)?.topupUrl;
	if (typeof raw !== "string") return null;
	const url = raw.trim();
	return /^https?:\/\//i.test(url) ? url : null;
}

/** 余额自动刷新周期（默认值，不做配置项）。@MAGIC 比服务端缓存 TTL 短：先看到新数字，缓存只管兜底。 */
export const BALANCE_REFRESH_MS = 2 * 60_000;

/** 连续失败达到这个重试次数后**降级为慢速探测**（首次尝试不算重试）。 */
export const BALANCE_MAX_RETRIES = 3;

/**
 * 失败超限后的慢速探测间隔（每 10 分钟还试一次）。
 * @WHY 以前是「超过上限就彻底不再发请求，直到用户点重试」——但重试按钮只在 failed 时出现，
 *   一旦快照后来变成 stale，用户就永远卡在「已过期」且无路可走（这也是把一个查询恢复正常的
 *   渠道长期显示为过期的原因之一）。降级有界重试既不打爆供应商接口，又能自己恢复。
 */
export const BALANCE_DEGRADED_MS = 10 * 60_000;

/** 账户状态的呈现口径（标签键 + 语义档位 + 说明键）。 */
export interface AccountStateView {
	labelKey: "channelAccountOk" | "channelAccountStale" | "channelAccountStaleTtl" | "channelAccountFailed" | "channelAccountUnsupported" | "channelQuerying";
	/** ok = 正常；aging = 数据旧了（渠道没报错）；bad = 查询失败/不支持；unknown = 还没查过。 */
	tone: "ok" | "aging" | "bad" | "unknown";
	tipKey?: "channelAccountStaleTip" | "channelAccountStaleTtlTip";
}

/**
 * 账户快照 → 呈现口径（chip / 用量详情 / 设置页行共用，避免三处文案与颜色各写一遍）。
 * @CONTRACT
 *   - `stale + staleReason:"ttl"` = 只是数字旧了（服务端缓存过了 TTL，渠道本身没报错）→「待刷新」；
 *   - `stale + staleReason:"failed"`（或旧服务端没有 staleReason）= 上次查询失败了 →「已过期」。
 */
export function accountStateView(status: UiAccountStatus | undefined): AccountStateView {
	if (!status) return { labelKey: "channelQuerying", tone: "unknown" };
	switch (status.status) {
		case "ok":
			return { labelKey: "channelAccountOk", tone: "ok" };
		case "stale":
			return status.staleReason === "ttl"
				? { labelKey: "channelAccountStaleTtl", tone: "aging", tipKey: "channelAccountStaleTtlTip" }
				: { labelKey: "channelAccountStale", tone: "bad", tipKey: "channelAccountStaleTip" };
		case "failed":
			return { labelKey: "channelAccountFailed", tone: "bad" };
		default:
			return { labelKey: "channelAccountUnsupported", tone: "bad" };
	}
}

/** 该快照是不是「最近一次查询失败」（自动刷新的失败计数与重试入口都看它）。 */
export function isAccountQueryFailed(status: UiAccountStatus | undefined): boolean {
	if (!status) return false;
	return status.status === "failed" || (status.status === "stale" && status.staleReason !== "ttl");
}

/**
 * 每个渠道的连续失败次数（模块级：调度器与「重试」按钮都要读写同一份计数）。
 * @WHY 连续失败（供应商接口挂了/没有查询能力）时不该无限重试打人家接口，也不该永远不恢复 ——
 *   计数放在这里，用户点一次「重试」就清零，自动刷新随即恢复。
 */
const failuresByChannel = new Map<string, number>();

/** 当前连续失败次数（测试与 UI 用）。 */
export function balanceFailuresOf(channelId: string): number {
	return failuresByChannel.get(channelId) ?? 0;
}

/** 手动重试：清零失败计数（自动刷新恢复可用）。 */
export function resetBalanceFailures(channelId: string): void {
	failuresByChannel.delete(channelId);
}

/**
 * 余额自动刷新的调度（抽出来是为了能用假时钟精确单测「多久刷一次 / 失败几次就停」）。
 * @CONTRACT
 *   - 立即查一次；之后每 intervalMs 一次；后台标签页不查；回到前台时若上次数据已超过一个
 *     周期则补一次。
 *   - 上一次结果是 failed 就累加失败计数，连续失败超过 {@link BALANCE_MAX_RETRIES} 次后
 *     **停止发起查询**（定时器还在，但没有请求；用户点「重试」清零即恢复）。
 *   - 返回停止函数（组件卸载/切换渠道时调用）。
 */
export function startBalanceRefresh(opts: {
	/** 该渠道的 id（失败计数按渠道分开记）。 */
	channelId: string;
	/** 发一次账户查询（服务端有 10 秒限频 + 5 分钟缓存兜底）。 */
	query: () => void;
	/** 上一次查询的状态（来自服务端账户快照）；undefined = 还没有结果。 */
	statusOf?: () => "ok" | "failed" | "stale" | "unsupported" | undefined;
	/** 上一次查询是不是「失败了」（stale 里只有 failed 那种才算；服务端 staleReason 口径）。 */
	queryFailedOf?: () => boolean;
	/** 上次成功查询的时间（来自服务端快照 checkedAt）；0 = 还没有数据。 */
	lastCheckedAt?: () => number;
	/** 页面是否在后台（默认读 document.hidden）。 */
	isHidden?: () => boolean;
	now?: () => number;
	intervalMs?: number;
	maxRetries?: number;
}): () => void {
	const intervalMs = opts.intervalMs ?? BALANCE_REFRESH_MS;
	const maxRetries = opts.maxRetries ?? BALANCE_MAX_RETRIES;
	const isHidden = opts.isHidden ?? (() => typeof document !== "undefined" && document.hidden);
	const now = opts.now ?? (() => Date.now());
	const lastAttemptAt = { value: 0 };
	const attempt = () => {
		// 先看上一次的结果：失败累加，成功后清零（失败计数只关心「连续」失败）。
		// @GOTCHA 失败在服务端会被记成 stale（保留上次余额），只看 status==="failed" 会漏掉全部
		//   「有余额的渠道查询失败」——计数永远碰不到上限。所以由调用方给出 queryFailedOf。
		const failed = opts.queryFailedOf ? opts.queryFailedOf() : opts.statusOf?.() === "failed";
		const status = opts.statusOf?.();
		if (failed) failuresByChannel.set(opts.channelId, balanceFailuresOf(opts.channelId) + 1);
		else if (status !== undefined) failuresByChannel.set(opts.channelId, 0);
		// 连续失败超过上限 → 降级成慢速探测（不再按周期打接口，但会自己恢复）。
		if (balanceFailuresOf(opts.channelId) > maxRetries) {
			if (now() - lastAttemptAt.value < BALANCE_DEGRADED_MS) return;
		}
		lastAttemptAt.value = now();
		opts.query();
	};
	attempt();
	const timer = setInterval(() => {
		if (isHidden()) return;
		attempt();
	}, intervalMs);
	const onVisible = () => {
		if (isHidden()) return;
		const last = opts.lastCheckedAt?.() ?? 0;
		if (now() - last > intervalMs) attempt();
	};
	if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
	return () => {
		clearInterval(timer);
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
	};
}
