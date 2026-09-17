/* 🍞 AI Breadcrumb — @COUPLED web/public/sw.js（BUILD_ID 缓存名 + activate 清旧缓存）,
 *   scripts/stamp-sw.mjs（构建后注入 BUILD_ID）, web/src/main.tsx（update() + controllerchange 重载）
 * @GOTCHA 浏览器用例：不进 npm run test:smoke；需要 PI_WEB_CHROME 或 playwright 缓存里的 chromium。
 * @CONTRACT 钉住「新部署后手机端不会一直看到旧界面」这条用户可见行为：
 *   ① 产物 sw.js 里没有占位符，且缓存名带构建号（不是写死的 -v1）；
 *   ② 装好 SW 后换一个构建号，旧的 static/shell 缓存会被 activate 清掉；
 *   ③ 清掉之后再取资源，拿到的是**服务端当前**的内容，不是旧缓存副本。
 * @WHY 事故形态：缓存名写死 -v1 → activate 只删「不叫 v1 的」→ 永不自清；
 *   导航离线回落到 shell 里的旧 index.html → 它引用旧 hash → 旧 hash 在 static 里永远命中，
 *   整套旧资源被无限期钉住（PWA 独立窗口里硬刷也不一定绕开）。
 *
 * Usage: npm run build && node tests/sw-cache-bust-ui-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHROME = CHROME_PATH;
if (!CHROME) {
	console.error("no chromium found: set PI_WEB_CHROME");
	process.exit(2);
}

const check = (name, ok, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) throw new Error(`check failed: ${name}`);
};

// ① 静态检查产物：构建流程真的把 BUILD_ID 盖进去了。
const swSource = readFileSync(join(ROOT, "web/dist/sw.js"), "utf8");
check("产物 sw.js 不含未替换的占位符", !swSource.includes("__PI_WEB_BUILD_ID__"));
const buildId = /const BUILD_ID = '([^']+)'/.exec(swSource)?.[1] ?? "";
check("产物 sw.js 带真实构建号", buildId.length > 0 && buildId !== "v1", `BUILD_ID=${buildId}`);
check("缓存名由构建号派生（不是写死的 -v1）", !swSource.includes('"pi-web-ui-static-v1"'));

const TOKEN = "sw-cache-bust-token";
const PORT = 9520 + Math.floor(Math.random() * 200);
const APP_URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-swc-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }, null, 2));

const server = spawn(realpathSync(process.execPath), ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_TOKEN: TOKEN,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const fail = async (msg) => {
	console.error(`FAIL: ${msg}`);
	console.error(serverLog.slice(-2000));
	server.kill("SIGKILL");
	process.exit(1);
};

for (let i = 0; i < 100; i++) {
	try {
		const r = await fetch(`${APP_URL}/api/health`);
		if (r.ok) break;
	} catch {}
	await sleep(200);
	if (i === 99) await fail("server did not start");
}

const browser = await chromium.launch({ executablePath: CHROME });
try {
	// 手机视口：这个 bug 就是在手机装成 PWA 后被看到的。
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
	const page = await ctx.newPage();
	await page.goto(`${APP_URL}/?token=${TOKEN}`);
	await page.waitForSelector(".composer-tools, .login-card", { timeout: 30000 });

	// 等 SW 真正接管（register 挂在 load 之后）。
	const controlled = await page.evaluate(async () => {
		if (!("serviceWorker" in navigator)) return "no-sw-api";
		const reg = await navigator.serviceWorker.ready;
		for (let i = 0; i < 60 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 250));
		return navigator.serviceWorker.controller ? (reg.active?.scriptURL ?? "active") : "not-controlled";
	});
	check("SW 已接管页面", controlled !== "not-controlled" && controlled !== "no-sw-api", String(controlled));

	// 让 SW 把资源灌进缓存，然后确认缓存名带的是当前构建号。
	await page.evaluate(async () => {
		await fetch("/favicon.svg", { cache: "no-store" }).catch(() => {});
	});
	await sleep(800);
	const before = await page.evaluate(() => caches.keys());
	check(
		"缓存名带当前构建号",
		before.some((k) => k.includes(buildId)),
		JSON.stringify(before),
	);
	// ② 模拟「新部署」：直接在页面里注册一个换了构建号的 worker 不现实，
	//    改为验证 activate 的淘汰逻辑本身 —— 造一个旧构建号的缓存，
	//    再触发一次 SW 更新，旧缓存必须消失。
	await page.evaluate(async () => {
		const cache = await caches.open("pi-web-ui-static-OLDBUILD");
		await cache.put("/stale-marker", new Response("stale"));
	});
	const withStale = await page.evaluate(() => caches.keys());
	check(
		"已造出一个旧构建号缓存",
		withStale.includes("pi-web-ui-static-OLDBUILD"),
		JSON.stringify(withStale),
	);

	// 触发 update + 重新 activate：unregister 再 register 会走一遍完整的 install/activate。
	// @GOTCHA unregister() 对**当前已被接管的页**是延迟生效的（旧 worker 会一直控制本页到卸载），
	//   所以这里必须 reload 一次让新 worker 真正 install → activate，否则 activate 根本不会跑，
	//   用例会把「没清理」误判成产品 bug。
	await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.getRegistration();
		await reg?.unregister();
	});
	await page.reload();
	await page.waitForSelector(".composer-tools, .login-card", { timeout: 30000 });
	await page.evaluate(async () => {
		await navigator.serviceWorker.register("/sw.js", { scope: "/" });
		await navigator.serviceWorker.ready;
	});
	// activate 里的 caches.delete 是异步的，轮询而不是定死一个 sleep。
	let after = [];
	for (let i = 0; i < 40; i++) {
		after = await page.evaluate(() => caches.keys());
		if (!after.includes("pi-web-ui-static-OLDBUILD")) break;
		await sleep(250);
	}
	check(
		"activate 清掉了不属于当前构建号的缓存",
		!after.includes("pi-web-ui-static-OLDBUILD"),
		JSON.stringify(after),
	);

	// ③ 清掉之后取资源，内容必须来自服务端当前产物。
	const live = await page.evaluate(async () => {
		const r = await fetch("/sw.js");
		return (await r.text()).includes("__PI_WEB_BUILD_ID__");
	});
	check("取到的 sw.js 是已盖章的产物（不是占位符版本）", live === false);

	console.log("\nALL PASS");
	server.kill("SIGTERM");
	await browser.close();
	process.exit(0);
} catch (error) {
	console.error(error);
	await fail(String(error?.message ?? error));
}
