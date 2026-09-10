/* 🍞 AI Breadcrumb Navigation — @COUPLED=fixture; @MAGIC=regression budgets.
 * @COUPLED ./fixtures/message-list-window.tsx
 * Run from any cwd: node vendor/pi-web-ui/tests/message-list-window-test.mjs
 * @WHY esbuild write:false and fulfilled routes require no build, server or sessions.
 * @MAGIC 82 rows = 80 window rows + one retained editor + one live stream; 4x CPU matches assessment.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/message-list-window.tsx", import.meta.url));
const origin = "http://message-list.fixture";
const executablePath = process.env.CHROME_PATH || CHROME_PATH || chromium.executablePath();
let browser;
// Last-resort guard also covers a stuck bundler/browser launch; normal cleanup is in finally.
const guard = setTimeout(() => {
	console.error("FAIL fixture exceeded 150 seconds");
	void browser?.close();
	stop();
	setTimeout(() => process.exit(1), 3000).unref();
	process.exitCode = 1;
}, 150000);
const failures = [];
let selectedScenarios = 0;
const errors = [];
const unexpected = [];
try {
	const bundle = await build({
		absWorkingDir: root,
		entryPoints: [fixture],
		bundle: true,
		write: false,
		outfile: "/virtual/fixture.js",
		platform: "browser",
		format: "esm",
		jsx: "automatic",
		nodePaths: [`${root}node_modules`],
		define: { "process.env.NODE_ENV": '"production"' },
		metafile: true,
		logLevel: "silent",
	});
	assert(
		!Object.keys(bundle.metafile.inputs).some((p) => /(?:^|\/)App\.tsx$|(?:^|\/)server\//.test(p)),
		"fixture must not bundle App/backend",
	);
	const assets = new Map(bundle.outputFiles.map((file) => [file.path.replace("/virtual", ""), file.contents]));
	assets.set("/styles.css", await readFile(`${root}web/src/styles.css`));
	const html = `<!doctype html><html lang="en"><head><link rel="icon" href="data:,">
		<link rel="stylesheet" href="/styles.css">${assets.has("/fixture.css") ? '<link rel="stylesheet" href="/fixture.css">' : ""}
		<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style>
		</head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
	browser = await chromium.launch({ executablePath, headless: true, timeout: 15000 });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		locale: "en-US",
		serviceWorkers: "block",
	});
	await context.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (url.origin !== origin) unexpected.push(url.href);
		if (url.origin === origin && path === "/") return route.fulfill({ contentType: "text/html", body: html });
		if (url.origin === origin && assets.has(path))
			return route.fulfill({
				contentType: path.endsWith(".css") ? "text/css" : "application/javascript",
				body: Buffer.from(assets.get(path)),
			});
		if (url.origin === origin && path === "/api/locales")
			return route.fulfill({ contentType: "application/json", body: '{"packs":[]}' });
		unexpected.push(path);
		await route.fulfill({ status: 404, body: "Unexpected fixture request" });
	});
	await context.routeWebSocket("**/*", (socket) => {
		unexpected.push("WebSocket");
		socket.close();
	});
	const page = await context.newPage();
	page.setDefaultTimeout(6000);
	page.on("pageerror", (error) => {
		errors.push(error.message);
		console.error(`BROWSER ${error.stack}`);
	});
	page.on("console", (message) => {
		if (["error", "warning"].includes(message.type())) console.error(`CONSOLE ${message.text()}`);
	});
	await page.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "en");
		window.fixtureMetrics = { maxRows: 0, longTasks: [] };
		new MutationObserver(() => {
			window.fixtureMetrics.maxRows = Math.max(
				window.fixtureMetrics.maxRows,
				document.querySelectorAll(".messages [data-msg-id]").length,
			);
		}).observe(document, { childList: true, subtree: true });
		new PerformanceObserver((list) =>
			window.fixtureMetrics.longTasks.push(
				...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
			),
		).observe({ type: "longtask", buffered: true });
	});
	const cdp = await context.newCDPSession(page);
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
	const frames = () =>
		page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const row = (id) => page.locator(`.messages [data-msg-id="${id}"]`);
	const waitBottom = () =>
		page.waitForFunction(() => {
			const el = document.querySelector(".messages");
			return el && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		});
	const visible = (id) =>
		page.waitForFunction((id) => {
			const el = document.querySelector(`.messages [data-msg-id="${id}"]`);
			const box = el?.getBoundingClientRect(),
				root = document.querySelector(".messages")?.getBoundingClientRect();
			return box && root && box.bottom > root.top && box.top < root.bottom;
		}, id);
	const metrics = async (name, startedAt) => {
		await frames();
		const result = await page.evaluate((start) => {
			const tasks = window.fixtureMetrics.longTasks.filter((t) => t.start >= start);
			const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
			let domNodes = 1;
			while (walker.nextNode()) domNodes++;
			return {
				elapsedMs: Math.round(performance.now() - start),
				domNodes,
				domElements: document.querySelectorAll("*").length,
				mountedRows: document.querySelectorAll(".messages [data-msg-id]").length,
				peakRows: window.fixtureMetrics.maxRows,
				spacers: document.querySelectorAll(".msg-window-spacer").length,
				questionTicks: document.querySelectorAll(".qn-bar").length,
				questionItems: document.querySelectorAll(".qn-list-item").length,
				longTasks: tasks.length,
				longTaskMs: Math.round(tasks.reduce((sum, t) => sum + t.duration, 0)),
				maxLongTaskMs: Math.round(Math.max(0, ...tasks.map((t) => t.duration))),
			};
		}, startedAt);
		console.log(JSON.stringify({ phase: name, cpuSlowdown: 4, ...result }));
		assert(result.mountedRows > 0 && result.mountedRows <= 82, `${name}: mounted rows ${result.mountedRows}`);
		assert(result.peakRows <= 82, `${name}: transient peak ${result.peakRows}`);
		assert(result.domElements < 6000, `${name}: DOM unexpectedly large (${result.domElements})`);
		assert(result.questionTicks <= 40 && result.questionItems <= 16, `${name}: question navigation unbounded`);
		return result;
	};
	const check = async (name, run) => {
		if (
			process.env.MESSAGE_LIST_SCENARIO &&
			!name.includes(process.env.MESSAGE_LIST_SCENARIO) &&
			!name.startsWith("no browser")
		)
			return;
		if (!name.startsWith("no browser")) selectedScenarios++;
		try {
			await run();
			console.log(`PASS ${name}`);
		} catch (error) {
			failures.push(name);
			console.error(`FAIL ${name}: ${error.message}`);
		}
	};
	const reset = async () => {
		if (!(await page.locator(".messages").count())) {
			await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
			await page.waitForFunction(() => window.messageListFixture?.ready);
		}
		await page.mouse.move(10, 10);
		await page.evaluate(() => window.messageListFixture.reset());
		await row("assessment-999").waitFor();
		await waitBottom();
		await frames();
	};
	const scrollTop = async () => {
		await page.locator(".messages").hover({ position: { x: 300, y: 300 } });
		await page.mouse.wheel(0, -1000000);
		await visible("assessment-0");
		await frames();
	};
	const openSearch = async (query) => {
		await page.locator("body").click({ position: { x: 5, y: 5 } });
		await page.keyboard.press("Control+f");
		await page.locator(".search-input").fill(query);
	};
	const activeHit = (id) =>
		page.waitForFunction((id) => {
			const range = CSS.highlights.get("msg-search-active")?.values().next().value;
			const element = range?.startContainer.parentElement;
			return element?.closest("[data-msg-id]")?.dataset.msgId === id;
		}, id);
	await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });
	await page.waitForFunction(() => window.messageListFixture?.ready);
	await row("assessment-999").waitFor();
	await waitBottom();
	await check("1000 ordinary messages bounded initial mount", async () => {
		const start = await page.evaluate(() => window.messageListFixture.startedAt);
		const result = await metrics("initial-1000", start);
		assert.equal(await row("assessment-0").count(), 0, "oldest row should be offscreen/unmounted");
		assert(result.elapsedMs < 10000, "initial render exceeded generous 10s regression budget at 4x CPU");
	});
	await check("scroll to first message and return to bottom", async () => {
		const start = await page.evaluate(() => performance.now());
		await scrollTop();
		await metrics("scroll-top", start);
		await page.locator(".scroll-bottom").click();
		await waitBottom();
		await visible("assessment-999");
	});
	await check("Ctrl+F finds old offscreen text; next/previous wrap; Escape closes", async () => {
		await reset();
		// Match integrated regression: expand history, unmount it by returning to
		// bottom, then open search. Search mode invalidates old height measurements.
		await scrollTop();
		await row("assessment-0").click();
		await row("assessment-0").locator(".msg-collapse-btn").waitFor();
		await page.locator(".scroll-bottom").click();
		await waitBottom();
		const start = await page.evaluate(() => performance.now());
		await openSearch("Message 42");
		await activeHit("assessment-42");
		await visible("assessment-42");
		assert.equal((await page.locator(".search-count").innerText()).trim(), "1/11");
		await metrics("search-offscreen", start);
		await page.locator(".search-input").press("Enter");
		await activeHit("assessment-420");
		await page.locator(".search-input").press("Shift+Enter");
		await activeHit("assessment-42");
		await page.locator(".search-input").press("Shift+Enter");
		await activeHit("assessment-429");
		await page.locator(".search-input").press("Enter");
		await activeHit("assessment-42");
		await page.keyboard.press("Escape");
		await page.locator(".search-bar").waitFor({ state: "detached" });
		assert.equal(await page.evaluate(() => CSS.highlights.has("msg-search-active")), false);
	});
	await check("collapse/expand and edited reask callback", async () => {
		await reset();
		await scrollTop();
		await row("assessment-0").click();
		await row("assessment-0").locator(".msg-collapse-btn").waitFor();
		await row("assessment-0").locator(".msg-collapse-btn").click();
		assert(await row("assessment-0").evaluate((el) => el.classList.contains("msg-collapsed")));
		await row("assessment-0").press("Enter");
		await row("assessment-0").getByRole("button", { name: "Edit & re-ask", exact: true }).click();
		await row("assessment-0").locator("textarea").fill("Edited synthetic question");
		await page.locator(".scroll-bottom").click();
		await waitBottom();
		assert.equal(await row("assessment-0").locator("textarea").inputValue(), "Edited synthetic question");
		await metrics("retained-editor", await page.evaluate(() => performance.now()));
		await row("assessment-0").locator("textarea").press("Control+Enter");
		assert.deepEqual(await page.evaluate(() => window.messageListFixture.edits), [
			{ id: "assessment-0", text: "Edited synthetic question", attachments: undefined },
		]);
	});
	await check("streaming stays at bottom; upward wheel escapes through finalization", async () => {
		await reset();
		await page.evaluate(() => window.messageListFixture.append());
		await visible("assessment-1000");
		await waitBottom();
		for (const n of [1, 2, 3]) {
			await page.evaluate((n) => window.messageListFixture.stream(n), n);
			await row("fixture-stream").waitFor();
			await frames();
			await waitBottom();
		}
		await scrollTop();
		for (const n of [4, 5]) {
			await page.evaluate((n) => window.messageListFixture.stream(n), n);
			await frames();
			await visible("assessment-0");
		}
		await page.evaluate(() => window.messageListFixture.finish());
		await frames();
		await visible("assessment-0");
		await page.locator(".scroll-bottom").click();
		await waitBottom();
		await visible("fixture-stream");
		await metrics("stream-finalized", await page.evaluate(() => performance.now()));
	});
	await check("question navigation reaches first, last and unsampled questions", async () => {
		await reset();
		const rail = page.locator(".qn-rail");
		await rail.focus();
		await page.keyboard.press("Home");
		await page.keyboard.press("Enter");
		await visible("assessment-0");
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await visible("assessment-998");
		await page.keyboard.press("Home");
		for (let i = 0; i < 17; i++) await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await visible("assessment-34");
		assert.equal((await page.locator('.qn-list-item[aria-selected="true"] .qn-list-idx').innerText()).trim(), "18");
		await metrics("question-navigation", await page.evaluate(() => performance.now()));
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => getComputedStyle(document.querySelector(".qn-list")).visibility === "hidden");
	});
	await check("no browser errors or unmocked requests", async () => {
		assert.deepEqual(errors, []);
		assert.deepEqual(unexpected, []);
	});
	assert(selectedScenarios > 0, "MESSAGE_LIST_SCENARIO did not match any scenario");
	if (failures.length) throw new Error(`${failures.length} scenario(s) failed: ${failures.join("; ")}`);
	console.log("PASS selected isolated MessageList browser scenarios");
} catch (error) {
	console.error(error.stack ?? error);
	process.exitCode = 1;
} finally {
	await browser?.close();
	stop();
	clearTimeout(guard);
}
