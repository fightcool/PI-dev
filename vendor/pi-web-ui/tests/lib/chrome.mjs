/**
 * 浏览器 E2E 测试用的 Chrome 可执行文件探测。
 *
 * 🍞 @COUPLED ../../../../tests/performance/config.mjs（根工程的 chromePath()：同一套扫描口径）
 * @BUGFIX 2026-09-17：候选路径里把 playwright 缓存版本号写死（…_headless_shell-1228），
 *   本机装的是 1243 → 探测全部落空 → CHROME_PATH="" → launch 退回 playwright 自己的期望路径
 *   并报 "Executable doesn't exist"，看起来像被测代码坏了。**不要再写死版本号**：
 *   缓存目录按 `chromium[_headless_shell]-<版本>` 命名，扫描后取版本号最大的那个。
 *
 * 顺序：
 * 1. 环境变量 PI_WEB_CHROME / CHROME_PATH 最优先；
 * 2. playwright 缓存目录扫描（各平台，版本号降序）；
 * 3. 本机 Chrome/Chromium 的常见安装位置。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** playwright 缓存根（各平台 + 环境变量覆盖）。 */
const CACHE_ROOTS = [
	process.env.PLAYWRIGHT_BROWSERS_PATH,
	join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright"),
	join(homedir(), "Library/Caches/ms-playwright"),
	process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"),
].filter(Boolean);

/** 缓存里一个浏览器目录下可执行文件的相对布局（各平台）。 */
const LAYOUTS = [
	"chrome-headless-shell-linux64/chrome-headless-shell",
	"chrome-headless-shell-win64/chrome-headless-shell.exe",
	"chrome-headless-shell-mac-arm64/chrome-headless-shell",
	"chrome-headless-shell-mac-x64/chrome-headless-shell",
	"chrome-linux/headless_shell",
	"chrome-linux64/chrome",
	"chrome-linux/chrome",
	"chrome-win64/chrome.exe",
	"chrome-win/chrome.exe",
	"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
	"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
];

/** 本机安装的 Chrome/Chromium（缓存里没有时的兜底）。 */
const SYSTEM_CANDIDATES = [
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium-browser",
	"/usr/bin/chromium",
];

/** 扫 playwright 缓存：目录名形如 chromium-1234 / chromium_headless_shell-1243，取版本号最大的。
 *  找不到返回 null（不是 ""）—— 空串会让 ?? 链条误判为「已找到」而跳过本机 Chrome 兜底。 */
function fromPlaywrightCache() {
	for (const root of CACHE_ROOTS) {
		if (!existsSync(root)) continue;
		const dirs = readdirSync(root)
			.filter((name) => /^chromium(?:_headless_shell)?-\d+$/.test(name))
			.sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
		for (const dir of dirs) {
			for (const layout of LAYOUTS) {
				const exe = join(root, dir, layout);
				if (existsSync(exe)) return exe;
			}
		}
	}
	return null;
}

/** 读环境变量：空串（含纯空白）视为未设置 —— `??` 只认 null/undefined，
 *  CI/脚本里常见的 `export PI_WEB_CHROME=` 会把整条探测链提前截死。 */
function fromEnv(name) {
	const value = process.env[name]?.trim();
	return value ? value : null;
}

export const CHROME_PATH =
	fromEnv("PI_WEB_CHROME") ??
	fromEnv("CHROME_PATH") ??
	fromPlaywrightCache() ??
	SYSTEM_CANDIDATES.find((p) => existsSync(p)) ??
	"";
