import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { ROOT, loadConfig } from "./lib.mjs";

const config = loadConfig();
const child = spawn(config.node, [join(ROOT, "scripts/start.mjs")], {
  cwd: ROOT,
  stdio: "ignore",
});
let launchError;
child.on("error", (error) => {
  launchError = error;
});
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null)
      throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/health`,
        { signal: AbortSignal.timeout(1000) },
      );
      const health = await response.json();
      if (health.pid !== child.pid)
        throw new Error("Port belongs to another process.");
      ready = response.ok && health.ok;
    } catch {
      /* Allow the new process time to bind its port. */
    }
    if (ready) break;
    await delay(500);
  }
  if (!ready) throw new Error("CI server readiness timeout.");
  const smoke = spawn(config.node, [join(ROOT, "scripts/smoke.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  const [code] = await once(smoke, "exit");
  if (code !== 0) throw new Error(`Smoke failed with ${code}`);
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(timer);
  }
}
