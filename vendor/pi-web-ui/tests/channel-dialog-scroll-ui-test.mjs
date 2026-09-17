/* 🍞 AI Breadcrumb — @COUPLED web/src/components/ChannelDialog.tsx（三段式壳：头/体/脚）,
 *   web/src/components/ChannelForm.tsx（编辑渠道）, web/src/styles.css（.chan-dialog* 的层叠）
 * @GOTCHA 浏览器用例：不进 npm run test:smoke；需要 PI_WEB_CHROME 或 playwright 缓存里的 chromium。
 * @CONTRACT 这个用例存在的唯一理由：**单测测不出层叠**。
 *   真实事故：窄屏规则被误写进 `@media (min-width:641px)` 桌面块，三类选择器特异性压过单类，
 *   把 `overflow:hidden` 丢了 → .modal 的 overflow-y:auto 复活 → 弹窗整体成了滚动容器，
 *   .chan-dialog-body 的 flex 夹持失效，**内容区不能滚**、头部被内容顶穿。
 *   jsdom 不做 @media 匹配也不算特异性，只有真浏览器量 scrollHeight/clientHeight 才测得到。
 * 📖 docs/DEV-CON-PROPOSAL.md §6（设置页）
 *
 * Usage: npm run build && node tests/channel-dialog-scroll-ui-test.mjs
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
const TOKEN = "chan-dialog-scroll-token";
const PORT = 9460 + Math.floor(Math.random() * 200);
const APP_URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-cds-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

// 一个自定义服务商 + 一条渠道：够让「编辑渠道」弹窗里长出足以溢出的内容。
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				"uu-api": {
					name: "UU api",
					baseUrl: "https://uuapi.io",
					api: "openai-completions",
					models: Array.from({ length: 40 }, (_, i) => ({ id: `model-${i + 1}` })),
				},
			},
		},
		null,
		2,
	),
);
// @CONTRACT 渠道档案落在 <agentDir>/dev-con/channels.json，版本字段叫 configRevision（见 channel-store.ts）。
mkdirSync(join(agentDir, "dev-con"), { recursive: true });
writeFileSync(
	join(agentDir, "dev-con", "channels.json"),
	JSON.stringify(
		{
			version: 1,
			configRevision: 1,
			channels: [
				{
					id: "ch-3",
					displayName: "UU apiClaude",
					providerId: "uu-api",
					endpointId: "",
					credentialRef: null,
					accountRef: "",
					models: Array.from({ length: 12 }, (_, i) => `model-${i + 1}`),
					enabled: true,
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

// 等服务起来
for (let i = 0; i < 100; i++) {
	try {
		const r = await fetch(`${APP_URL}/api/health`);
		if (r.ok) break;
	} catch {}
	await sleep(200);
	if (i === 99) await fail("server did not start");
}

const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
try {
	// 桌面与窄屏两个视口都要验（事故就是「桌面上被窄屏规则污染」）。
	for (const vp of [
		// 高度刻意压低：内容必须真的溢出，否则「能不能滚」这条断言什么都没证明。
		// 截图里的实际视口（弹窗 908px 宽、内容 1147px 高一带）；矮视口另测一档。
		// 用户真实视口（截图那台：1854×814 @1.25dpr）—— 关闭按钮错位就是在这个断点被看到的。
		{ name: "用户视口", width: 1854, height: 814 },
		// 刻意压矮：保证内容溢出，验证「只有内容区滚」。
		{ name: "矮桌面", width: 1280, height: 560 },
		{ name: "窄屏", width: 480, height: 520 },
	]) {
		// 先用足够高的视口完成导航（矮视口下齿轮/侧栏会折叠，点不到），
		// 进入弹窗后再压矮视口来制造溢出 —— 导航与「是否溢出」互不干扰。
		// 导航阶段一律用宽视口：窄屏下 chip 行与齿轮会折叠，定位不到；
		// 进入弹窗后再切到目标视口，验证该断点下的层叠结果。
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
		await page.locator('[title*="设置"]').first().click();
		await page.waitForSelector(".settings-modal", { timeout: 10000 });
		await page.locator(".settings-tab", { hasText: "渠道" }).first().click();
		await page.waitForSelector(".chan-settings", { timeout: 15000 });
		const rowCount = await page.locator(".chan-row").count();
		if (rowCount === 0) {
			const dump = await page.locator(".chan-settings").innerText().catch(() => "(no .chan-settings)");
			await fail(`渠道列表是空的，fixture 没被读到。面板内容：\n${dump.slice(0, 600)}`);
		}
		// @GOTCHA「编辑」是图标按钮，文字在 title 上（不是按钮文本），只能按 title 定位。
		await page.locator('.chan-row button[title="编辑"]').first().click();
		await page.waitForSelector('[role="dialog"].chan-form-dialog', { timeout: 15000 });
		// 展开「进阶设置」：内容更长，溢出更确定（也顺带验证展开后仍然只有 body 滚）。
		await page.locator(".chan-section-head", { hasText: "进阶设置" }).first().click();
		await page.setViewportSize({ width: vp.width, height: vp.height });
		await sleep(200);

		const geom = await page.evaluate(() => {
			const dialog = document.querySelector('[role="dialog"].chan-form-dialog');
			const body = dialog.querySelector(".chan-dialog-body");
			const head = dialog.querySelector(".chan-dialog-head");
			const foot = dialog.querySelector(".chan-dialog-foot");
			const cs = (el) => getComputedStyle(el);
			return {
				dialogOverflowY: cs(dialog).overflowY,
				dialogScrollable: dialog.scrollHeight - dialog.clientHeight,
				bodyOverflowY: cs(body).overflowY,
				bodyScrollable: body.scrollHeight - body.clientHeight,
				// 头/脚必须在弹窗可视范围内（不被内容顶走）
				headTop: head.getBoundingClientRect().top,
				dialogTop: dialog.getBoundingClientRect().top,
				footBottom: foot.getBoundingClientRect().bottom,
				dialogBottom: dialog.getBoundingClientRect().bottom,
				// 内容区第一个分区的顶边必须在头部下沿之下（负边距事故会让它钻到头部底下）
				headBottom: head.getBoundingClientRect().bottom,
				closeBottom: dialog.querySelector(".modal-close").getBoundingClientRect().bottom,
				bodyTop: body.getBoundingClientRect().top,
				firstChildTop: body.firstElementChild?.getBoundingClientRect().top ?? 0,
			};
		});

		console.log(`  [${vp.name}] `, JSON.stringify(geom));
		// ① 内容确实溢出了（否则这条用例什么也没证明）
		if (geom.bodyScrollable <= 0) await fail(`${vp.name}: 内容没有溢出，用例无效（bodyScrollable=${geom.bodyScrollable}）`);
		// ② 滚动发生在 body，不在弹窗本体
		if (geom.bodyOverflowY !== "auto" && geom.bodyOverflowY !== "scroll")
			await fail(`${vp.name}: 内容区不可滚（overflow-y=${geom.bodyOverflowY}）`);
		if (geom.dialogScrollable > 1)
			await fail(`${vp.name}: 弹窗本体成了滚动容器（scrollHeight-clientHeight=${geom.dialogScrollable}），头脚会被滚走`);
		// ③ 实际滚一下，body 的 scrollTop 必须动
		const moved = await page.evaluate(() => {
			const body = document.querySelector('[role="dialog"].chan-form-dialog .chan-dialog-body');
			body.scrollTop = 200;
			return body.scrollTop;
		});
		if (geom.bodyScrollable > 0 && moved <= 0)
			await fail(`${vp.name}: 内容溢出了 ${geom.bodyScrollable}px 但 scrollTop 设不动，内容区实际不能滚`);
		// ④ 头/脚固定在弹窗内，内容不钻到头部下面
		if (geom.headTop < geom.dialogTop - 1) await fail(`${vp.name}: 头部跑到弹窗上沿之外`);
		if (geom.footBottom > geom.dialogBottom + 1) await fail(`${vp.name}: 页脚跑到弹窗下沿之外`);
		// @BUGFIX 全局 .modal-close 的 sticky 负边距会把 × 推到头部之外、盖在内容第一行上。
		if (geom.closeBottom > geom.bodyTop + 1)
			await fail(`${vp.name}: 关闭按钮越过内容区上沿（closeBottom=${Math.round(geom.closeBottom)} bodyTop=${Math.round(geom.bodyTop)}）—— .modal-close 的负边距漏进来了`);
		if (geom.firstChildTop < geom.headBottom - 1)
			await fail(`${vp.name}: 内容区首个元素被压到头部之下（headBottom=${geom.headBottom} firstChildTop=${geom.firstChildTop}）—— .modal-close 的负边距又漏进来了`);

		// 高视口下内容未必溢出，这一档只验「关闭按钮/头脚位置」；矮视口才强制验滚动。
		if (vp.height <= 620 && geom.bodyScrollable < 40)
			await fail(`${vp.name}: 溢出只有 ${geom.bodyScrollable}px，太小，测不出滚动`);
		results.push(`${vp.name}: body 可滚 ${geom.bodyScrollable}px，滚到 ${moved}；弹窗本体不滚；头脚在位`);
		await page.close();
	}
} finally {
	await browser.close();
	server.kill("SIGKILL");
}

for (const line of results) console.log("  ✓", line);
console.log("PASS channel dialog scroll");
