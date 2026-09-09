/**
 * All-source update check: pi-web-ui itself, the installed pi core
 * (@earendil-works/pi-coding-agent — probed via `pi --version`, with a
 * vendored-copy fallback), plus the DIRECT pi extensions declared in
 * <agentDir>/npm/package.json (fallback: raw node_modules walk).
 * Pure logic lives here so it can be unit-tested with an injected fetcher
 * (and an injected pi-core probe); ClientSession only wires it to the wire
 * protocol.
 */
import { readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pick, type ServerLang } from "./i18n.js";

const PI_CORE_PACKAGE = "@earendil-works/pi-coding-agent";

const REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 8_000;
/** Parallel registry lookups per batch. */
const CONCURRENCY = 5;

/** Simple numeric semver compare: >0 means a newer than b. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x - y;
	}
	return 0;
}

/**
 * Cache a zero-arg function's value for ttlMs. Plain value memoization: the
 * pi probe returns null on failure instead of throwing, so errors thread
 * through as ordinary values and there is nothing to rethrow.
 */
export function memoizeWithTtl<T>(fn: () => T, ttlMs: number): () => T {
	let entry: { at: number; value: T } | null = null;
	return () => {
		const now = Date.now();
		if (!entry || now - entry.at >= ttlMs) {
			entry = { at: now, value: fn() };
		}
		return entry.value;
	};
}

/**
 * Parse `pi --version` stdout into a version string, or null. Two-stage:
 * prefer a line that is exactly the version (optional leading "v", optional
 * prerelease/build suffix) so a stdout preamble like "Update available:
 * 0.85.0" cannot forge it; otherwise fall back to the first loose
 * semver-looking token. The exact-line match keeps the FULL version incl.
 * prerelease (0.85.0-beta.1 stays 0.85.0-beta.1).
 */
export function parsePiVersionOutput(stdout: string): string | null {
	const exact = stdout.match(/^\s*v?(\d+\.\d+\.\d+(?:[-+][\w.]+)*)\s*$/m)?.[1];
	if (exact) return exact;
	return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export type UpdateItemKind = "webui" | "pi-core" | "package";

export interface UpdateItem {
	name: string;
	kind: UpdateItemKind;
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
}

export interface LocalPackage {
	name: string;
	version: string;
	kind: UpdateItemKind;
}

/**
 * Enumerate installed pi packages for the "check all updates" list, matching
 * what the TUI shows: the DIRECT dependencies declared in
 * <agentDir>/npm/package.json, with each installed version resolved from
 * node_modules/<name>/package.json (not the manifest range). Transitive deps
 * are not listed.
 *
 * Fallback: when the manifest is missing/unreadable or declares no
 * dependencies, fall back to the historical raw node_modules walk.
 */
export function listInstalledPackages(agentDir: string): LocalPackage[] {
	const direct = readManifestDeps(agentDir);
	if (direct) return direct;
	return walkNodeModules(agentDir);
}

/** Direct deps from the npm manifest with installed versions, or null. */
function readManifestDeps(agentDir: string): LocalPackage[] | null {
	let manifest: { dependencies?: Record<string, string> } | null;
	try {
		manifest = JSON.parse(readFileSync(join(agentDir, "npm", "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		} | null;
		// Literal `null` parses fine but explodes on property access — treat as
		// unreadable (fallback to the raw walk), per the documented contract.
		if (!manifest || typeof manifest !== "object") return null;
	} catch {
		return null;
	}
	const deps = manifest.dependencies;
	if (!deps || typeof deps !== "object" || Object.keys(deps).length === 0) {
		return null;
	}
	const root = join(agentDir, "npm", "node_modules");
	const out: LocalPackage[] = [];
	for (const name of Object.keys(deps)) {
		const item = readLocalPackage(join(root, ...name.split("/")));
		// Broken/uninstalled entries are skipped (the registry never sees them).
		if (item) out.push(item);
	}
	// Deterministic order (manifest key order is arbitrary).
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Legacy fallback: raw walk of <agentDir>/npm/node_modules — top-level plain
 * names plus one level inside @scope dirs. Skips .bin, dotfiles and anything
 * without a readable package.json.
 */
function walkNodeModules(agentDir: string): LocalPackage[] {
	const root = join(agentDir, "npm", "node_modules");
	const out: LocalPackage[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.startsWith(".") || entry === ".bin") continue;
		if (entry.startsWith("@")) {
			let scoped: string[];
			try {
				scoped = readdirSync(join(root, entry));
			} catch {
				continue;
			}
			for (const name of scoped) {
				if (name.startsWith(".")) continue;
				const item = readLocalPackage(join(root, entry, name));
				if (item) out.push(item);
			}
		} else {
			const item = readLocalPackage(join(root, entry));
			if (item) out.push(item);
		}
	}
	// Deterministic order (readdir order is FS-dependent).
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readLocalPackage(dir: string): LocalPackage | null {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
		if (!pkg.name || !pkg.version) return null;
		return { name: pkg.name, version: pkg.version, kind: "package" };
	} catch {
		return null;
	}
}

/** How long a pi probe result stays hot (mirrors ClientSession.piCliProbe). */
const PI_PROBE_TTL_MS = 10_000;

let piCoreProbe: { at: number; version: string | null } | null = null;

/** Locate the pi CLI on PATH without spawning anything. */
function piCliOnPath(): string | null {
	const dirs = (process.env.PATH ?? "").split(delimiter);
	for (const dir of dirs) {
		if (!dir) continue;
		const candidate = join(dir, "pi");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Read the pi core version from disk: resolve the `pi` bin (typically a
 * symlink into <global>/node_modules/<pkg>/dist/bundle/cli.js) and walk up to
 * its package.json. FORK-FREE by design — see the note on defaultProbePiCore.
 */
function readPiCoreVersionFromDisk(): string | null {
	const bin = piCliOnPath();
	if (!bin) return null;
	try {
		let dir = dirname(realpathSync(bin));
		for (let i = 0; i < 8; i++) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
					if (pkg.name === PI_CORE_PACKAGE && pkg.version) return pkg.version;
				} catch {
					/* unreadable package.json — keep walking */
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Default pi core probe: run the globally installed `pi --version`, memoized
 * machine-wide for PI_PROBE_TTL_MS so repeated collectTargets calls never
 * re-probe. Reads the version from disk (pi bin → realpath → package.json)
 * instead of spawning `pi --version`. FORK-FREE by design — see the note on
 * defaultProbePiCore.
 */
export function defaultProbePiCore(): string | null {
	const now = Date.now();
	const cached = piCoreProbe;
	if (cached && now - cached.at < PI_PROBE_TTL_MS) return cached.version;
	const version = readPiCoreVersionFromDisk();
	piCoreProbe = { at: now, version };
	return version;
}

/**
 * Fallback when the CLI probe yields nothing: the version of the vendored pi
 * core copy in <agentDir>/npm/node_modules, or null if that is absent too.
 */
function readVendoredPiCore(agentDir: string): string | null {
	try {
		const pkg = JSON.parse(
			readFileSync(join(agentDir, "npm", "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"), "utf8"),
		) as { name?: string; version?: string };
		if (pkg.name !== PI_CORE_PACKAGE || !pkg.version) return null;
		return pkg.version;
	} catch {
		return null;
	}
}

/**
 * Build the full local target list: webui + the pi core + installed packages.
 * The pi core version comes from the CLI probe (injectable for tests), falling
 * back to the vendored copy under <agentDir>/npm/node_modules. Packages
 * listing the core directly are filtered out so the pi-core row wins — never
 * two rows for the same package.
 */
export function collectTargets(
	agentDir: string,
	webuiVersion: string,
	probePiCore: () => string | null = defaultProbePiCore,
): LocalPackage[] {
	const targets: LocalPackage[] = [{ name: "pi-web-ui", version: webuiVersion, kind: "webui" }];
	const coreVersion = probePiCore() ?? readVendoredPiCore(agentDir);
	if (coreVersion) {
		targets.push({
			name: PI_CORE_PACKAGE,
			version: coreVersion,
			kind: "pi-core",
		});
	}
	targets.push(...listInstalledPackages(agentDir).filter((pkg) => pkg.name !== PI_CORE_PACKAGE));
	return targets;
}

export type Fetcher = (
	url: string,
	init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Default fetcher (real network). Tests inject a fake. */
export const defaultFetcher: Fetcher = (url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>;

interface RegistryDoc {
	"dist-tags"?: { latest?: string };
	time?: Record<string, string>;
}

/** Look up one package's latest version + publish time in the npm registry. */
export async function fetchLatest(
	fetcher: Fetcher,
	name: string,
): Promise<{ latest: string | null; latestPublishedAt: string | null }> {
	const res = await fetcher(`${REGISTRY}/${encodeURIComponent(name)}`, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as RegistryDoc;
	const latest = data["dist-tags"]?.latest ?? null;
	return {
		latest,
		latestPublishedAt: latest && data.time ? (data.time[latest] ?? null) : null,
	};
}

/**
 * Check every target against the registry. One failed lookup degrades to an
 * error item (upToDate: false) without failing the rest. Results keep the
 * input order. Bounded concurrency (CONCURRENCY) keeps registry load polite.
 */
export async function checkAll(
	targets: LocalPackage[],
	fetcher: Fetcher = defaultFetcher,
	/** 单项 registry 查询失败时的 error 文案语言（默认英文）。 */
	lang?: () => ServerLang,
): Promise<UpdateItem[]> {
	const l = lang?.() ?? "en";
	const results: UpdateItem[] = Array.from({ length: targets.length }) as UpdateItem[];
	let cursor = 0;
	async function worker() {
		while (cursor < targets.length) {
			const i = cursor++;
			const t = targets[i]!;
			try {
				const { latest, latestPublishedAt } = await fetchLatest(fetcher, t.name);
				results[i] = {
					name: t.name,
					kind: t.kind,
					current: t.version,
					latest,
					latestPublishedAt,
					upToDate: latest === null || compareVersions(t.version, latest) >= 0,
				};
			} catch (err) {
				const errMessage = (err as Error).message;
				results[i] = {
					name: t.name,
					kind: t.kind,
					current: t.version,
					latest: null,
					latestPublishedAt: null,
					upToDate: false,
					error: pick(
						l,
						`检查更新失败：${errMessage}`,
						`Failed to check for updates: ${errMessage}`,
						"updatecheck.check.failed",
						{ errMessage },
					),
				};
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
	return results;
}
