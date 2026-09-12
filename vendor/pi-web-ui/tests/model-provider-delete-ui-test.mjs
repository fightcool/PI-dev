/* 🍞 AI Breadcrumb — @COUPLED web/src/components/ModelConfigModal.tsx（隐藏集合 / 批量删除）,
 * server/client-state.ts（hiddenBuiltinProviders 持久化）, server/settings-service.ts（set/push）
 * @GOTCHA 浏览器用例：需 PI_WEB_CHROME 指向可用 Chromium（见 ../lib/chrome.mjs），
 *   不进 npm run test:smoke（冒烟清单只收零浏览器依赖的协议用例）。
 * 📖 docs/DEV-CON-PROPOSAL.md §4 */
// 管理模型 → 删除内置服务商（UI 侧，零 token）：
//   1. 每个内置服务商行都有「删除」按钮（models.json 声明的那些除外——它们的
//      真删除在「自定义服务商」区块）
//   2. 删除 → 行消失 + 底部出现「已删除 N 个」汇总行 + 落盘 client-state.json
//   3. 「查看」展开 → 「恢复」放回列表，汇总行消失，落盘同步清空
//   4. 批量「删除未配置的 N 个」一次清掉未配置项，隐藏数与按钮数字一致
//
// Usage: npm run build && PI_WEB_CHROME=<chrome> node tests/model-provider-delete-ui-test.mjs
import { CHROME_PATH } from "./lib/chrome.mjs";
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = CHROME_PATH;
const TOKEN = "model-delete-ui-test-token";
const PORT = 9040 + Math.floor(Math.random() * 200);
const URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-mpdel-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

// 让 pi 运行时能起来（至少一个可用模型），并声明一个 models.json 自定义服务商
// （它在「内置」区块也会出现，但那里不该给它「删除（隐藏）」按钮）。
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "k" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "k", models: [{ id: "m1" }] },
		},
	}),
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
	stdio: ["ignore", "ignore", "ignore"],
	windowsHide: true,
});
process.on("exit", () => {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const statePath = join(dataDir, "client-state.json");
const readHidden = () => {
	try {
		return JSON.parse(readFileSync(statePath, "utf8")).__settings__?.settings?.hiddenBuiltinProviders ?? [];
	} catch {
		return [];
	}
};

async function run() {
	for (let i = 0; i < 80; i++) {
		try {
			const r = await fetch(`${URL}/`);
			if (r.ok) break;
		} catch {
			/* retry */
		}
		await sleep(250);
	}
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on("dialog", (d) => void d.accept());
		// 固定中文界面：断言里的按钮文案才能跨环境稳定（与仓库其它 UI 用例一致）。
		await page.addInitScript(() => {
			try {
				localStorage.setItem("pi-web-ui:lang", "zh");
			} catch {
				/* storage unavailable */
			}
		});
		await page.goto(`${URL}/?token=${TOKEN}`);
		await page.waitForSelector("button.chip", { timeout: 30000 });
		await page.waitForSelector(".chip-model", { timeout: 30000 });

		// 模型下拉 → 管理模型
		await page
			.locator("button.chip", { has: page.locator(".chip-model") })
			.first()
			.click();
		const manage = page.locator(".dd-footer button", { hasText: "管理模型" }).first();
		await manage.waitFor({ timeout: 8000 });
		await manage.click();
		await page.waitForSelector(".model-modal", { timeout: 10000 });

		const rowFor = (id) => page.locator(".model-modal .provider-key-row", { hasText: id }).first();
		const hiddenBar = page.locator(".model-modal .provider-hidden-bar");
		const total = await page.locator(".model-modal .provider-key-row").count();
		check("built-in providers are listed", total > 2, `rows=${total}`);

		// 1) 真·内置服务商有「删除」按钮
		const anthropic = rowFor("anthropic");
		check(
			"a real built-in provider offers the delete button",
			(await anthropic.locator(".provider-actions .iconbtn.danger").count()) === 1,
		);
		// models.json 声明的服务商（main）在「内置」区块里不给隐藏按钮
		check(
			"a models.json provider does not offer hide (real delete lives in the custom section)",
			(await rowFor("main").locator(".provider-actions .iconbtn.danger").count()) === 0,
		);

		// 2) 删除 anthropic → 行消失 + 汇总行 + 落盘
		await anthropic.locator(".provider-actions .iconbtn.danger").click();
		await page.waitForFunction(() => document.querySelectorAll(".model-modal .provider-hidden-bar").length === 1, {
			timeout: 8000,
		});
		check("deleting removes the row", (await rowFor("anthropic").count()) === 0);
		const barText = await hiddenBar.innerText();
		check("the summary row reports the deleted count", barText.includes("1"), barText.replace(/\n/g, " "));
		await sleep(600);
		check("the hidden set is persisted", readHidden().includes("anthropic"), JSON.stringify(readHidden()));

		// 3) 展开 → 恢复
		await hiddenBar.locator("button").click();
		const hiddenRow = page.locator(".model-modal .provider-hidden-row", { hasText: "anthropic" }).first();
		await hiddenRow.waitFor({ timeout: 8000 });
		check("the deleted provider can be listed again", (await hiddenRow.count()) === 1);
		await hiddenRow.locator("button").click();
		await page.waitForFunction(() => document.querySelectorAll(".model-modal .provider-hidden-bar").length === 0, {
			timeout: 8000,
		});
		check("restoring puts the row back", (await rowFor("anthropic").count()) === 1);
		await sleep(600);
		check("restoring clears the persisted set", !readHidden().includes("anthropic"), JSON.stringify(readHidden()));

		// 4) 批量删除未配置项：隐藏数 = 按钮上的数字
		const bulk = page.locator(".model-modal-fixed-hint button").first();
		const bulkText = await bulk.innerText();
		const n = Number((bulkText.match(/\d+/) ?? ["0"])[0]);
		check("the bulk delete button counts the unconfigured providers", n > 2, bulkText.replace(/\n/g, " "));
		await bulk.click();
		// 批量隐藏后只剩 models.json 声明的那些（它们不是隐藏对象）
		await page.waitForFunction(
			(want) => document.querySelectorAll(".model-modal .provider-key-row").length === want,
			total - n,
			{ timeout: 15000 },
		);
		const afterBar = await hiddenBar.innerText();
		check(
			"bulk delete hides every unconfigured built-in provider",
			afterBar.includes(String(n)),
			afterBar.replace(/\n/g, " "),
		);
		check("custom providers survive the bulk delete", (await rowFor("main").count()) === 1);
		await sleep(600);
		check(
			"bulk delete is persisted",
			readHidden().length === n && readHidden().includes("anthropic"),
			JSON.stringify(readHidden().length),
		);

		console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
	} finally {
		await browser.close();
	}
}

try {
	await run();
} catch (err) {
	failures++;
	console.error("test crashed:", err);
} finally {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
	await sleep(300);
	process.exit(failures === 0 ? 0 : 1);
}
