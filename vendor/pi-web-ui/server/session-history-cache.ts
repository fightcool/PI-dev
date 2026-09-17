/**
 * @COUPLED agent-service.ts: history listing/search and persisted-node invalidation.
 * @COUPLED session-signature.ts: the cheap (mtimeMs:size) signature this cache gates on.
 * @GOTCHA An invalidated scan must neither publish nor return its stale result.
 * @PERF Both scans it backs parse EVERY transcript on disk (measured 2026-09-16:
 *   `SessionManager.list` 540ms / 35.6MB for one project, `listAll` 960ms / 75.2MB
 *   across all projects — 5x the 14MB that produced the earlier 0.22s/0.25s numbers).
 *   With `signature` supplied the cache skips the parse entirely when no transcript
 *   changed, and `adopted()` exempts the files this process is actively appending to
 *   (a streaming run would otherwise force a full rescan every 800ms debounce).
 *   The running conversation's own entry is refreshed once per run by
 *   `broadcastPersistedNode()` → `invalidateSessionInfos()`.
 * See ../docs/architecture-core.md for multi-device history synchronization.
 */
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

type Scan = { promise: Promise<SessionInfo[]> };
type Stamps = Map<string, string>;
type Entry = { infos: SessionInfo[]; at: number; stamps?: Stamps };

/** `path → "${mtimeMs}:${size}"`；见 session-signature.ts。 */
export type SessionStamps = Stamps;

export interface SessionHistoryCacheOptions {
	/** Cheap fingerprint of every transcript on disk. When it is unchanged since the
	 *  scan that produced the cached list, the list is reused regardless of TTL —
	 *  identical signatures prove identical content. */
	signature?: () => Promise<SessionStamps>;
	/** Files this process is writing right now (live conversations). Their signature
	 *  changes must NOT trigger a rescan: the in-memory session already owns those
	 *  writes, and `invalidate()` refreshes them once the run ends. */
	adopted?: (path: string) => boolean;
}

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
		private readonly options: SessionHistoryCacheOptions = {},
	) {}

	get(cwd: string): Promise<SessionInfo[]> {
		const pending = this.scans.get(cwd);
		if (pending) return pending.promise;

		// Register the flight synchronously so concurrent callers share it, then decide
		// asynchronously whether the cached list is still provably fresh.
		const scan: Scan = { promise: undefined! };
		scan.promise = this.resolve(cwd, scan);
		this.scans.set(cwd, scan);
		return scan.promise;
	}

	private async resolve(cwd: string, scan: Scan): Promise<SessionInfo[]> {
		const cached = this.cached.get(cwd);
		if (cached && (await this.reusable(cwd, scan, cached))) {
			// Provably fresh (signature unchanged, or within TTL): serve it without a parse.
			// `cached.infos` is the same array the entry still holds — no re-entry into get().
			if (this.scans.get(cwd) === scan) this.scans.delete(cwd);
			return cached.infos;
		}
		let infos: SessionInfo[];
		try {
			infos = await Promise.resolve().then(() => this.load(cwd));
		} catch (error) {
			if (this.scans.get(cwd) !== scan) return this.get(cwd);
			this.scans.delete(cwd);
			throw error;
		}
		// A mutation superseded this scan. Existing waiters also need fresh data.
		if (this.scans.get(cwd) !== scan) return this.get(cwd);
		this.scans.delete(cwd);
		// Signature is captured AFTER the scan: a file written while we were reading it
		// stays "changed" and the next get() revalidates, which is the safe direction.
		const stamps = await this.captureStamps();
		this.cached.delete(cwd);
		this.cached.set(cwd, { infos, at: this.now(), stamps });
		this.trim();
		return infos;
	}

	/** True when the cached list can be served without touching the disk again. */
	private async reusable(cwd: string, scan: Scan, cached: Entry): Promise<boolean> {
		const withinTtl = this.now() - cached.at < this.ttlMs;
		const serve = (): boolean => {
			// Refresh recency (Map order) so a hot project is never the one evicted;
			// `at` stays put: the TTL is measured from the scan that produced the list.
			this.cached.delete(cwd);
			this.cached.set(cwd, cached);
			return true;
		};
		// No fingerprint to compare (not configured, or it could not be captured):
		// fall back to plain TTL freshness instead of failing the listing.
		if (!this.options.signature || !cached.stamps) return withinTtl ? serve() : false;
		const current = await this.captureStamps();
		if (!current) return withinTtl ? serve() : false;
		if (this.scans.get(cwd) !== scan) return false;
		if (!this.signatureUnchanged(cached.stamps, current)) return false;
		return serve();
	}

	private signatureUnchanged(previous: Stamps, current: Stamps): boolean {
		for (const [path, stamp] of current) {
			const before = previous.get(path);
			if (before === stamp) continue;
			// A file this process is appending to right now: not evidence of foreign change.
			if (before !== undefined && this.options.adopted?.(path)) continue;
			return false;
		}
		for (const path of previous.keys()) if (!current.has(path)) return false;
		return true;
	}

	private async captureStamps(): Promise<Stamps | undefined> {
		if (!this.options.signature) return undefined;
		try {
			return await this.options.signature();
		} catch {
			// A failed fingerprint must never fail a listing — fall back to TTL freshness.
			return undefined;
		}
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
