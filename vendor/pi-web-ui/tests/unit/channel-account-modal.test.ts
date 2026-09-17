// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/ChannelAccountModal.tsx（被测件）,
 *   ../../web/src/components/ChannelForm.tsx（草稿 accountKind/accountJson + 摘要行）,
 *   ../../web/src/components/ChannelSettings.tsx（列表行入口 → channel_save）,
 *   ../../server/dev-con/account-template.ts（声明式模板契约的事实源）
 * 📖 docs/DEV-CON-PROPOSAL.md §7（余额/配额）, §8 P3（账户查询）
 * @CONTRACT 覆盖三件必须成立的事：
 *   ① 保存产出的 extra.account = 文本框那份 JSON 原样（不查询 = null，绝不静默丢字段）；
 *   ② JSON 非法 / 模板缺 request.url → 报错 + 保存禁用（坏配置进不了服务端）；
 *   ③ 无障碍与键盘：role/aria-modal/aria-labelledby、ESC 关闭、点遮罩关闭、预设一键填充。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
	ChannelAccountModal,
	accountKindLabel,
	accountPayloadOf,
	accountSummaryOf,
	formatAccountJson,
	parseAccountJson,
	type AccountPreset,
} from "../../web/src/components/ChannelAccountModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { Translate } from "../../web/src/i18n.js";

// react-dom/test-utils 的 act 需要这个开关，否则每次渲染都警告（与其他 jsdom 单测同一做法）。
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// @GOTCHA LanguageProvider 在英文词典未就绪时**只渲染 boot-wait 占位**（不渲染 children）：
//   jsdom 里没有服务端可预取，locale 若是 en 就永远等不到 → 弹窗根本不挂载，全部断言取到 null。
//   固定成中文（核心词典同步可用）才测得到真实 DOM。
localStorage.setItem("pi-web-ui:lang", "zh");

/** 测试用 t()：回显键名 + 参数，断言看的是「哪个错误被触发」而不是具体译文。 */
const t = ((key: string, vars?: Record<string, string | number>) =>
	vars ? `${key}:${Object.values(vars).join(",")}` : key) as unknown as Translate;

/** 契约里那份声明式模板（服务端 account-template.ts 的形状）。 */
const TEMPLATE = {
	kind: "template",
	request: { url: "{baseUrl}/v1/usage", method: "GET", headers: { Authorization: "Bearer {apiKey}" } },
	map: { isValid: "isValid", remaining: "remaining ?? balance", used: "usage.total.actual_cost", unit: "unit" },
	unit: "USD",
	topupUrl: "https://uuapi.io/console/topup",
};

const presets: AccountPreset[] = [
	{ id: "uu-api", label: "UU api", description: "UU api 账户查询", template: TEMPLATE },
	{
		id: "openai-gateway",
		label: "OpenAI 兼容网关",
		description: "内置探测",
		template: { kind: "openai-gateway", url: "{baseUrl}", unit: "USD" },
	},
];

let root: Root | null = null;

function mount(props: Partial<Parameters<typeof ChannelAccountModal>[0]> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const saved: { kind: string; json: string; account: Record<string, unknown> | null }[] = [];
	const closed = vi.fn();
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ChannelAccountModal, {
					title: "账户查询设置",
					kind: "",
					json: "",
					presets,
					showOverwrite: false,
					onSave: (r) => saved.push(r),
					onClose: closed,
					...props,
				}),
			),
		);
	});
	return { container, saved, closed };
}

const click = (el: Element | null) => {
	if (!el) throw new Error("missing element");
	act(() => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

/** 触发受控输入（React 受控组件要走原生 setter 才认）。 */
function setValue(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
	act(() => {
		setter.call(el, value);
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

const saveButton = (c: HTMLElement) => [...c.querySelectorAll("button")].find((b) => b.classList.contains("primary"))!;

afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
});

describe("JSON 解析与提交载荷", () => {
	it("模板 JSON 原样成为 extra.account（字段一个都不丢）", () => {
		const { account, error } = accountPayloadOf({ kind: "template", json: JSON.stringify(TEMPLATE) }, t);
		expect(error).toBeUndefined();
		expect(account).toEqual(TEMPLATE);
	});

	it("「不查询」提交 account:null（显式覆盖，不是「保持原样」）", () => {
		expect(accountPayloadOf({ kind: "", json: JSON.stringify(TEMPLATE) }, t)).toEqual({ account: null });
	});

	it("非法 JSON 给出 err.message 级错误，且不产出 account", () => {
		const r = accountPayloadOf({ kind: "template", json: '{ "kind": "template", }' }, t);
		expect(r.account).toBeUndefined();
		expect(r.error).toContain("channelAccountJsonError:");
	});

	it("模板缺 request.url 被拦下（能解析 ≠ 能用）", () => {
		const r = accountPayloadOf({ kind: "template", json: '{ "kind": "template", "map": {} }' }, t);
		expect(r.error).toBe("channelAccountUrlRequired");
	});

	it("网关探测不需要 JSON：留空只提交 kind", () => {
		expect(accountPayloadOf({ kind: "openai-gateway", json: "" }, t)).toEqual({ account: { kind: "openai-gateway" } });
	});

	it("kind 以单选为准：模板里写了别的 kind 也按当前选择覆盖", () => {
		const r = accountPayloadOf({ kind: "openai-gateway", json: JSON.stringify(TEMPLATE) }, t);
		expect((r.account as Record<string, unknown>).kind).toBe("openai-gateway");
	});

	it("数组/标量不是合法配置（顶层必须是对象）", () => {
		expect(parseAccountJson("[1,2]").error).toBeTruthy();
		expect(parseAccountJson('"x"').error).toBeTruthy();
		expect(parseAccountJson("   ")).toEqual({});
	});
});

describe("摘要行（渠道表单里那一行）", () => {
	it("方式 + 接口地址一眼可见", () => {
		expect(accountSummaryOf({ kind: "template", json: JSON.stringify(TEMPLATE) }, t)).toBe(
			"channelAccountKindTemplate · {baseUrl}/v1/usage",
		);
	});

	it("没配就说「不查询」，坏 JSON 只降级成方式标签（不炸）", () => {
		expect(accountSummaryOf({ kind: "", json: "" }, t)).toBe("channelAccountKindNone");
		expect(accountSummaryOf({ kind: "template", json: "{" }, t)).toBe("channelAccountKindTemplate");
	});

	it("旧配置的顶层 url 也认（回显里没有 request 时不至于摘要空白）", () => {
		expect(accountSummaryOf({ kind: "openai-gateway", json: '{"url":"https://x.ai"}' }, t)).toBe(
			"channelAccountKindGateway · https://x.ai",
		);
	});

	it("未知 kind 如实标出，不悄悄当成模板", () => {
		expect(accountKindLabel("openrouter", t)).toBe("channelAccountKindOther:openrouter");
	});

	it("回显对象 → 格式化 JSON；空回显 = 空串", () => {
		expect(formatAccountJson(TEMPLATE)).toBe(JSON.stringify(TEMPLATE, null, 2));
		expect(formatAccountJson(null)).toBe("");
	});
});

describe("弹窗交互与无障碍", () => {
	it("role=dialog + aria-modal + aria-labelledby 指向标题", () => {
		const { container } = mount();
		const dialog = container.querySelector('[role="dialog"]')!;
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		const titleId = dialog.getAttribute("aria-labelledby")!;
		expect(container.querySelector(`#${titleId}`)?.textContent).toBe("账户查询设置");
	});

	it("默认「不查询」时不显示 JSON 文本框；选模板后出现", () => {
		const { container } = mount();
		expect(container.querySelector("textarea")).toBeNull();
		click(container.querySelectorAll('input[type="radio"]')[1]);
		expect(container.querySelector("textarea")).not.toBeNull();
	});

	it("选预设 = 把 template 以格式化 JSON 填进文本框", () => {
		const { container } = mount({ kind: "template", json: "" });
		setValue(container.querySelector("select")!, "uu-api");
		expect(container.querySelector("textarea")!.value).toBe(JSON.stringify(TEMPLATE, null, 2));
	});

	it("选中网关预设会切到网关方式（模板方式没法表达内置探测）", () => {
		const { container } = mount({ kind: "template", json: "" });
		setValue(container.querySelector("select")!, "openai-gateway");
		const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
		expect(radios[2].checked).toBe(true);
	});

	it("JSON 非法 → 红字错误 + 保存禁用", () => {
		const { container } = mount({ kind: "template", json: "{ oops" });
		expect(container.querySelector(".chan-warn")?.textContent).toContain("JSON");
		expect(saveButton(container).disabled).toBe(true);
	});

	it("保存把解析后的对象交给调用方", () => {
		const { container, saved } = mount({ kind: "template", json: JSON.stringify(TEMPLATE, null, 2) });
		expect(saveButton(container).disabled).toBe(false);
		click(saveButton(container));
		expect(saved).toHaveLength(1);
		expect(saved[0].account).toEqual(TEMPLATE);
	});

	it("ESC 与点遮罩都关闭；点弹窗内部不关", () => {
		const { container, closed } = mount();
		click(container.querySelector(".modal")!);
		expect(closed).not.toHaveBeenCalled();
		click(container.querySelector(".modal-backdrop")!);
		expect(closed).toHaveBeenCalledTimes(1);
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(closed).toHaveBeenCalledTimes(2);
	});

	it("Tab 焦点不逃出弹窗（末位再 Tab 回到首位）", () => {
		const { container } = mount({ kind: "template", json: JSON.stringify(TEMPLATE) });
		const focusable = [...container.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter(
			(el) => !(el as HTMLButtonElement).disabled,
		);
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		act(() => last.focus());
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		});
		expect(document.activeElement).toBe(first);
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
		});
		expect(document.activeElement).toBe(last);
	});

	it("已存渠道提示「整体覆盖」，新建渠道不提示", () => {
		const withOverwrite = mount({ showOverwrite: true });
		const hints = [...withOverwrite.container.querySelectorAll(".set-hint")].map((e) => e.textContent).join("");
		expect(hints.length).toBeGreaterThan(0);
		act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		const without = mount({ showOverwrite: false });
		expect(without.container.querySelectorAll(".set-hint").length).toBe(0);
	});
});
