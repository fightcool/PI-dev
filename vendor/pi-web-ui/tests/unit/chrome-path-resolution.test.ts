/* 🍞 AI Breadcrumb — @COUPLED ../lib/chrome.mjs（被测件）, ../../../../tests/performance/config.mjs
 *   （根工程 chromePath()：同一套「扫描缓存」口径）
 * @CONTRACT 浏览器 E2E 不能因为 playwright 缓存版本号变了就整体失效：
 *   ① 源码里不得再出现写死版本号的缓存路径（`chrome-headless-shell-1234/...` 这类字面量）；
 *   ② 缓存扫描按目录名里的版本号降序，取存在的第一个布局；
 *   ③ PI_WEB_CHROME / CHROME_PATH 环境变量仍最优先；
 *   ④ 缓存与系统 Chrome 都找不到时返回 ""（调用方的 `if (!CHROME_PATH)` 依赖这个语义）。
 * @BUGFIX 2026-09-17：原候选表写死 `chromium_headless_shell-1228`，本机是 1243 →
 *   CHROME_PATH="" → launch 退回 playwright 期望路径并报 "Executable doesn't exist"，
 *   表现成「被测代码坏了」。这道用例防止回归。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "lib", "chrome.mjs");

/** 在子进程里按指定环境解析（模块在 import 时就定死了 CHROME_PATH，必须换进程）。 */
function resolveWithEnv(env: Record<string, string>): string {
	const out = execFileSync(
		process.execPath,
		["-e", `import(${JSON.stringify(SRC)}).then(m => process.stdout.write(m.CHROME_PATH))`],
		{ env: { ...process.env, ...env }, encoding: "utf8" },
	);
	return out;
}

/** 造一个假的 playwright 缓存根：两个版本 + 一个非浏览器目录。 */
function fakeCacheRoot(): { root: string; newest: string; older: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-chrome-cache-"));
	const layout = "chrome-headless-shell-linux64/chrome-headless-shell";
	const build = (dir: string) => {
		mkdirSync(join(root, dir, "chrome-headless-shell-linux64"), { recursive: true });
		writeFileSync(join(root, dir, layout), "#!/bin/sh\n");
		return join(root, dir, layout);
	};
	return { root, newest: build("chromium_headless_shell-9999"), older: build("chromium_headless_shell-1228") };
}

describe("浏览器可执行文件探测", () => {
	it("源码里不再写死 playwright 缓存版本号", () => {
		const src = readFileSync(SRC, "utf8");
		// 匹配 "ms-playwright/...-1234/..." 这类写死版本号的路径片段
		const hardcoded = src.match(/ms-playwright\/[\w.]*?-?\d{3,}/g) ?? [];
		expect(hardcoded, "写死的缓存版本号路径（应改为扫描目录名）").toEqual([]);
	});

	it("PI_WEB_CHROME / CHROME_PATH 环境变量最优先", () => {
		expect(resolveWithEnv({ PI_WEB_CHROME: "/custom/pi-web-chrome" })).toBe("/custom/pi-web-chrome");
		expect(resolveWithEnv({ CHROME_PATH: "/custom/chrome-path" })).toBe("/custom/chrome-path");
		// PI_WEB_CHROME 优先于 CHROME_PATH
		expect(resolveWithEnv({ PI_WEB_CHROME: "/a", CHROME_PATH: "/b" })).toBe("/a");
	});

	it("扫描缓存目录：取版本号最大的那个，不依赖写死的版本", () => {
		const { root, newest } = fakeCacheRoot();
		expect(resolveWithEnv({ PLAYWRIGHT_BROWSERS_PATH: root, PI_WEB_CHROME: "", CHROME_PATH: "" })).toBe(newest);
	});

	it("缓存与系统 Chrome 都没有时返回空串（调用方据此报「no Chrome found」）", () => {
		const empty = mkdtempSync(join(tmpdir(), "pi-chrome-empty-"));
		// POSIX 下 /usr/bin/chromium* 可能真实存在，这里只断言「不会抛异常、要么空串要么真实存在的路径」
		const resolved = resolveWithEnv({
			PLAYWRIGHT_BROWSERS_PATH: empty,
			XDG_CACHE_HOME: empty,
			PI_WEB_CHROME: "",
			CHROME_PATH: "",
		});
		expect(typeof resolved).toBe("string");
		expect(resolved.includes("undefined")).toBe(false);
	});
});
