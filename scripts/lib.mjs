import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
export const CONFIG_DIR = resolve(
  process.env.PI_DEV_CONFIG_DIR || join(homedir(), ".config/pi-dev"),
);
export const CONFIG_FILE = join(CONFIG_DIR, "runtime.json");
export const SERVICE = "pi-web-ui-dev.service";
export const PROFILES = {
  lean: ["pi-context-prune"],
  full: [
    "pi-context-prune",
    "pi-lens",
    "pi-subagents",
    "pi-mcp-adapter",
    "@howaboua/pi-codex-conversion",
    "@narumitw/pi-goal",
  ],
};

export function validateConfig(config) {
  if (config.root !== ROOT)
    throw new Error("Checkout moved; rerun configure explicitly.");
  if (config.host !== "127.0.0.1")
    throw new Error("Only loopback binding is supported.");
  if (
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    config.port === 8787
  ) {
    throw new Error(
      "Choose an unprivileged port other than the legacy 8787 port.",
    );
  }
  if (!Object.hasOwn(PROFILES, config.profile))
    throw new Error("Unknown profile.");
  for (const field of ["root", "node", "dataDir", "agentDir", "tokenFile"]) {
    if (
      typeof config[field] !== "string" ||
      !config[field].startsWith("/") ||
      /[\r\n\0]/.test(config[field])
    ) {
      throw new Error(`Invalid absolute path: ${field}`);
    }
  }
  if (config.dataDir === config.agentDir)
    throw new Error("Web and agent directories must differ.");
  return config;
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Cannot read valid JSON from ${path}`, { cause });
  }
}

export function loadConfig() {
  return validateConfig(readJson(CONFIG_FILE));
}

export function runtimeEnv(config, base = process.env) {
  const token = readFileSync(config.tokenFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error("Invalid private access token.");
  return {
    ...base,
    PATH: [
      join(ROOT, ".venv/bin"),
      join(ROOT, "node_modules/.bin"),
      dirname(config.node),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    VIRTUAL_ENV: join(ROOT, ".venv"),
    PI_WEB_HOST: config.host,
    PI_WEB_PORT: String(config.port),
    PI_WEB_CWD: ROOT,
    PI_WEB_DATA_DIR: config.dataDir,
    PI_WEB_ENGINE: "pi",
    PI_CODING_AGENT_DIR: config.agentDir,
    // 不要设置 PI_CODING_AGENT_SESSION_DIR：SDK 0.85.1 不读它写盘（仍写
    // <agentDir>/sessions/--<cwd>--/），但 pi-web-ui 会把它当 sessionDir 传给
    // 非递归的 list()/listAll()，导致「历史对话 / 最近项目」列表恒为空。
    PI_WEB_TOKEN: token,
    // The public hostname is fixed for this deployment. Callers can still
    // override it explicitly when running an isolated local instance.
    PI_WEB_RP_ID: base.PI_WEB_RP_ID || "dev.ftai.cc",
    PI_WEB_ORIGIN: base.PI_WEB_ORIGIN || "https://dev.ftai.cc",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

export function systemdQuote(value, expandDollars = true) {
  let escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  if (expandDollars) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
}
