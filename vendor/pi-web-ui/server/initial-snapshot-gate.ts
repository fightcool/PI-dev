/**
 * @COUPLED index.ts hello/get_state/send; web/src/use-chat.ts ready handling.
 * @GOTCHA Gate only the new socket: existing tabs must keep receiving revisions.
 * See ../docs/architecture-core.md for snapshot resync and plugin ordering.
 */
export class InitialSnapshotGate {
	private initialized = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	/** Plugin discovery normally wins; a stuck activation must not blank chat. */
	start(flushFull: () => void, timeoutMs = 5000): void {
		if (this.initialized || this.timer) return;
		this.timer = setTimeout(() => this.complete(flushFull), timeoutMs);
		this.timer.unref?.();
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Coalesce startup get_state requests into the promised initial full state. */
	get canSendSnapshot(): boolean {
		return this.initialized;
	}

	/** Open before flushing so the initial full snapshot reaches this socket. */
	complete(flushFull: () => void): void {
		if (this.initialized) return;
		this.dispose();
		this.initialized = true;
		flushFull();
	}
}
