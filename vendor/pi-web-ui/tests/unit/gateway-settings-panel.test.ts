// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/GatewaySettings.tsx（被测件）,
 *   ../../web/src/components/GatewayUsageBlock.tsx（用量区块）, ../../web/src/use-chat.ts（opsApi 契约）,
 *   ../../server/model-admin.ts（getGateway/saveGateway 的实现）
 * 📖 docs/NEWAPI-GATEWAY.md §2（单网关接入：界面上只有一个地址、一把密钥、一份模型清单）
 * @CONTRACT 钉住四件在界面上会直接骗到人的事：
 *   ① 密钥语义是「留空 = 不修改」，要清除必须显式勾选（一个空框不能同时表示两件事）；
 *   ② 没有读数时用量区说「还没读取过」，绝不显示 $0.00（那会被读成「没花钱」）；
 *   ③ 「该服务商没有账单接口」是永久事实，要说清楚而不是报错；
 *   ④ 重复接入只提示 + 给删除按钮，不自动删。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GatewaySettings } from "../../web/src/components/GatewaySettings.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChatState } from "../../web/src/use-chat.js";
import type { UiGatewayConfig, UiGatewayUsage } from "../../web/src/types.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
localStorage.setItem("pi-web-ui:lang", "zh");

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const CONFIG: UiGatewayConfig = {
	providerId: "newapi",
	name: "NewAPI 网关（api.ftai.cc）",
	baseUrl: "https://api.ftai.cc/v1",
	api: "openai-completions",
	hasApiKey: true,
	models: [{ id: "deepseek-flash" }, { id: "gpt-5.6-sol" }],
};

const USAGE: UiGatewayUsage = {
	providerId: "newapi",
	providerName: "NewAPI 网关（api.ftai.cc）",
	baseUrl: "https://api.ftai.cc",
	usedUsd: 0.0011296,
	limitUsd: null,
	remainingUsd: null,
	unlimited: true,
	checkedAt: Date.UTC(2026, 8, 21, 12),
};

function mount(props: {
	gateway?: Partial<ChatState["gateway"]>;
	usage?: Partial<ChatState["gatewayUsage"]>;
	activeProvider?: string | null;
	settings?: { hiddenModels?: string[] } | null;
}) {
	const sent: unknown[] = [];
	const opsApi = {
		getGateway: vi.fn(() => 1),
		saveGateway: vi.fn((input: unknown) => {
			sent.push(input);
			return 7;
		}),
		queryGatewayUsage: vi.fn(() => 1),
		refreshProviderModels: vi.fn(() => 1),
	} as unknown as ChatState extends never ? never : Parameters<typeof GatewaySettings>[0]["opsApi"];
	const send = vi.fn((msg: unknown) => {
		sent.push(msg);
		return true;
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() =>
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GatewaySettings, {
					gateway: {
						ok: true,
						saveOk: null,
						duplicates: [],
						config: CONFIG,
						...props.gateway,
					} as ChatState["gateway"],
					gatewayUsage: { ok: null, ...props.usage } as ChatState["gatewayUsage"],
					activeProvider: props.activeProvider === undefined ? "newapi" : props.activeProvider,
					refreshProviderResult: null,
					settings: (props.settings === undefined ? null : props.settings) as never,
					opsApi,
					send: send as never,
				}) as ReactNode,
			),
		),
	);
	return { container, sent, opsApi, send };
}

const textOf = (el: HTMLElement) => el.textContent ?? "";

/** 受控输入：直接改 .value 不会触发 React 的 onChange（React 覆写了 value setter），
 *  必须走原生 setter + input 事件。 */
function typeInto(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}
const inputByLabel = (container: HTMLElement, label: string): HTMLInputElement => {
	const field = [...container.querySelectorAll(".gw-field")].find((f) => textOf(f as HTMLElement).includes(label));
	return field!.querySelector("input") as HTMLInputElement;
};

describe("GatewaySettings：地址 + 密钥 + 模型清单", () => {
	it("回显网关地址与密钥「已保存」状态（密钥正文永不出现在界面上）", () => {
		const { container } = mount({});
		// 面板要说明**当前网关是谁**（有注册名就用它，没有就显示存储键）。
		expect(textOf(container)).toContain("当前网关");
		expect(textOf(container)).toContain("NewAPI 网关（api.ftai.cc） · newapi");
		expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("https://api.ftai.cc/v1");
		const key = container.querySelector('input[type="password"]') as HTMLInputElement;
		expect(key.value, "密钥正文不回填").toBe("");
		// 「留空 = 不修改」是输入框的 placeholder（不在 textContent 里）。
		expect(key.placeholder).toContain("留空 = 不修改");
	});

	it("模型清单来自网关：逐个展示 + 每个都能开关（启用计数）", () => {
		const { container, send, opsApi } = mount({});
		expect(textOf(container)).toContain("已启用 2 / 共 2");
		const chips = [...container.querySelectorAll(".gw-model-chip")];
		expect(chips.map((c) => c.textContent?.replace(/^[●○] /, ""))).toEqual(["deepseek-flash", "gpt-5.6-sol"]);
		// 点一下 = 收起来（写 settings.hiddenModels，纯 UI 偏好；不动 models.json）。
		act(() => (chips[0] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(send).toHaveBeenCalledWith({ type: "set_settings", hiddenModels: ["newapi/deepseek-flash"] });
		expect(opsApi.saveGateway).not.toHaveBeenCalled();
	});

	it("被收起来的模型在面板上显示为关（○ + 划线），再点一下恢复", () => {
		const { container, send } = mount({
			gateway: { config: { ...CONFIG, models: [{ id: "deepseek-flash" }] } },
			settings: { hiddenModels: ["newapi/deepseek-flash"] },
		});
		expect(textOf(container)).toContain("已启用 0 / 共 1");
		const chip = container.querySelector(".gw-model-chip") as HTMLElement;
		expect(chip.className).toContain("off");
		act(() => chip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(send).toHaveBeenCalledWith({ type: "set_settings", hiddenModels: [] });
	});

	it("留空保存 = 不上行 apiKey（只改地址不会把密钥清掉）", () => {
		const { opsApi } = mount({});
		const saveBtn = [...document.querySelectorAll("button")].find((b) => textOf(b).includes("保存网关配置"))!;
		act(() => saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(opsApi.saveGateway).toHaveBeenCalledTimes(1);
		const arg = (opsApi.saveGateway as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect("apiKey" in arg).toBe(false);
	});

	it("填了新密钥就上行；勾选「清除」上行空串（两种意图分得开）", () => {
		const typed = mount({});
		const key = typed.container.querySelector('input[type="password"]') as HTMLInputElement;
		act(() => typeInto(key, "sk-new"));
		const saveBtn = [...document.querySelectorAll("button")].find((b) => textOf(b).includes("保存网关配置"))!;
		act(() => saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const arg = (typed.opsApi.saveGateway as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(arg.apiKey).toBe("sk-new");

		document.body.innerHTML = "";
		act(() => root?.unmount());
		root = null;
		const cleared = mount({});
		const box = cleared.container.querySelector('.gw-check input[type="checkbox"]') as HTMLInputElement;
		act(() => box.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const btn2 = [...document.querySelectorAll("button")].find((b) => textOf(b).includes("保存网关配置"))!;
		act(() => btn2.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const arg2 = (cleared.opsApi.saveGateway as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(arg2.apiKey).toBe("");
	});

	it("没有读数时说「还没读取过」，绝不显示 $0.00", () => {
		const { container } = mount({ usage: { ok: null, usage: undefined } });
		expect(textOf(container)).toContain("网关自报用量");
		expect(textOf(container)).not.toContain("$0.00");
	});

	it("有读数时给金额并按「累计」口径说明（该部署忽略日期窗口）", () => {
		const { container } = mount({ usage: { ok: true, usage: USAGE } });
		expect(textOf(container)).toContain("$0.0011");
		expect(textOf(container)).toContain("累计");
		expect(textOf(container)).not.toContain("近 30 天");
		expect(textOf(container)).toContain("网关自报");
	});

	it("该服务商没有账单接口时说明白，不显示成查询失败", () => {
		const { container } = mount({ usage: { ok: false, unsupported: true, error: "网关未提供用量接口" } });
		expect(textOf(container)).toContain("没有账单接口");
		expect(textOf(container)).not.toContain("网关未提供用量接口");
	});

	it("重复接入只提示并可一键删除（不自动删）", () => {
		const { container, send } = mount({
			gateway: { duplicates: [{ providerId: "ftai", baseUrl: "https://api.ftai.cc", modelCount: 3 }] },
		});
		expect(textOf(container)).toContain("重复接入");
		expect(textOf(container)).toContain("ftai");
		expect(send).not.toHaveBeenCalled();
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const del = [...container.querySelectorAll("button")].find((b) => textOf(b).includes("删除"))!;
		act(() => del.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(send).toHaveBeenCalledWith({ type: "delete_model_config", providerId: "ftai" });
		vi.restoreAllMocks();
	});

	it("打开面板就读取一次配置（配置不在快照里，按需读）", () => {
		const { opsApi } = mount({});
		expect(opsApi.getGateway).toHaveBeenCalled();
	});
});

describe("GatewaySettings：模型能力标注", () => {
	/** 找到指定模型的能力行。 */
	const capRow = (container: HTMLElement, id: string): HTMLElement =>
		[...container.querySelectorAll(".gw-cap-row")].find((r) => (r.querySelector(".gw-cap-id")?.textContent ?? "") === id) as HTMLElement;
	const capCheck = (row: HTMLElement, i: number): HTMLInputElement =>
		row.querySelectorAll(".gw-cap-check input")[i] as HTMLInputElement;
	const capLevel = (row: HTMLElement, label: string): HTMLElement =>
		[...row.querySelectorAll(".gw-cap-level")].find((b) => b.textContent === label) as HTMLElement;
	const capSave = () =>
		[...document.querySelectorAll("button")].find((b) => textOf(b).includes("保存能力标注"))! as HTMLElement;
	const saveCalls = (opsApi: unknown) =>
		(opsApi as unknown as { saveGateway: { mock: { calls: unknown[][] } } }).saveGateway.mock.calls;

	it("勾选推理后保存：动过的字段显式提交，没动过的裸模型只回传 id（回填继续接管）", () => {
		const { container, opsApi } = mount({});
		const row = capRow(container, "deepseek-flash");
		act(() => capCheck(row, 0).dispatchEvent(new MouseEvent("click", { bubbles: true })));
		act(() => capSave().dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const arg = saveCalls(opsApi)[0][0] as { models: Record<string, unknown>[] };
		expect(arg.models[0]).toEqual({ id: "deepseek-flash", reasoning: true });
		expect(arg.models[1]).toEqual({ id: "gpt-5.6-sol" });
	});

	it("勾选档位生成同名映射；基线已有的字段（reasoning/input）原样回显", () => {
		const { container, opsApi } = mount({
			gateway: {
				config: { ...CONFIG, models: [{ id: "m-reasoning", reasoning: true, input: ["text", "image"] }] },
			},
		});
		const row = capRow(container, "m-reasoning");
		// 无映射时默认 off..high 勾选；补勾「极高」。
		act(() => capLevel(row, "极高").dispatchEvent(new MouseEvent("click", { bubbles: true })));
		act(() => capSave().dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const arg = saveCalls(opsApi)[0][0] as { models: Record<string, unknown>[] };
		expect(arg.models[0].reasoning).toBe(true);
		expect(arg.models[0].input).toEqual(["text", "image"]);
		// off 勾选 = 不写键；其余档勾选 = 同名值，未勾 = null。
		expect(arg.models[0].thinkingLevelMap).toEqual({
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
	});

	it("取消推理勾选发送显式 false（显式声明优先，挡住能力表回填）", () => {
		const { container, opsApi } = mount({
			gateway: { config: { ...CONFIG, models: [{ id: "m-reasoning", reasoning: true }] } },
		});
		const row = capRow(container, "m-reasoning");
		act(() => capCheck(row, 0).dispatchEvent(new MouseEvent("click", { bubbles: true })));
		act(() => capSave().dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const arg = saveCalls(opsApi)[0][0] as { models: Record<string, unknown>[] };
		expect(arg.models[0].reasoning).toBe(false);
		expect("thinkingLevelMap" in arg.models[0]).toBe(false);
	});

	it("档位一个不剩时阻止保存并点名模型", () => {
		const { container, opsApi } = mount({
			gateway: { config: { ...CONFIG, models: [{ id: "m-reasoning", reasoning: true }] } },
		});
		const row = capRow(container, "m-reasoning");
		for (const label of ["关闭", "极简", "低", "中", "高"]) {
			act(() => capLevel(row, label).dispatchEvent(new MouseEvent("click", { bubbles: true })));
		}
		act(() => capSave().dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(saveCalls(opsApi)).toHaveLength(0);
		expect(textOf(container)).toContain("m-reasoning 至少勾选一个档位");
	});

	it("数值字段空 = 不写键（绝不落成 0）", () => {
		const { container, opsApi } = mount({
			gateway: { config: { ...CONFIG, models: [{ id: "m-plain" }] } },
		});
		const row = capRow(container, "m-plain");
		const nums = [...row.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
		act(() => typeInto(nums[0], "128000"));
		act(() => capSave().dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const arg = saveCalls(opsApi)[0][0] as { models: Record<string, unknown>[] };
		expect(arg.models[0].contextWindow).toBe(128000);
		expect("maxTokens" in arg.models[0]).toBe(false);
	});
});
