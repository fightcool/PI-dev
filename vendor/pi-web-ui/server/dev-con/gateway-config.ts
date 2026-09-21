/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../model-admin.ts（getGateway / saveGateway 用本模块解析并回写）,
 *            ../agent-service.ts（listModels 用 filterCatalogToProviders 收窄目录）,
 *            ../../web/src/components/GatewaySettings.tsx（界面按同一口径展示）,
 *            gateway-usage.ts（siteRootOf 复用：同一台网关的判定）
 *   📖 docs/NEWAPI-GATEWAY.md §2（单网关模型：谁算网关、重复接入怎么处理）
 *   @CONTRACT 纯逻辑：禁止 fs / 网络 / SDK 导入，便于 vitest 直接覆盖规格。
 *   @WHY 「服务商」在本实例里只是 models.json 的存储细节（SDK 需要 providers.<id> 这个结构），
 *        对用户只有一个东西：网关。所以这里集中回答两个问题 ——
 *         ① **谁**是网关（回写配置时要知道往哪写）；
 *         ② 还有谁指向**同一个地址**（重复接入：同一批模型在选择器里出现两次）。
 *        判定必须稳定可预测：界面显示的就是服务端写回的那个，不允许两处各推一次。
 * ──────────────────────────────────────────────────
 */
import type { UiGatewayDuplicate } from "../protocol.js";
import { siteRootOf } from "./gateway-usage.js";

/** 一个 models.json 服务商的最小事实（供解析用；不加载任何运行时）。 */
export interface ProviderFacts {
	providerId: string;
	name?: string;
	baseUrl?: string;
	modelCount: number;
}

/**
 * 解析「哪一个是网关」。
 *
 * 优先级（第一条命中即用）：
 *  1. 当前生效模型所属的服务商 —— 它就是正在被调用的那个入口，最没有歧义；
 *  2. 只有一个已配置服务商 —— 唯一接入的常态；
 *  3. 第一个已配置服务商（models.json 的键顺序，稳定）。
 * 一个都没有 → null（界面必须如实说「还没配网关」，而不是显示一个空壳）。
 */
export function resolveGatewayProviderId(input: {
	/** 已配置服务商 id（models.json 的键顺序）。 */
	providerIds: readonly string[];
	/** 当前生效模型所属服务商；null/缺省 = 未知或不是已配置服务商。 */
	activeProvider?: string | null;
}): string | null {
	const ids = input.providerIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) return null;
	const active = (input.activeProvider ?? "").trim();
	if (active && ids.includes(active)) return active;
	return ids[0];
}

/**
 * 与网关指向同一地址的**其它**服务商（重复接入）。
 * @WHY 旧的多渠道时代同一台网关常常被登记多次（不同协议/不同模型子集各一条），
 *   单网关接入后这些是纯冗余：同一批模型在选择器里出现两遍、用量归属分裂成两个 providerId。
 *   界面**只提示不自动删**（配置是用户的东西，删错了要能查）：本函数只负责识别。
 */
export function sameGatewayDuplicates(input: {
	gatewayId: string;
	gatewayBaseUrl?: string;
	providers: readonly ProviderFacts[];
}): UiGatewayDuplicate[] {
	const root = input.gatewayBaseUrl ? siteRootOf(input.gatewayBaseUrl) : "";
	if (!root) return [];
	const out: UiGatewayDuplicate[] = [];
	for (const p of input.providers) {
		if (p.providerId === input.gatewayId) continue;
		if (!p.baseUrl) continue;
		if (siteRootOf(p.baseUrl) !== root) continue;
		out.push({
			providerId: p.providerId,
			...(p.name ? { name: p.name } : {}),
			...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
			modelCount: p.modelCount,
		});
	}
	return out;
}

/**
 * 模型目录收窄：只保留**已配置服务商**（models.json）的模型。
 * @WHY 单网关接入下「选哪个模型」和「走哪条链路」不再是两个决定 —— 目录里不该出现
 *   内置服务商（用户没配、也管不了的）与重复接入的第二份拷贝。
 * @GOTCHA 一个已配置服务商都没有时**不**收窄（返回原列表）：全新实例/开发环境还没配网关，
 *   此时把目录清空会让应用直接不可用。宁可暂时多显示，也不能让选择器变空。
 */
export function filterCatalogToProviders<T extends { provider: string }>(
	models: readonly T[],
	providerIds: readonly string[],
): T[] {
	const ids = new Set(providerIds.map((id) => id.trim()).filter(Boolean));
	if (ids.size === 0) return [...models];
	return models.filter((m) => ids.has(m.provider));
}
