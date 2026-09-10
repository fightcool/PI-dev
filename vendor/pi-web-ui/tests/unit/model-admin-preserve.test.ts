/* 🍞 AI Breadcrumb — @COUPLED ../../server/model-admin.ts
 * 📖 ../../docs/MODEL-ROUTING.md
 * 规格锁：设置面板保存服务商配置时，表单不管理的模型/服务商字段（cost、thinkingLevelMap、
 * compat、modelOverrides、headers、未来新增字段）必须原样保留，不能被 UI 保存抹掉。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelAdminService, type ModelAdminHost } from "../../server/model-admin.js";

function makeHost(agentDir: string): ModelAdminHost {
	return {
		agentDir,
		emit: () => {},
		flushSnapshot: () => {},
		isDisposed: () => false,
		modelRuntime: () =>
			({
				refresh: async () => {},
				setRuntimeApiKey: async () => {},
				getProviders: () => [],
				getProviderAuthStatus: () => undefined,
			}) as never,
		invalidatePiConfig: () => {},
		pushModels: async () => {},
	};
}

const initial = {
	providers: {
		deepseek: {
			// 手工对齐的官方元数据（表单不管理）
			custom: "keep-me",
			modelOverrides: { "deepseek-v4-pro": { cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 } } },
			models: [
				{
					id: "deepseek-flash",
					name: "DeepSeek-V4.1-Flash",
					api: "openai-completions",
					baseUrl: "https://api.deepseek.com",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 1000000,
					maxTokens: 384000,
					cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
					thinkingLevelMap: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max" },
					compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
				},
			],
		},
		other: { baseUrl: "https://example.test/v1", models: [{ id: "m1" }] },
	},
};

function setup(): { dir: string; svc: ModelAdminService } {
	const dir = mkdtempSync(join(tmpdir(), "model-admin-"));
	writeFileSync(join(dir, "models.json"), JSON.stringify(initial, null, 2) + "\n");
	return { dir, svc: new ModelAdminService(makeHost(dir)) };
}

const read = (dir: string) => JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));

describe("保存服务商配置时的字段保留", () => {
	it("保留表单不管理的服务商级与模型级字段", async () => {
		const { dir, svc } = setup();
		await svc.saveModelConfig("deepseek", {
			providerId: "deepseek",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			models: [
				{
					id: "deepseek-flash",
					name: "DeepSeek-V4.1-Flash",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 1000000,
					maxTokens: 384000,
				},
			],
		});
		const saved = read(dir).providers.deepseek;
		expect(saved.custom).toBe("keep-me");
		expect(saved.modelOverrides["deepseek-v4-pro"].cost.input).toBe(1.32);
		expect(saved.models[0].cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
		expect(saved.models[0].thinkingLevelMap.max).toBe("max");
		expect(saved.models[0].compat.thinkingFormat).toBe("deepseek");
	});

	it("表单管理的字段以表单为准（能关掉 reasoning/vision）", async () => {
		const { dir, svc } = setup();
		await svc.saveModelConfig("deepseek", {
			providerId: "deepseek",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			models: [{ id: "deepseek-flash", name: "Renamed", input: ["text"], contextWindow: 200000 }],
		});
		const model = read(dir).providers.deepseek.models[0];
		expect(model.name).toBe("Renamed");
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(200000);
		expect(model.reasoning).toBeUndefined();
		expect(model.maxTokens).toBeUndefined();
	});

	it("不触碰其它服务商，且新模型不带旧条目的残留", async () => {
		const { dir, svc } = setup();
		await svc.saveModelConfig("deepseek", {
			providerId: "deepseek",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			models: [
				{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", input: ["text", "image"] },
				{ id: "brand-new", name: "Brand New", input: ["text"] },
			],
		});
		const providers = read(dir).providers;
		expect(providers.other).toEqual(initial.providers.other);
		expect(providers.deepseek.models.map((m: { id: string }) => m.id)).toEqual(["deepseek-flash", "brand-new"]);
		expect(providers.deepseek.models[1].cost).toBeUndefined();
	});
});
