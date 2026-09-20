/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/ModelChannelPicker.tsx（渠道分组的模型行 + 切捛器过滤 + 绑定是否可用）,
 *            components/ChannelModelWhitelist.tsx（勾选白名单）,
 *            components/ChannelSettings.tsx（默认模型下拉 / 白名单摘要）,
 *            server/dev-con/channel-model.ts（validateSelection 的白名单口径 + bindingCoversModel）
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道 = 服务商+端点+凭据+模型白名单）、§6（编码界面与选择器）
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

/**
 * 渠道**切捛器**里应该列出的渠道（设置页/用量面板不用这个）。
 *
 * @WHY 停用是用户**自己的决定**（在渠道设置里关掉的），他既然关了就不该在切捛器里再看到它，
 *   也不需要在那里再被解释一次。而 `providerMissing` / `keyMissing` 是**需要他去修的问题**，
 *   那类渠道必须保留并把原因写出来 —— 默默消失会让人以为渠道被删了（见 ChannelGroup 的 reason）。
 * @CONTRACT 只过滤「切捛器」（ModelChannelPicker 的模型列表）。设置页要能重新启用它、
 *   用量面板要能统计它、状态 chip 要能说出当前绑定 —— 那些地方一律拿**全部**渠道。
 * @GOTCHA `enabled` 缺失（老快照/测试夹具）按**启用**处理：缺字段绝不藏东西（同一口径见 channelAllowsModel）。
 */
export function switcherChannels(channels: UiChannelInfo[]): UiChannelInfo[] {
	return channels.filter((c) => c.enabled !== false);
}

/**
 * 没有对话绑定时，用「Agent 实际生效的模型」反推它属于哪个渠道。
 *
 * @WHY 渠道绑定是按对话存的（channels.json 的 bindings 以 conversationId 为 key）。
 *   新建对话还没有绑定，binding.effective 为 null，但输入区 chip 上已经显示着模型名 ——
 *   只看 binding 的话，用户看到的就是「有模型却一个高亮都没有」。
 * @CONTRACT 只在**命中唯一渠道**时返回它；同一模型可能出现在多个渠道下（不同服务商配了
 *   同名模型，或多个渠道指向同一服务商），那种情况返回 null —— 宁可不高亮，
 *   也不能把用户没选的渠道标成「正在使用」。
 */
export function inferChannelIdByModel(
	channels: Pick<UiChannelInfo, "id" | "providerId" | "models">[],
	models: ModelInfo[],
	activeModelId: string | null | undefined,
): string | null {
	if (!activeModelId) return null;
	const hits = channels.filter((c) => channelModels(models, c).some((m) => m.id === activeModelId));
	return hits.length === 1 ? hits[0].id : null;
}

/**
 * 这条对话绑定是否还描述 Agent 当下在用的模型（与 server/dev-con/channel-model.ts 的
 * bindingCoversModel 同一口径：服务商 + 白名单，不是「模型 id 相等」）。
 *
 * @WHY 绑定里的 modelId 是「选择那一刻」的快照，而模型还能被渠道以外的路径换掉
 *   （channel_state 还没到的 set_model、cycle_model、项目默认模型、扩展）。服务端会在快照构造时
 *   对账并清掉这类绑定，但界面不能只指望对面：拿旧绑定当「正在使用」，用户看到的就是
 *   「明明在跑 deepseek，却显示 UU apiClaude · claude-opus-5」。两边同口径就没人说谎。
 * @CONTRACT 实际模型未知（null/undefined）时一律返回 true：缺信息不判负，宁可保留绑定，
 *   也不要在拿不到模型时把用户显式选的渠道从界面上抹掉。
 * @GOTCHA 模型 id 可能不止一个斜杠 —— 用 bareModelId 剥前缀（见文件头 @GOTCHA）。
 */
export function bindingCoversActiveModel(
	channel: Pick<UiChannelInfo, "providerId" | "models"> | null | undefined,
	binding: { channelId?: string | null; modelId?: string | null } | null | undefined,
	activeModelId: string | null | undefined,
): boolean {
	if (!activeModelId) return true;
	if (!binding?.channelId) return false;
	if (!channel) return false;
	const provider = activeModelId.split("/")[0] || "";
	if (provider && channel.providerId !== provider) return false;
	const whitelist = channel.models ?? [];
	return whitelist.length === 0 || whitelist.includes(bareModelId(activeModelId));
}
