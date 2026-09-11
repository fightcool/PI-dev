/**
 * @COUPLED agent-service.ts: history listing/search and persisted-node invalidation.
 * @GOTCHA An invalidated scan must neither publish nor return its stale result.
 * @PERF Both scans it backs parse EVERY transcript on disk (measured ~0.22s for the
 *   current project, ~0.25s across all projects, 14–16 MiB); keep the retention
 *   window in mind when adding a new caller, and rely on invalidation (not the TTL)
 *   for freshness — the TTL only absorbs repetition within one interaction.
 * See ../docs/architecture-core.md for multi-device history synchronization.
 */
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

type Scan = { promise: Promise<SessionInfo[]> };
type Entry = { infos: SessionInfo[]; at: number };

/** Per-key retained lists, with single-flight scans per key. TTL starts at completion. */
export class SessionHistoryCache {
	private readonly cached = new Map<string, Entry>();
	private readonly scans = new Map<string, Scan>();

	constructor(
		private readonly load: (cwd: string) => Promise<SessionInfo[]>,
		private readonly ttlMs = 3000,
		private readonly now = Date.now,
		/** Keys retained before the least-recently-used one is dropped. */
		private readonly maxKeys = 8,
	) {}

	get(cwd: string): Promise<SessionInfo[]> {
		const cached = this.cached.get(cwd);
		if (cached && this.now() - cached.at < this.ttlMs) {
			// Refresh recency so a hot project is never the one evicted.
			this.cached.delete(cwd);
			this.cached.set(cwd, cached);
			return Promise.resolve(cached.infos);
		}
		const pending = this.scans.get(cwd);
		if (pending) return pending.promise;

		const scan: Scan = { promise: undefined! };
		scan.promise = Promise.resolve()
			.then(() => this.load(cwd))
			.then(
				(infos) => {
					// A mutation superseded this scan. Existing waiters also need fresh data.
					if (this.scans.get(cwd) !== scan) return this.get(cwd);
					this.scans.delete(cwd);
					this.cached.delete(cwd);
					this.cached.set(cwd, { infos, at: this.now() });
					this.trim();
					return infos;
				},
				(error: unknown) => {
					if (this.scans.get(cwd) !== scan) return this.get(cwd);
					this.scans.delete(cwd);
					throw error;
				},
			);
		this.scans.set(cwd, scan);
		return scan.promise;
	}

	invalidate(cwd: string): void {
		this.cached.delete(cwd);
		this.scans.delete(cwd);
	}

	private trim(): void {
		while (this.cached.size > this.maxKeys) {
			const oldest = this.cached.keys().next();
			if (oldest.done) return;
			this.cached.delete(oldest.value);
		}
	}
}
