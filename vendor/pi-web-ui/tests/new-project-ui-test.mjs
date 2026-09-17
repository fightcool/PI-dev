/**
 * 🍞 AI Breadcrumb
 * @COUPLED web/src/components/LeftPanelProjects.tsx（左栏「＋ 新建项目」入口 + 空态）,
 *          web/src/components/DirectoryPicker.tsx（浏览/新建/选择的唯一实现），
 *          web/src/app/app-dialogs.tsx（新建项目弹窗挂载点），
 *          tests/unit/new-project-entry.test.ts（同一契约的纯逻辑层）
 * 📖 ../../docs/STRUCTURE.md（项目 = 工作目录）
 * @CONTRACT 真实 Chromium + 真服务（隔离端口与 data-dir，零 token、不碰真实模型）。
 *   验证「用户能不能在应用里新建一个项目」这条闭环：
 *     ① 左栏「最近项目」标题常显，标题行有 ＋ 入口（即便一个项目都没有）；
 *     ② 点 ＋ 打开目录选择器弹窗，默认展开文件夹名输入行；
 *     ③ 输入名字 → 创建并打开 → 目录真的建在磁盘上，且成为当前工作目录（底栏 + 文件树）；
 *     ④ 新项目出现在左栏「最近项目」里。
 * @GOTCHA 隔离 data-dir 必需：宿主实例可能开了 Passkey/口令门（页面会停在登录页，
 *   与本功能无关的假失败）。同理清掉 PI_WEB_TOKEN / PI_WEB_MANAGED。
 * @GOTCHA PasskeyGate 是**纯客户端**门：即使服务端没设 PI_WEB_TOKEN，页面也先渲染登录卡
 *   （隔离实例下任何 token 都能过）。浏览器 E2E 必须先种 localStorage token，否则
 *   `.panel-left` 永远不会出现。与 tests/performance/isolation.mjs 同一做法。
 *
 * 用法：node tests/new-project-ui-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8905;
const BASE = `http://localhost:${PORT}`;

// 父目录（浏览目标）+ 起始工作区（两者分开：新建后 cwd 必须真的换过去）
const base = mkdtempSync(join(tmpdir(), "pi-web-newproj-"));
const parentDir = join(base, "workspaces");
const startDir = join(base, "start");
mkdirSync(parentDir, { recursive: true });
mkdirSync(startDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-newproj-data-"));
const agentDir = join(base, "agent");
const NEW_NAME = "demo-project";
const newProjPath = join(parentDir, NEW_NAME);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let server = null;
let browser = null;

async function run() {
	try {
		await freePort(PORT);
	} catch {
		/* port free */
	}
	const env = { ...process.env };
	for (const key of ["PI_WEB_TOKEN", "PI_WEB_MANAGED"]) delete env[key];
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_CWD: startDir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage();
	// 跳过纯客户端的 Passkey 门 + 固定中文（下面的断言看中文文案）。
	await page.addInitScript(
		"try{localStorage.setItem('pi-web-ui:token','e2e-isolated-instance');localStorage.setItem('pi-web-ui:lang','zh')}catch(e){}",
	);
	page.on("pageerror", (e) => console.log("pageerror:", e.message));
	await page.goto(BASE);
	await page.waitForSelector(".panel-left .panel-sessions", { timeout: 15000 });
	await sleep(1200);

	// 隔离实例没有 pi 配置（PI_CODING_AGENT_DIR 是临时目录），启动会弹「安装/配置 pi」引导，
	// 它的 .modal-backdrop 会遮住左栏 —— 先关掉（与本用例无关）。
	if ((await page.locator(".modal-backdrop").count()) > 0) {
		await page
			.locator(".modal-backdrop .modal-close")
			.first()
			.click({ timeout: 3000 })
			.catch(() => {});
		await sleep(400);
	}
	check("无遮罩遮挡左栏", (await page.locator(".modal-backdrop").count()) === 0);

	// 1) 最近项目区块常显 + 标题行有新建入口（这就是原来缺的：0 项目时整块不渲染）
	const titles = await page.locator(".panel-left .panel-section-title").allTextContents();
	check(
		"最近项目标题常显",
		titles.some((t) => t.includes("最近项目")),
		titles.join("|"),
	);
	check("标题行有 ＋ 新建项目入口", (await page.locator(".panel-projects .lp-projects-new").count()) === 1);

	// 2) 点 ＋ → 弹窗（默认展开文件夹名输入行，按钮是「创建并打开」）
	await page.locator(".panel-projects .lp-projects-new").click();
	await page.waitForSelector(".cwd-picker-modal", { timeout: 5000 });
	check(
		"弹窗是无障碍对话框",
		(await page.locator('.cwd-picker-modal[role="dialog"][aria-modal="true"]').count()) === 1,
	);
	check("默认展开文件夹名输入行", (await page.locator(".cwd-picker-modal .cwd-newrow input").count()) === 1);

	// 3) 浏览到父目录：直接在路径输入框里定位（Enter 会切 cwd，所以只填不回车，
	//    靠 complete_path 的防抖刷新列表）
	await page.locator(".cwd-picker-modal .cwd-picker-input").fill(parentDir.replace(/\\/g, "/"));
	await sleep(900);

	// 4) 输入项目名 → 创建并打开
	await page.locator(".cwd-picker-modal .cwd-newrow input").fill(NEW_NAME);
	await page.locator(".cwd-picker-modal .cwd-newrow .cwd-choose-btn.primary").click();
	// 建目录 → 服务端刷新列表 → 确认存在后才 set_cwd（不抢跑），故等久一点
	await sleep(2500);

	check("目录已真的创建在磁盘上", existsSync(newProjPath), newProjPath);
	const closed = (await page.locator(".cwd-picker-modal").count()) === 0;
	check("创建并打开后弹窗自动关闭", closed);

	// 5) 工作目录切过去了：底栏路径 + 左栏最近项目
	const footer = (await page.locator(".status-cwd").first().textContent()) ?? "";
	check("底栏工作目录 = 新项目", footer.includes(NEW_NAME), footer.trim());
	const projectNames = await page.locator(".panel-projects .project-name").allTextContents();
	check("新项目出现在最近项目列表", projectNames.includes(NEW_NAME), projectNames.join("|"));

	// 6) 底栏入口仍然可用（选择器抽成组件后行为不能变）
	await page.locator(".status-cwd").first().click();
	await page.waitForSelector(".cwd-picker", { timeout: 5000 });
	check("底栏仍打开同一个选择器（非弹窗形态）", (await page.locator(".cwd-picker-modal").count()) === 0);
	await page.keyboard.press("Escape");
}

try {
	await run();
} catch (err) {
	console.error("FATAL:", err?.message ?? err);
	failures++;
} finally {
	if (browser) await browser.close().catch(() => {});
	if (server?.pid) {
		try {
			process.kill(server.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
	await sleep(300);
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
