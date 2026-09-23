// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/FooterBar.tsx（被测件）,
 *   ../../web/src/use-chat.ts（resources 5 秒轮询：ready 即启、断开即停）,
 *   ../../web/src/components/SystemResources.tsx（设置→系统复用同一份快照，已去掉自带 interval）
 * @CONTRACT 钉住三件事：
 *   ① 机器负载芯片只在**有快照**时占位（同网关项契约：常驻监视器不放永远空着的项）；
 *   ② cpuPercent 首次采样为 null → 显示「—」而不是 0%/消失，内存照常显示；
 *   ③ tooltip 带负载均值（1/5/15 分钟）与 cgroup 口径，方便无鼠标悬停环境截图排障。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { FooterBar } from "../../web/src/components/FooterBar.js";
import { SystemResources } from "../../web/src/components/SystemResources.js";
import { useChat } from "../../web/src/use-chat.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChatState } from "../../web/src/use-chat.js";
import type { UiResourceSnapshot } from "../../web/src/types.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
localStorage.setItem("pi-web-ui:lang", "zh");

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const snapshot = (host: Partial<UiResourceSnapshot["host"]> = {}): UiResourceSnapshot => ({
	at: Date.UTC(2026, 8, 23, 9, 30),
	host: {
		hostname: "C2026",
		platform: "linux",
		uptimeSec: 86400,
		cpuCount: 4,
		loadAvg: [0.48, 0.5, 0.31],
		cpuPercent: 9.7,
		mem: { totalBytes: 8 * 1024 ** 3, usedBytes: 5.2 * 1024 ** 3, availableBytes: 2.8 * 1024 ** 3, swapTotalBytes: 0, swapUsedBytes: 0 },
		...host,
	},
	app: {
		pid: 123,
		node: "v22.19.0",
		uptimeSec: 3600,
		rssBytes: 512 * 1024 ** 2,
		heapUsedBytes: 128 * 1024 ** 2,
		heapTotalBytes: 192 * 1024 ** 2,
		externalBytes: 8 * 1024 ** 2,
		cgroup: { currentBytes: 1.2 * 1024 ** 3, maxBytes: 7.5 * 1024 ** 3, highBytes: null },
	},
	disks: [],
	sources: { cpu: "/proc/stat", mem: "/proc/meminfo", disk: "statfs", cgroup: "cgroupv2" },
	warnings: [],
});

/** 最小可渲染 ChatState：只填 FooterBar 渲染路径真正读到的字段（测试口径，非完整快照）。 */
const chatOf = (resources: ChatState["resources"]): ChatState =>
	({
		status: "open",
		ready: true,
		state: {
			conversationId: "c1",
			model: null,
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
			queue: { steering: [], followUp: [] },
			tools: [],
			version: 1,
			piConfigured: true,
			piAgentInstalled: true,
			isStreaming: false,
			stats: {
				totalMessages: 3,
				tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
				cost: 0,
				contextUsage: { tokens: 150, contextWindow: 1000000, percent: 0.015 },
			},
		},
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		notices: [],
		sessions: [],
		conversations: [],
		activeConversationId: "c1",
		switching: false,
		projects: [],
		models: [],
		modelsConfig: [],
		providers: [],
		gatewayUsage: { busy: false, ok: null },
		gateway: { ok: null, saveOk: null, duplicates: [] },
		usageHistory: null,
		resources,
		statuses: [],
		jev: { status: null, config: null, probe: null },
	} as unknown as ChatState);

const opsApi = {} as never;
const send = (() => true) as never;

function mount(resources: ChatState["resources"]) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() =>
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(FooterBar, { chat: chatOf(resources), opsApi, send }) as ReactNode,
			),
		),
	);
	return container;
}

describe("FooterBar 机器负载芯片", () => {
	it("有快照时显示 CPU 与内存；tooltip 带 1/5/15 分钟负载与 cgroup", () => {
		const container = mount({ type: "resources", reqId: 1, ok: true, snapshot: snapshot() });
		const chip = container.querySelector(".status-load") as HTMLElement;
		expect(chip).not.toBeNull();
		expect(chip.textContent).toContain("CPU");
		expect(chip.textContent).toContain("10%");
		expect(chip.textContent).toContain("5.2G / 8.0G");
		const title = chip.getAttribute("title") ?? "";
		expect(title).toContain("机器负载");
		expect(title).toContain("0.48 / 0.50 / 0.31");
		expect(title).toContain("cgroup: 1.2G / 7.5G");
	});

	it("cpuPercent 首采为 null → CPU 显示「—」（不是 0%），内存照常", () => {
		const container = mount({
			type: "resources",
			reqId: 1,
			ok: true,
			snapshot: snapshot({ cpuPercent: null }),
		});
		const chip = container.querySelector(".status-load") as HTMLElement;
		expect(chip.textContent).toContain("—");
		expect(chip.textContent).not.toContain("0%");
		expect(chip.textContent).toContain("5.2G / 8.0G");
	});

	it("没有快照（或读取失败）时不占位 —— 常驻监视器不放永远空着的项", () => {
		for (const resources of [null, { type: "resources", reqId: 1, ok: false } as ChatState["resources"]]) {
			const container = mount(resources);
			expect(container.querySelector(".status-load")).toBeNull();
			act(() => root?.unmount());
			document.body.innerHTML = "";
		}
	});
});

describe("SystemResources：快照轮询已上收到 use-chat", () => {
	/** 挂载面板，返回容器与收到的 onRefresh 次数的读取器。snap=null 时面板提前返回（无按钮）。 */
	function mountPanel(snap: UiResourceSnapshot | null = null) {
		const onRefresh = vi.fn();
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() =>
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(SystemResources, { snapshot: snap, onRefresh }) as ReactNode,
				),
			),
		);
		return { container, onRefresh };
	}

	it("不再自建 interval：挂载后 6 秒内不自动刷新（刷新由 use-chat 的 5 秒轮询驱动）", () => {
		vi.useFakeTimers();
		try {
			const { onRefresh } = mountPanel();
			act(() => vi.advanceTimersByTime(6000));
			expect(onRefresh).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("手动刷新按钮仍然有效（面板底部的「刷新」）", () => {
		const { container, onRefresh } = mountPanel(snapshot());
		const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("刷新"));
		expect(btn).toBeDefined();
		act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});
});

describe("use-chat：机器负载轮询随连接启停", () => {
	it("ready 后立即拉一次并每 5 秒轮询；断开即停", () => {
		vi.useFakeTimers();
		class FakeWS {
			static OPEN = 1;
			static instances: FakeWS[] = [];
			sent: string[] = [];
			onopen: (() => void) | null = null;
			onmessage: ((ev: { data: string }) => void) | null = null;
			onclose: (() => void) | null = null;
			readyState = 1;
			send(data: string) {
				this.sent.push(data);
			}
			close() {
				this.readyState = 3;
				this.onclose?.();
			}
			constructor(_url: string) {
				FakeWS.instances.push(this);
			}
		}
		vi.stubGlobal("WebSocket", FakeWS);
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() =>
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(function Probe() {
						useChat();
						return createElement("span");
					}),
				),
			),
		);
		const ws = FakeWS.instances.at(-1)!;
		act(() => ws.onopen?.());
		act(() =>
			ws.onmessage?.({
				data: JSON.stringify({ type: "ready", clientId: "probe", serverVersion: "0.85.1" }),
			}),
		);
		const polls = () => ws.sent.filter((s) => s.includes('"list_resources"')).length;
		expect(polls(), "ready 即首调（顺带预热 CPU 采样基线）").toBe(1);
		act(() => vi.advanceTimersByTime(5000));
		expect(polls()).toBe(2);
		act(() => vi.advanceTimersByTime(5000));
		expect(polls()).toBe(3);
		// 断开：ready 翻 false → 轮询停（重连由 connect 闭环处理，不影响本断言）
		act(() => ws.close());
		const atClose = polls();
		act(() => vi.advanceTimersByTime(10000));
		expect(polls(), "断开后不再轮询").toBe(atClose);
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
});
