/* 🍞 AI Breadcrumb: @COUPLED scripts/lib.mjs, scripts/lifecycle/files.mjs, tests/start.test.mjs
 * @CONTRACT Always execute the archived vendor artifact; never substitute an npm runtime.
 */
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { isMain, loadConfig, runtimeEnv } from "./lib.mjs";
import { syncPackages } from "./lifecycle/files.mjs";

export function runtimeEntry(config) {
  const entry = join(config.root, "vendor/pi-web-ui/dist/server/index.js");
  try { if (statSync(entry).isFile()) return entry; } catch {}
  throw new Error(`Vendor runtime missing: ${entry}. Run npm run setup:dependencies and npm run build at the code root.`);
}

export async function start(config = loadConfig()) {
  const entry = runtimeEntry(config);
  const env = runtimeEnv(config);
  syncPackages(config);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(config.workspaceDir ?? config.root);
  await import(pathToFileURL(entry).href);
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("Start accepts no CLI overrides; use configure to change runtime settings.");
  await start();
}
