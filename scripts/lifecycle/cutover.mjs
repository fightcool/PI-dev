/*
 * 🍞 AI Breadcrumb: @COUPLED scripts/pm2.mjs, deploy/pi-dev-pm2.service.in
 * @CONTRACT Runs in a separate user unit, outside the service being replaced.
 * Waits for active work, then switches; activation failures restore the old unit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson } from "./files.mjs";
import { waitForHealth } from "./health.mjs";

export function systemctl(args) {
  return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function cutover(options, { control, run = systemctl, health = waitForHealth,
  sleep = delay, now = Date.now, report = () => {} } = {}) {
  const { oldUnit = "pi-web-ui-dev.service", pm2Unit = "pi-dev-pm2.service", config, node,
    configFile, backupFile, waitMs = 600000, pollMs = 2000 } = options;
  let stopped = false, quiesced = false;
  const state = { status: "waiting", oldUnit, pm2Unit, startedAt: new Date().toISOString() };
  const update = (status, fields = {}) => { Object.assign(state, { status }, fields); report({ ...state }); };
  const oldEnabled = run(["is-enabled", oldUnit]);
  try {
    const initial = await control("status");
    if (!initial?.ok) throw new Error("Old service control socket is unavailable.");
    if (!(await control("quiesce"))?.ok) throw new Error("Could not quiesce old service.");
    quiesced = true;
    update("waiting", { connectedClients: initial.connectedClients, activeConversations: initial.activeConversations });
    const deadline = now() + waitMs;
    while (true) {
      const status = await control("status");
      if (!status?.ok) throw new Error("Old service became unavailable while waiting.");
      if (status.activeConversations === 0 && status.pendingMessages === 0) break;
      if (now() >= deadline) throw new Error("Active work did not drain before the deployment deadline.");
      await sleep(pollMs);
    }
    // No credential files are copied. runtime.json contains only instance paths.
    if (!existsSync(backupFile)) writeFileSync(backupFile, readFileSync(configFile), { flag: "wx", mode: 0o600 });
    update("switching");
    for (const unit of ["pi-web-ui-dev-watchdog.timer", "pi-web-ui-dev-watchdog.service"]) {
      const load = run(["show", unit, "--property=LoadState", "--value"]);
      if (load === "loaded") {
        run(["stop", unit]);
        if (unit.endsWith(".timer")) run(["disable", unit]);
      }
    }
    run(["stop", oldUnit]);
    stopped = true;
    run(["disable", oldUnit]);
    atomicJson(configFile, { ...config, workspaceDir: config.workspaceDir ?? config.root, node });
    run(["enable", "--now", pm2Unit]);
    // Query PM2-owned app PID through the local control socket, never dump env.
    let ready;
    for (let n = 0; n < 60; n++) {
      ready = await control("status");
      if (ready?.ok && ready.pid !== initial.pid) break;
      await sleep(500);
    }
    if (!ready?.ok || ready.pid === initial.pid) throw new Error("New application did not open its control socket.");
    await health({ ...config, workspaceDir: config.workspaceDir ?? config.root }, { pid: ready.pid, timeout: 15000, candidate: true });
    update("deployed", { pid: ready.pid, finishedAt: new Date().toISOString() });
    return state;
  } catch (error) {
    if (stopped) {
      try {
        run(["disable", "--now", pm2Unit]);
        if (existsSync(backupFile)) writeFileSync(configFile, readFileSync(backupFile), { mode: 0o600 });
        if (oldEnabled === "enabled") run(["enable", oldUnit]);
        run(["start", oldUnit]);
        let restored;
        for (let n = 0; n < 60; n++) {
          restored = await control("status");
          if (restored?.ok && restored.pid !== state.pid) break;
          await sleep(500);
        }
        if (!restored?.ok) throw new Error("Old service did not recover.");
        await health({ ...config, workspaceDir: config.workspaceDir ?? config.root }, { pid: restored.pid, timeout: 15000, candidate: false });
        await control("unquiesce");
        update("rolled_back", { error: error.message });
      } catch { update("recovery_failed", { error: error.message }); }
    } else {
      if (quiesced) await control("unquiesce");
      update("cancelled", { error: error.message });
    }
    throw error;
  }
}
