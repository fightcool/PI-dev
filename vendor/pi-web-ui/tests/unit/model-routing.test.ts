/* 🍞 AI Breadcrumb — @COUPLED ../../server/model-routing.ts
 * 📖 ../../docs/MODEL-ROUTING.md
 * 规格锁：官方 2026-09-10 DeepSeek-V4.1-Flash 发布后的路由事实（id / 视觉 / 上下文 /
 * 上限 / 高价口径 / 思考档位映射 / 退场日期）。改这些数字必须同时改官方核对记录。
 */
import { describe, expect, it } from "vitest";
import {
	DEEPSEEK_FLASH,
	DEEPSEEK_FLASH_REF,
	RETIRED_DEEPSEEK_ROUTES,
	canonicalDeepseekRouteId,
	dshModelCatalog,
	dshModelChoices,
	filterRoutableModels,
	isRetiredDeepseekRoute,
} from "../../server/model-routing.js";

describe("官方 Flash 路由事实", () => {
	it("只暴露官方在售 id deepseek-flash", () => {
		expect(DEEPSEEK_FLASH.id).toBe("deepseek-flash");
		expect(DEEPSEEK_FLASH_REF).toBe("deepseek/deepseek-flash");
		expect(DEEPSEEK_FLASH.name).toBe("DeepSeek-V4.1-Flash");
	});

	it("上下文 1M / 输出上限 384K / 原生多模态 / 支持思考", () => {
		expect(DEEPSEEK_FLASH.contextWindow).toBe(1_000_000);
		expect(DEEPSEEK_FLASH.maxTokens).toBe(384_000);
		expect(DEEPSEEK_FLASH.input).toEqual(["text", "image"]);
		expect(DEEPSEEK_FLASH.reasoning).toBe(true);
	});

	it("成本表用高峰列表价，低谷为其一半（成本表无分时能力）", () => {
		expect(DEEPSEEK_FLASH.cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
		// 低谷价（写入 models.json 的注释里，不参与估算）
		const offPeak = { input: 0.15, output: 0.6, cacheRead: 0.003 };
		expect(offPeak.input * 2).toBeCloseTo(DEEPSEEK_FLASH.cost.input, 10);
		expect(offPeak.output * 2).toBeCloseTo(DEEPSEEK_FLASH.cost.output, 10);
		expect(offPeak.cacheRead * 2).toBeCloseTo(DEEPSEEK_FLASH.cost.cacheRead, 10);
	});

	it("思考档位映射与官方 reasoning_effort 表一致", () => {
		expect(DEEPSEEK_FLASH.thinkingLevelMap).toEqual({
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "high",
			max: "max",
		});
		// off 未列 → pi 的 thinkingFormat=deepseek 分支发 thinking.type=disabled。
		expect("off" in DEEPSEEK_FLASH.thinkingLevelMap).toBe(false);
	});
});

describe("退役路由处理", () => {
	it("三个旧 id 标记为退役，V4-Pro 的退场时点随官方公告", () => {
		expect(RETIRED_DEEPSEEK_ROUTES.map((r) => r.id)).toEqual([
			"deepseek-v4-flash",
			"deepseek-v4-flash-vision-exp",
			"deepseek-v4-pro",
		]);
		const pro = RETIRED_DEEPSEEK_ROUTES.find((r) => r.id === "deepseek-v4-pro");
		expect(pro?.effectiveAt).toBe("2026-09-14T04:00:00Z");
		expect(pro?.replacedBy).toBe("deepseek-flash");
	});

	it("别名规范化到官方 id，未知 id 原样返回", () => {
		expect(canonicalDeepseekRouteId("deepseek-v4-flash")).toBe("deepseek-flash");
		expect(canonicalDeepseekRouteId("deepseek-v4-flash-vision-exp")).toBe("deepseek-flash");
		expect(canonicalDeepseekRouteId("deepseek-v4-pro")).toBe("deepseek-flash");
		expect(canonicalDeepseekRouteId("deepseek-flash")).toBe("deepseek-flash");
		expect(canonicalDeepseekRouteId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
		expect(isRetiredDeepseekRoute("deepseek-flash")).toBe(false);
	});

	it("选择器过滤退役 id，其他服务商不受影响", () => {
		const models = [
			{ provider: "deepseek", id: "deepseek-flash" },
			{ provider: "deepseek", id: "deepseek-v4-flash" },
			{ provider: "deepseek", id: "deepseek-v4-flash-vision-exp" },
			{ provider: "deepseek", id: "deepseek-v4-pro" },
			{ provider: "cctq", id: "gpt-6-astra" },
			{ provider: "cctq", id: "deepseek-v4-flash" },
		];
		expect(filterRoutableModels(models)).toEqual([
			{ provider: "deepseek", id: "deepseek-flash" },
			{ provider: "cctq", id: "gpt-6-astra" },
			{ provider: "cctq", id: "deepseek-v4-flash" },
		]);
	});
});

describe("DSH 本地表与 adapter 目录", () => {
	it("顶栏只留一个模型，且自带视觉", () => {
		expect(dshModelChoices()).toEqual([
			{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", provider: "deepseek", vision: true },
		]);
	});

	it("adapter 目录条目与官方数字一致，且显式替换默认三个旧 id", () => {
		expect(dshModelCatalog()).toEqual([
			{
				id: "deepseek-flash",
				name: "DeepSeek-V4.1-Flash",
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				inputModalities: ["text", "image"],
			},
		]);
	});

	it("目录返回新数组，调用方改动不污染常量", () => {
		const first = dshModelCatalog();
		first[0].inputModalities.push("audio");
		expect(dshModelCatalog()[0].inputModalities).toEqual(["text", "image"]);
	});
});
