/* 🍞 AI Breadcrumb — @COUPLED web/src/components/ChannelModelWhitelist.tsx（「获取接口清单」按钮）,
 * web/src/components/ChannelForm.tsx（reqId/providerId 匹配）, server/model-admin.ts fetchChannelModels
 * @GOTCHA 浏览器用例：不进 npm run test:smoke（冒烟清单只收零浏览器依赖的协议用例）；
 *   需要 PI_WEB_CHROME 指向可用 Chromium（见 ./lib/chrome.mjs）。
 * 📖 docs/DEV-CON-PROPOSAL.md §4（渠道白名单） */
// 渠道表单「获取接口清单」（浏览器端，零 token）：
//   1. 点按钮 → 服务端按该服务商 baseUrl 探测 /models（密钥服务端解析 → 端点收到命名密钥）
//   2. 接口返回的模型并入白名单候选（带「接口」标记），勾选后计入已选数量
//   3. 回执写清探测地址与条数
//   4. 保存渠道后列表行显示白名单摘要（证明勾选的是真白名单，不是展示态）
//
// Usage: npm run build && PI_WEB_CHROME=<chrome> node tests/channel-models-fetch-ui-test.mjs
import { CHROME_PATH } from "./lib/chrome.mjs";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = CHROME_PATH;
const TOKEN = "channel-models-ui-test-token";
const PORT = 9060 + Math.floor(Math.random() * 200);
const MOCK_PORT = PORT + 1;
const APP_URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-cmui-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const authSeen = [];
const mock = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	const send = (code, body) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(typeof body === "string" ? body : JSON.stringify(body));
	};
	if (url.pathname === "/models") {
		authSeen.push(req.headers.authorization ?? null);
		return send(200, {
			data: [{ id: "cc1q/gpt-6-astra" }, { id: "cc1q/gpt-5.6-sol" }],
		});
	}
	send(404, { error: "no route" });
});
await new Promise((res) => mock.listen(MOCK_PORT, "127.0.0.1", res));

// cc1q：带 baseUrl 的自定义服务商 + 一把命名密钥（探测必须用这把）。
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ cc1q: { type: "api_key", key: "inline-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			cc1q: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "inline-key",
				models: [{ id: "cc1q/gpt-5.6-sol" }],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "provider-keys.json"),
	JSON.stringify({ cc1q: { activeKeyName: "主密钥", keys: [{ name: "主密钥", apiKey: "named-key-A" }] } }),
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
	try {
		mock.close();
	} catch {
		/* gone */
	}
});

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

async function run() {
	for (let i = 0; i < 80; i++) {
		try {
			const r = await fetch(`${APP_URL}/`);
			if (r.ok) break;
		} catch {
			/* retry */
		}
		await sleep(250);
	}
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await page.addInitScript(() => {
			try {
				localStorage.setItem("pi-web-ui:lang", "zh");
			} catch {
				/* storage unavailable */
			}
		});
		await page.goto(`${APP_URL}/?token=${TOKEN}`);
		await page.waitForSelector("button.chip", { timeout: 30000 });

		// 设置 → 渠道 → 新增渠道
		await page.locator('[title*="设置"]').first().click();
		await page.waitForSelector(".settings-modal", { timeout: 10000 });
		await page.locator(".settings-tab", { hasText: "渠道" }).first().click();
		await page.locator(".chan-settings-head button", { hasText: "新增渠道" }).first().click();
		await page.waitForSelector(".chan-form", { timeout: 8000 });

		// 服务商 = cc1q（第 1 个 select），显示名必填
		await page.locator(".chan-form .field input").first().fill("测试渠道");
		const selects = page.locator(".chan-form select");
		await selects.nth(0).selectOption("cc1q");

		// 目录里的候选（来自 models.json）：1 条，且没有「接口」标记
		const rowsBefore = await page.locator(".chan-models-list .chan-model-row").count();
		check("registry candidates are listed first", rowsBefore === 1, `rows=${rowsBefore}`);
		check("no API badge before fetching", (await page.locator(".chan-model-src").count()) === 0);

		// 获取接口清单
		authSeen.length = 0;
		await page.locator(".chan-models-head button", { hasText: "获取接口清单" }).first().click();
		const receipt = page.locator(".chan-models-fetch");
		await receipt.waitFor({ timeout: 15000 });
		const receiptText = await receipt.innerText();
		check(
			"receipt names the probed baseUrl and the model count",
			/2/.test(receiptText) && receiptText.includes(`127.0.0.1:${MOCK_PORT}`),
			receiptText,
		);
		check("the probe authenticated with the named key", authSeen[0] === "Bearer named-key-A", JSON.stringify(authSeen));

		// 接口独有的候选（gpt-6-astra）带「接口」标记
		const apiBadges = await page.locator(".chan-model-src").count();
		check("endpoint-only models are marked as API-sourced", apiBadges === 1, `badges=${apiBadges}`);
		const rowsAfter = await page.locator(".chan-models-list .chan-model-row").count();
		check("endpoint models merge into the candidate list", rowsAfter === 2, `rows=${rowsAfter}`);

		// 勾选接口返回的那条 → 已选 1
		await page.locator(".chan-model-row", { hasText: "cc1q/gpt-6-astra" }).first().locator("input").check();
		const count = await page.locator(".chan-models-count").innerText();
		check("checking an endpoint model counts toward the whitelist", /1/.test(count), count);

		// 保存 → 列表行显示白名单摘要
		await page.locator(".chan-form-actions button", { hasText: "保存" }).first().click();
		await page.waitForSelector(".chan-row", { timeout: 15000 });
		const rowText = await page.locator(".chan-row").first().innerText();
		check("saved channel carries the whitelist", /1/.test(rowText), rowText.replace(/\n/g, " "));

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
	try {
		mock.close();
	} catch {
		/* gone */
	}
	await sleep(300);
	process.exit(failures === 0 ? 0 : 1);
}
