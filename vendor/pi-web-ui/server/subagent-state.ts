/* 🍞 AI Breadcrumb — @COUPLED agent-service.ts, subagent-archive.ts, subagents.ts
 * @CONTRACT A pending/retrying run is not terminal just because streaming pauses.
 * 📖 ../docs/conversation-lifecycle.md
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type SubagentState = "running" | "queued" | "done" | "canceled";
export interface SubagentSnapshot {
	convId: string;
	type: string;
	title: string;
	prompt: string;
	state: SubagentState;
	streaming: boolean;
	error?: string;
	canceled?: boolean;
	messageCount: number;
	model?: string;
	output: string;
	/** Full transcript is archived and its heavy runtime has been released. */
	archived?: boolean;
}

export function isSubagentTerminal(r: SubagentSnapshot | undefined): boolean {
	return !!r && !r.streaming;
}

export interface SubagentView {
	id: string;
	title: string;
	subagentType?: string;
	session: AgentSession;
	retryState?: unknown;
	subagentStarting?: boolean;
	subagentPending?: number;
	subagentError?: string;
}

export function subagentRunOutcome(conv: SubagentView): { error?: string; canceled?: boolean } {
	if (conv.retryState) return {};
	try {
		const msgs = conv.session.agent.state.messages;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as { role?: string; errorMessage?: string; stopReason?: string };
			if (m.role !== "assistant") continue;
			if (typeof m.errorMessage === "string" && m.errorMessage.trim()) return { error: m.errorMessage.trim() };
			if (m.stopReason === "aborted" || m.stopReason === "cancelled") return { canceled: true };
			break;
		}
	} catch {
		/* A replacing session has no stable outcome yet. */
	}
	return conv.subagentError ? { error: conv.subagentError } : {};
}

export function toSubagentSnapshot(conv: SubagentView): SubagentSnapshot {
	const streaming =
		conv.session.isStreaming ||
		!conv.session.isIdle ||
		!!conv.retryState ||
		!!conv.subagentStarting ||
		(conv.subagentPending ?? 0) > 0;
	let messageCount = 0;
	try {
		messageCount = conv.session.getSessionStats().totalMessages;
	} catch {
		/* Replacing session. */
	}
	return {
		convId: conv.id,
		type: conv.subagentType ?? "general",
		title: conv.title,
		prompt: "",
		state: streaming ? "running" : "done",
		streaming,
		...subagentRunOutcome(conv),
		messageCount,
		model: conv.session.model?.id,
		output: conv.session.getLastAssistantText() ?? "",
	};
}
