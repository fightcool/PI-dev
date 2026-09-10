/* 🍞 AI Breadcrumb: @COUPLED scripts/pm2.mjs, deploy/pi-dev-pm2.service.in, tests/pm2-manager.test.mjs
 * @COUPLED deploy/ecosystem.config.cjs; 📖 docs/PM2-PRODUCTION.md
 * @WHY systemd owns foreground PM2; never spawn a daemon to inspect an inactive unit.
 * @CONTRACT Commands capture output; diagnostics expose allowlisted process fields only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, lstatSync, realpathSync, mkdirSync, mkdtempSync,
  readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, absolutePath, systemdQuote } from "../lib.mjs";
import { assertRealDirectoryPath, contained } from "./release-options.mjs";
import { serviceResources } from "./service-resources.mjs";

export const PM2_SERVICE = "pi-dev-pm2.service";
const ACTIONS = ["install", "status", "start", "stop", "restart"];

export function pm2Options(env = process.env, home = homedir()) {
  const base = absolutePath(env.PI_DEV_DEPLOY_ROOT ?? join(home, ".local/share/pi-dev/deploy"), "deploy root");
  if (["/", "/srv", "/home", home].includes(base)) throw new Error("Choose a dedicated deployment root.");
  const configDir = absolutePath(env.PI_DEV_CONFIG_DIR ?? join(home, ".config/pi-dev"), "config directory");
  if (!statSync(configDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Config directory must exist.");
  assertRealDirectoryPath(base);
  const shared = join(base, "shared"), pm2Home = join(shared, "pm2");
  if (env.PM2_HOME !== undefined && absolutePath(env.PM2_HOME, "PM2 home") !== pm2Home)
    throw new Error("PM2_HOME must be deploy/shared/pm2.");
  if (env.PI_DEV_PM2_NAME !== undefined && env.PI_DEV_PM2_NAME !== "pi-dev-web")
    throw new Error("Production PM2 name must be pi-dev-web.");
  for (const path of [shared, pm2Home, join(shared, "logs")]) assertRealDirectoryPath(path);
  const resources = serviceResources({ ...env, PI_DEV_HEAP_MB: env.PI_DEV_HEAP_MB ?? "2048",
    PI_DEV_MEMORY_HIGH: env.PI_DEV_MEMORY_HIGH ?? "3G", PI_DEV_MEMORY_MAX: env.PI_DEV_MEMORY_MAX ?? "4G" });
  const maxMemory = env.PI_DEV_PM2_MAX_MEMORY ?? "3G";
  const bytes = value => { const m = /^([1-9][0-9]*)(M|G)$/.exec(value); return m ? Number(m[1]) * (m[2] === "G" ? 1024 ** 3 : 1024 ** 2) : NaN; };
  if (!Number.isSafeInteger(bytes(maxMemory)) || bytes(maxMemory) <= Number(resources.HEAP_MB) * 1024 ** 2 ||
      bytes(maxMemory) > bytes(resources.MEMORY_MAX)) throw new Error("PM2 memory must satisfy heap < PM2 limit <= MemoryMax (M or G).");
  return { base, shared, configDir, pm2Home, current: join(base, "current"),
    node: join(base, "tools/node/bin/node"), pm2: join(base, "tools/pm2/node_modules/pm2/bin/pm2"),
    runtime: join(base, "tools/pm2/node_modules/pm2/bin/pm2-runtime"), resources, maxMemory };
}

export function renderPm2Unit(options, templateRoot = ROOT) {
  const qenv = (key, value) => systemdQuote(`${key}=${value}`, false);
  const values = { BASE: options.base.replaceAll("%", "%%"), NODE: systemdQuote(options.node),
    PM2_RUNTIME: systemdQuote(options.runtime), ECOSYSTEM: systemdQuote(join(options.current, "deploy/ecosystem.config.cjs")),
    PM2_HOME: qenv("PM2_HOME", options.pm2Home), RELEASE_ROOT: qenv("PI_DEV_RELEASE_ROOT", options.current),
    CONFIG_DIR: qenv("PI_DEV_CONFIG_DIR", options.configDir), DEPLOY_ROOT: qenv("PI_DEV_DEPLOY_ROOT", options.base),
    NODE_ENV_PATH: qenv("PI_DEV_NODE", options.node) };
  return readFileSync(join(templateRoot, "deploy/pi-dev-pm2.service.in"), "utf8")
    .replace(/@([A-Z0-9_]+)@/g, (_, key) => { if (!(key in values)) throw new Error("Unknown unit placeholder."); return values[key]; })
    .replace(/^Environment=PI_DEV_HEAP_MB=.*$/m, `Environment=PI_DEV_HEAP_MB=${options.resources.HEAP_MB}`)
    .replace(/^Environment=PI_DEV_PM2_MAX_MEMORY=.*$/m, `Environment=PI_DEV_PM2_MAX_MEMORY=${options.maxMemory}`)
    .replace(/^MemoryHigh=.*$/m, `MemoryHigh=${options.resources.MEMORY_HIGH}`)
    .replace(/^MemoryMax=.*$/m, `MemoryMax=${options.resources.MEMORY_MAX}`);
}

function validateRuntime(options) {
  if (!lstatSync(options.current, { throwIfNoEntry: false })?.isSymbolicLink() ||
      !contained(join(options.base, "releases"), realpathSync(options.current)))
    throw new Error("current must link to a release under deploy/releases.");
  for (const path of [options.node, options.runtime, options.pm2, join(options.current, "deploy/ecosystem.config.cjs"),
    join(options.current, "vendor/pi-web-ui/dist/build-info.json")])
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`Required runtime file missing: ${path}`);
}

function buildInfo(options) {
  const file = join(options.current, "vendor/pi-web-ui/dist/build-info.json");
  if (!existsSync(file)) return null;
  try {
    if (!contained(join(options.base, "releases"), realpathSync(options.current))) return null;
    const info = JSON.parse(readFileSync(file, "utf8"));
    return { path: realpathSync(file), commit: /^[a-f0-9]{40}$/.test(info.commit) ? info.commit : null };
  } catch { throw new Error("Cannot read linked build-info metadata."); }
}

export function pm2Action(action, { env = process.env, home = homedir(), exec = spawnSync,
  unitDir = join(home, ".config/systemd/user"), templateRoot = ROOT, log = console.log,
  uid = process.getuid?.(), alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } },
} = {}) {
  if (!ACTIONS.includes(action)) throw new Error(`Usage: node scripts/pm2.mjs ${ACTIONS.join("|")}`);
  if (uid === 0) throw new Error("Run PM2 management as the deployment user, never root.");
  const options = pm2Options(env, home);
  const command = (program, args, commandEnv = env) => {
    const result = exec(program, args, { env: commandEnv, stdio: "pipe", encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    // Neither stderr nor errors from PM2 may be echoed: they may contain environment values.
    if (result.error || result.status !== 0) throw new Error(`Manager command failed: ${program === "systemctl" ? "systemctl" : "PM2/verification"}`);
    return result.stdout?.trim() ?? "";
  };
  const systemctl = args => command("systemctl", ["--user", ...args]);
  const state = unit => {
    const out = systemctl(["show", "--property=LoadState,ActiveState", unit]);
    const fields = Object.fromEntries(out.split("\n").map(line => line.split("=")));
    if (!["loaded", "not-found", "masked"].includes(fields.LoadState) ||
        !["active", "inactive", "failed", "activating", "deactivating", "reloading", "refreshing"].includes(fields.ActiveState))
      throw new Error("Cannot determine manager state.");
    return fields.ActiveState;
  };
  const inactive = value => ["inactive", "failed"].includes(value);
  const currentState = state(PM2_SERVICE);
  if (action === "status") {
    let apps = [];
    if (currentState === "active") {
      const pidFile = join(options.pm2Home, "pm2.pid");
      const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "0");
      if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) throw new Error("PM2 supervisor is not ready; retry status.");
      let raw;
      try { raw = JSON.parse(command(options.node, [options.pm2, "jlist"], { ...env, PM2_HOME: options.pm2Home })); }
      catch { throw new Error("Cannot obtain PM2 status."); }
      if (!Array.isArray(raw)) throw new Error("Invalid PM2 status response.");
      const number = n => Number.isFinite(n) && n >= 0 ? n : null;
      const states = ["online", "stopped", "stopping", "launching", "errored", "one-launch-status", "waiting restart"];
      apps = raw.filter(app => app?.name === "pi-dev-web").map(app => ({ name: "pi-dev-web", pid: number(app.pid),
        status: states.includes(app.pm2_env?.status) ? app.pm2_env.status : "unknown",
        restarts: number(app.pm2_env?.restart_time), rss: number(app.monit?.memory),
        uptimeMs: Number.isFinite(app.pm2_env?.pm_uptime) ? Math.max(0, Date.now() - app.pm2_env.pm_uptime) : null }));
    }
    const result = { unit: PM2_SERVICE, state: currentState, apps, buildInfo: buildInfo(options) };
    log(JSON.stringify(result, null, 2));
    return result;
  }
  if (action === "stop") { systemctl(["stop", PM2_SERVICE]); return; }
  if (action === "install" && !inactive(currentState)) throw new Error("Stop the PM2 unit explicitly before installing.");
  if (["start", "restart"].includes(action)) {
    for (const unit of ["pi-web-ui-dev.service", "pi-web-ui-dev-watchdog.timer", "pi-web-ui-dev-watchdog.service"])
      if (!inactive(state(unit))) throw new Error("Retire the previous UI manager and watchdog before starting PM2.");
    if (inactive(currentState)) {
      const file = join(options.pm2Home, "pm2.pid");
      const pid = Number(existsSync(file) ? readFileSync(file, "utf8").trim() : "0");
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error("An unmanaged PM2 process is already running.");
    }
  }
  validateRuntime(options);
  if (action === "install") {
    absolutePath(unitDir, "unit directory");
    const rendered = renderPm2Unit(options, templateRoot);
    for (const dir of [options.pm2Home, join(options.shared, "logs"), unitDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(join(unitDir, ".pi-dev-pm2-"));
    try {
      const file = join(stage, PM2_SERVICE);
      writeFileSync(file, rendered, { mode: 0o600 });
      command("systemd-analyze", ["--user", "verify", file]);
      if (!inactive(state(PM2_SERVICE))) throw new Error("PM2 unit became active during installation.");
      renameSync(file, join(unitDir, PM2_SERVICE));
      systemctl(["daemon-reload"]);
      log(`Installed ${join(unitDir, PM2_SERVICE)}; start and boot enablement are explicit operations.`);
    } finally { rmSync(stage, { recursive: true, force: true }); }
  } else { systemctl([action, PM2_SERVICE]); }
}
