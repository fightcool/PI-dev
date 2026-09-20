// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/JevSettings.tsx（被测件）,
 *   ../../web/src/components/JevRuntimeView.tsx（运行状态/命题/余额/自检展示）,
 *   ../../web/src/jev-decision.ts（出站消息 + 阈值校验）,
 *   ../../web/src/channel-account.ts（余额口径复用）, ../../server/protocol.ts（UiJev* 类型）
 * 📖 docs/DEV-CON-PROPOSAL.md §6（设置页）
 * @CONTRACT 「非黑盒」的可验证口径：
 *   ① 密钥只按名称出现：面板里没有密钥正文、没有 password 输入框，提交的载荷也只有 {providerId,keyName}；
 *   ② 运行状态 / 命题 / 最近错误逐项来自服务端，取不到就说取不到（不拿 0 顶替）；
 *   ③ 阈值不合法时保存按钮禁用并给出原因（含抖动带宽解释）；
 *   ④ 「测试连接」= jev_probe，失败原因（双语）必须显示出来；
 *   ⑤ 保存 = jev_config_save，只提交界面拥有的字段（服务端读-合并-写）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { JevSettings } from "../../web/src/components/JevSettings.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChannelApi, JevProbeResultMsg, JevUiState } from "../../web/src/use-chat.js";
import type {
	ClientMessage,
	UiAccountStatus,
	UiChannelInfo,
	UiJevGateConfig,
	UiJevProposition,
	UiJevRuntimeStatus,
} from "../../web/src/types.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// @GOTCHA LanguageProvider 在英文词典未就绪时只渲染 boot-wait 占位（jsdom 里取不到服务端）。
localStorage.setItem("pi-web-ui:lang", "zh");

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const CONFIG: UiJevGateConfig = {
	enabled: true,
	endpoint: "https://openrouter.ai/api/alpha/decisions",
	model: "typesafe/jev-1.13",
	// 只有名称 —— 密钥正文不在协议里，也不可能出现在这里。
	credentialRef: { providerId: "openrouter", keyName: "prod" },
	thresholds: { approveAt: 0.65, blockAt: 0.35 },
	timeoutMs: 8000,
	cacheTtlMs: 300000,
	minIntervalMs: 1000,
};

const RUNTIME: UiJevRuntimeStatus = {
	total: 12,
	approve: 7,
	block: 3,
	review: 2,
	failed: 1,
	inputTokens: 4200,
	outputTokens: 310,
	cost: 0.4213,
	cacheHits: 4,
	avgElapsedMs: 812,
	lastError: { at: 1758000000000, code: "E_TIMEOUT", error: "上游超时", errorEn: "upstream timeout" },
};

const EMPTY_RUNTIME: UiJevRuntimeStatus = {
	total: 0,
	approve: 0,
	block: 0,
	review: 0,
	failed: 0,
	inputTokens: 0,
	outputTokens: 0,
	cost: 0,
	cacheHits: 0,
	avgElapsedMs: 0,
	lastError: null,
};

const PROPOSITIONS: UiJevProposition[] = [
	{
		id: "is_breaking_change",
		instructions: "这次改动是否破坏向后兼容",
		criteria: { true: "存在不兼容的接口改动", false: "完全向后兼容" },
	},
	{ id: "touches_auth", instructions: "是否改到鉴权路径", criteria: { true: "改了鉴权", false: "没改鉴权" } },
];

const statusOf = (config: UiJevGateConfig = CONFIG): JevUiState => ({
	status: { type: "jev_status", reqId: 7, ok: true, status: { config, runtime: RUNTIME, propositions: PROPOSITIONS } },
	config: null,
	probe: null,
});

const PROBE_FAIL: JevProbeResultMsg = {
	type: "jev_probe_result",
	reqId: 1,
	ok: false,
	error: "未配置可用的 Jev 凭据：请在门禁设置里选择一个密钥名",
	errorEn: "No usable Jev credential: pick a key name in the gate settings",
};

const CHANNELS: UiChannelInfo[] = [
	{
		id: "or-main",
		displayName: "OpenRouter 主号",
		providerId: "openrouter",
		endpointId: "",
		credentialRef: null,
		accountRef: "or-acc",
		models: [],
		enabled: true,
		keys: [{ keyName: "prod", active: true }],
		keyMissing: false,
		providerMissing: false,
		// 配了账户查询方式（kind 非空）—— 余额行才会出现（channelAccountView 的口径）。
		account: { kind: "openai-gateway" },
	},
];
const ACCOUNTS: UiAccountStatus[] = [
	{
		accountRef: "or-acc",
		kind: "openai-gateway",
		status: "ok",
		balance: 45.43301698,
		unit: "USD",
		checkedAt: 1758000000000,
	},
];

function mount(
	initial: {
		jev?: JevUiState;
		channels?: UiChannelInfo[];
		accounts?: UiAccountStatus[];
		providerKeys?: Record<string, { name: string; active: boolean }[]>;
		providers?: { id: string; name: string; configured: boolean }[];
	} = {},
) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: ClientMessage[] = [];
	const send = (msg: ClientMessage) => {
		sent.push(msg);
		return true;
	};
	const queryChannelAccount = vi.fn(() => "cmd-1");
	const channelApi = { queryChannelAccount } as unknown as ChannelApi;
	const render = (props: {
		jev?: JevUiState;
		channels?: UiChannelInfo[];
		accounts?: UiAccountStatus[];
		providerKeys?: Record<string, { name: string; active: boolean }[]>;
		providers?: { id: string; name: string; configured: boolean }[];
	}) =>
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(JevSettings, {
					jev: props.jev ?? statusOf(),
					send,
					channelApi,
					providerKeys: props.providerKeys ?? {
						openrouter: [
							{ name: "prod", active: true },
							{ name: "backup", active: false },
						],
					},
					providers: props.providers ?? [{ id: "openrouter", name: "OpenRouter", configured: true }],
					models: [],
					channels: props.channels ?? CHANNELS,
					accounts: props.accounts ?? ACCOUNTS,
					onOpenProviderKeys: () => {},
				}) as ReactNode,
			),
		);
	act(() => render(initial));
	return { container, sent, queryChannelAccount, rerender: (p: Parameters<typeof render>[0]) => act(() => render(p)) };
}

const textOf = (c: HTMLElement) => c.textContent ?? "";
const buttons = (c: HTMLElement) => [...c.querySelectorAll("button")];
const byText = (c: HTMLElement, text: string) => buttons(c).find((b) => (b.textContent ?? "").trim().includes(text));
const click = (el: Element | undefined) => {
	expect(el, "target button exists").toBeTruthy();
	act(() => {
		el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};
/** 受控 input 赋值：必须走原生 setter，否则 React 的 value tracker 认为没变、onChange 不触发。 */
const type = (input: HTMLInputElement, value: string) => {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
};
/** 受控 select 赋值：同样走原生 setter + change（React 的 select 监听 change）。 */
const selectOption = (select: HTMLSelectElement, value: string) => {
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
	act(() => {
		setter.call(select, value);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
};
const cards = (c: HTMLElement) =>
	Object.fromEntries(
		[...c.querySelectorAll(".resource-card")].map((el) => [
			el.querySelector(".resource-title")?.textContent ?? "",
			el.querySelector(".resource-value")?.textContent ?? "",
		]),
	);

describe("Jev 决策门禁分区（设置面板）", () => {
	it("挂载即拉一次运行状态（jev_status，reqId 从 1 起）", () => {
		const { sent } = mount();
		expect(sent[0]).toEqual({ type: "jev_status", reqId: 1 });
	});

	it("密钥只按名称回显：没有密钥正文、没有 password 输入框", () => {
		const { container } = mount();
		expect(textOf(container)).toContain("openrouter / prod");
		expect(container.querySelectorAll('input[type="password"]').length).toBe(0);
		expect(container.innerHTML).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
	});

	it("密钥名已不在列表里：照原样显示并说明它已失效（不静默变成别的密钥）", () => {
		const { container } = mount({ providerKeys: { openrouter: [{ name: "backup", active: true }] } });
		const keySelect = [...container.querySelectorAll("select")][1] as HTMLSelectElement;
		expect(keySelect.value).toBe("prod");
		expect([...keySelect.options].map((o) => o.value)).toContain("prod");
		expect(textOf(container)).toContain("该密钥名在当前服务商下已不存在");
	});

	it("切服务商默认选该服务商当前的 active 密钥名（不是留空，也不是沿用上一家的名字）", () => {
		const { container } = mount({
			providerKeys: {
				openrouter: [{ name: "prod", active: true }],
				deepseek: [
					{ name: "old", active: false },
					{ name: "main", active: true },
				],
			},
			providers: [
				{ id: "openrouter", name: "OpenRouter", configured: true },
				{ id: "deepseek", name: "DeepSeek", configured: true },
			],
		});
		const [providerSelect, keySelect] = [...container.querySelectorAll("select")] as HTMLSelectElement[];
		selectOption(providerSelect, "deepseek");
		expect(keySelect.value).toBe("main");
	});

	it('选了服务商但没选密钥名：保存拦住（服务端只接受明确名称，不会得到 keyName:""）', () => {
		const { container, sent } = mount({
			providerKeys: { openrouter: [{ name: "prod", active: false }] },
			jev: statusOf({ ...CONFIG, credentialRef: null }),
		});
		const [providerSelect] = [...container.querySelectorAll("select")] as HTMLSelectElement[];
		selectOption(providerSelect, "openrouter");
		expect(textOf(container)).toContain("服务端只接受明确名称的密钥引用");
		click(byText(container, "保存配置"));
		expect(sent.filter((m) => m.type === "jev_config_save").length).toBe(0);
	});

	it("端点必须是 https 且不能为空：先拦住保存（服务端也会拒，这里只省一轮往返）", () => {
		const { container, sent } = mount();
		const endpoint = [...container.querySelectorAll("input")].find((i) =>
			i.value.startsWith("https://openrouter"),
		) as HTMLInputElement;
		type(endpoint, "http://openrouter.ai/api/alpha/decisions");
		expect(textOf(container)).toContain("必须是 https 地址");
		click(byText(container, "保存配置"));
		expect(sent.filter((m) => m.type === "jev_config_save").length).toBe(0);
		type(endpoint, "");
		expect(textOf(container)).toContain("必须是 https 地址");
	});

	it("模型 ID 为空拦住保存（默认值只在字段缺省时生效，空串会被服务端拒）", () => {
		const { container, sent } = mount();
		const model = [...container.querySelectorAll("input")].find(
			(i) => i.value === "typesafe/jev-1.13",
		) as HTMLInputElement;
		type(model, "   ");
		expect(textOf(container)).toContain("模型 ID 不能为空");
		click(byText(container, "保存配置"));
		expect(sent.filter((m) => m.type === "jev_config_save").length).toBe(0);
	});

	it("未绑定密钥：可以保存（配好再挂钥匙），但要如实说门禁叫不动 Jev", () => {
		const { container, sent } = mount({ jev: statusOf({ ...CONFIG, credentialRef: null }) });
		expect(textOf(container)).toContain("未绑定密钥：门禁无法调用 Jev");
		click(byText(container, "保存配置"));
		const save = sent.find((m) => m.type === "jev_config_save") as Extract<ClientMessage, { type: "jev_config_save" }>;
		expect(save.config.credentialRef).toBeNull();
	});

	it("运行状态逐项来自服务端（总调用/三分支/失败/token/费用/缓存/平均耗时）", () => {
		const { container } = mount();
		const c = cards(container);
		expect(c["总调用"]).toBe("12");
		expect(c["放行"]).toBe("7");
		expect(c["拦下"]).toBe("3");
		expect(c["转人工"]).toBe("2");
		expect(c["失败"]).toBe("1");
		expect(c["缓存命中"]).toBe("4");
		expect(c["输入"]).toBe("4200");
		expect(c["输出"]).toBe("310");
		expect(c["费用"]).toBe("0.42");
		expect(c["平均耗时"]).toBe("812 ms");
	});

	it("最近一次错误保留原始 code 与原文（不吞掉服务端事实）", () => {
		const { container } = mount();
		expect(textOf(container)).toContain("E_TIMEOUT");
		expect(textOf(container)).toContain("上游超时");
	});

	it("没有调用记录时先说一句「还没有调用记录」（下面的 0 是服务端事实，不是编的）", () => {
		const { container } = mount({
			jev: {
				status: {
					type: "jev_status",
					reqId: 7,
					ok: true,
					status: { config: CONFIG, runtime: EMPTY_RUNTIME, propositions: [] },
				},
				config: null,
				probe: null,
			},
		});
		expect(textOf(container)).toContain("还没有调用记录");
		expect(cards(container)["总调用"]).toBe("0");
		expect(textOf(container)).toContain("服务端没有返回命题清单");
	});

	it("命题清单：默认一行摘要，展开才显示成立/不成立的口径", () => {
		const { container } = mount();
		expect(textOf(container)).toContain("is_breaking_change");
		expect(textOf(container)).not.toContain("存在不兼容的接口改动");
		click(byText(container, "展开"));
		expect(textOf(container)).toContain("存在不兼容的接口改动");
		expect(textOf(container)).toContain("完全向后兼容");
	});

	it("阈值不合法 → 保存禁用并说明原因（含抖动带宽）", () => {
		const { container, sent } = mount();
		const approve = container.querySelector('input[type="number"]') as HTMLInputElement;
		type(approve, "0.2"); // blockAt 0.35 ≥ approveAt 0.2 → 非法
		expect(textOf(container)).toContain("阈值不合法");
		const saveBtn = byText(container, "保存配置") as HTMLButtonElement;
		expect(saveBtn.disabled).toBe(true);
		click(saveBtn);
		expect(sent.filter((m) => m.type === "jev_config_save").length).toBe(0);
		expect(textOf(container)).toContain("0.08"); // 解释文案必须讲清抖动带宽
	});

	it("保存提交的只有界面拥有的字段（无密钥正文字段，阈值取当前输入）", () => {
		const { container, sent } = mount();
		const [approve, block] = [...container.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
		type(approve, "0.7");
		type(block, "0.3");
		click(byText(container, "保存配置"));
		const save = sent.find((m) => m.type === "jev_config_save");
		expect(save).toBeTruthy();
		const config = (save as Extract<ClientMessage, { type: "jev_config_save" }>).config;
		expect(Object.keys(config).sort()).toEqual(["credentialRef", "enabled", "endpoint", "model", "thresholds"]);
		expect(config.thresholds).toEqual({ approveAt: 0.7, blockAt: 0.3 });
		expect(config.credentialRef).toEqual({ providerId: "openrouter", keyName: "prod" });
		expect(JSON.stringify(config)).not.toMatch(/sk-/);
	});

	it("别名模型（-latest）给出漂移警告", () => {
		const { container } = mount();
		const modelInput = [...container.querySelectorAll("input")].find(
			(i) => i.value === "typesafe/jev-1.13",
		) as HTMLInputElement;
		type(modelInput, "typesafe/jev-latest");
		expect(textOf(container)).toContain("别名");
	});

	it("服务端拒绝保存时把原因显示出来（rejected 不是静默失败）", () => {
		const { container } = mount({
			jev: {
				...statusOf(),
				config: {
					type: "jev_config_result",
					reqId: 1,
					ok: false,
					phase: "rejected",
					error: "拦截阈值 blockAt（0.8）必须小于放行阈值 approveAt（0.2）",
					errorEn: "The block threshold (0.8) must be lower than the approve threshold (0.2)",
				},
			},
		});
		expect(textOf(container)).toContain("服务端拒绝了这次配置");
		expect(textOf(container)).toContain("必须小于放行阈值");
	});

	it("「测试连接」发 jev_probe；失败原因（原文）必须显示", () => {
		const { container, sent, rerender } = mount();
		click(byText(container, "测试连接"));
		expect(sent.find((m) => m.type === "jev_probe")).toEqual({ type: "jev_probe", reqId: 1 });
		rerender({ jev: { ...statusOf(), probe: PROBE_FAIL } });
		expect(textOf(container)).toContain("未配置可用的 Jev 凭据");
	});

	it("自检成功：显示结论、逐项分数与本次调用审计 + 原始 JSON", () => {
		const { container, rerender } = mount();
		rerender({
			jev: {
				...statusOf(),
				probe: {
					type: "jev_probe_result",
					reqId: 1,
					ok: true,
					decision: {
						outcome: "block",
						reason: "判定项触及拦截阈值（is_breaking_change=0.02；拦截阈值 0.1）",
						reasonEn: "Checks at or below the block threshold",
						checks: { is_breaking_change: 0.02 },
						audit: {
							model: "typesafe/jev-1.13",
							elapsedMs: 640,
							cache: "miss",
							inputTokens: 120,
							outputTokens: 12,
							cost: 0.0002,
						},
					},
				},
			},
		});
		expect(textOf(container)).toContain("连接正常");
		expect(textOf(container)).toContain("拦下");
		expect(textOf(container)).toContain("is_breaking_change=0.02");
		expect(textOf(container)).toContain("typesafe/jev-1.13");
		expect(textOf(container)).toContain("缓存未命中");
		expect(container.querySelector("pre")?.textContent).toContain('"outcome": "block"');
	});

	it("服务商还没存密钥时：仍能选到已注册的服务商，并给出「先建密钥」的一步", () => {
		const { container } = mount({
			providerKeys: {},
			providers: [{ id: "openrouter", name: "OpenRouter", configured: false }],
		});
		const providerSelect = container.querySelector("select") as HTMLSelectElement;
		expect([...providerSelect.options].map((o) => o.value)).toContain("openrouter");
		expect(textOf(container)).toContain("请先在「内置服务商与密钥」里为它创建密钥");
	});

	it("保存生效后表单回到服务端权威值（草稿不一直是本地副本）", () => {
		const { container, sent, rerender } = mount();
		const [approve] = [...container.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
		type(approve, "0.7");
		click(byText(container, "保存配置"));
		const reqId = (sent.find((m) => m.type === "jev_config_save") as { reqId: number }).reqId;
		// 服务端回一份归一化过的配置（这里把 0.7 收成 0.65）：输入框要跟着服务端走。
		rerender({
			jev: {
				...statusOf(),
				config: { type: "jev_config_result", reqId, ok: true, phase: "applied", config: CONFIG },
			},
		});
		expect((container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe("0.65");
		expect(textOf(container)).toContain("配置已生效");
	});

	it("余额复用渠道账户查询：有渠道显示格式化余额，没有则如实说明（不显示 0）", () => {
		const withChannel = mount();
		expect(textOf(withChannel.container)).toContain("45.43");
		expect(textOf(withChannel.container)).toContain("OpenRouter 主号");
		act(() => root?.unmount());
		const withoutChannel = mount({ channels: [], accounts: [] });
		expect(textOf(withoutChannel.container)).toContain("没有可用于余额查询的渠道");
	});
});
