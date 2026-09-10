import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	isPluginView,
	requestPluginView,
	subscribeLoadedPluginViews,
	syncPluginViews,
	type LoadedPluginView,
} from "../plugin-loader";
import { setFenceSend, syncFenceRenderers } from "../plugin-fence";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";
import type { CommandDef } from "../types";
import type { AppConnection, ViewName } from "./types";

/** @CONTRACT All navigation paths share gating; hidden visited panes retain state. */
export function useAppViews({ chat, send, terminal }: AppConnection) {
	const t = useT();
	const [chosen, setChosen] = useState<ViewName>("chat");
	const [visited, setVisited] = useState<Set<ViewName>>(() => new Set());
	const terminalOpenRequested = useRef(false);
	const terminalOn = !chat.tabs || chat.tabs.includes("terminal");
	const gitOn = !chat.tabs || chat.tabs.includes("git");
	const pluginsOn = !chat.tabs || chat.tabs.includes("plugins");
	const enabledPlugins = useMemo(
		() => chat.plugins.filter((p) => !chat.settings?.disabledPlugins?.includes(p.id)),
		[chat.plugins, chat.settings?.disabledPlugins],
	);
	const viewPlugins = useMemo(
		() => (pluginsOn ? enabledPlugins.filter(isPluginView) : []),
		[enabledPlugins, pluginsOn],
	);
	const allowed = useCallback(
		(name: ViewName) =>
			name === "chat" ||
			(name === "terminal" ? terminalOn : name === "git" ? gitOn : viewPlugins.some((p) => name === `plugin:${p.id}`)),
		[terminalOn, gitOn, viewPlugins],
	);
	const view = allowed(chosen) ? chosen : "chat";
	useEffect(() => {
		if (chosen !== view) setChosen(view);
	}, [chosen, view]);
	const setView = useCallback((name: ViewName) => setChosen(allowed(name) ? name : "chat"), [allowed]);
	useEffect(() => {
		setVisited((previous) => {
			const next = new Set([...previous].filter(allowed));
			next.add(view);
			return next.size === previous.size && [...next].every((name) => previous.has(name)) ? previous : next;
		});
	}, [view, allowed]);
	const [pluginViews, setPluginViews] = useState<LoadedPluginView[]>([]);
	useEffect(() => subscribeLoadedPluginViews(setPluginViews), []);
	useEffect(() => {
		setFenceSend(send);
		syncFenceRenderers(enabledPlugins, chat.pluginsEpoch);
		syncPluginViews(viewPlugins, chat.pluginsEpoch);
		// An epoch invalidates hidden bundles too. Reload them only on next access.
		if (view.startsWith("plugin:")) void requestPluginView(view.slice(7));
	}, [enabledPlugins, viewPlugins, chat.pluginsEpoch, send, view]);

	const createShell = useCallback(() => {
		if (!terminalOn || !chat.ready || chat.terminals.length !== 0) return false;
		terminal.create({
			id: randomUuid(),
			conversationId: chat.activeConversationId || chat.state?.conversationId || "",
			title: t("terminalTitle", { n: 1 }),
			cwd: chat.state?.cwd ?? "",
			cols: 80,
			rows: 24,
			running: true,
			exitCode: null,
		});
		return true;
	}, [
		terminalOn,
		chat.ready,
		chat.terminals.length,
		chat.activeConversationId,
		chat.state?.conversationId,
		chat.state?.cwd,
		terminal.create,
		t,
	]);
	const chooseView = useCallback(
		(name: ViewName) => {
			terminalOpenRequested.current = terminalOn && name === "terminal" && chat.terminals.length === 0;
			// Wait for the committed terminal list: TopBar may have just created a
			// command tab in this same event before requesting the terminal view.
			setView(name);
		},
		[terminalOn, chat.terminals.length, setView],
	);
	useEffect(() => {
		if (!terminalOpenRequested.current) return;
		if (view !== "terminal" || chat.terminals.length !== 0 || createShell()) terminalOpenRequested.current = false;
	}, [chat.terminals.length, createShell, view]);

	useEffect(() => {
		const onCommand = (event: Event) => {
			const detail = (event as CustomEvent<{ title?: string; command?: string }>).detail;
			if (!terminalOn || !detail?.command || !chat.ready) return;
			const title = detail.title || t("pluginCommandFallback");
			const command: CommandDef = { name: title, command: detail.command, cwd: "${pwd}" };
			const existing = chat.terminals.find((tm) => tm.title === title);
			if (existing) {
				terminal.restart(existing.id);
				terminal.select(existing.id);
				send({
					type: "run_command",
					terminalId: existing.id,
					conversationId: existing.conversationId,
					command,
					cols: 80,
					rows: 24,
				});
			} else {
				terminal.create({
					id: randomUuid(),
					conversationId: chat.activeConversationId || chat.state?.conversationId || "",
					title,
					cwd: chat.state?.cwd ?? "",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					command,
				});
			}
			setView("terminal");
		};
		window.addEventListener("pi-web-ui:plugin-run-command", onCommand);
		return () => window.removeEventListener("pi-web-ui:plugin-run-command", onCommand);
	}, [
		chat.ready,
		chat.terminals,
		chat.activeConversationId,
		chat.state?.conversationId,
		chat.state?.cwd,
		terminal,
		send,
		terminalOn,
		setView,
		t,
	]);
	return {
		view,
		setView,
		chooseView,
		enabledPlugins,
		terminalVisited: terminalOn && (view === "terminal" || visited.has("terminal")),
		gitVisited: gitOn && (view === "git" || visited.has("git")),
		pluginViews: pluginViews.filter((entry) => viewPlugins.some((p) => p.id === entry.info.id)),
	};
}
