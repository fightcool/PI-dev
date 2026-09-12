/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ModelThinking.tsx（余额 chip）, components/FooterBar.tsx（用量面板里的渠道账户区）,
 *            server/dev-con/channel-state.ts（channel_state.accounts 的快照键 = accountRef || channel.id）
 *   📖 docs/DEV-CON-PROPOSAL.md §7（余额与用量分开、不猜测）
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
 * 余额的「人话」表达：有余额就给数值；拿不到余额就说「未知」——**绝不把接口字段名、HTTP 状态、
 * 控制台令牌这些开发者语言摆到用户面前**（那些放点击后的详情里）。
 */
export function balanceTextOf(account: UiAccountStatus | undefined, t: (k: string) => string): string {
	const raw = account?.balance ?? account?.quota?.remaining;
	if (raw === undefined) return t("channelAccountUnknownBalance");
	const num = Number.isInteger(raw) ? String(raw) : raw.toFixed(2);
	return account?.unit ? `${num} ${account.unit}` : num;
}

/** 该账户快照给得出「已用」时的可读文本（没有则 null）。 */
export function usedTextOf(account: UiAccountStatus | undefined): string | null {
	const used = account?.quota?.used;
	if (used === undefined) return null;
	const num = Number.isInteger(used) ? String(used) : used.toFixed(2);
	return account?.unit ? `${num} ${account.unit}` : num;
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
