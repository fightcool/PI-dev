/* 🍞 AI Breadcrumb: @COUPLED scripts/lib.mjs, scripts/lifecycle/systemd.mjs, tests/service.test.mjs
 * @COUPLED deploy/pi-web-ui-dev.service.in
 * @CONTRACT Importing is inert; all mutations validate config before commands or writes.
 * @WHY Verify a staged unit before retiring the watchdog or replacing the live unit.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
  copyFileSync, renameSync, rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { CONFIG_DIR, ROOT, SERVICE, isMain, loadConfig, validateConfig, systemdQuote } from "./lib.mjs";
import { createSystemd } from "./lifecycle/systemd.mjs";
import { serviceResources } from "./lifecycle/service-resources.mjs";

export async function assertPortFree(config) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export function renderUnit(config, configDir = CONFIG_DIR, env = process.env) {
  validateConfig(config);
  const replacements = {
    ...serviceResources(env),
    WORKSPACE: systemdQuote(config.workspaceDir ?? ROOT, false),
    NODE: systemdQuote(config.node),
    START: systemdQuote(join(config.root, "scripts/start.mjs")),
    CONFIG_ENV: systemdQuote(`PI_DEV_CONFIG_DIR=${configDir}`, false),
  };
  return readFileSync(join(ROOT, "deploy/pi-web-ui-dev.service.in"), "utf8")
    .replace(/@(WORKSPACE|NODE|START|CONFIG_ENV|HEAP_MB|MEMORY_HIGH|MEMORY_MAX)@/g, (_, key) => replacements[key]);
}

export async function serviceAction(action, {
  exec, getConfig = loadConfig, configDir = CONFIG_DIR, env = process.env,
  unitDir = join(homedir(), ".config/systemd/user"),
  checkPort = assertPortFree, log = console.log,
} = {}) {
  if (!["install", "status", "start", "stop", "restart", "disable"].includes(action))
    throw new Error("Usage: node scripts/service.mjs install|status|start|stop|restart|disable");
  const systemd = createSystemd(exec);
  if (action === "status") return systemd.run(["status", SERVICE]);
  const config = validateConfig(getConfig());
  for (const path of [configDir, unitDir]) {
    if (typeof path !== "string" || !isAbsolute(path) || /[\r\n\0]/.test(path))
      throw new Error("Service paths must be absolute and contain no control characters.");
  }
  if (action === "install") {
    const rendered = renderUnit(config, configDir, env);
    systemd.assertStopped(SERVICE);
    mkdirSync(unitDir, { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(join(unitDir, ".pi-dev-stage-"));
    const stagedPath = join(stage, SERVICE);
    const unitPath = join(unitDir, SERVICE);
    try {
      writeFileSync(stagedPath, rendered, { mode: 0o600 });
      systemd.verify(stagedPath);
      systemd.retireWatchdog();
      // A watchdog job could have started the main service during verification.
      systemd.assertStopped(SERVICE);
      await checkPort(config);
      if (existsSync(unitPath)) {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        copyFileSync(unitPath, join(configDir, `${SERVICE}.${Date.now()}.bak`));
      }
      renameSync(stagedPath, unitPath);
      systemd.run(["daemon-reload"]);
      systemd.run(["enable", "--now", SERVICE]);
      log(`Installed ${unitPath}; native systemd restart handles recovery.`);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } else {
    if (["stop", "disable"].includes(action)) systemd.retireWatchdog();
    systemd.run(action === "disable" ? ["disable", "--now", SERVICE] : [action, SERVICE]);
  }
}

if (isMain(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Service requires exactly one action.");
  await serviceAction(process.argv[2]);
}
