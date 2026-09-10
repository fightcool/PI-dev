/**
 * @COUPLED agent-service.ts: history listing/search and persisted-node invalidation.
 * @GOTCHA An invalidated scan must neither publish nor return its stale result.
 * See ../docs/architecture-core.md for multi-device history synchronization.
 */
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

type Scan = { promise: Promise<SessionInfo[]> };

/** One retained list, with per-cwd single-flight scans. TTL starts at completion. */
export class SessionHistoryCache {
	private cached: { cwd: string; infos: SessionInfo[]; at: number } | undefined;
	private readonly scans = new Map<string, Scan>();

	constructor(
		private readonly load: (cwd: string) => Promise<SessionInfo[]>,
		private readonly ttlMs = 3000,
		private readonly now = Date.now,
	) {}

	get(cwd: string): Promise<SessionInfo[]> {
		const cached = this.cached;
		if (cached?.cwd === cwd && this.now() - cached.at < this.ttlMs) {
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
					this.cached = { cwd, infos, at: this.now() };
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
		if (this.cached?.cwd === cwd) this.cached = undefined;
		this.scans.delete(cwd);
	}
}
