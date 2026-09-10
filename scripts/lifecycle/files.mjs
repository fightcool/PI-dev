/* 🍞 AI Breadcrumb: @COUPLED scripts/configure.mjs, scripts/start.mjs
 * @WHY Atomic private writes and profile migration are shared by configure and movable releases.
 */
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { PROFILES, readJson } from "../lib.mjs";

export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error(`Expected a real directory: ${path}`);
}

export function atomicJson(path, data) {
  privateDirectory(dirname(path));
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`Expected a regular file: ${path}`);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function syncPackages(config) {
  const path = join(config.agentDir, "settings.json");
  const settings = existsSync(path) ? readJson(path) : {
    defaultProjectTrust: "ask", enableInstallTelemetry: false,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  if (settings.packages !== undefined && !Array.isArray(settings.packages))
    throw new Error("Agent settings.packages must be an array.");
  const known = new Set(Object.values(PROFILES).flat());
  // Only root-managed absolute dependency paths migrate; custom/npm package specs survive.
  const custom = (settings.packages ?? []).filter(item => !(typeof item === "string" &&
    item.startsWith("/") && [...known].some(name => item.endsWith(`/node_modules/${name}`))));
  const packages = [...custom, ...PROFILES[config.profile].map(name => join(config.root, "node_modules", name))];
  if (JSON.stringify(settings.packages) !== JSON.stringify(packages)) atomicJson(path, { ...settings, packages });
}
