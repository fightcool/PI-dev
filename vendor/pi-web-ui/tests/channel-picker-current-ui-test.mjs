/* 🍞 AI Breadcrumb — @COUPLED web/src/components/ModelChannelPicker.tsx（渠道分组头：高亮 + 置顶 + 余额），
 *   web/src/components/ModelThinking.tsx（把 channelState.accounts 传进列表）,
 *   web/src/channel-account.ts（channelBalanceBrief：余额/已用口径）, web/src/styles.css（.chan-group.current）
 * @GOTCHA 浏览器用例：不进 npm run test:smoke；需要 PI_WEB_CHROME 或 playwright 缓存里的 chromium。
 * @CONTRACT 这个用例钉住三条用户可见的口径（都是单测测不到的「渲染结果」）：
 *   ① 当前正在使用的渠道整组高亮（.chan-group.current）并带「正在使用」文字标记 —— 不只靠颜色；
 *   ② 当前渠道排在列表第一个（渠道多了不该滚到中间去找）；
 *   ③ 配了账户查询但没查过的渠道如实写「余额未查询」，没配账户查询的渠道那一格根本不出现
 *      —— 绝不拿 0 冒充余额。
 * 📖 docs/DEV-CON-PROPOSAL.md §6（选择器）, §7（余额与用量分开、不猜测）
 *
 * Usage: npm run build && node tests/channel-picker-current-ui-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = CHROME_PATH;
if (!CHROME) {
	console.error("no chromium found: set PI_WEB_CHROME");
	process.exit(2);
}
const TOKEN = "chan-picker-current-token";
const PORT = 9760 + Math.floor(Math.random() * 200);
const APP_URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-cpc-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

// 两个服务商 × 每个两个模型：够形成两个渠道分组。
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				"uu-api": {
					name: "UU api",
					baseUrl: "https://uuapi.example",
					api: "openai-completions",
					// @GOTCHA 模型要出现在选择器里，服务商必须在 pi 运行时注册成功（需要密钥）；
					// 没密钥时渠道行仍在设置页，但下拉里一个模型行都不会渲染。
					apiKey: "test-key-uu",
					models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
				},
				rightcode: {
					name: "RightCode",
					baseUrl: "https://rightcode.example",
					api: "openai-completions",
					apiKey: "test-key-rc",
					models: [{ id: "gpt-6-astra" }, { id: "gpt-5.6-sol" }],
				},
			},
		},
		null,
		2,
	),
);
// ch-second 配了账户查询（但本用例不发查询 → 应显示「余额未查询」）；
// ch-first 没配账户查询（→ 那一格根本不出现）。
mkdirSync(join(agentDir, "dev-con"), { recursive: true });
writeFileSync(
	join(agentDir, "dev-con", "channels.json"),
	JSON.stringify(
		{
			version: 1,
			configRevision: 1,
			channels: [
				{
					id: "ch-first",
					displayName: "UU apiClaude",
					providerId: "uu-api",
					endpointId: "",
					credentialRef: null,
					accountRef: "",
					models: [],
					enabled: true,
				},
				{
					id: "ch-second",
					displayName: "RightCode",
					providerId: "rightcode",
					endpointId: "",
					credentialRef: null,
					accountRef: "",
					models: [],
					enabled: true,
					extra: { account: { kind: "openai-gateway" } },
				},
			],
		},
		null,
		2,
	),
);

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
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) throw new Error(`check failed: ${name}`);
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
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.addInitScript(() => {
		try {
			localStorage.setItem("pi-web-ui:lang", "zh");
		} catch {
			/* storage unavailable */
		}
	});
	await page.goto(`${APP_URL}/?token=${TOKEN}`);
	await page.waitForSelector("button.chip", { timeout: 30000 });

	// 打开模型下拉（有渠道 → 走 ChannelModelList 的渠道分组）。
	const openPicker = async () => {
		await page
			.locator("button.chip", { has: page.locator(".chip-model") })
			.first()
			.click();
		await page.waitForSelector(".chan-group", { timeout: 15000 });
	};
	await openPicker();

	const groups = await page.locator(".chan-group").count();
	check("渠道按分组渲染", groups === 2, `groups=${groups}`);

	// ③ 余额那一格的口径：配了账户查询但没查过 → 「余额未查询」；没配 → 不出现。
	const second = page.locator(".chan-group", { hasText: "RightCode" }).first();
	const first = page.locator(".chan-group", { hasText: "UU apiClaude" }).first();
	const secondAcct = await second.locator(".chan-head-acct").count();
	const secondText = secondAcct > 0 ? await second.locator(".chan-head-acct").first().innerText() : "";
	check("配了账户查询、未查过 → 如实写「未查询」", secondAcct === 1 && secondText.includes("未查询"), secondText);
	check("没配账户查询 → 余额那一格不出现（不拿 0 冒充）", (await first.locator(".chan-head-acct").count()) === 0);

	// 选中第二个渠道下的一个模型 → 它成为当前生效渠道。
	await second.locator(".dd-item").first().click();
	await sleep(800);

	// ① 整组高亮 + 「正在使用」文字标记；② 置顶。
	await openPicker();
	const state = await page.evaluate(() => {
		const groups = [...document.querySelectorAll(".chan-group")];
		return {
			order: groups.map((g) => g.querySelector(".chan-name")?.textContent ?? ""),
			currentIndex: groups.findIndex((g) => g.classList.contains("current")),
			currentCount: groups.filter((g) => g.classList.contains("current")).length,
			markerText: document.querySelector(".chan-group.current .chan-head-current")?.textContent ?? "",
			// 高亮必须真的落在样式上（不是只加了个类名却没规则）
			hasBg: (() => {
				const el = document.querySelector(".chan-group.current");
				if (!el) return false;
				const cs = getComputedStyle(el);
				return cs.borderLeftWidth !== "0px" || cs.backgroundColor !== "rgba(0, 0, 0, 0)";
			})(),
		};
	});
	check("恰有一个渠道被标为当前", state.currentCount === 1, `count=${state.currentCount}`);
	check("当前渠道排在第一个", state.currentIndex === 0, `order=${JSON.stringify(state.order)}`);
	check("当前渠道带「正在使用」文字标记（不只靠颜色）", state.markerText.includes("正在使用"), state.markerText);
	check("高亮样式真的生效（.chan-group.current 有边/底色）", state.hasBg);

	console.log("\nALL PASS");
	server.kill("SIGTERM");
	await browser.close();
	process.exit(0);
} catch (error) {
	console.error(error);
	await fail(String(error?.message ?? error));
}
