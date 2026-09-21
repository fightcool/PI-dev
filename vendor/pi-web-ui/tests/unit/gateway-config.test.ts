/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../../server/dev-con/gateway-config.ts（被测件）,
 *            ../../server/model-admin.ts（getGateway / saveGateway 用同一批解析）,
 *            ../../server/agent-service.ts（listModels 用 filterCatalogToProviders 收窄目录）,
 *            ../../web/src/gateway-usage.ts（前端展示口径的对应实现）
 *   📖 docs/NEWAPI-GATEWAY.md §2（单网关模型：谁算网关、重复接入怎么处理、目录怎么收窄）
 *   @CONTRACT 这是**规格**单测：钉死解析优先级与「宁可多显示也不清空」的兜底，
 *     这两条一旦漂移，界面就会把配置写到用户没在看的那个入口上。
 * ──────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";
import {
	filterCatalogToProviders,
	resolveGatewayProviderId,
	sameGatewayDuplicates,
} from "../../server/dev-con/gateway-config.js";

describe("resolveGatewayProviderId（谁是网关）", () => {
	it("当前生效模型的服务商优先：正在被调用的入口最没有歧义", () => {
		expect(resolveGatewayProviderId({ providerIds: ["a", "b"], activeProvider: "b" })).toBe("b");
	});

	it("没有生效模型时用唯一/第一个已配置服务商（models.json 键顺序，稳定）", () => {
		expect(resolveGatewayProviderId({ providerIds: ["only"] })).toBe("only");
		expect(resolveGatewayProviderId({ providerIds: ["first", "second"] })).toBe("first");
	});

	it("生效模型不在已配置服务商里（内置服务商）→ 不用它，回落到已配置项", () => {
		expect(resolveGatewayProviderId({ providerIds: ["gw"], activeProvider: "openai" })).toBe("gw");
	});

	it("一个都没配 → null（界面如实说「还没配网关」，不编一个出来）", () => {
		expect(resolveGatewayProviderId({ providerIds: [] })).toBeNull();
		expect(resolveGatewayProviderId({ providerIds: ["  "] })).toBeNull();
	});
});

describe("sameGatewayDuplicates（重复接入）", () => {
	const providers = [
		{ providerId: "newapi", baseUrl: "https://api.ftai.cc/v1", modelCount: 7 },
		{ providerId: "ftai", baseUrl: "https://api.ftai.cc", modelCount: 3 },
		{ providerId: "deepseek", baseUrl: "https://api.deepseek.com", modelCount: 1 },
	];

	it("同一站点（忽略 /v1 与尾斜杠）即算重复，其它站点不算", () => {
		const dup = sameGatewayDuplicates({ gatewayId: "newapi", gatewayBaseUrl: "https://api.ftai.cc/v1", providers });
		expect(dup.map((d) => d.providerId)).toEqual(["ftai"]);
		expect(dup[0]?.modelCount).toBe(3);
	});

	it("网关自己没有 baseUrl 时不做判断（不知道地址就无法比较，不猜）", () => {
		expect(sameGatewayDuplicates({ gatewayId: "newapi", providers })).toEqual([]);
	});

	it("没有 baseUrl 的条目（内置服务商）不参与比较", () => {
		const dup = sameGatewayDuplicates({
			gatewayId: "gw",
			gatewayBaseUrl: "https://api.ftai.cc",
			providers: [{ providerId: "builtin", modelCount: 5 }],
		});
		expect(dup).toEqual([]);
	});
});

describe("filterCatalogToProviders（模型目录收窄）", () => {
	const models = [
		{ provider: "newapi", id: "deepseek-flash" },
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "ftai", id: "deepseek-flash" },
	];

	it("只保留已配置服务商的模型（内置服务商与第二份拷贝都不再出现）", () => {
		expect(filterCatalogToProviders(models, ["newapi"]).map((m) => `${m.provider}/${m.id}`)).toEqual([
			"newapi/deepseek-flash",
		]);
	});

	it("一个都没配时**不**收窄：全新实例不能因为没配网关就没有可选模型", () => {
		expect(filterCatalogToProviders(models, [])).toHaveLength(3);
		expect(filterCatalogToProviders(models, ["", "  "])).toHaveLength(3);
	});
});
