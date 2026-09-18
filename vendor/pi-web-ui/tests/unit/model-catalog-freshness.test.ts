/* 🍞 AI Breadcrumb — @COUPLED ../../server/model-catalog-freshness.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §4（服务商/模型目录的所有权）
 * 覆盖：身份戳的构造与缺字段回落、变化判定、以及「读不到 ≠ 变了」的护栏。
 *
 * 为什么值得单测：这里是「旧会话看不到新服务商」这类 bug 的唯一防线。判定写错的表现是
 * 静默的——要么永远不刷新（用户症状：该渠道暂无可用的模型），要么每次都刷新（list_models
 * 变成昂贵的空转）。两种都不会抛错，只能靠断言。
 */
import { describe, expect, it } from "vitest";
import {
	modelCatalogStale,
	modelConfigStamp,
	modelsConfigPathOf,
	stampOf,
} from "../../server/model-catalog-freshness.js";

describe("stampOf", () => {
	it("mtime + size 组合成身份戳", () => {
		expect(stampOf({ mtimeMs: 1000, size: 42 })).toBe("1000:42");
	});

	it("缺字段 / 非有限数 / 空值 → 空串（= 没有可用判据）", () => {
		expect(stampOf(null)).toBe("");
		expect(stampOf(undefined)).toBe("");
		expect(stampOf({ mtimeMs: Number.NaN, size: 1 })).toBe("");
		expect(stampOf({ mtimeMs: 1, size: Number.NaN })).toBe("");
		// 只改 size（同 mtime，文件系统时间戳精度不足时的补救）也必须被认出来
		expect(stampOf({ mtimeMs: 1000, size: 42 })).not.toBe(stampOf({ mtimeMs: 1000, size: 43 }));
	});
});

describe("modelCatalogStale", () => {
	it("两侧都有值且不同 → 需要重载", () => {
		expect(modelCatalogStale("1000:42", "2000:42")).toBe(true);
		expect(modelCatalogStale("1000:42", "1000:43")).toBe(true);
	});

	it("相同 → 不重载", () => {
		expect(modelCatalogStale("1000:42", "1000:42")).toBe(false);
	});

	it("任一侧为空串 → 不重载（把「读不到」当成「变了」会每次白刷新甚至重试死循环）", () => {
		expect(modelCatalogStale("", "1000:42")).toBe(false);
		expect(modelCatalogStale("1000:42", "")).toBe(false);
		expect(modelCatalogStale("", "")).toBe(false);
	});
});

describe("modelConfigStamp / modelsConfigPathOf", () => {
	it("路径是 agentDir/models.json（与 model-admin 的写入路径同一处）", () => {
		expect(modelsConfigPathOf("/tmp/agent")).toBe("/tmp/agent/models.json");
	});

	it("文件不存在 → 空串，不抛错", () => {
		expect(modelConfigStamp("/nonexistent-dir-xyz/models.json")).toBe("");
	});

	it("真实文件：写完能取到戳，且内容变化后戳会变", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pi-freshness-"));
		const path = modelsConfigPathOf(dir);
		expect(modelConfigStamp(path)).toBe("");
		writeFileSync(path, JSON.stringify({ providers: {} }));
		const first = modelConfigStamp(path);
		expect(first).not.toBe("");
		expect(modelCatalogStale(first, modelConfigStamp(path))).toBe(false);
		// size 变化 → 一定被认出来（多数文件系统 mtime 精度足够，但 size 是兜底判据）
		writeFileSync(path, JSON.stringify({ providers: { main: { api: "openai-completions" } } }));
		expect(modelCatalogStale(first, modelConfigStamp(path))).toBe(true);
	});
});
