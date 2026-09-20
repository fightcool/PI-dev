/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-settings.ts
 * 📖 docs/DEV-CON-PROPOSAL.md §4（配置落盘/校验/密钥边界）
 * 用真实临时目录验证：默认值、读-合并-写（不整份覆盖）、0600 + tmp/rename 原子写、
 * 损坏文件不静默清空、明文密钥拒绝、未知字段无损保留。
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jevSettingsPath, loadJevSettings, saveJevSettings } from "../../server/dev-con/jev-settings.js";
import { JEV_DEFAULT_MODEL, defaultJevGateConfig } from "../../server/dev-con/jev-model.js";

/** 合成密钥（运行时拼接，避免被发布检查当成真实密钥字面量）。 */
const SYNTHETIC_KEY = ["sk", "or", "TESTONLY0123456789abcdef0123"].join("-");

const dirs: string[] = [];
function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jev-settings-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadJevSettings", () => {
	it("returns defaults and marks a missing file as absent", () => {
		const loaded = loadJevSettings(agentDir());
		expect(loaded.exists).toBe(false);
		expect(loaded.parseError).toBeUndefined();
		expect(loaded.config).toEqual(defaultJevGateConfig());
	});

	it("flags a corrupted file instead of silently resetting it", () => {
		const dir = agentDir();
		mkdirSync(join(dir, "dev-con"), { recursive: true });
		writeFileSync(jevSettingsPath(dir), "{ not json");
		const loaded = loadJevSettings(dir);
		expect(loaded).toMatchObject({ exists: true, parseError: true });
		// 磁盘内容没有被改写（调用方必须自己决定怎么处理）。
		expect(readFileSync(jevSettingsPath(dir), "utf8")).toBe("{ not json");
	});

	it("flags a file whose values fail validation", () => {
		const dir = agentDir();
		mkdirSync(join(dir, "dev-con"), { recursive: true });
		writeFileSync(jevSettingsPath(dir), JSON.stringify({ endpoint: "http://insecure.example/x" }));
		expect(loadJevSettings(dir)).toMatchObject({ parseError: true, config: defaultJevGateConfig() });
	});
});

describe("saveJevSettings", () => {
	it("merges a partial patch into the existing file (never a whole-file overwrite)", () => {
		const dir = agentDir();
		expect(saveJevSettings(dir, { model: "typesafe/jev-1.13" }).ok).toBe(true);
		const patched = saveJevSettings(dir, { credentialRef: { providerId: "openrouter", keyName: "密钥 1" } });
		expect(patched.ok).toBe(true);
		const loaded = loadJevSettings(dir);
		expect(loaded.config.model).toBe(JEV_DEFAULT_MODEL);
		expect(loaded.config.credentialRef).toEqual({ providerId: "openrouter", keyName: "密钥 1" });
		expect(loaded.config.thresholds).toEqual({ approveAt: 0.9, blockAt: 0.1 });
	});

	it("deep-merges thresholds so a single field does not wipe the other", () => {
		const dir = agentDir();
		saveJevSettings(dir, { thresholds: { approveAt: 0.8 } });
		const loaded = loadJevSettings(dir);
		expect(loaded.config.thresholds).toEqual({ approveAt: 0.8, blockAt: 0.1 });
	});

	it("writes mode 0600 through tmp + rename (no leftovers, no partial file)", () => {
		const dir = agentDir();
		expect(saveJevSettings(dir, { endpoint: "https://openrouter.ai/api/alpha/decisions" }).ok).toBe(true);
		const path = jevSettingsPath(dir);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(dir, "dev-con")).filter((name) => name.includes(".tmp"))).toEqual([]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, model: JEV_DEFAULT_MODEL });
	});

	it("refuses invalid values and leaves the previous file untouched", () => {
		const dir = agentDir();
		saveJevSettings(dir, { model: "typesafe/jev-1.13" });
		const before = readFileSync(jevSettingsPath(dir), "utf8");
		const rejected = saveJevSettings(dir, { endpoint: "http://openrouter.ai/x" });
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error).toContain("https");
		expect(rejected.errorEn).toContain("https");
		expect(readFileSync(jevSettingsPath(dir), "utf8")).toBe(before);
	});

	it("refuses literal secrets without echoing them back", () => {
		const dir = agentDir();
		const rejected = saveJevSettings(dir, { credentialRef: { providerId: "openrouter", keyName: SYNTHETIC_KEY } });
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error).toContain("明文密钥");
		expect(rejected.error).not.toContain(SYNTHETIC_KEY);
		expect(rejected.errorEn).not.toContain(SYNTHETIC_KEY);
	});

	it("refuses to merge into a corrupted file (no silent data loss)", () => {
		const dir = agentDir();
		mkdirSync(join(dir, "dev-con"), { recursive: true });
		writeFileSync(jevSettingsPath(dir), "{ broken");
		const result = saveJevSettings(dir, { model: "m" });
		expect(result.ok).toBe(false);
		expect(readFileSync(jevSettingsPath(dir), "utf8")).toBe("{ broken");
	});

	it("keeps unknown top-level fields (lossless round-trip)", () => {
		const dir = agentDir();
		mkdirSync(join(dir, "dev-con"), { recursive: true });
		writeFileSync(
			jevSettingsPath(dir),
			JSON.stringify({ model: "typesafe/jev-1.13", futureField: { note: "keep me" } }),
		);
		expect(saveJevSettings(dir, { enabled: false }).ok).toBe(true);
		const raw = JSON.parse(readFileSync(jevSettingsPath(dir), "utf8")) as Record<string, unknown>;
		expect(raw.futureField).toEqual({ note: "keep me" });
		expect(raw.enabled).toBe(false);
	});

	it("stores only the key NAME reference", () => {
		const dir = agentDir();
		expect(saveJevSettings(dir, { credentialRef: { providerId: "openrouter", keyName: "密钥 1" } }).ok).toBe(true);
		const raw = readFileSync(jevSettingsPath(dir), "utf8");
		expect(raw).toContain("密钥 1");
		expect(raw).not.toContain(SYNTHETIC_KEY);
		expect(raw).not.toContain("apiKey");
	});
});
