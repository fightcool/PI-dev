/* 🍞 AI Breadcrumb — @COUPLED agent-service.ts, dsh/dsh-agent-service.ts
 * @WHY Eight is an idle-cache budget, never a limit on starting user work.
 * @CONTRACT Busy work and its ancestors are protected; callers persist before disposal.
 * 📖 ../docs/conversation-lifecycle.md
 */
export const IDLE_CONVERSATION_BUDGET = 8;
export const SUBAGENT_CONCURRENCY = 8;

export interface ConversationCandidate {
	id: string;
	cwd: string;
	parentId?: string;
	isSubagent: boolean;
	busy: boolean;
	lastActiveAt: number;
	/** User histories may be evicted only when durable (or completely empty). */
	recoverable: boolean;
}

export function retirementCandidates(
	conversations: ConversationCandidate[],
	activeId: string,
	budget = IDLE_CONVERSATION_BUDGET,
): string[] {
	const protectedIds = new Set(conversations.filter((c) => c.busy || c.id === activeId).map((c) => c.id));
	const byId = new Map(conversations.map((c) => [c.id, c]));
	for (const id of protectedIds) {
		let parent = byId.get(id)?.parentId;
		const seen = new Set<string>();
		while (parent && !seen.has(parent)) {
			seen.add(parent);
			protectedIds.add(parent);
			parent = byId.get(parent)?.parentId;
		}
	}
	// Children retire first, so an archive failure cannot orphan a retained descendant.
	const depth = (c: ConversationCandidate) => {
		let n = 0,
			parent = c.parentId;
		const seen = new Set<string>([c.id]);
		while (parent && !seen.has(parent)) {
			seen.add(parent);
			n++;
			parent = byId.get(parent)?.parentId;
		}
		return n;
	};
	const idle = conversations.filter((c) => !protectedIds.has(c.id));
	const retired = idle
		.filter((c) => c.isSubagent)
		.sort((a, b) => depth(b) - depth(a))
		.map((c) => c.id);
	const projects = new Map<string, ConversationCandidate[]>();
	for (const c of conversations.filter((c) => !c.isSubagent)) {
		const group = projects.get(c.cwd) ?? [];
		group.push(c);
		projects.set(c.cwd, group);
	}
	for (const group of projects.values()) {
		const candidates = group
			.filter((c) => !protectedIds.has(c.id) && c.recoverable)
			.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
		// Active/busy conversations may exceed the target; never reject new work.
		const excess = Math.max(0, group.length - budget);
		retired.push(...candidates.slice(0, excess).map((c) => c.id));
	}
	return retired;
}
