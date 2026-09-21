#!/usr/bin/env node
/* 🍞 @COUPLED footer-theme-check.mjs, ../performance/{config,isolation,fixtures}.mjs,
 * vendor/pi-web-ui/web/src/components/JevFooterItem.tsx, JevRuntimeView.tsx
 * @CONTRACT Synthetic jev_status over the isolated WS harness; no settings/key workflow.
 * Run after building: node tests/jev/footer-theme-browser.mjs
 * BENCH_WEB_ROOT can select an existing build, as in the shared browser harness.
 */
import assert from "node:assert/strict";
import { config, chromePath, origin, vendorRequire } from "../performance/config.mjs";
import { isolatedContext } from "../performance/isolation.mjs";
import { snapshot, socketReply } from "../performance/fixtures.mjs";
import { checkFooterTheme } from "./footer-theme-check.mjs";

const runtime = {
	total: 37, approve: 20, block: 9, review: 8, failed: 2,
	inputTokens: 28400, outputTokens: 740, cost: 0.0021,
	cacheHits: 12, diskHits: 5, avgElapsedMs: 412, lastError: null,
};
const status = {
	config: {
		enabled: true, endpoint: "https://synthetic.invalid/decisions", model: "typesafe/jev-1.13",
		credentialRef: null, thresholds: { approveAt: 0.9, blockAt: 0.1 },
		timeoutMs: 8000, cacheTtlMs: 900000, minIntervalMs: 250, recordSamples: true,
	},
	runtime, propositions: [],
};
const options = config();
const { chromium } = vendorRequire("playwright-core");
const deadline = setTimeout(() => {
	console.error("Jev footer theme verification exceeded 120 seconds");
	process.exit(1);
}, 120_000);
let browser;
try {
	browser = await chromium.launch({
		executablePath: chromePath(chromium), headless: true,
		proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
		args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"],
	});
	const state = snapshot(1);
	const { context, traffic } = await isolatedContext(browser, options, state);
	try {
		await context.routeWebSocket("**/*", (socket) => {
			const url = new URL(socket.url());
			assert.equal(url.origin, origin.replace("http:", "ws:"));
			assert.equal(url.pathname, "/ws");
			socket.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				for (const reply of socketReply(message, state)) socket.send(JSON.stringify(reply));
				// Same authoritative status shape as a server push; do not mutate React or the DOM.
				if (message.type === "hello" || message.type === "jev_status") {
					socket.send(JSON.stringify({ type: "jev_status", reqId: message.reqId ?? 0, ok: true, status }));
				}
			});
		});
		const page = await context.newPage();
		page.setDefaultTimeout(options.stepTimeout);
		await page.goto(origin, { waitUntil: "domcontentloaded" });
		await page.locator("footer.statusbar button.status-jev").click();
		const panel = page.locator(".usage-panel.jev-panel");
		await panel.waitFor({ state: "visible" });
		await panel.locator(".resource-card").first().waitFor();
		assert.equal(await panel.locator(".resource-card").count(), 11);
		const total = panel.locator(".resource-card").filter({ hasText: "Total calls" });
		assert.equal(await total.locator(".resource-value").innerText(), String(runtime.total));
		const check = (name, passed, detail) => {
			assert.ok(passed, `${name}: ${detail}`);
			console.log(`PASS ${name}: ${detail}`);
		};
		await checkFooterTheme(page, panel, check);
		await page.locator(".status-cwd-backdrop").click({ position: { x: 10, y: 10 } });
		await panel.waitFor({ state: "detached" });
		assert.equal(traffic.pageErrors, 0, "No browser page errors");
		assert.equal(traffic.externalBlocked + traffic.unhandled + traffic.routeErrors, 0, "Only isolated fixture traffic");
		console.log("PASS Jev status push renders real counts; panel closes; no page/network errors");
	} finally {
		await context.close();
	}
} finally {
	await browser?.close();
	clearTimeout(deadline);
}
