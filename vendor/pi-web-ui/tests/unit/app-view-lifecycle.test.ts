// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalViewBridge } from "../../web/src/app/use-terminal-view-bridge";
import { useAppViews } from "../../web/src/app/use-app-views";
import { AppViews } from "../../web/src/app/app-views";
import type { AppConnection } from "../../web/src/app/types";

const counts = vi.hoisted(() => ({
	terminal: 0,
	scm: 0,
	terminalUnmount: 0,
	scmUnmount: 0,
	terminalLoads: 0,
	scmLoads: 0,
}));
vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../web/src/plugin-fence", () => ({ setFenceSend: vi.fn(), syncFenceRenderers: vi.fn() }));
vi.mock("../../web/src/components/TerminalPanel", () => {
	counts.terminalLoads++;
	return {
		TerminalPanel: () => {
			useEffect(() => {
				counts.terminal++;
				return () => {
					counts.terminalUnmount++;
				};
			}, []);
			return createElement("input", { "aria-label": "terminal draft", defaultValue: "" });
		},
	};
});
vi.mock("../../web/src/components/SCMPanel", () => {
	counts.scmLoads++;
	return {
		ScmPanel: () => {
			useEffect(() => {
				counts.scm++;
				return () => {
					counts.scmUnmount++;
				};
			}, []);
			return createElement("input", { "aria-label": "SCM draft", defaultValue: "" });
		},
	};
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

function connection(): AppConnection {
	return {
		chat: { ready: true, terminals: [], plugins: [], pluginsEpoch: 1, tabs: undefined, state: null },
		send: vi.fn(() => true),
		terminal: { create: vi.fn(), close: vi.fn(), restart: vi.fn(), select: vi.fn(), register: vi.fn(() => () => {}) },
	} as unknown as AppConnection;
}
const meta = {
	id: "one",
	conversationId: "conversation",
	title: "one",
	cwd: "",
	cols: 80,
	rows: 24,
	running: true,
	exitCode: null,
};
const commandMessage = {
	type: "run_command" as const,
	terminalId: "one",
	conversationId: "conversation",
	command: { name: "test", command: "test" },
	cols: 80,
	rows: 24,
};

/** 🍞 @COUPLED app/use-terminal-view-bridge.ts: replay, StrictMode, local spawn, gating. */
describe("lazy terminal bridge", () => {
	it("replays via the original bridge and suppresses the mount-time rerun of a server terminal", async () => {
		const source = connection();
		const writer = { write: vi.fn(), dispose: vi.fn() };
		const unregister = vi.fn();
		source.terminal.register = vi.fn((_conversation, _id, target) => {
			target.write("buffered output");
			return unregister;
		});
		let bridge!: ReturnType<typeof useTerminalViewBridge>;
		function Harness() {
			bridge = useTerminalViewBridge(source, true);
			return null;
		}
		await act(async () => root.render(createElement(Harness)));
		const cleanup = bridge.terminal.register("conversation", "one", writer);
		expect(writer.write).toHaveBeenCalledWith("buffered output");
		expect(bridge.terminalSend(commandMessage)).toBe(true);
		expect(source.send).not.toHaveBeenCalled();
		bridge.terminalSend(commandMessage);
		expect(source.send).toHaveBeenCalledTimes(1);
		cleanup();
		expect(unregister).toHaveBeenCalledOnce();
	});

	it("spawns a local tab once and tolerates a register/unregister before the first frame", async () => {
		const source = connection();
		let bridge!: ReturnType<typeof useTerminalViewBridge>;
		function Harness() {
			bridge = useTerminalViewBridge(source, true);
			return null;
		}
		await act(async () => root.render(createElement(Harness)));
		bridge.terminal.create(meta);
		const writer = { write: vi.fn(), dispose: vi.fn() };
		bridge.terminal.register("conversation", "one", writer)();
		const cleanup = bridge.terminal.register("conversation", "one", writer);
		bridge.terminalSend(commandMessage);
		expect(source.send).toHaveBeenCalledTimes(1);
		cleanup();
		bridge.terminal.register("conversation", "one", writer);
		bridge.terminalSend(commandMessage);
		expect(source.send).toHaveBeenCalledTimes(1);
	});

	it("does not repeat an explicit command sent while a local tab is waiting to mount", async () => {
		const source = connection();
		let bridge!: ReturnType<typeof useTerminalViewBridge>;
		function Harness() {
			bridge = useTerminalViewBridge(source, true);
			return null;
		}
		await act(async () => root.render(createElement(Harness)));
		bridge.terminal.create(meta);
		bridge.send(commandMessage);
		bridge.terminal.register("conversation", "one", { write: vi.fn(), dispose: vi.fn() });
		bridge.terminalSend(commandMessage);
		expect(source.send).toHaveBeenCalledTimes(1);
	});

	it("blocks local creation and mount spawning when terminal tabs are disabled", async () => {
		const source = connection();
		let bridge!: ReturnType<typeof useTerminalViewBridge>;
		function Harness() {
			bridge = useTerminalViewBridge(source, false);
			return null;
		}
		await act(async () => root.render(createElement(Harness)));
		bridge.terminal.create(meta);
		expect(bridge.terminalSend(commandMessage)).toBe(false);
		expect(bridge.send(commandMessage)).toBe(false);
		expect(source.terminal.create).not.toHaveBeenCalled();
		expect(source.send).not.toHaveBeenCalled();
	});
});

/** 🍞 @COUPLED app/app-views.tsx, app/use-app-views.ts: lazy import and retained DOM. */
describe("App view activation", () => {
	it("loads no secondary view initially and preserves each visited pane while hidden", async () => {
		const source = connection();
		let views!: ReturnType<typeof useAppViews>;
		function Harness() {
			views = useAppViews(source);
			return createElement(AppViews, {
				connection: source,
				views,
				terminalSend: source.send,
				onSwitchToTerminal: () => views.setView("terminal"),
			});
		}
		await act(async () => root.render(createElement(Harness)));
		expect(counts.terminalLoads).toBe(0);
		expect(counts.scmLoads).toBe(0);
		expect(container.children).toHaveLength(0);
		await act(async () => views.setView("terminal"));
		await vi.waitFor(() => expect(container.querySelector("input")).not.toBeNull());
		const terminalInput = container.querySelector("input")!;
		terminalInput.value = "retained terminal";
		expect(counts.terminalLoads).toBe(1);
		expect(counts.scmLoads).toBe(0);
		await act(async () => views.setView("git"));
		await vi.waitFor(() => expect(container.querySelector('[aria-label="SCM draft"]')).not.toBeNull());
		const scmInput = container.querySelector<HTMLInputElement>('[aria-label="SCM draft"]')!;
		scmInput.value = "retained SCM";
		await act(async () => views.setView("chat"));
		expect(terminalInput.closest(".view-pane")?.classList.contains("hidden")).toBe(true);
		expect(scmInput.closest(".view-pane")?.classList.contains("hidden")).toBe(true);
		await act(async () => views.setView("terminal"));
		expect(container.querySelector('[aria-label="terminal draft"]')).toBe(terminalInput);
		expect(terminalInput.value).toBe("retained terminal");
		expect(scmInput.value).toBe("retained SCM");
		expect(counts.terminal).toBe(1);
		expect(counts.scm).toBe(1);
		source.chat = { ...source.chat, tabs: ["chat"] };
		await act(async () => root.render(createElement(Harness)));
		expect(views.view).toBe("chat");
		expect(container.children).toHaveLength(0);
		expect(counts.terminalUnmount).toBe(1);
		expect(counts.scmUnmount).toBe(1);
	});

	it("defers a requested first shell until ready and blocks plugin terminal events under gating", async () => {
		const source = connection();
		source.chat.ready = false;
		let views!: ReturnType<typeof useAppViews>;
		function Harness() {
			views = useAppViews(source);
			return null;
		}
		await act(async () => root.render(createElement(Harness)));
		await act(async () => views.chooseView("terminal"));
		expect(source.terminal.create).not.toHaveBeenCalled();
		source.chat = { ...source.chat, ready: true };
		await act(async () => root.render(createElement(Harness)));
		expect(source.terminal.create).toHaveBeenCalledOnce();
		source.chat = { ...source.chat, tabs: ["chat"] };
		await act(async () => root.render(createElement(Harness)));
		await act(async () => {
			views.chooseView("terminal");
			window.dispatchEvent(new CustomEvent("pi-web-ui:plugin-run-command", { detail: { command: "echo test" } }));
		});
		expect(views.view).toBe("chat");
		expect(source.terminal.create).toHaveBeenCalledOnce();
		expect(source.send).not.toHaveBeenCalled();
	});
});
