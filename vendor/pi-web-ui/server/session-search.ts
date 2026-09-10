/*
 * @COUPLED agent-service.ts#searchSessions, protocol.ts#SessionSearchResult,
 * tests/unit/session-search.test.ts. See docs/architecture-core.md.
 * @GOTCHA Search cached SDK text; anchors use transcript order, not the active branch.
 */
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { MessageAnchor, SessionSearchResult } from "./protocol.js";

const MAX_OPEN_FILES = 4;
const MAX_ANCHORS = 10;
const YIELD_EVERY_LINES = 256;
let activeFiles = 0;
const waitingFiles: Array<() => void> = [];

async function acquireFileSlot(): Promise<void> {
	if (activeFiles < MAX_OPEN_FILES) {
		activeFiles++;
		return;
	}
	await new Promise<void>((resolve) => waitingFiles.push(resolve));
}

function releaseFileSlot(): void {
	const next = waitingFiles.shift();
	if (next) next();
	else activeFiles--;
}

/** q is already lowercased, matching ClientSession's search contract. */
export function sessionMatchesSearch(q: string, s: SessionInfo): boolean {
	if (s.name && s.name.toLowerCase().includes(q)) return true;
	if (basename(s.path).toLowerCase().includes(q)) return true;
	if (s.firstMessage.toLowerCase().includes(q)) return true;
	return s.allMessagesText.toLowerCase().includes(q);
}

export function messageSearchText(m: { content?: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const b of c) {
		if (!b || typeof b !== "object") continue;
		const block = b as { type?: unknown; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** q is already lowercased; a smaller cap is useful for callers needing one anchor. */
export async function collectSessionAnchors(filePath: string, q: string, cap = MAX_ANCHORS): Promise<MessageAnchor[]> {
	const limit = Math.min(MAX_ANCHORS, Math.floor(cap));
	if (!q || !(limit > 0)) return [];
	await acquireFileSlot();
	let input: ReturnType<typeof createReadStream> | undefined;
	let lines: ReturnType<typeof createInterface> | undefined;
	let closed: Promise<void> | undefined;
	let readFailed = false;
	const anchors: MessageAnchor[] = [];
	try {
		input = createReadStream(filePath, { encoding: "utf8" });
		closed = new Promise<void>((resolve) => input!.once("close", resolve));
		input.on("error", () => {
			readFailed = true;
		});
		lines = createInterface({ input, crlfDelay: Infinity });
		let lineCount = 0;
		for await (const line of lines) {
			// @GOTCHA Buffered small/blank/bad lines can otherwise starve timers.
			if (++lineCount % YIELD_EVERY_LINES === 0) await yieldToEventLoop();
			if (!line.trim()) continue;
			let entry: {
				type?: unknown;
				message?: { role?: unknown; timestamp?: unknown; content?: unknown };
			};
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const m = entry.message;
			if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
			if (typeof m.timestamp !== "number") continue;
			const text = messageSearchText(m);
			if (!text || !text.toLowerCase().includes(q)) continue;
			anchors.push({ role: m.role, timestamp: m.timestamp });
			if (anchors.length >= limit) break;
		}
		return readFailed ? [] : anchors;
	} catch {
		return [];
	} finally {
		lines?.close();
		input?.destroy();
		// Hold the shared slot until the descriptor closes, including early cap exits.
		await closed;
		releaseFileSlot();
	}
}

/** Search supplied metadata only; never discovers sessions or loads SDK runtime state. */
export async function searchSessionInfos(infos: readonly SessionInfo[], q: string): Promise<SessionSearchResult[]> {
	q = q.trim().toLowerCase();
	if (!q) return [];
	const matches = infos
		.filter((s) => sessionMatchesSearch(q, s))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, 50);
	return Promise.all(
		matches.map(async (s): Promise<SessionSearchResult> => ({
			path: s.path,
			name: s.name,
			firstMessage: s.firstMessage,
			messageCount: s.messageCount,
			modified: s.modified.getTime(),
			source: "web",
			anchors: await collectSessionAnchors(s.path, q),
		})),
	);
}
