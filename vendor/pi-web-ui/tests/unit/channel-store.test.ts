/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/channel-store.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §4（存储所有权、无第二套密钥事实源、外部修改不可静默覆盖）
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultCatalog, makeBinding, MAX_PERSISTED_BINDINGS, type ChannelRecord } from "../../server/dev-con/channel-model.js";
import { catalogHash, channelStorePath, loadCatalog, saveCatalog } from "../../server/dev-con/channel-store.js";

const channel = (id: string): ChannelRecord => ({
	id,
	displayName: id,
	providerId: "main",
	endpointId: "default",
	credentialRef: null,
	accountRef: null,
	enabled: true,
	extra: {},
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-dev-channels-"));
});

describe("channel store", () => {
	it("returns an empty catalog when nothing was saved yet", () => {
		const loaded = loadCatalog(dir);
		expect(loaded.exists).toBe(false);
		expect(loaded.hash).toBeNull();
		expect(loaded.catalog).toEqual(defaultCatalog());
	});

	it("round-trips channels, defaults, bindings and unknown fields without loss", () => {
		const catalog = {
			...defaultCatalog(),
			configRevision: 4,
			channels: [{ ...channel("ch-1"), extra: { future: { nested: true } } }],
			instanceDefault: { channelId: "ch-1", endpointId: "default", credentialRef: null, modelId: "main/m1" },
			projectDefaults: { "/proj": { channelId: "ch-1", endpointId: "default", credentialRef: null, modelId: "main/m2" } },
			bindings: {
				c1: makeBinding({
					conversationId: "c1",
					selection: { channelId: "ch-1", endpointId: "default", credentialRef: null, modelId: "main/m1" },
					configRevision: 4,
					bindingRevision: 2,
					now: 100,
				}),
			},
			extra: { writtenBy: "external-tool", futureFlag: { nested: true } },
		};
		const saved = saveCatalog(dir, catalog, null);
		expect(saved.ok).toBe(true);
		const reloaded = loadCatalog(dir);
		expect(reloaded.catalog.configRevision).toBe(4);
		expect(reloaded.catalog.channels[0].extra).toEqual({ future: { nested: true } });
		expect(reloaded.catalog.projectDefaults["/proj"]?.modelId).toBe("main/m2");
		expect(reloaded.catalog.bindings.c1.bindingRevision).toBe(2);
		// 未知顶层字段原样保留（无损往返）；version 是存储自己的字段，不作为未知值透传。
		expect(reloaded.catalog.extra).toEqual({ writtenBy: "external-tool", futureFlag: { nested: true } });
	});

	it("reports a conflict when the file changed after our baseline", () => {
		expect(saveCatalog(dir, defaultCatalog(), null).ok).toBe(true);
		const baseline = catalogHash(dir);
		writeFileSync(channelStorePath(dir), JSON.stringify({ ...defaultCatalog(), configRevision: 99 }), "utf8");
		const stale = saveCatalog(dir, { ...defaultCatalog(), configRevision: 1 }, baseline);
		expect(stale).toMatchObject({ ok: false, kind: "conflict" });
	});

	it("treats a file created by someone else as a conflict for a null baseline", () => {
		mkdirSync(join(dir, "dev-con"), { recursive: true });
		writeFileSync(channelStorePath(dir), JSON.stringify(defaultCatalog()), "utf8");
		expect(saveCatalog(dir, defaultCatalog(), null)).toMatchObject({ ok: false, kind: "conflict" });
	});

	it("refuses to persist credential-shaped fields (no second key source)", () => {
		const result = saveCatalog(dir, { ...defaultCatalog(), extra: { apiKey: "sk-leak" } }, null);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.kind).toBe("invalid");
		expect(result.ok === false && result.errors?.[0]).toContain("不得包含密钥字段");
	});

	it("writes atomically with owner-only permissions and prunes old bindings", () => {
		const bindings = Object.fromEntries(
			Array.from({ length: MAX_PERSISTED_BINDINGS + 5 }, (_, i) => [
				`c${i}`,
				makeBinding({
					conversationId: `c${i}`,
					selection: { channelId: "ch-1", endpointId: "default", credentialRef: null, modelId: "main/m1" },
					configRevision: 1,
					bindingRevision: i,
					now: i,
				}),
			]),
		);
		expect(saveCatalog(dir, { ...defaultCatalog(), channels: [channel("ch-1")], bindings }, null).ok).toBe(true);
		const text = readFileSync(channelStorePath(dir), "utf8");
		expect(Object.keys(JSON.parse(text).bindings)).toHaveLength(MAX_PERSISTED_BINDINGS);
		if (process.platform !== "win32") expect(statSync(channelStorePath(dir)).mode & 0o777).toBe(0o600);
	});
});
