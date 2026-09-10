import { useCallback, useMemo, useRef } from "react";
import type { ClientMessage } from "../types";
import type { AppConnection } from "./types";

/**
 * @COUPLED components/TermXterm.tsx, use-chat.ts terminal bridge.
 * @GOTCHA TermXterm sends a spawn on mount. Only locally created tabs need it;
 * server-listed terminals must replay through register without rerunning commands.
 */
export function useTerminalViewBridge(connection: AppConnection, allowed: boolean) {
	const { terminal, send } = connection;
	const local = useRef(new Set<string>());
	const mounting = useRef(new Set<string>());
	const key = (conversationId: string, id: string) => `${conversationId}:${id}`;
	const create = useCallback<AppConnection["terminal"]["create"]>(
		(meta) => {
			if (!allowed) return;
			local.current.add(key(meta.conversationId, meta.id));
			terminal.create(meta);
		},
		[allowed, terminal.create],
	);
	const register = useCallback<AppConnection["terminal"]["register"]>(
		(conversationId, id, writer) => {
			const idKey = key(conversationId, id);
			mounting.current.add(idKey);
			const unregister = terminal.register(conversationId, id, writer);
			return () => {
				mounting.current.delete(idKey);
				unregister();
			};
		},
		[terminal.register],
	);
	const viewSend = useCallback(
		(message: ClientMessage) => {
			if (message.type === "terminal_create" || message.type === "run_command") {
				if (!allowed) return false;
				const idKey = key(message.conversationId ?? "", message.terminalId);
				if (mounting.current.has(idKey)) {
					mounting.current.delete(idKey);
					if (!local.current.has(idKey)) return true;
					if (send(message)) {
						local.current.delete(idKey);
						return true;
					}
					return false;
				}
			}
			return send(message);
		},
		[allowed, send],
	);
	const commandSend = useCallback(
		(message: ClientMessage) => {
			if (message.type === "terminal_create" || message.type === "run_command") {
				if (!allowed) return false;
				const sent = send(message);
				if (sent) local.current.delete(key(message.conversationId ?? "", message.terminalId));
				return sent;
			}
			return send(message);
		},
		[allowed, send],
	);
	const api = useMemo(
		() => ({ ...terminal, create, register }),
		[create, register, terminal.close, terminal.restart, terminal.select],
	);
	return { terminal: api, terminalSend: viewSend, send: commandSend };
}
