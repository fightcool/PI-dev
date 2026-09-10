/* 🍞 AI Breadcrumb — @COUPLED agent-service.ts, conversation-retention.ts, subagent-archive.ts
 * @CONTRACT Archive first, release second. Failures retain the runtime and its descendants.
 * 📖 ../docs/conversation-lifecycle.md
 */
import { existsSync } from "node:fs";
import type { Conversation } from "./agent-service.js";
import { retirementCandidates } from "./conversation-retention.js";
import { SubagentArchive, type ArchivedSubagent } from "./subagent-archive.js";
import { toSubagentSnapshot } from "./subagent-state.js";
import { hasActiveSubagentRun, hasPendingWaitSubscription } from "./wait-subscription-scan.js";

export function conversationBusy(conv: Conversation): boolean {
	return (
		conv.subagentStarting === true ||
		(conv.subagentPending ?? 0) > 0 ||
		!conv.session.isIdle ||
		conv.session.isStreaming ||
		!!conv.retryState ||
		!!conv.compactionState ||
		!!conv.reloadInFlight ||
		conv.goal.reviewing ||
		conv.wizardRunning ||
		conv.queueSteering.length > 0 ||
		conv.queueFollowUp.length > 0 ||
		conv.toolStartTimes.size > 0 ||
		conv.terminals.countLive() > 0 ||
		hasActiveSubagentRun({ sessionId: conv.session.sessionFile }) ||
		hasPendingWaitSubscription({ sessionId: conv.session.sessionFile })
	);
}

interface MaintenanceHost {
	conversations(): Map<string, Conversation>;
	activeId(): string;
	drop(id: string): void;
	changed(): void;
	warn(): void;
	restore(record: ArchivedSubagent): Promise<Conversation>;
}

export class ConversationMaintenance {
	private timer?: ReturnType<typeof setTimeout>;
	private interval?: ReturnType<typeof setInterval>;
	private closed = false;
	private failed = new Set<string>();
	private restoring = new Map<string, Promise<Conversation | undefined>>();
	constructor(
		readonly archive: SubagentArchive,
		private host: MaintenanceHost,
	) {}

	start(): void {
		// @MAGIC 5000ms also rechecks terminal exits and expiring extension wake markers.
		this.interval ??= setInterval(() => this.reap(), 5000);
		this.interval.unref();
	}
	schedule(): void {
		if (this.closed || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.reap();
		}, 0);
		this.timer.unref();
	}

	reap(): void {
		if (this.closed) return;
		try {
			this.reapSafe();
			this.failed.delete("scan");
		} catch {
			if (!this.failed.has("scan")) {
				this.failed.add("scan");
				this.host.warn();
			}
		}
	}

	private reapSafe(): void {
		const conversations = this.host.conversations();
		const candidates = retirementCandidates(
			[...conversations.values()].map((conv) => ({
				id: conv.id,
				cwd: conv.cwd,
				parentId: conv.parentId,
				isSubagent: conv.isSubagent,
				busy: conversationBusy(conv),
				lastActiveAt: conv.lastActiveAt,
				recoverable:
					conv.session.getSessionStats().totalMessages === 0 ||
					!!(conv.session.sessionFile && existsSync(conv.session.sessionFile)),
			})),
			this.host.activeId(),
		);
		let changed = false;
		for (const id of candidates) {
			const conv = conversations.get(id);
			if (!conv || id === this.host.activeId() || [...conversations.values()].some((c) => c.parentId === id)) continue;
			try {
				if (conv.isSubagent) {
					const header = conv.session.sessionManager.getHeader();
					if (!header) throw new Error("Missing subagent header");
					this.archive.write({
						version: 1,
						id,
						cwd: conv.cwd,
						parentId: conv.parentId,
						parentSessionId: conv.parentId ? conversations.get(conv.parentId)?.session.sessionId : undefined,
						createdAt: conv.createdAt,
						template: conv.subagentTemplate,
						model: conv.session.model
							? { provider: conv.session.model.provider, id: conv.session.model.id }
							: undefined,
						snapshot: { ...toSubagentSnapshot(conv), archived: true },
						header,
						leafId: conv.session.sessionManager.getLeafId(),
						entries: conv.session.sessionManager.getEntries(),
					});
				}
				this.host.drop(id);
				this.failed.delete(id);
				changed = true;
			} catch {
				if (!this.failed.has(id)) {
					this.failed.add(id);
					this.host.warn();
				}
			}
		}
		if (changed) this.host.changed();
	}

	restore(id: string): Promise<Conversation | undefined> {
		const live = this.host.conversations().get(id);
		if (live) return Promise.resolve(live);
		const existing = this.restoring.get(id);
		if (existing) return existing;
		const task = this.restoreOnce(id).finally(() => this.restoring.delete(id));
		this.restoring.set(id, task);
		return task;
	}

	private async restoreOnce(id: string): Promise<Conversation | undefined> {
		if (this.closed) return undefined;
		const record = this.archive.read(id);
		if (!record) return undefined;
		const conv = await this.host.restore(record);
		if (this.closed) {
			conv.unsubscribe?.();
			conv.terminals.killAll();
			await conv.runtime.dispose();
			return undefined;
		}
		this.host.conversations().set(id, conv);
		return conv;
	}

	stop(): void {
		this.closed = true;
		clearInterval(this.interval);
		clearTimeout(this.timer);
	}
}
