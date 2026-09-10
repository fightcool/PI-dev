// Regression: installed vs enabled counts and skill toggles affect the prompt catalog.
// Uses an isolated server, synthetic skills, and a browser; no provider credentials.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CHROME_PATH } from "./lib/chrome.mjs";
const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(repo + "/package.json");
const { chromium } = require("playwright-core");
const WS = require("ws");
const base = mkdtempSync(join(tmpdir(), "skills-ui-proof-"));
for (const d of ["agent/skills", "data", "work", "home"]) mkdirSync(join(base, d), { recursive: true });
const names = [
	"archflow",
	"code-review",
	"coding-principles",
	"domain-modeling",
	"frontend-design",
	"git-guardrails-claude-code",
	"grill-with-docs",
	"grilling",
	"safe-terminal-executor",
	"self-check",
	"setup-pre-commit",
	"vibe-add-feature",
	"vibe-agent",
	"vibe-brainstorm",
	"vibe-init",
	"vibe-new-app",
	"vibe-spec-review",
	"writing-for-agents",
];
for (const n of names) {
	const dir = join(base, "agent/skills", n);
	mkdirSync(dir);
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${n}\ndescription: Test fixture for ${n}.\n---\nTest skill.\n`);
}
const disabled = [
	"archflow",
	"git-guardrails-claude-code",
	"grilling",
	"setup-pre-commit",
	"vibe-add-feature",
	"vibe-agent",
	"vibe-brainstorm",
	"vibe-init",
	"vibe-new-app",
	"vibe-spec-review",
];
writeFileSync(
	join(base, "data/client-state.json"),
	JSON.stringify({
		__settings__: { projects: [], settings: { disabledSkills: disabled, reviewDisabledSkills: disabled } },
	}),
);
const port = 18943;
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repo,
	env: {
		PATH: process.env.PATH,
		HOME: join(base, "home"),
		PI_CODING_AGENT_DIR: join(base, "agent"),
		PI_WEB_DATA_DIR: join(base, "data"),
		PI_WEB_CWD: join(base, "work"),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_PORT: String(port),
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	},
	stdio: "ignore",
});
let ws, browser, page;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn) => {
	const until = Date.now() + 20000;
	while (Date.now() < until) {
		if (await fn()) return;
		await pause(100);
	}
	throw Error("Timed out");
};
const deadline = setTimeout(() => {
	server.kill();
	process.exit(1);
}, 55000);
let state;
try {
	await wait(async () => {
		try {
			return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
		} catch {
			return false;
		}
	});
	ws = new WS(`ws://127.0.0.1:${port}/ws`);
	ws.on("message", (b) => {
		const m = JSON.parse(b);
		if (m.type === "settings_state") state = m.settings;
	});
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "skills-audit", locale: "en" }));
	await wait(() => !!state);
	ws.send(JSON.stringify({ type: "get_settings" }));
	await wait(() => state.skills.length === 18);
	assert.equal(state.skills.filter((s) => s.enabled).length, 8);
	assert.equal(state.reviewSkills.filter((s) => s.enabled).length, 8);
	const catalog = state.effectiveSystemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0] || "";
	assert.ok(catalog, "Effective system prompt must contain skill catalog");
	const active = [...catalog.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]);
	assert.equal(active.length, 8);
	for (const n of disabled) assert.ok(!active.includes(n));
	console.log("PASS: settings_state=8/18; review=8/18; effective system prompt catalog=8 (archflow/vibe excluded)");
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	page = await browser.newPage({ locale: "en-US", viewport: { width: 1000, height: 800 } });
	await page.goto(`http://127.0.0.1:${port}/?token=isolated-test-placeholder`);
	await page.locator('button[title="Settings"],button[title="设置"]').first().click({ timeout: 15000 });
	await page.locator('.settings-tab[title="Skills"],.settings-tab[title="技能"]').click();
	await page.waitForFunction(() => document.querySelector(".set-section-title")?.textContent?.includes("8/18"));
	await page.screenshot({ path: join(base, "skills-disabled.png") });
	const sw = page
		.locator(".set-row")
		.filter({ has: page.locator(".set-row-name", { hasText: /^archflow$/ }) })
		.getByRole("switch");
	assert.equal(await sw.getAttribute("aria-checked"), "false");
	await sw.click();
	await page.waitForFunction(() => document.querySelector(".set-section-title")?.textContent?.includes("9/18"));
	await sw.click();
	await page.waitForFunction(() => document.querySelector(".set-section-title")?.textContent?.includes("8/18"));
	console.log("PASS: browser skill counter 8/18 -> enable archflow 9/18 -> disable 8/18, no restart");
	console.log("Screenshot:", join(base, "skills-disabled.png"));
} catch (e) {
	console.error(e.message);
	if (page) {
		await page.screenshot({ path: join(base, "failure.png") });
		console.log("Screenshot", join(base, "failure.png"));
		console.log((await page.locator("body").innerText()).slice(0, 1600));
	}
	process.exitCode = 1;
} finally {
	if (browser) await browser.close();
	ws?.terminate();
	server.kill();
	clearTimeout(deadline);
	setTimeout(() => process.exit(process.exitCode || 0), 1000);
}
