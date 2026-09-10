/* [breadcrumb] @COUPLED Dockerfile, compose.yaml, scripts/configure.mjs, scripts/lib.mjs, scripts/start.mjs
 * @CONTRACT Stored config stays loopback-only; only this container process binds all interfaces.
 * @WHY Reuse profile registration, environment sanitization and the exact vendor entry.
 */
import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configure } from "../configure.mjs";
import { absolutePath, isMain, runtimeEnv } from "../lib.mjs";
import { runtimeEntry } from "../start.mjs";

export async function startContainer() {
  if (process.argv.length > 2) throw new Error("Container start accepts no CLI overrides; use container environment settings.");
  const configDir = absolutePath(process.env.PI_DEV_CONFIG_DIR ?? "/config", "configDir");
  const stateDir = absolutePath(process.env.PI_DEV_STATE_DIR ?? "/data", "stateDir");
  const workspaceDir = absolutePath(process.env.PI_WEB_CWD ?? "/workspace", "workspaceDir");
  mkdirSync(workspaceDir, { recursive: true });
  accessSync(workspaceDir, constants.R_OK | constants.W_OK | constants.X_OK);
  const config = configure({ configDir, options: {
    stateDir, workspaceDir, node: process.execPath, host: "127.0.0.1",
    port: Number(process.env.PI_WEB_PORT ?? "8788"),
    profile: process.env.PI_DEV_PROFILE ?? "lean",
    dataDir: process.env.PI_WEB_DATA_DIR ?? join(stateDir, "web"),
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(stateDir, "agent"),
    tokenFile: join(configDir, "token"),
  } });
  const entry = runtimeEntry(config);
  const env = runtimeEnv(config, {
    ...process.env,
    PI_WEB_RP_ID: process.env.PI_WEB_RP_ID ?? "localhost",
    PI_WEB_ORIGIN: process.env.PI_WEB_ORIGIN ?? `http://localhost:${config.port}`,
  });
  // Apply after validation, without weakening host lifecycle validation.
  env.PI_WEB_HOST = "0.0.0.0";
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(config.workspaceDir);
  await import(pathToFileURL(entry).href);
}

if (isMain(import.meta.url)) {
  await startContainer();
}
