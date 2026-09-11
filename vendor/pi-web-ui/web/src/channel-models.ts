/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ModelChannelPicker.tsx（渠道分组的模型行）,
 *            components/ChannelModelWhitelist.tsx（勾选白名单）,
 *            components/ChannelSettings.tsx（默认模型下拉 / 白名单摘要）,
 *            server/dev-con/channel-model.ts（validateSelection 的白名单口径）
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道 = 服务商+端点+凭据+模型白名单）
 *   @CONTRACT 纯函数，无 React / 无 IO。白名单按**服务商内部 id** 匹配（"deepseek-flash"），
 *             模型目录里的 id 是 "provider/deepseek-flash"；空白名单 = 不限（列出全部）。
 *   @GOTCHA 模型 id 可能不止一个斜杠（"openrouter/vendor/model"）——只剥掉**第一个** provider
 *           前缀，用 slice(1).join("/") 而不是 split("/")[1]，否则白名单永远匹配不上。
 *   @GOTCHA 服务端 channel_state 里的 models 可能是 undefined（老快照/测试夹具），
 *           这里一律按「不限」处理，绝不因为缺字段就把模型全藏起来。
 * ──────────────────────────────────────────────────
 */
import type { ModelInfo, UiChannelInfo } from "./types";

/** 渠道白名单里的 id（provider 内部 id，例如 "deepseek-flash"）。 */
export function bareModelId(modelId: string): string {
	if (!modelId) return "";
	return modelId.split("/").slice(1).join("/") || modelId;
}

/** 该渠道是否允许这个模型（空白名单 = 不限）。 */
export function channelAllowsModel(channel: Pick<UiChannelInfo, "models"> | null | undefined, modelId: string): boolean {
	const whitelist = channel?.models ?? [];
	return whitelist.length === 0 || whitelist.includes(bareModelId(modelId));
}

/** 渠道可选的模型：先按服务商过滤，再按白名单过滤，最后按搜索词过滤。 */
export function channelModels(
	models: ModelInfo[],
	channel: Pick<UiChannelInfo, "providerId" | "models">,
	filter = "",
): ModelInfo[] {
	const q = filter.trim().toLowerCase();
	return models.filter(
		(m) =>
			m.provider === channel.providerId &&
			channelAllowsModel(channel, m.id) &&
			(!q || m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)),
	);
}

/** 白名单是否真的在限制（非空 = 限制）。 */
export function hasModelWhitelist(channel: Pick<UiChannelInfo, "models"> | null | undefined): boolean {
	return (channel?.models ?? []).length > 0;
}
