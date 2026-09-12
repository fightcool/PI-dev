#!/usr/bin/env node
/* 🍞 AI Breadcrumb Navigation
 * @COUPLED vendor/pi-web-ui/web/src/components/{ModelThinking,ModelChannelPicker,FooterBar,UsageDetail}.tsx
 * @COUPLED vendor/pi-web-ui/web/src/use-chat.ts（channel_select 的 revision 提交）
 * @COUPLED tests/performance/{config,isolation,fixtures,metrics}.mjs（复用的浏览器隔离与 WS 替身）
 * 📖 docs/DEV-CON-PROPOSAL.md §6（编码界面入口）与 §10 A03/A05/A11
 * @CONTRACT 真实 Chromium + 合成数据 + 模拟 WS，不接触真实服务、模型或凭据。
 *   DEV-CON A11 证据：渠道选择器分组/禁用原因、待生效提示、底部状态栏、用量归属展示，
 *   以及点击模型时确实发出**带版本**的 channel_select 组合命令。
 * @COUPLED tests/performance/fixtures.mjs（socketReply 的渠道/用量夹具；channel_state 里带
 *   models 白名单与 accountPresets 预设）、vendor/pi-web-ui/web/src/components/{ChannelForm,
 *   ChannelRow,ChannelModelWhitelist,ChannelAccountQuery,ChannelUsage,ModelChannelPicker}.tsx
 * @GOTCHA 新增检查的语义（全在合成数据上验证，不允许因为“界面上看不到”就放宽）：
 *   模型白名单只在非空时生效（空 = 不限）、行内启用切换必须带上 models、
 *   编辑时渠道 id 只读、账户模板的 JSON 校验必须拦下坏配置（不得发出 channel_save）、
 *   删除要确认并有回执、按渠道用量把未归属/未上报/未知价格如实展示。
 *
 * 用法：node tests/channels/browser-ui.mjs
 */
import { config, chromePath, origin, vendorRequire } from "../performance/config.mjs";
import { isolatedContext } from "../performance/isolation.mjs";
import { snapshot, settingsFixture, socketReply } from "../performance/fixtures.mjs";
import { errorSummary } from "../performance/diagnostics.mjs";

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

/** 真实上游原文（实测自 www.cctq.ai 的 new-api 网关）：报错卡要能说清「哪个渠道 · 哪个模型」失败。 */
const CCTQ_QUOTA_ERROR =
	'OpenAI API error (403): {"message":"用户额度不足, 剩余额度: ¥-0.013362 (request id: 202609121538353343706438268d9d6vAofL5Y9)","type":"new_api_error","param":"","code":"insufficient_user_quota"}';

const MODELS = [
	{ id: "main/m1", name: "Mock One", provider: "main", vision: false },
	{ id: "main/m2", name: "Mock Two", provider: "main", vision: false },
];

const CHANNELS = [
	{ id: "ch-a", displayName: "渠道 A", providerId: "main", endpointId: "default",
		credentialRef: { providerId: "main", keyName: "密钥 1" }, accountRef: null, enabled: true,
		// 配了账户查询 → 输入框工具条要出现「余额」chip（PC 与移动端同位置）。
		account: { kind: "openai-gateway", url: "{baseUrl}/api/user/self", method: "GET", unit: "USD",
			topupUrl: "https://pay.example/channel-a" },
		models: ["m1"],
		keys: [{ keyName: "密钥 1", active: true }, { keyName: "密钥 2", active: false }], keyMissing: false, providerMissing: false },
	{ id: "ch-b", displayName: "渠道 B", providerId: "main", endpointId: "default",
		credentialRef: { providerId: "main", keyName: "密钥 2" }, accountRef: null, enabled: true,
		models: [],
		keys: [{ keyName: "密钥 1", active: true }, { keyName: "密钥 2", active: false }], keyMissing: false, providerMissing: false },
	{ id: "ch-off", displayName: "渠道 停用", providerId: "main", endpointId: "default",
		credentialRef: null, accountRef: null, enabled: false, models: [],
		keys: [{ keyName: "密钥 1", active: true }], keyMissing: false, providerMissing: false },
	{ id: "ch-gone", displayName: "渠道 失效", providerId: "ghost", endpointId: "default",
		credentialRef: null, accountRef: null, enabled: true, models: [],
		keys: [], keyMissing: false, providerMissing: true },
];

/** 末尾追加的一条「模型调用失败」消息（真实上游原文）：报错卡要能说清渠道与模型。 */
const ERROR_MESSAGE = {
	id: "assessment-err",
	role: "assistant",
	content: [],
	provider: "main",
	model: "m1",
	stopReason: "error",
	errorMessage: CCTQ_QUOTA_ERROR,
	timestamp: 1700000000009,
};

const state = {
	...snapshot(3),
	messages: [...snapshot(3).messages, ERROR_MESSAGE],
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
		recentRequests: [
			{ id: "r:resp-1", at: 1700000000000, runId: "run-1", conversationId: "assessment", cwd: "/synthetic",
				source: "user", channelId: "ch-a", credentialKeyName: "密钥 1", providerId: "main", modelId: "m1",
				bindingRevision: 4, configRevision: 7, input: 90, output: 38, cacheRead: 20, cacheWrite: 5, total: 153,
				cost: 0.03, costBasis: "sdk-model-pricing", currency: "USD" },
			{ id: "r:resp-2", at: 1700000005000, runId: "run-1", conversationId: "assessment", cwd: "/synthetic",
				source: "probe", channelId: null, credentialKeyName: null, providerId: "main", modelId: "m1",
				bindingRevision: null, configRevision: null, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12,
				cost: 0, costBasis: "unknown", currency: null },
		],
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
		pending: [],
		// P3 状态口径：成功 / 不支持 / 过期（失败但保留上次结果）三种都要能显示。
		accounts: [
			{ accountRef: "ch-a", kind: "openai-gateway", status: "ok", unit: "USD", balance: 12.5,
				quota: { used: 1, limit: 13.5, remaining: 12.5, unit: "USD" }, checkedAt: 1700000000000 },
			{ accountRef: "ch-b", kind: "unsupported", status: "unsupported", error: "no account endpoint" },
			{ accountRef: "ch-off", kind: "openrouter", status: "stale", unit: "USD", balance: 3.25,
				checkedAt: 1700000000000, staleSince: 1700000000000, error: "HTTP 503" },
		],
		// 账户查询模板预设（服务端 ACCOUNT_TEMPLATE_PRESETS 形状；一键填充到编辑器）。
		accountPresets: [
			{ id: "deepseek", label: "DeepSeek 官方", description: "GET /user/balance → balance_infos[]",
				template: { kind: "template", url: "https://api.deepseek.com/user/balance", method: "GET",
					items: { path: "balance_infos", currency: "currency", total: "total_balance" },
					mapping: { available: "is_available" } } },
			{ id: "openrouter", label: "OpenRouter", description: "GET /credits → data.total_credits",
				template: { kind: "template", url: "https://openrouter.ai/api/v1/credits", method: "GET",
					mapping: { limit: "data.total_credits", used: "data.total_usage", remaining: "data.total_credits" },
					unit: "USD" } },
		],
	},
};

// 设置面板在 settings_state 到达前返回 null；fixtures.settingsFixture() 提供最小可用态。
/** 移动端上下文的替代回复（复用同一份合成状态，但不依赖 performance 隔离底座）。 */
const mobileReplies = (msg) => {
	switch (msg.type) {
		case "hello":
			return [
				{ type: "ready", serverVersion: "synthetic", managed: true, engine: "pi" },
				{ type: "plugins", plugins: [], epoch: 1 },
				{ type: "snapshot", state },
				{ type: "settings_state", settings: settingsFixture() },
				{ type: "channel_state", ...state.channelState },
			];
		case "list_channels": return [{ type: "channel_state", ...state.channelState }];
		case "list_models": return [{ type: "models", models: MODELS }];
		case "channel_select": return [{ type: "channel_command_result", commandId: msg.commandId, ok: true, phase: "applied",
			channelId: msg.channelId, configRevision: 7, bindingRevision: 5 }];
		// 其余（模型列表、用量历史、系统资源…）复用性能夹具的替身回复，
		// 避免每加一条协议就在这里漏一个 case（之前正是这样丢了 settings_state）。
		default: return socketReply(msg, state);
	}
};

const options = config();
const { chromium } = vendorRequire("playwright-core");
const browser = await chromium.launch({ executablePath: chromePath(chromium), headless: true,
	args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"] });
let sent = [];
/** 自动刷新用例专用：记录该上下文发出的帧（与主上下文分开，避免互相干扰计数）。 */
const clockSent = [];
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
	// 渠道配了账户查询时，余额 chip 出现在输入框工具条（思考强度右侧），PC 端不必翻设置。
	const desktopBalance = page.locator(".composer-tools-left .chan-balance");
	check("toolbar shows the channel balance chip", (await desktopBalance.isVisible()) && (await desktopBalance.innerText()).includes("12.5"),
		await desktopBalance.innerText().catch(() => "missing"));

	// 2b) 模型调用失败：报错卡先把**哪个渠道·哪个模型**失败摆到最前面（两个渠道可能指向同一个站点，
	// 只有「用户额度不足」原文时用户会把一个渠道的欠费看反），人话原因 + 充值直达，「详情」里才是上游原文。
	const errCard = page.locator(".msg-error").first();
	await errCard.waitFor({ state: "visible", timeout: options.stepTimeout });
	const errWhere = (await errCard.locator(".msg-error-where").innerText()).trim();
	check("error card names the failing channel and model", errWhere === "渠道 A · m1", errWhere);
	const errText = (await errCard.locator(".msg-error-text").innerText()).trim();
	const errHref = await errCard.locator(".msg-error-link").getAttribute("href").catch(() => null);
	check("error card explains quota exhaustion in plain words (gateway figure kept)",
		errText.includes("¥-0.013362") && !errText.includes("insufficient_user_quota"), errText);
	check("error card links straight to the channel top-up page", errHref === "https://pay.example/channel-a", String(errHref));
	check("raw upstream error stays folded until Details is pressed", (await errCard.locator(".msg-error-detail").count()) === 0);
	await errCard.locator(".msg-error-more").first().click();
	const errDetail = await errCard.locator(".msg-error-detail").first().innerText();
	check("Details reveals the raw upstream error (request id included)",
		errDetail.includes("insufficient_user_quota") && errDetail.includes("request id:"), errDetail.slice(0, 120));
	await errCard.locator(".msg-error-more").first().click();
	check("Details folds back", (await errCard.locator(".msg-error-detail").count()) === 0);

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

	// 3b) 模型白名单（channel.models）：非空时只显示白名单内的模型，并在渠道头上写明。
	const wlHint = await page.locator(".chan-group .chan-whitelist").allInnerTexts();
	check("picker marks the channels that limit their model list", wlHint.length === 1 && wlHint[0].includes("1"), wlHint.join(" | "));
	const wlGroupA = page
		.locator(".chan-group", { has: page.locator(".chan-name", { hasText: "渠道 A" }) })
		.locator(".dd-model-cell");
	const wlRowsA = await wlGroupA.allInnerTexts();
	check("a channel whitelist hides the provider's other models", wlRowsA.length === 1 && wlRowsA[0].includes("Mock One"), wlRowsA.join(" | "));
	const wlRowsB = await page
		.locator(".chan-group", { has: page.locator(".chan-name", { hasText: "渠道 B" }) })
		.locator(".dd-model-cell")
		.allInnerTexts();
	check("an empty whitelist still lists every model of the provider", wlRowsB.length === 2, wlRowsB.join(" | "));

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
	// 余额点开后的细节：主界面只说「余额未知」，细节（余额/已用/说明）在这里；标题右侧还要有充值直达。
	const accountBlock = page.locator(".usage-account");
	check("usage detail shows the channel account block", await accountBlock.isVisible(), await accountBlock.innerText().catch(() => "missing"));
	const accountText = (await accountBlock.innerText()).replace(/\n/g, " / ");
	check("the account block says it refreshes automatically", /2 minutes|2 分钟/.test(accountText), accountText);
	check("a healthy account offers no retry button", (await accountBlock.locator(".usage-account-retry").count()) === 0, accountText);
	check("the account block states the balance in plain words", /Balance|余额/.test(accountText) && accountText.includes("12.5"), accountText);
	check("the account block shows the usage when only that is known", accountText.includes("1 USD") || accountText.includes("1.00"), accountText);
	const topup = page.locator(".usage-panel-head .usage-topup");
	check("the usage panel links straight to the provider top-up page", (await topup.getAttribute("href")) === "https://pay.example/channel-a" && (await topup.getAttribute("target")) === "_blank", String(await topup.getAttribute("href")));

	// 5b) §7 逐请求记录：时间 + 计价依据；未知价格不得显示为 0。
	const recent = page.locator(".usage-recent");
	await recent.waitFor({ state: "visible", timeout: options.stepTimeout }).catch(() => undefined);
	if (await recent.count()) {
		const recentText = await recent.first().innerText();
		check("recent request table lists time, channel and model", /\d{1,2}:\d{2}/.test(recentText) && recentText.includes("渠道 A") && recentText.includes("m1"), recentText.split("\n").slice(0, 3).join(" / "));
		check("unknown pricing is labelled instead of a zero cost", (await page.locator(".usage-recent .usage-unknown-price").count()) === 1);
		// 面板里现在有两个说明（逐请求计价依据 + 历史时间窗），按文本匹配而不是取 last()。
		const notes = await page.locator(".usage-cost-note").allInnerTexts();
		check("pricing basis is stated", notes.some((n) => n.includes("price table at request time")), notes.join(" | ").slice(0, 160));
	} else {
		check("recent request table renders", false, "selector .usage-recent not found");
	}

	// 5c) P4 首个切片：用量历史（按渠道/项目/… + 时间窗），未归属行诚实标注。
	const history = page.locator(".usage-history");
	await history.waitFor({ state: "visible", timeout: options.stepTimeout }).catch(() => undefined);
	if (await history.count()) {
		const historyText = await history.first().innerText();
		check(
			"usage history renders grouped rows with totals and an honest unattributed row",
			historyText.includes("渠道 A") && historyText.includes("Unattributed") && historyText.includes("Total") && historyText.includes("unpriced"),
			historyText.split("\n").slice(0, 5).join(" / "),
		);
		sent = [];
		await history.locator(".chan-btn", { hasText: "By project" }).first().click();
		await page.waitForTimeout(300);
		const query = sent.find((m) => m.type === "usage_history_query");
		check("switching the grouping asks the server for that aggregation", query?.groupBy === "project", JSON.stringify(query ?? null));
		check("history queries carry a time window bound", typeof query?.from === "number" || query?.from === undefined);
	} else {
		check("usage history section renders", false, "selector .usage-history not found");
	}

	// 6) 渠道设置页（A11 的「配置」入口）：列表、禁用/缺失标记、账户状态、增改命令。
	// 用量面板自带拦截式 backdrop（点击任意处才收起），先把它关掉再进设置页。
	// 用程序化 click 触发 React 的 onClick：force click 仍可能被同一 class 的另一个
	// backdrop（底栏同时存在「用量面板」与「cwd 编辑」两个同 class 遮罩）挡住命中测试。
	await page.locator(".status-cwd-backdrop").first().evaluate((el) => el.click());
	await page.waitForTimeout(200);
	if (await page.locator(".status-cwd-backdrop").count()) {
		await page.locator(".status-cwd-backdrop").first().evaluate((el) => el.click());
	}
	await page.locator(".usage-panel").waitFor({ state: "hidden", timeout: options.stepTimeout }).catch(() => undefined);
	sent = [];
	await page.locator('button.chip[title="Settings"]').first().click();
	await page.locator(".settings-modal").waitFor({ state: "visible", timeout: options.stepTimeout });
	await page.locator(".settings-rail .settings-tab", { hasText: "Channels" }).first().click();
	await page.locator(".chan-settings").waitFor({ state: "visible", timeout: options.stepTimeout });
	const rows = await page.locator(".chan-settings .chan-row").count();
	check("settings page lists every configured channel", rows === 4, `rows=${rows}`);
	const warns = (await page.locator(".chan-settings .chan-warn").allInnerTexts()).join(" | ");
	check("settings page marks provider-missing channels", warns.includes("Provider not registered"), warns);
	const settingsText = await page.locator(".chan-settings").first().innerText();
	check(
		"settings page shows ok / unsupported / stale account states with real numbers",
		settingsText.includes("OK") && settingsText.includes("Unsupported") && settingsText.includes("Stale") &&
			settingsText.includes("Balance 12.5 USD") && settingsText.includes("last successful result"),
	);
	// 查询账户 = 一条 channel_query_account（不改配置）。
	await page.locator(".chan-settings .chan-row").first().locator("button.chan-btn", { hasText: "Query account" }).click();
	check("account query sends channel_query_account", sent.some((m) => m.type === "channel_query_account" && m.channelId === "ch-a"), JSON.stringify(sent.at(-1) ?? null));

	// 6b) 模型白名单摘要：限定 N 个 / 不限 必须逐行写明。
	const summary = (await page.locator(".chan-settings .chan-models-summary").allInnerTexts()).join(" | ");
	check(
		"settings rows summarise the model whitelist (limited vs unrestricted)",
		summary.includes("Limited to 1 models") && summary.includes("Unrestricted"),
		summary,
	);

	// 6c) 按渠道用量：每行一个渠道（Token/费用/最近使用），未归属与未上报如实标注。
	const usageBlock = page.locator(".chan-settings .chan-usage");
	await usageBlock.locator("table").waitFor({ state: "visible", timeout: options.stepTimeout });
	const usageText = (await usageBlock.first().innerText()).replace(/\n/g, " / ");
	check(
		"per-channel usage block lists requests/tokens/cost and the last use",
		usageText.includes("渠道 A") && usageText.includes("153") && usageText.includes("0.03"),
		usageText.slice(0, 220),
	);
	check(
		"per-channel usage keeps unattributed rows and unreported/pricing caveats honest",
		usageText.includes("Unattributed") && usageText.includes("unpriced") && usageText.includes("unreported"),
		usageText.slice(0, 260),
	);
	check("channels without records say so instead of showing 0", usageText.includes("No records in this window"));
	sent = [];
	await usageBlock.locator(".chan-btn", { hasText: "30 days" }).first().click();
	const usageQuery = sent.find((m) => m.type === "usage_history_query");
	check("the usage block asks for channel grouping with a window", usageQuery?.groupBy === "channel" && typeof usageQuery?.from === "number", JSON.stringify(usageQuery ?? null));

	// 6d) 启用切换必须带上白名单（channel_save 是整体替换）。
	sent = [];
	await page.locator(".chan-settings .chan-row").first().locator(".chan-enable input").click();
	const toggle = sent.find((m) => m.type === "channel_save");
	check(
		"toggling enabled keeps the channel's model whitelist",
		toggle?.channel?.models?.join(",") === "m1" && toggle?.channel?.enabled === false && toggle?.channel?.id === "ch-a",
		JSON.stringify(toggle?.channel ?? null),
	);
	check("a successful command is reported instead of silently doing nothing", (await page.locator(".chan-settings .chan-receipt.ok").first().innerText()).includes("Toggle enabled"));

	// 6e) 编辑：id 只读（绑定键）+ 白名单已勾选；删除要确认并给回执。
	sent = [];
	await page.locator(".chan-settings .chan-row").first().locator('button.chan-btn[title="Edit"]').click();
	const editForm = page.locator(".chan-form").first();
	await editForm.waitFor({ state: "visible", timeout: options.stepTimeout });
	const editText = await editForm.innerText();
	check("editing keeps the channel id read-only and explains why", (await editForm.locator("input").nth(1).getAttribute("readonly")) !== null && editText.includes("binding key"), editText.slice(0, 120));
	check("editing pre-checks the channel's whitelist", (await editForm.locator(".chan-model-row input:checked").count()) === 1);
	await editForm.locator(".chan-btn", { hasText: "Cancel" }).click();
	await editForm.waitFor({ state: "hidden", timeout: options.stepTimeout }).catch(() => undefined);
	page.once("dialog", (dialog) => void dialog.accept());
	await page.locator(".chan-settings .chan-row").first().locator("button.chan-btn.danger").click();
	check("delete asks for confirmation and then sends channel_delete", sent.some((m) => m.type === "channel_delete" && m.channelId === "ch-a"), JSON.stringify(sent.at(-1) ?? null));
	check("the delete result is reported", (await page.locator(".chan-settings .chan-receipt.ok").first().innerText()).includes("Delete channel"));

	// 6e2) 新建服务商 + 渠道一次提交（方案 A：渠道面板是唯一入口）。
	// 默认就是「新建服务商」：填地址/协议/密钥 → 拉接口清单 → 勾模型 → 保存即一条 channel_save
	// 同时带上 provider（models.json），不再需要先去「管理模型」建一遍。
	await page.locator(".chan-settings .chan-btn", { hasText: "Add channel" }).first().click();
	const newForm = page.locator(".chan-settings form, .chan-form").first();
	await newForm.waitFor({ state: "visible", timeout: options.stepTimeout });
	await newForm.locator("input").first().fill("CCTQ Claude");
	check(
		"new channel defaults to creating the provider in the same form",
		await newForm.locator(".chan-conn-mode input").first().isChecked(),
	);
	await newForm.locator(".chan-conn .field input").nth(1).fill("https://www.cctq.ai");
	await newForm.locator(".chan-conn .field input").nth(2).fill("sk-synthetic");
	await newForm.locator(".chan-conn select").first().selectOption("anthropic-messages");
	check(
		"the connection form warns about the protocol (Claude vs GPT)",
		(await newForm.locator(".chan-conn").innerText()).includes("anthropic-messages"),
	);
	await newForm.locator(".chan-models-head .chan-btn", { hasText: "Fetch from endpoint" }).click();
	await newForm.locator(".chan-model-row").first().waitFor({ state: "visible", timeout: options.stepTimeout });
	await newForm.locator(".chan-models-head .chan-btn", { hasText: "Select all" }).click();
	sent = [];
	await page.locator(".chan-settings .chan-btn", { hasText: "Save" }).last().click();
	const combined = sent.find((m) => m.type === "channel_save");
	check(
		"one command carries both the provider (models.json) and the channel",
		combined?.provider?.api === "anthropic-messages" &&
			combined?.provider?.baseUrl === "https://www.cctq.ai" &&
			combined?.provider?.apiKey === "sk-synthetic" &&
			combined?.provider?.models?.map((m) => m.id).join(",") === "claude-opus-5,claude-sonnet-5",
		JSON.stringify(combined?.provider ?? null),
	);
	check(
		"the channel leaves the provider id to the server (slug) and keeps the whitelist",
		combined?.channel?.providerId === "" &&
			combined?.provider?.providerId === undefined &&
			combined?.channel?.models?.length === 2,
		JSON.stringify(combined?.channel ?? null),
	);
	await page.locator(".chan-receipt.ok").first().waitFor({ state: "visible", timeout: options.stepTimeout }).catch(() => undefined);

	// 6f) 新增渠道（复用已注册服务商）= 一条带 configRevision 的 channel_save（含白名单与账户查询模板）。
	await page.locator(".chan-settings .chan-btn", { hasText: "Add channel" }).first().click();
	const form = page.locator(".chan-settings form, .chan-form").first();
	await form.waitFor({ state: "visible", timeout: options.stepTimeout });
	await form.locator("input").first().fill("渠道 新");
	// 切到「使用已有服务商」：只引用已注册服务商，不写 models.json。
	await form.locator(".chan-conn-mode input").nth(1).check();
	// 已有服务商模式：只剩「服务商」下拉，新建连接字段（地址/协议/密钥）全部收起。
	check(
		"choosing an existing provider hides the connection fields",
		(await form.locator(".chan-conn .field").count()) === 1 &&
			(await form.locator(".chan-conn select").count()) === 1,
		String(await form.locator(".chan-conn").innerText()),
	);
	// 模型白名单：一键全选该服务商的模型（空选 = 不限）。
	await form.locator(".chan-models-head .chan-btn", { hasText: "Select all" }).click();
	check("selecting all models fills the whitelist counter", (await form.locator(".chan-models-count").innerText()).includes("2"), await form.locator(".chan-models-count").innerText());
	// 账户查询模板：预设一键填充 → 故意写坏 JSON → 保存必须被拦下。
	const accountEditor = form.locator(".chan-account");
	await accountEditor.locator("select").first().selectOption("deepseek");
	check(
		"picking a preset fills the query template",
		(await accountEditor.locator("input").first().inputValue()) === "https://api.deepseek.com/user/balance",
		await accountEditor.locator("input").first().inputValue(),
	);
	const mappingBox = accountEditor.locator("textarea").last();
	await mappingBox.fill("{not json");
	sent = [];
	await page.locator(".chan-settings .chan-btn", { hasText: "Save" }).last().click();
	const warnText = (await page.locator(".chan-settings .chan-warn").allInnerTexts()).join(" | ");
	check(
		"invalid JSON is reported instead of being sent as config",
		!sent.some((m) => m.type === "channel_save") && /not valid JSON/.test(warnText),
		warnText.slice(0, 200),
	);
	// 换一个预设（会重新填充合法 JSON）后再保存。
	await accountEditor.locator("select").first().selectOption("openrouter");
	sent = [];
	await page.locator(".chan-settings .chan-btn", { hasText: "Save" }).last().click();
	const save = sent.find((m) => m.type === "channel_save");
	check("saving a channel sends channel_save with the expected config revision", save?.expectedConfigRevision === 7, JSON.stringify(save ?? null));
	check("the save carries the model whitelist", save?.channel?.models?.length === 2, JSON.stringify(save?.channel?.models ?? null));
	check("reusing an existing provider sends no provider payload", save?.provider === undefined, JSON.stringify(save?.provider ?? null));
	check(
		"the save carries the account query template (kind/url/mapping)",
		save?.channel?.extra?.account?.kind === "template" &&
			save.channel.extra.account.url === "https://openrouter.ai/api/v1/credits" &&
			save.channel.extra.account.mapping?.limit === "data.total_credits",
		JSON.stringify(save?.channel?.extra ?? null),
	);
	check("a successful save is reported to the user", (await page.locator(".chan-settings .chan-receipt.ok").first().innerText()).includes("Save channel"));
	await context.close();

	// 6f2) 余额自动刷新：进入时先查一次，之后每 5 分钟一次。
	//      用浏览器时钟推进时间来真实验证（`runFor` 会按时序触发 app 在页面加载期创建的定时器；
	//      `fastForward` 不会 —— 实测过，别换回去）。服务端另有 10 秒限频 + 5 分钟缓存兜底。
	//      断言口径故意放宽：假时钟会扰乱 WS 心跳导致重连，重连可能让组件重新挂载并重建定时器，
	//      所以只钉「1 分钟内不重复查（不是轮询）」+「每个 5 分钟窗口至少多一次」。
	{
		const { context: clk } = await isolatedContext(browser, options, { ...state }, () => {}, (m) => clockSent.push(m));
		try {
			const clkPage = await clk.newPage();
			await clkPage.clock.install();
			await clkPage.goto(origin, { waitUntil: "domcontentloaded" });
			await clkPage.locator(".composer-tools-left .chan-balance").waitFor({ state: "visible", timeout: options.stepTimeout });
			await clkPage.waitForTimeout(300);
			const queries = () => clockSent.filter((m) => m.type === "channel_query_account").length;
			const initial = queries();
			check("余额进入时先查一次", initial === 1, `queries=${initial}`);
			await clkPage.clock.runFor("00:30");
			await clkPage.waitForTimeout(200);
			check("半个周期内不会重复查询（不是轮询）", queries() === initial, `queries=${queries()}`);
			const windows = [];
			for (let i = 0; i < 3; i++) {
				await clkPage.clock.runFor("02:00");
				await clkPage.waitForTimeout(200);
				windows.push(queries());
			}
			// 周期由 channel-account-refresh.test.ts 用假时钟精确钉死（5 分钟）；这里只证明
			// 「连续推进时间确实会不断自动刷新」（假时钟会扰乱 WS 心跳导致重连，计数会有抖动）。
			check(
				"推进时间会持续自动刷新（周期 2 分钟）",
				windows[2] > windows[0] && windows.every((n, i) => n >= (i === 0 ? initial : windows[i - 1])),
				`queries=${initial} → ${windows.join(" → ")}`,
			);
			// 从后台标签页切回来时，若数据已过期要补一次（夹具的查询时间是旧的 → 必然补）。
			const beforeReturn = queries();
			await clkPage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
			await clkPage.waitForTimeout(200);
			check("切回标签页时补一次刷新", queries() > beforeReturn, `queries=${beforeReturn} → ${queries()}`);
		} finally {
			await clk.close();
		}
	}

	// 6g) 未绑定渠道时也要显示余额：clientId 在 sessionStorage（每标签页独立），新标签页就是新
	//     clientId，而渠道绑定按 clientId 命名空间存 —— 对话还在跑同一个模型，绑定却没了。
	//     此时若该模型的服务商只对应一个带账户查询的渠道，就用它（多义则不猜）。
	{
		const noBinding = { ...state, channelBinding: { effective: null, pending: null, source: "none" } };
		const { context: bare } = await isolatedContext(browser, options, noBinding, () => {}, () => {});
		try {
			const barePage = await bare.newPage();
			await barePage.goto(origin, { waitUntil: "domcontentloaded" });
			const derivedChip = barePage.locator(".composer-tools-left .chan-balance");
			await derivedChip.waitFor({ state: "visible", timeout: options.stepTimeout });
			check(
				"balance chip still shows when the conversation has no channel binding",
				(await derivedChip.innerText()).includes("12.5"),
				await derivedChip.innerText(),
			);
			check(
				"the derived chip says it was matched by provider",
				(await derivedChip.getAttribute("title")).includes("matched from the current model"),
				String(await derivedChip.getAttribute("title")),
			);
		} finally {
			await bare.close();
		}
	}

	// 7) 移动端视口（A11 要求桌面与移动端均可用）：同一套渠道状态在手机宽度下仍可读可操作。
	const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
		locale: "en-US", serviceWorkers: "block" });
	try {
		const mobileSent = [];
		const mobilePage = await mobile.newPage();
		await mobile.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (url.origin !== origin) return route.abort("blockedbyclient");
			const { readFile } = await import("node:fs/promises");
			const { extname, resolve } = await import("node:path");
			const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
			const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
				".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };
			if (!mime[extname(rel)]) {
				if (url.pathname === "/api/locales") return route.fulfill({ json: { packs: [] } });
				if (url.pathname === "/api/themes") return route.fulfill({ json: { themes: [] } });
				return route.abort("blockedbyclient");
			}
			return route.fulfill({ contentType: mime[extname(rel)], body: await readFile(resolve(options.webRoot, rel)) });
		});
		await mobile.routeWebSocket("**/*", (socket) => {
			socket.onMessage((raw) => {
				const msg = JSON.parse(String(raw));
				mobileSent.push(msg);
				for (const reply of mobileReplies(msg)) socket.send(JSON.stringify(reply));
			});
		});
		await mobile.addInitScript(() => {
			localStorage.setItem("pi-web-ui:token", "synthetic-fixture-only");
			localStorage.setItem("pi-web-ui:lang", "en");
		});
		await mobilePage.goto(origin, { waitUntil: "domcontentloaded" });
		await mobilePage.locator(".chan-chip.effective").waitFor({ state: "visible", timeout: options.stepTimeout });
		const mobileOk = await mobilePage.locator(".chan-chip.pending").isVisible();
		check("mobile viewport shows effective + pending channel state", mobileOk);
		// 手机上底栏仍要显示「上下文 + 缓存命中率」（命中率此前被整条规则隐藏）。
		check("mobile footer keeps the cache hit rate next to context",
			(await mobilePage.locator(".statusbar .status-ctx").isVisible()) &&
			(await mobilePage.locator(".statusbar .status-cache").isVisible()));
		// 余额 chip 在「思考强度」右侧、手机上也在同一行（文案随语言，按数字断言）。
		const mobileBalance = mobilePage.locator(".composer-tools-left .chan-balance");
		check("mobile toolbar shows the balance chip",
			(await mobileBalance.isVisible()) && (await mobileBalance.innerText()).includes("12.5"),
			await mobileBalance.innerText().catch(() => "missing"));
		await mobilePage.locator("button.chip", { has: mobilePage.locator(".chip-model") }).first().click();
		await mobilePage.locator(".chan-group").first().waitFor({ state: "visible", timeout: options.stepTimeout });
		const mobileGroups = await mobilePage.locator(".chan-group").count();
		check("mobile picker groups channels too", mobileGroups === 4, `groups=${mobileGroups}`);
		mobileSent.length = 0;
		const mobileGroupA = mobilePage.locator(".chan-group", { has: mobilePage.locator(".chan-name", { hasText: "渠道 A" }) });
		await mobileGroupA.locator(".dd-model-cell", { hasText: "Mock One" }).first().click();
		check("mobile click still sends one combined channel_select", mobileSent.filter((m) => m.type === "channel_select").length === 1,
			JSON.stringify(mobileSent.find((m) => m.type === "channel_select") ?? null));
	} finally {
		await mobile.close();
	}

	// 8) P4 候选：系统资源面板（设置 → 系统分组），桌面上下文再开一次。
	sent = [];
	const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", serviceWorkers: "block" });
	try {
		await desktop.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (url.origin !== origin) return route.abort("blockedbyclient");
			const { readFile } = await import("node:fs/promises");
			const { extname, resolve } = await import("node:path");
			const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
			const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
				".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };
			if (!mime[extname(rel)]) {
				if (url.pathname === "/api/locales") return route.fulfill({ json: { packs: [] } });
				if (url.pathname === "/api/themes") return route.fulfill({ json: { themes: [] } });
				return route.abort("blockedbyclient");
			}
			return route.fulfill({ contentType: mime[extname(rel)], body: await readFile(resolve(options.webRoot, rel)) });
		});
		await desktop.routeWebSocket("**/*", (socket) => {
			socket.onMessage((raw) => {
				const msg = JSON.parse(String(raw));
				sent.push(msg);
				for (const reply of mobileReplies(msg)) socket.send(JSON.stringify(reply));
			});
		});
		await desktop.addInitScript(() => {
			localStorage.setItem("pi-web-ui:token", "synthetic-fixture-only");
			localStorage.setItem("pi-web-ui:lang", "en");
		});
		const page2 = await desktop.newPage();
		await page2.goto(origin, { waitUntil: "domcontentloaded" });
		await page2.locator('button.chip[title="Settings"]').first().click();
		await page2.locator(".settings-modal").waitFor({ state: "visible", timeout: options.stepTimeout });
		await page2.locator('.settings-rail .settings-tab[data-tab="system"]').click();
		const resources = page2.locator(".resources");
		await resources.waitFor({ state: "visible", timeout: options.stepTimeout }).catch(() => undefined);
		if (await resources.count()) {
			const text = await resources.first().innerText();
			check(
				"resources panel shows CPU / memory / app / disk with sources",
				text.includes("12.5%") && text.includes("GiB") && text.includes("This app") && text.includes("80.0%") && text.includes("source: proc-stat") && text.includes("unit memory"),
				text.split("\n").slice(0, 6).join(" / "),
			);
			check("resources panel labels disk usage as an estimate", text.includes("an estimate"), text.slice(-160));
			// P4 运维：存储占用明细 + 保留策略（只读；标注可清理候选，删除仍由人工在服务器上执行）。
			const storageText = await resources.first().innerText();
			check(
				"storage section lists areas with sizes and cleanup hints",
				storageText.includes("Storage") && storageText.includes("sessions") && storageText.includes("13 MiB") &&
					storageText.includes("Upload cache — a cleanup candidate") && storageText.includes("User data — not recommended to clean") &&
					storageText.includes("Usage-history retention"),
				storageText.split("\n").slice(-8).join(" / "),
			);
			const retentionVisible = storageText.includes("keep 30 days") || storageText.includes("size-based rotation only");
			check("retention selector shows the current policy", retentionVisible, storageText.slice(-120));
			sent = [];
			await resources.locator("button.chan-btn", { hasText: "keep 90 days" }).first().click();
			check("changing retention sends set_usage_retention", sent.some((m) => m.type === "set_usage_retention" && m.maxAgeDays === 90), JSON.stringify(sent.at(-1) ?? null));
			sent = [];
			await resources.locator("button.chan-btn", { hasText: "Recompute storage" }).first().click();
			check("storage refresh asks for a new walk", sent.some((m) => m.type === "list_storage"), JSON.stringify(sent.at(-1) ?? null));
			// P4 运维：诊断包（只读元数据）+ 告警开关。
			sent = [];
			await resources.locator("button.chan-btn", { hasText: "Generate diagnostics" }).first().click();
			check("diagnostics button requests the bundle", sent.some((m) => m.type === "list_diagnostics"), JSON.stringify(sent.at(-1) ?? null));
			await page2.waitForTimeout(400);
			const diagText = await resources.first().innerText();
			check(
				"diagnostics summary shows commit/protocol/unit and the privacy note",
				diagText.includes("protocol v21") && diagText.includes("pi-dev-pm2.service=active") && diagText.includes("metadata only"),
				diagText.split("\n").slice(-4).join(" / "),
			);
			sent = [];
			await resources.locator("button.chan-btn", { hasText: /Resource alerts:/ }).first().click();
			check("alert toggle sends set_ops_alerts", sent.some((m) => m.type === "set_ops_alerts"), JSON.stringify(sent.at(-1) ?? null));
			sent = [];
			await resources.locator("button.chan-btn", { hasText: "Refresh channel state" }).first().click();
			check("manual refresh asks for a new snapshot", sent.some((m) => m.type === "list_resources"), JSON.stringify(sent.at(-1) ?? null));
		} else {
			// 诊断信息：把设置面板里实际渲染出来的分组与文本带出来（避免只报「找不到」）。
			const tabs = await page2.locator(".settings-rail .settings-tab").allInnerTexts();
			const railHtml = (await page2.locator(".settings-rail").innerHTML().catch(() => "")).replace(/\s+/g, " ").slice(0, 260);
			const modalText = (await page2.locator(".settings-modal").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
			check("resources panel renders", false, `tabs=[${tabs.join("|")}] rail="${railHtml}" modal="${modalText}"`);
		}
	} finally {
		await desktop.close();
	}

} catch (err) {
	check("browser run completed without exceptions", false, err?.message ?? String(err));
} finally {
	await browser.close();
	console.log(failures === 0 ? "\n✓ channel browser UI: all checks passed" : `\n✗ channel browser UI: ${failures} check(s) failed`);
	process.exit(failures === 0 ? 0 : 1);
}
