/* 🍞 AI Breadcrumb: @COUPLED scripts/lib.mjs, scripts/lifecycle/files.mjs, tests/configure.test.mjs
 * @CONTRACT createConfig is pure: dev/release fixtures need no private configuration or credentials.
 */
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR, ROOT, isMain, validateConfig, readJson } from "./lib.mjs";
import { atomicJson, privateDirectory, syncPackages } from "./lifecycle/files.mjs";

export function createConfig({ root = ROOT, configDir = CONFIG_DIR,
  stateDir = process.env.PI_DEV_STATE_DIR || join(homedir(), ".local/share/pi-dev"),
  workspaceDir = process.env.PI_DEV_CWD || root, node = process.execPath, host = "127.0.0.1", port = Number(process.env.PI_DEV_PORT ?? 8788),
  profile = "lean", dataDir = join(stateDir, "web"), agentDir = join(stateDir, "agent"),
  tokenFile = join(configDir, "token"), ...unknown } = {}) {
  if (Object.keys(unknown).length) throw new Error(`Unknown config options: ${Object.keys(unknown).join(", ")}`);
  return validateConfig({ root, workspaceDir, node, host, port, profile, dataDir, agentDir, tokenFile });
}

export function configure({ configDir = CONFIG_DIR, options = {} } = {}) {
  const file = join(configDir, "runtime.json");
  const existing = existsSync(file) ? readJson(file) : {};
  const stateDir = options.stateDir ?? process.env.PI_DEV_STATE_DIR;
  const config = createConfig({ ...existing, root: ROOT, configDir,
    ...(process.env.PI_DEV_PORT !== undefined ? { port: Number(process.env.PI_DEV_PORT) } : {}),
    ...(process.env.PI_DEV_CWD ? { workspaceDir: resolve(process.env.PI_DEV_CWD) } : {}),
    ...(stateDir ? { stateDir, dataDir: join(stateDir, "web"), agentDir: join(stateDir, "agent") } : {}),
    ...options });
  for (const dir of [configDir, config.dataDir, config.agentDir]) privateDirectory(dir);
  if (!existsSync(config.tokenFile)) writeFileSync(config.tokenFile, `${randomBytes(32).toString("hex")}\n`,
    { mode: 0o600, flag: "wx" });
  syncPackages(config);
  atomicJson(file, config);
  return config;
}

export function parseConfigureArgs(args) {
  const names = { profile: "profile", port: "port", host: "host", workspace: "workspaceDir",
    "state-dir": "stateDir", "data-dir": "dataDir", "agent-dir": "agentDir" };
  const options = {};
  for (const arg of args) {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !Object.hasOwn(names, match[1])) throw new Error(`Unknown configure argument: ${arg}`);
    const field = names[match[1]];
    options[field] = field === "port" ? Number(match[2]) : field.endsWith("Dir") ? resolve(match[2]) : match[2];
  }
  return options;
}

if (isMain(import.meta.url)) {
  const config = configure({ options: parseConfigureArgs(process.argv.slice(2)) });
  console.log(`Configured ${join(CONFIG_DIR, "runtime.json")}; profile=${config.profile}; cwd=${config.workspaceDir}`);
}
