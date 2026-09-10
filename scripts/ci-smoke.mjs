/*
 * 🍞 AI Breadcrumb: isolated CI/runtime smoke; never loads operator configuration.
 * @COUPLED scripts/configure.mjs, scripts/smoke.mjs, scripts/start.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { configure } from "./configure.mjs";

const temporary = mkdtempSync(join(tmpdir(), "pi-dev-smoke-"));
const configDir = join(temporary, "config");
const workspaceDir = join(temporary, "workspace");
mkdirSync(workspaceDir);
const probe = createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const config = configure({ configDir, options: { root: ROOT, stateDir: join(temporary, "state"), workspaceDir, port } });
const env = { ...process.env, PI_DEV_CONFIG_DIR: configDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
// Do not let installed user packages/trust/model settings enter an integration fixture.
const { writeFileSync } = await import("node:fs");
writeFileSync(join(config.agentDir, "settings.json"), JSON.stringify({ packages: [], enableInstallTelemetry: false, defaultProjectTrust: "never" }));
const children = [];
const guard = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 60000);
try {
  const child = spawn(process.execPath, [join(ROOT, "scripts/start.mjs")], { cwd: workspaceDir, env, stdio: "ignore" });
  children.push(child);
  let launchError;
  child.on("error", error => { launchError = error; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      ready = response.ok && health.ok && health.pid === child.pid;
    } catch { /* Wait only for this fixture's port. */ }
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw new Error("Isolated server readiness timeout.");
  const smoke = spawn(process.execPath, [join(ROOT, "scripts/smoke.mjs")], { cwd: ROOT, env, stdio: "inherit" });
  children.push(smoke);
  const [code] = await once(smoke, "exit");
  if (code !== 0) throw new Error(`Smoke failed with ${code}`);
} finally {
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(timer);
  }
  clearTimeout(guard);
  rmSync(temporary, { recursive: true, force: true });
}
