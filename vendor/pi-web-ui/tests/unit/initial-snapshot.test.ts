import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { InitialSnapshotGate } from "../../server/initial-snapshot-gate.js";
import type { ServerMessage, UiMessage } from "../../server/protocol.js";

// Exercise the real revision emitter without constructing SDK/config/services.
function session() {
	const messages: UiMessage[] = [{ id: "u-1", role: "user", content: [{ type: "text", text: "dummy" }] }];
	const cs: ClientSession = Object.assign(Object.create(ClientSession.prototype), {
		disposed: false,
		snapshotTimer: null,
		snapRev: 0,
		emittedMessages: null,
		emittedRev: 0,
		emittedConvId: "",
		activeId: "dummy-conversation",
		// 每对话的历史窗口状态：尾部优先（P1-8）经 `this.conv` 读这两个字段决定是否截断
		//（conv 是只读 getter，所以这里给的是它背后的 convs 映射）。
		convs: new Map([["dummy-conversation", { historyExpanded: false, historyOmitted: 0 }]]),
		sinks: new Set<(msg: ServerMessage) => void>(),
		currentMessages: () => messages.slice(),
		buildLightState: (rev: number) => ({ rev, conversationId: "dummy-conversation" }),
	});
	return { cs, messages, sinks: (cs as unknown as { sinks: Set<(msg: ServerMessage) => void> }).sinks };
}

describe("initial snapshot ordering and resync", () => {
	it.each(["hello", "reconnect", "plugin activation slower than the snapshot"])(
		"%s gets one full baseline, then valid deltas and full resync",
		() => {
			const { cs, messages, sinks } = session();
			// Simulate the reused session's revision history before attaching a socket.
			cs.flushSnapshot();
			const gate = new InitialSnapshotGate();
			const received: ServerMessage[] = [];
			sinks.add((msg) => {
				if ((msg.type === "snapshot" || msg.type === "snapshot_delta") && !gate.canSendSnapshot) return;
				received.push(msg);
			});
			const getState = () => {
				if (gate.canSendSnapshot) cs.flushSnapshot(true);
			};
			getState();
			getState();
			cs.flushSnapshot(); // SDK event during plugin discovery is gated.
			expect(received).toEqual([]);
			// The hello handler completes the gate synchronously, so nothing waits on
			// plugin activation anymore (the 5s fallback timer is gone).
			gate.complete(() => cs.flushSnapshot(true));
			gate.complete(() => cs.flushSnapshot(true));
			expect(received).toHaveLength(1);
			const baseline = received[0];
			expect(baseline.type).toBe("snapshot");
			if (baseline.type !== "snapshot") throw new Error("Expected full baseline");
			expect(baseline.state.messages).toEqual(messages);
			messages.push({ id: "u-2", role: "user", content: [] });
			cs.flushSnapshot();
			expect(received[1]).toMatchObject({
				type: "snapshot_delta",
				baseRev: baseline.state.rev,
				appended: [messages[1]],
			});
			getState(); // A gap after initialization must always get FULL state.
			expect(received[2]).toMatchObject({ type: "snapshot", state: { messages } });
		},
	);

	it("a new device does not block existing sockets or break their next revision", () => {
		const { cs, sinks } = session();
		const oldDevice: ServerMessage[] = [];
		const newDevice: ServerMessage[] = [];
		sinks.add((msg) => oldDevice.push(msg));
		cs.flushSnapshot();
		const gate = new InitialSnapshotGate();
		sinks.add((msg) => {
			if (gate.canSendSnapshot) newDevice.push(msg);
		});
		cs.flushSnapshot();
		expect(oldDevice[1].type).toBe("snapshot_delta");
		expect(newDevice).toEqual([]);
		gate.complete(() => cs.flushSnapshot(true));
		expect(newDevice[0].type).toBe("snapshot");
		expect(oldDevice[2]).toBe(newDevice[0]); // same broadcast object/serialization
		cs.flushSnapshot();
		expect(oldDevice[3]).toBe(newDevice[1]);
	});

	it("completion opens the gate before flushing, once only", () => {
		const gate = new InitialSnapshotGate();
		const flush = vi.fn(() => expect(gate.canSendSnapshot).toBe(true));
		expect(gate.canSendSnapshot).toBe(false);
		gate.complete(flush);
		gate.complete(flush);
		expect(flush).toHaveBeenCalledTimes(1);
	});
});
