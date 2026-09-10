import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { SessionHistoryCache } from "../../server/session-history-cache.js";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../../server/protocol.js";

const info = (path: string, modified = 1): SessionInfo => ({
	path,
	id: path,
	cwd: "/a",
	created: new Date(0),
	modified: new Date(modified),
	firstMessage: path,
	messageCount: 1,
	allMessagesText: path,
});

function client(load: (cwd: string) => Promise<SessionInfo[]>) {
	const received: ServerMessage[] = [];
	// No constructor: these paths need only dummy list data and an in-memory sink.
	const cs: ClientSession = Object.assign(Object.create(ClientSession.prototype), {
		cwd: "/a",
		disposed: false,
		sessionsRequested: false,
		sessionHistory: new SessionHistoryCache(load),
		emit: (msg: ServerMessage) => received.push(msg),
	});
	return { cs, received };
}

describe("ClientSession history integration", () => {
	it("does not publish the previous project's slow list after switching cwd", async () => {
		let finish!: (infos: SessionInfo[]) => void;
		const slow = new Promise<SessionInfo[]>((resolve) => {
			finish = resolve;
		});
		const { cs, received } = client((cwd) => (cwd === "/a" ? slow : Promise.resolve([info("b")])));
		const first = cs.refreshSessions();
		cs.cwd = "/b";
		await cs.refreshSessions();
		finish([info("a")]);
		await first;
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "sessions", sessions: [{ path: "b" }] });
	});

	it("does not publish a failed old project's empty list over the current one", async () => {
		let fail!: (error: Error) => void;
		const slow = new Promise<SessionInfo[]>((_resolve, reject) => {
			fail = reject;
		});
		const { cs, received } = client((cwd) => (cwd === "/a" ? slow : Promise.resolve([info("b")])));
		const first = cs.refreshSessions();
		cs.cwd = "/b";
		await cs.refreshSessions();
		fail(new Error("old directory unavailable"));
		await first;
		expect(received).toHaveLength(1);
	});

	it("external mutation invalidates in-flight scans for all existing waiters", async () => {
		let finish!: (infos: SessionInfo[]) => void;
		const slow = new Promise<SessionInfo[]>((resolve) => {
			finish = resolve;
		});
		const load = vi
			.fn()
			.mockReturnValueOnce(slow)
			.mockResolvedValueOnce([info("new")]);
		const { cs, received } = client(load);
		const first = cs.refreshSessions();
		await Promise.resolve();
		cs.notifyExternalSessionsChanged("/a");
		finish([info("deleted")]);
		await first;
		expect(load).toHaveBeenCalledTimes(2);
		expect(received.length).toBeGreaterThan(0);
		for (const msg of received) expect(msg).toMatchObject({ type: "sessions", sessions: [{ path: "new" }] });
	});

	it("invalidates cached background-project data without pushing it into this project", async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce([info("old")])
			.mockResolvedValueOnce([info("new")]);
		const { cs, received } = client(load);
		await cs.refreshSessions();
		cs.cwd = "/b";
		cs.notifyExternalSessionsChanged("/a");
		expect(received).toHaveLength(1);
		cs.cwd = "/a";
		await cs.refreshSessions();
		expect(received[1]).toMatchObject({ type: "sessions", sessions: [{ path: "new" }] });
	});

	it("preserves newest-first ordering and the history panel's 200-result cap", async () => {
		const { cs, received } = client(async () => Array.from({ length: 210 }, (_, n) => info(String(n), n)));
		await cs.refreshSessions();
		const message = received[0];
		if (message.type !== "sessions") throw new Error("Expected session list");
		expect(message.sessions).toHaveLength(200);
		expect(message.sessions[0].path).toBe("209");
		expect(message.sessions[199].path).toBe("10");
	});
});
