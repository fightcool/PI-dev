#!/usr/bin/env node
/* 🍞 AI Breadcrumb Navigation
 * @COUPLED vendor/pi-web-ui/web/src/components/{ModelThinking,ModelChannelPicker,FooterBar,UsageDetail}.tsx
 * @COUPLED vendor/pi-web-ui/web/src/use-chat.ts（channel_select 的 revision 提交）
 * @COUPLED tests/performance/{config,isolation,fixtures,metrics}.mjs（复用的浏览器隔离与 WS 替身）
 * 📖 docs/DEV-CON-PROPOSAL.md §6（编码界面入口）与 §10 A03/A05/A11
 * @CONTRACT 真实 Chromium + 合成数据 + 模拟 WS，不接触真实服务、模型或凭据。
 *   DEV-CON A11 证据：渠道选择器分组/禁用原因、待生效提示、底部状态栏、用量归属展示，
 *   以及点击模型时确实发出**带版本**的 channel_select 组合命令。
 *
 * 用法：node tests/channels/browser-ui.mjs
 */
import { config, chromePath, origin, vendorRequire } from "../performance/config.mjs";
import { isolatedContext } from "../performance/isolation.mjs";
import { snapshot } from "../performance/fixtures.mjs";
import { errorSummary } from "../performance/diagnostics.mjs";

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

const MODELS = [
	{ id: "main/m1", name: "Mock One", provider: "main", vision: false },
	{ id: "main/m2", name: "Mock Two", provider: "main", vision: false },
];

const CHANNELS = [
	{ id: "ch-a", displayName: "渠道 A", providerId: "main", endpointId: "default",
		credentialRef: { providerId: "main", keyName: "密钥 1" }, accountRef: null, enabled: true,
		keys: [{ keyName: "密钥 1", active: true }, { keyName: "密钥 2", active: false }], keyMissing: false, providerMissing: false },
	{ id: "ch-b", displayName: "渠道 B", providerId: "main", endpointId: "default",
		credentialRef: { providerId: "main", keyName: "密钥 2" }, accountRef: null, enabled: true,
		keys: [{ keyName: "密钥 1", active: true }, { keyName: "密钥 2", active: false }], keyMissing: false, providerMissing: false },
	{ id: "ch-off", displayName: "渠道 停用", providerId: "main", endpointId: "default",
		credentialRef: null, accountRef: null, enabled: false,
		keys: [{ keyName: "密钥 1", active: true }], keyMissing: false, providerMissing: false },
	{ id: "ch-gone", displayName: "渠道 失效", providerId: "ghost", endpointId: "default",
		credentialRef: null, accountRef: null, enabled: true, keys: [], keyMissing: false, providerMissing: true },
];

const state = {
	...snapshot(3),
	model: { id: "m1", name: "Mock One", provider: "main", vision: false },
	providerKeys: { main: [{ name: "密钥 1", active: true }, { name: "密钥 2", active: false }] },
	models: MODELS,
	channelBinding: {
		effective: { conversationId: "assessment", channelId: "ch-a", endpointId: "default",
			credentialRef: { providerId: "main", keyName: "密钥 1" }, modelId: "main/m1",
			bindingRevision: 4, configRevision: 7, lastUsedAt: 1, channelName: "渠道 A" },
		pending: { conversationId: "assessment", channelId: "ch-b", endpointId: "default",
			credentialRef: { providerId: "main", keyName: "密钥 2" }, modelId: "main/m2",
			bindingRevision: 5, configRevision: 7, lastUsedAt: 2, channelName: "渠道 B" },
		source: "conversation",
	},
	stats: {
		totalMessages: 3,
		tokens: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, total: 165,
			request: { input: 30, output: 4, total: 34, cacheRead: 0, cacheWrite: 0, total_cost: 0, cost: 0.01 },
			run: { input: 100, output: 40, total: 165, cost: 0.03 } },
		cost: 0.04,
		runId: "run-1",
		attribution: [
			{ source: "user", channelId: "ch-a", credentialKeyName: "密钥 1", providerId: "main", modelId: "m1",
				bindingRevision: 4, configRevision: 7, requests: 2, input: 90, output: 38, cacheRead: 20, cacheWrite: 5, total: 153, cost: 0.03 },
			{ source: "subagent", channelId: null, credentialKeyName: null, providerId: "main", modelId: "m1",
				bindingRevision: null, configRevision: null, requests: 1, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12, cost: 0.01 },
		],
		contextUsage: { tokens: 165, contextWindow: 200000, percent: 0.08 },
	},
	channelState: {
		type: "channel_state", configRevision: 7, bindingRevision: 5,
		channels: CHANNELS,
		instanceDefault: null,
		projectDefault: null,
		bindings: [{ conversationId: "assessment", channelId: "ch-a", endpointId: "default",
			credentialRef: { providerId: "main", keyName: "密钥 1" }, modelId: "main/m1",
			bindingRevision: 4, configRevision: 7, lastUsedAt: 1, channelName: "渠道 A" }],
		pending: [], accounts: [],
	},
};

const options = config();
const { chromium } = vendorRequire("playwright-core");
const browser = await chromium.launch({ executablePath: chromePath(chromium), headless: true,
	args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"] });
let sent = [];
try {
	// 记录客户端发出的帧：必须走 isolatedContext 的回调，不能再注册 routeWebSocket
	// （后者会替换掉替身 socket，页面就收不到 snapshot/channel_state 了）。
	const { context } = await isolatedContext(browser, options, state, () => {}, (message) => sent.push(message));
	const page = await context.newPage();
	page.on("pageerror", (err) => check("no page error", false, errorSummary(err, true).message));
	await page.goto(origin, { waitUntil: "domcontentloaded" });
	await page.locator(".chan-chip.effective").waitFor({ state: "visible", timeout: options.stepTimeout });

	// 1) 待生效与有效绑定同时可见（A03 的可见性要求）。
	const effective = (await page.locator(".chan-chip.effective").first().innerText()).trim();
	const pending = (await page.locator(".chan-chip.pending").first().innerText()).trim();
	check("effective channel chip shows the bound channel", effective.includes("渠道 A"), effective);
	check("pending chip shows the deferred channel + badge", pending.includes("渠道 B") && pending.includes("Applying after this run"), pending);

	// 2) 底部状态栏显示有效渠道（A11 的「当前渠道」入口）。
	const footer = (await page.locator(".status-channel").first().innerText()).trim();
	check("footer shows the effective channel", footer.includes("渠道 A"), footer);

	// 3) 选择器按渠道分组，禁用渠道给出明确原因且不可点选。
	// 触发器是 Dropdown 里的 .chip（内含 .chip-model 名称）。
	await page.locator("button.chip", { has: page.locator(".chip-model") }).first().click();
	await page.locator(".chan-group").first().waitFor({ state: "visible", timeout: options.stepTimeout });
	const groups = await page.locator(".chan-group").count();
	const names = await page.locator(".chan-group .chan-name").allInnerTexts();
	check("picker groups models by channel", groups === 4, `groups=${groups} names=${names.join("|")}`);
	const disabledHeads = page.locator(".chan-group .chan-head.disabled");
	const disabledCount = await disabledHeads.count();
	const reasons = (await page.locator(".chan-group .chan-head.disabled .chan-reason").allInnerTexts()).join(" | ");
	check("disabled channels are marked with a reason", disabledCount === 2, `${disabledCount}: ${reasons}`);
	const clickable = await page.locator(".chan-group .chan-head.disabled .dd-model-cell, .chan-group .chan-head.disabled .chan-key").count();
	check("disabled channels expose no clickable model/key", clickable === 0, `clickable=${clickable}`);

	// 4) 点击渠道 A 下的「密钥 2」+ 模型 → 一条带版本的组合命令（A03/A04）。
	sent = [];
	const groupA = page.locator(".chan-group", { has: page.locator(".chan-name", { hasText: "渠道 A" }) });
	await groupA.locator(".chan-key", { hasText: "密钥 2" }).first().click();
	await groupA.locator(".dd-model-cell", { hasText: "Mock One" }).first().click();
	const select = sent.find((m) => m.type === "channel_select");
	check("model click sends one combined channel_select", Boolean(select));
	check("command carries channel + named credential + model", select?.channelId === "ch-a" && select?.credentialKeyName === "密钥 2" && select?.modelId === "main/m1",
		JSON.stringify(select ?? null));
	check("command carries both expected revisions", select?.expectedConfigRevision === 7 && select?.expectedBindingRevision === 4,
		`config=${select?.expectedConfigRevision} binding=${select?.expectedBindingRevision}`);

	// 5) 用量详情展示归属，未归属行诚实标注（P2）。
	await page.keyboard.press("Escape");
	await page.locator(".status-tokens, .footer-tokens").first().click().catch(() => undefined);
	const attr = page.locator(".usage-attr");
	await attr.waitFor({ state: "visible", timeout: options.stepTimeout }).catch(() => undefined);
	if (await attr.count()) {
		const text = await attr.first().innerText();
		check("usage detail lists channel attribution", text.includes("渠道 A"), text.split("\n").slice(0, 4).join(" / "));
		const unattributed = await page.locator(".usage-attr .usage-unattributed").count();
		check("rows without a channel are labelled unattributed", unattributed === 1, `count=${unattributed}`);
	} else {
		check("usage detail opens from the footer", false, "selector .usage-attr not found");
	}
	await context.close();
} catch (err) {
	check("browser run completed without exceptions", false, err?.message ?? String(err));
} finally {
	await browser.close();
	console.log(failures === 0 ? "\n✓ channel browser UI: all checks passed" : `\n✗ channel browser UI: ${failures} check(s) failed`);
	process.exit(failures === 0 ? 0 : 1);
}
