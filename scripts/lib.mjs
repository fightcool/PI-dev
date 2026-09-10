/* 🍞 AI Breadcrumb: @COUPLED scripts/configure.mjs, scripts/start.mjs, scripts/lifecycle/release.mjs
 * @CONTRACT root is executable code; workspaceDir and private state survive release switches.
 * 📖 docs/DEV-CON-PROPOSAL.md: 8787 forbidden; 8791 reserved for standalone dev-con.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
export const CONFIG_DIR = resolve(process.env.PI_DEV_CONFIG_DIR || join(homedir(), ".config/pi-dev"));
export const CONFIG_FILE = join(CONFIG_DIR, "runtime.json");
export const SERVICE = "pi-web-ui-dev.service";
export const PROFILES = {
  lean: ["pi-context-prune"],
  full: ["pi-context-prune", "pi-lens", "pi-subagents", "pi-mcp-adapter",
    "@howaboua/pi-codex-conversion", "@narumitw/pi-goal"],
};

export function absolutePath(value, field) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\r\n\0]/.test(value))
    throw new Error(`Invalid absolute path: ${field}`);
  return resolve(value);
}

export function validatePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8787, 8791].includes(port))
    throw new Error("Choose an unprivileged port; legacy 8787 and dev-con 8791 are reserved.");
  return port;
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid runtime config.");
  if (config.host !== "127.0.0.1") throw new Error("Only loopback binding is supported.");
  validatePort(config.port);
  if (!Object.hasOwn(PROFILES, config.profile)) throw new Error("Unknown profile.");
  for (const field of ["root", "node", "dataDir", "agentDir", "tokenFile"])
    absolutePath(config[field], field);
  if (config.workspaceDir !== undefined) absolutePath(config.workspaceDir, "workspaceDir");
  for (const path of [config.root, config.workspaceDir ?? config.root])
    if (resolve(path) === "/root" || resolve(path).startsWith("/root/"))
      throw new Error("Code root and workspace must not use /root; run as the development user.");
  const web = resolve(config.dataDir), agent = resolve(config.agentDir);
  if (web === agent || web.startsWith(`${agent}/`) || agent.startsWith(`${web}/`))
    throw new Error("Web and agent directories must be separate, non-nested directories.");
  return config;
}

export function isMain(url) {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]); }
  catch { return false; }
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Cannot read valid JSON from ${path}`); }
}

export function loadConfig(file = CONFIG_FILE, codeRoot = ROOT) {
  const stored = validateConfig(readJson(file));
  return validateConfig({ ...stored, root: absolutePath(codeRoot, "root"),
    workspaceDir: stored.workspaceDir ?? stored.root });
}

export function runtimeEnv(config, base = process.env) {
  validateConfig(config);
  const token = readFileSync(config.tokenFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid private access token.");
  const env = { ...base };
  // npm/PM2 may retain these across cwd changes. Do not inherit checkout-specific paths.
  for (const key of ["PI_CODING_AGENT_SESSION_DIR", "PI_DEV_WEB_UI_ENTRY", "NODE_PATH",
    "npm_package_json", "npm_config_local_prefix", "INIT_CWD"]) delete env[key];
  return { ...env,
    PATH: [join(config.root, ".venv/bin"), join(config.root, "node_modules/.bin"),
      dirname(config.node), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    VIRTUAL_ENV: join(config.root, ".venv"),
    PI_WEB_HOST: config.host, PI_WEB_PORT: String(config.port),
    PI_WEB_CWD: config.workspaceDir ?? config.root,
    PI_WEB_DATA_DIR: config.dataDir, PI_WEB_ENGINE: "pi",
    PI_CODING_AGENT_DIR: config.agentDir, PI_WEB_TOKEN: token,
    PI_WEB_RP_ID: base.PI_WEB_RP_ID || "dev.ftai.cc",
    PI_WEB_ORIGIN: base.PI_WEB_ORIGIN || "https://dev.ftai.cc",
    PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_WEB_MANAGED: "1",
  };
}

export function systemdQuote(value, expandDollars = true) {
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (expandDollars) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
}
