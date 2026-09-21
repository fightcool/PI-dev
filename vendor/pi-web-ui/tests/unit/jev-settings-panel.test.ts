// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/JevSettings.tsx（被测件）,
 *   ../../web/src/components/JevRuntimeView.tsx（运行状态/命题/余额/自检展示）,
 *   ../../web/src/jev-decision.ts（出站消息 + 阈值校验）,
 *   ../../web/src/components/GatewayUsageBlock.tsx（余额行复用的网关自报用量口径）,
 *   ../../server/protocol.ts（UiJev* 类型）
 * 📖 docs/DEV-CON-PROPOSAL.md §6（设置页）
 * @CONTRACT 「非黑盒」的可验证口径：
 *   ① 密钥只按名称出现：面板里没有密钥正文、没有 password 输入框，提交的载荷也只有 {providerId,keyName}；
 *   ② 运行状态 / 命题 / 最近错误逐项来自服务端，取不到就说取不到（不拿 0 顶替）；
 *   ③ 阈值不合法时保存按钮禁用并给出原因（含抖动带宽解释）；
 *   ④ 「测试连接」= jev_probe，失败原因（双语）必须显示出来；
 *   ⑤ 保存 = jev_config_save，只提交界面拥有的字段（服务端读-合并-写）；
 *   ⑥ 真实样本留痕开关 + 复盘状态：代价与边界（4000 / «redacted» / 0600）必须写在界面上，
 *      recordSamples **只在改过**时才上行（缺省 = 服务端保留磁盘上的值）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { JevSettings } from "../../web/src/components/JevSettings.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { JevProbeResultMsg, JevUiState } from "../../web/src/use-chat.js";
import type {
	ClientMessage,
	UiJevGateConfig,
	UiJevProposition,
	UiJevReviewStatus,
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
	// 全量留痕默认开（协议默认 true）。
	recordSamples: true,
};

/** UiJevReviewStatus 夹具：默认未到期、无待复盘；用例只用它关心的字段。 */
function review(patch: Partial<UiJevReviewStatus>): UiJevReviewStatus {
	return {
		pending: 0,
		due: false,
		reason: null,
		oldestPendingAt: null,
		newestPendingAt: null,
		needsHumanLabel: 0,
		thresholds: { minEntries: 40, maxAgeMs: 7 * 24 * 60 * 60_000 },
		lastAckAt: null,
		...patch,
	};
}

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
	diskHits: 3,
	avgElapsedMs: 812,
	lastError: { at: 1758000000000, code: "E_TIMEOUT", error: "上游超时", errorEn: "upstream timeout" },
	reviewStatus: review({ pending: 12, due: true, reason: "entries", oldestPendingAt: 1758000000000 }),
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
	diskHits: 0,
	avgElapsedMs: 0,
	lastError: null,
	reviewStatus: review({}),
};

// 命题文本即**送进模型的文本**，服务端注册表里是英文（官方：Jev 英文准确率最优）。
const PROPOSITIONS: UiJevProposition[] = [
	{
		id: "change_preserves_public_api",
		instructions: "Decide whether this change keeps the public API compatible.",
		criteria: {
			true: "Yes: no public export is removed or renamed.",
			false: "No: it removes or changes a public interface.",
		},
	},
	{
		id: "touches_auth",
		instructions: "Decide whether this change touches the auth path.",
		criteria: { true: "Yes: the auth path is touched.", false: "No: the auth path is untouched." },
	},
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


function mount(
	initial: {
		jev?: JevUiState;
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
	// 网关自报用量：余额行现在读的是这份读数（不再有渠道账户查询）。
	const gatewayUsage = { ok: null as boolean | null, usage: undefined, duplicates: [] } as never;
	const render = (props: {
		jev?: JevUiState;
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
					opsApi: { queryGatewayUsage: () => 1, getGateway: () => 1, saveGateway: () => 1, refreshProviderModels: () => 1 } as never,
					gatewayUsage,
					providerKeys: props.providerKeys ?? {
						openrouter: [
							{ name: "prod", active: true },
							{ name: "backup", active: false },
						],
					},
					providers: props.providers ?? [{ id: "openrouter", name: "OpenRouter", configured: true }],
					models: [],
					onOpenGatewayTab: () => {},
				}) as ReactNode,
			),
		);
	act(() => render(initial));
	return { container, sent, rerender: (p: Parameters<typeof render>[0]) => act(() => render(p)) };
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

/* ---- 逐判定项阈值一节的定位：按 data-prop-id，不靠行序 ---- */
type ClientSave = Extract<ClientMessage, { type: "jev_config_save" }>;
/** 某个判定项那一行（.jev-prop-row；故意不是 .set-row，见组件头部 @GOTCHA）。 */
const propRow = (c: HTMLElement, id: string) => c.querySelector(`.jev-prop-row[data-prop-id="${id}"]`) as HTMLElement;
/** 那一行的两个数字输入：[放行, 拦截]。 */
const propInputs = (c: HTMLElement, id: string) =>
	[...propRow(c, id).querySelectorAll('input[type="number"]')] as HTMLInputElement[];
const propClear = (c: HTMLElement, id: string) =>
	propRow(c, id).querySelector("button.set-btn-mini") as HTMLButtonElement;
/** 点一次「保存配置」并取出出站帧的 config（没有发出则返回 undefined）。 */
const savePayload = (c: HTMLElement, sent: ClientMessage[]): ClientSave["config"] | undefined => {
	sent.length = 0;
	click(byText(c, "保存配置"));
	return (sent.find((m) => m.type === "jev_config_save") as ClientSave | undefined)?.config;
};

/** 配置里带逐判定项独立阈值（键 = 判定项 id）。 */
const configWithOverrides = (
	perProposition: Record<string, { approveAt?: number; blockAt?: number }>,
): UiJevGateConfig => ({ ...CONFIG, thresholds: { ...CONFIG.thresholds, perProposition } });

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
		// 费用口径与用量面板同源（web/src/gateway-usage.ts 的 formatUsd）：带币种、按量级给精度。
		// 0.421 在这种量级下给 3 位小数（旧口径固定 2 位会把它显示成 0.42，丢精度）。
		expect(c["费用"]).toBe("$0.421");
		expect(c["平均耗时"]).toBe("812 ms");
	});

	it("磁盘命中单列一栏，并给出 CLI 清缓存的提示（缓存是派生数据，不开新接口）", () => {
		const { container } = mount();
		expect(cards(container)["磁盘命中（持久缓存）"]).toBe("3");
		expect(textOf(container)).toContain("npm run jev -- cache clear");
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
		expect(textOf(container)).toContain("change_preserves_public_api");
		expect(textOf(container)).not.toContain("Yes: no public export is removed or renamed.");
		click(byText(container, "展开"));
		expect(textOf(container)).toContain("Yes: no public export is removed or renamed.");
		expect(textOf(container)).toContain("No: it removes or changes a public interface.");
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
						reason: "判定项触及拦截阈值（change_preserves_public_api=0.02；拦截阈值 0.1）",
						reasonEn: "Checks at or below the block threshold",
						checks: { change_preserves_public_api: 0.02 },
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
		expect(textOf(container)).toContain("change_preserves_public_api=0.02");
		expect(textOf(container)).toContain("typesafe/jev-1.13");
		expect(textOf(container)).toContain("缓存未命中");
		expect(container.querySelector("pre")?.textContent).toContain('"outcome": "block"');
	});

	it("服务商还没存密钥时：能选到已注册的服务商，并就地给出建密钥的一步（不把人推去别的面板）", () => {
		const { container, sent } = mount({
			providerKeys: {},
			providers: [{ id: "openrouter", name: "OpenRouter", configured: false }],
		});
		const providerSelect = container.querySelector("select") as HTMLSelectElement;
		expect([...providerSelect.options].map((o) => o.value)).toContain("openrouter");
		// OpenRouter 排第一（否则要在 46 项里找它）
		expect([...providerSelect.options][1].value).toBe("openrouter");
		// 就地建密钥：名 + 值两个输入 + 新建按钮，且值框是 password
		const pw = container.querySelector('.jev-newkey input[type="password"]') as HTMLInputElement;
		expect(pw).not.toBeNull();
		expect(textOf(container)).toContain("就在下面新建一把");
		// 填完点创建 → 走既有 add_provider_key（同一份密钥库，不新增事实源）
		const nameInput = container.querySelector('.jev-newkey input:not([type="password"])') as HTMLInputElement;
		type(nameInput, "jev");
		type(pw, "SYNTHETIC-NOT-A-REAL-KEY");
		click(byText(container, "新建密钥"));
		const add = sent.find((m) => m.type === "add_provider_key") as { provider: string; name?: string } | undefined;
		expect(add?.provider).toBe("openrouter");
		expect(add?.name).toBe("jev");
		// 发完立刻清空值框：界面不再持有密钥正文
		expect((container.querySelector('.jev-newkey input[type="password"]') as HTMLInputElement).value).toBe("");
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

	it("余额行复用网关自报用量：没有读数时如实说明，绝不显示 0", () => {
		// 单网关接入后余额只有一个来源（网关自己的账单接口，见 GatewayUsageBlock）；
		// 这里只钉住「没读数时不编数字」这一条底线，具体格式由 gateway-usage 单测覆盖。
		const { container } = mount();
		expect(container.querySelector(".gw-usage")).not.toBeNull();
		expect(textOf(container)).toContain("网关自报用量");
		expect(textOf(container)).not.toContain("$0.00");
	});
});

describe("Jev 决策门禁：逐判定项阈值", () => {
	const [API, AUTH] = ["change_preserves_public_api", "touches_auth"] as const;

	it("逐一列出全部命题：判定语句 + 放行/拦截两个输入 + 清除，全局那节标注为全局默认", () => {
		const { container } = mount();
		const rows = [...container.querySelectorAll(".jev-prop-row")];
		expect(rows.map((r) => (r as HTMLElement).dataset.propId)).toEqual([API, AUTH]);
		expect(propRow(container, API).querySelector(".jev-prop-name")?.textContent).toBe(API);
		// 判定语句 + title 放全文（整段英文说明不铺在面板上）。
		const desc = propRow(container, API).querySelector(".jev-prop-desc") as HTMLElement;
		expect(desc.getAttribute("title")).toBe(PROPOSITIONS[0].instructions);
		expect(desc.textContent).toBe(PROPOSITIONS[0].instructions);
		// 两个数字输入 + 一个清除按钮。
		expect(propInputs(container, API).length).toBe(2);
		expect(propClear(container, API).textContent).toContain("清除");
		// 默认留空 = 继承全局（placeholder 说得清楚，不是让人猜空值是什么）。
		expect(propInputs(container, API)[0].value).toBe("");
		expect(propInputs(container, API)[0].placeholder).toContain("继承全局");
		// 全局那一节被明确标注为「全局默认」（否则两节阈值看不出谁盖谁）。
		expect(textOf(container)).toContain("全局默认");
		// 每个项都显示了「生效阈值」（未覆盖 = 全局值）。
		expect(propRow(container, API).textContent).toContain("继承全局");
		expect(propRow(container, API).textContent).toContain("0.65 / 0.35");
	});

	it("判定语句超长时截断到一行，title 里保留全文（与命题清单同一份服务端文本）", () => {
		const long = {
			id: "long_proposition",
			instructions: `Decide something long. ${"x".repeat(200)}`,
			criteria: { true: "t", false: "f" },
		};
		const { container } = mount({
			jev: {
				status: {
					type: "jev_status",
					reqId: 7,
					ok: true,
					status: { config: CONFIG, runtime: RUNTIME, propositions: [long] },
				},
				config: null,
				probe: null,
			},
		});
		const desc = propRow(container, long.id).querySelector(".jev-prop-desc") as HTMLElement;
		expect(desc.getAttribute("title")).toBe(long.instructions);
		expect(desc.textContent).toContain("…");
		expect((desc.textContent ?? "").length).toBeLessThan(long.instructions.length);
	});

	it("这节必须说明为什么需要独立阈值（实测分数区间错开）与空白带的含义", () => {
		const { container } = mount();
		const hint = textOf(container);
		expect(hint).toContain("0.4");
		expect(hint).toContain("0.7");
		expect(hint).toContain("0.8");
		expect(hint).toContain("转人工");
		expect(hint).toContain("三态判定");
	});

	it("只改一项：提交的 payload 只含那一项（绝不整块回写别人的阈值）", () => {
		const { container, sent } = mount();
		type(propInputs(container, AUTH)[0], "0.4");
		const payload = savePayload(container, sent);
		expect(payload).toBeTruthy();
		const per = payload!.thresholds?.perProposition as Record<string, unknown>;
		expect(Object.keys(per)).toEqual([AUTH]);
		expect(per[AUTH]).toEqual({ approveAt: 0.4 });
		// 只填了一侧：另一侧**根本不带这个字段**（带 undefined 会把合并语义改掉）。
		expect(Object.keys(per[AUTH] as object)).toEqual(["approveAt"]);
		// 未改过的那一项根本不出现（否则会把别的客户端刚设的值覆盖掉）。
		expect(per[API]).toBeUndefined();
	});

	it("留空 = 继承全局：留空的一侧不发字段，没碰过的项也不带出去", () => {
		const { container, sent } = mount({
			jev: statusOf(configWithOverrides({ [AUTH]: { approveAt: 0.5, blockAt: 0.2 } })),
		});
		// 回显的覆盖值已经在输入框里。
		expect(propInputs(container, AUTH)[0].value).toBe("0.5");
		// 把放行一侧清空（留空 = 继承全局），只改拦截：提交时放行字段整个不出现。
		type(propInputs(container, AUTH)[0], "");
		type(propInputs(container, AUTH)[1], "0.1");
		const per = savePayload(container, sent)!.thresholds?.perProposition as Record<string, unknown>;
		expect(Object.keys(per)).toEqual([AUTH]);
		expect(per[AUTH]).toEqual({ blockAt: 0.1 });
		expect(Object.keys(per[AUTH] as object)).toEqual(["blockAt"]);
	});

	it("清除 = 提交 { id: null }（删掉磁盘上的独立阈值，回到继承全局）", () => {
		const { container, sent } = mount({
			jev: statusOf(configWithOverrides({ [API]: { approveAt: 0.45 }, [AUTH]: { approveAt: 0.5, blockAt: 0.2 } })),
		});
		click(propClear(container, AUTH));
		// 清除后输入框立刻为空（且生效值回到全局）。
		expect(propInputs(container, AUTH)[0].value).toBe("");
		expect(propInputs(container, AUTH)[1].value).toBe("");
		expect(propRow(container, AUTH).textContent).toContain("继承全局");
		const per = savePayload(container, sent)!.thresholds?.perProposition as Record<string, unknown>;
		expect(per[AUTH]).toBeNull();
		// 没碰过的另一项仍然不提交。
		expect(Object.keys(per)).toEqual([AUTH]);
	});

	it("越界或拦截 ≥ 放行：就地拦下、保存禁用、一个请求都不发", () => {
		const { container, sent } = mount();
		const saveBtn = byText(container, "保存配置") as HTMLButtonElement;
		// ① 越界（>1）。
		type(propInputs(container, API)[0], "1.4");
		expect(propRow(container, API).textContent).toContain("独立阈值不合法");
		expect(saveBtn.disabled).toBe(true);
		sent.length = 0;
		click(saveBtn);
		expect(sent.filter((m) => m.type === "jev_config_save").length).toBe(0);
		// ② 拦截 ≥ 放行：留空的一侧按**全局**补齐后再判（全局 0.65 / 0.35）。
		type(propInputs(container, API)[0], "");
		type(propInputs(container, API)[1], "0.7");
		expect(propRow(container, API).textContent).toContain("独立阈值不合法");
		expect(saveBtn.disabled).toBe(true);
		sent.length = 0;
		click(saveBtn);
		expect(sent.filter((m) => m.type === "jev_config_save").length).toBe(0);
		// ③ 只把放行压到全局拦截值以下：生效是 0.35 ≥ 0.3，同样拦下。
		type(propInputs(container, API)[1], "");
		type(propInputs(container, API)[0], "0.3");
		expect(propRow(container, API).textContent).toContain("独立阈值不合法");
		// 修好之后立刻可以保存（就地提示不是永久禁用）。
		type(propInputs(container, API)[0], "0.5");
		expect(propRow(container, API).textContent).not.toContain("独立阈值不合法");
		expect(saveBtn.disabled).toBe(false);
	});

	it("有 perProposition 时面板显示覆盖值（不是全局值），没覆盖的一侧走全局", () => {
		const { container } = mount({
			jev: statusOf(configWithOverrides({ [API]: { approveAt: 0.45 } })),
		});
		// 覆盖值回显到输入框（0.45，不是全局的 0.65）；没覆盖的一侧留空 = 继承。
		expect(propInputs(container, API)[0].value).toBe("0.45");
		expect(propInputs(container, API)[1].value).toBe("");
		// 生效阈值一行写的是「独立阈值 0.45 / 0.35」（拦截侧回落全局，不是 0.35 就不会被看出来）。
		const rowText = propRow(container, API).textContent ?? "";
		expect(rowText).toContain("独立阈值");
		expect(rowText).toContain("0.45 / 0.35");
		// 没被覆盖的判定项如实显示「继承全局 0.65 / 0.35」。
		const otherText = propRow(container, AUTH).textContent ?? "";
		expect(otherText).toContain("继承全局");
		expect(otherText).toContain("0.65 / 0.35");
	});

	it("保存生效后逐判定项输入回到回执里的权威值（草稿不残留）", () => {
		const { container, sent, rerender } = mount();
		type(propInputs(container, API)[0], "0.5");
		sent.length = 0;
		click(byText(container, "保存配置"));
		const reqId = (sent.find((m) => m.type === "jev_config_save") as ClientSave).reqId;
		// 服务端回一份归一化过的配置（0.5 → 0.45）：输入框跟着回执走。
		rerender({
			jev: {
				...statusOf(configWithOverrides({ [API]: { approveAt: 0.45 } })),
				config: {
					type: "jev_config_result",
					reqId,
					ok: true,
					phase: "applied",
					config: configWithOverrides({ [API]: { approveAt: 0.45 } }),
				},
			},
		});
		expect(propInputs(container, API)[0].value).toBe("0.45");
	});

	it("只有保存回执里有独立阈值时也显示它（服务端保存后不补推 jev_status，不能退回旧值）", () => {
		const { container, sent, rerender } = mount();
		// 编辑后保存：回执带着刚生效的独立阈值，而 status.config 还是保存前的那份（没有覆盖）。
		type(propInputs(container, API)[0], "0.45");
		sent.length = 0;
		click(byText(container, "保存配置"));
		const reqId = (sent.find((m) => m.type === "jev_config_save") as ClientSave).reqId;
		rerender({
			jev: {
				...statusOf(), // status 里的 config 仍然没有 perProposition
				config: {
					type: "jev_config_result",
					reqId,
					ok: true,
					phase: "applied",
					config: configWithOverrides({ [API]: { approveAt: 0.45 } }),
				},
			},
		});
		// 输入框显示回执里的值（不是退回空），清除按钮可用（确实有独立阈值可清）。
		expect(propInputs(container, API)[0].value).toBe("0.45");
		expect(propClear(container, API).disabled).toBe(false);
		expect(propRow(container, API).textContent).toContain("独立阈值");
		// 而没被覆盖的那一项仍然没得清（不发无意义的删除帧）。
		expect(propClear(container, AUTH).disabled).toBe(true);
	});

	it("「重新载入」丢弃本地逐判定项草稿（不只是拉一次状态）", () => {
		// reqId 与服务端回包对齐，“重新载入”才不会被 busy 禁用（单测里没有真实往返）。
		const base = statusOf();
		const { container } = mount({ jev: { ...base, status: { ...base.status!, reqId: 1 } } });
		type(propInputs(container, API)[0], "0.5");
		expect(propInputs(container, API)[0].value).toBe("0.5");
		// .chan-settings-head 的第一个按钮就是「重新载入」。
		click(container.querySelector(".chan-settings-head button") as HTMLButtonElement);
		// 服务端生效值里没有覆盖 → 重载后回到空（继承全局）。
		expect(propInputs(container, API)[0].value).toBe("");
	});
});

/* ------------------------------------------------------------------ */
/* 真实样本留痕（全量留痕）+ 复盘状态                                    */
/* ------------------------------------------------------------------ */

/** 「记录真实决策样本」那个开关：面板里有两个 .chan-enable，按标签文字定位，不靠行序。 */
const sampleToggle = (c: HTMLElement) =>
	[...c.querySelectorAll(".chan-enable")]
		.find((el) => (el.textContent ?? "").includes("记录真实决策样本"))
		?.querySelector("input") as HTMLInputElement | undefined;
/** 点一下受控 checkbox：走原生 click（同时翻转 checked 并发事件，React 的 change 插件才看得到）。 */
const toggleCheckbox = (input: HTMLInputElement) =>
	act(() => {
		input.click();
	});
/** 服务端把这次保存应用了：回执里的 config 就是新的生效基线（服务端保存后不补推 jev_status）。 */
const applied = (reqId: number, config: UiJevGateConfig): JevUiState => ({
	...statusOf(),
	config: { type: "jev_config_result", reqId, ok: true, phase: "applied", config },
});

describe("Jev 决策门禁：真实样本留痕与复盘", () => {
	it("留痕开关随服务端值回显：默认勾选，服务端关掉时就是未勾选", () => {
		const on = mount();
		expect(sampleToggle(on.container), "开关存在").toBeTruthy();
		expect(sampleToggle(on.container)!.checked).toBe(true);
		expect(textOf(on.container)).toContain("全量留痕");
		act(() => root?.unmount());
		const off = mount({ jev: statusOf({ ...CONFIG, recordSamples: false }) });
		expect(sampleToggle(off.container)!.checked).toBe(false);
	});

	it("取消勾选后保存：出站载荷里 recordSamples 为 false", () => {
		const { container, sent } = mount();
		toggleCheckbox(sampleToggle(container)!);
		expect(sampleToggle(container)!.checked).toBe(false);
		const payload = savePayload(container, sent);
		expect(payload?.recordSamples).toBe(false);
	});

	it("没碰过这个开关就不上行这个字段（缺省 = 服务端保留磁盘上的值，不拿旧值盖回去）", () => {
		const { container, sent } = mount();
		const payload = savePayload(container, sent);
		expect(payload).toBeTruthy();
		expect("recordSamples" in (payload as object)).toBe(false);
	});

	it("保存生效后改回开：以回执为基线，仍然上行 true（不拿过期的 status 比）", () => {
		const { container, sent, rerender } = mount();
		// ① 关掉并保存 → 服务端回执确认 false（status 里的 config 还是旧的 true）。
		toggleCheckbox(sampleToggle(container)!);
		sent.length = 0;
		click(byText(container, "保存配置"));
		const reqId = (sent.find((m) => m.type === "jev_config_save") as ClientSave).reqId;
		rerender({ jev: applied(reqId, { ...CONFIG, recordSamples: false }) });
		expect(sampleToggle(container)!.checked).toBe(false);
		// ② 再勾回去 → 载荷必须是 true；若基线跟的是旧 status（true），这里会被当成「没改过」而不发。
		toggleCheckbox(sampleToggle(container)!);
		sent.length = 0;
		click(byText(container, "保存配置"));
		const save = sent.find((m) => m.type === "jev_config_save") as ClientSave;
		expect(save.config.recordSamples).toBe(true);
	});

	it("提示把代价与边界写全：截断 4000 字符 / 密钥形状抹成 «redacted» / 落盘 0600", () => {
		const { container } = mount();
		const text = textOf(container);
		expect(text).toContain("4000");
		expect(text).toContain("«redacted»");
		expect(text).toContain("0600");
		// 位置与轮转也说清楚（否则没人知道去哪看、能畩多少）。
		expect(text).toContain("jev-samples.jsonl");
		expect(text).toContain("2000 条");
		// 关掉/清空的出口：关掉即停止写入，已写的用 samples clear 清。
		expect(text).toContain("samples clear");
		// 缓存回放不记（样本只认真实决策）也要说明。
		expect(text).toContain("缓存回放不记");
	});

	it("复盘状态如实回显（待复盘 / 已到期）并给出同一条导出命令", () => {
		const { container } = mount();
		const text = textOf(container);
		expect(text).toContain("样本复盘");
		expect(text).toContain("待复盘 12 条");
		expect(text).toContain("已到期");
		expect(text).toContain("npm run jev -- review export --since 7d > corpus.week.jsonl");
		expect(text).toContain("npm run jev -- review ack");
	});

	it("未到期就不说「已到期」（到期与否读的是服务端回包，不是客户端算的）", () => {
		const { container } = mount({
			jev: {
				...statusOf(),
				status: {
					type: "jev_status",
					reqId: 7,
					ok: true,
					status: {
						config: CONFIG,
						runtime: { ...RUNTIME, reviewStatus: review({ pending: 3 }) },
						propositions: PROPOSITIONS,
					},
				},
			},
		});
		const text = textOf(container);
		expect(text).toContain("待复盘 3 条");
		expect(text).not.toContain("已到期");
	});

	it("旧服务端没有 reviewStatus：留痕开关照旧渲染，复盘那一节不渲染也不崩", () => {
		const { reviewStatus: _omitted, ...legacy } = RUNTIME;
		const { container } = mount({
			jev: {
				...statusOf(),
				status: {
					type: "jev_status",
					reqId: 7,
					ok: true,
					status: { config: CONFIG, runtime: legacy as UiJevRuntimeStatus, propositions: PROPOSITIONS },
				},
			},
		});
		expect(sampleToggle(container)!.checked).toBe(true);
		expect(textOf(container)).not.toContain("待复盘");
	});
});
