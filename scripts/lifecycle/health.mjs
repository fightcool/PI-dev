/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/release.mjs, scripts/smoke.mjs
 * @CONTRACT Health must belong to the expected PM2 pid, not an unrelated listener.
 */
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";

export async function assertPortFree(host, port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function waitForHealth(config, { pid, timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
        redirect: "error",
      });
      const health = await response.json();
      if (response.status === 200 && !response.headers.has("set-cookie") && health.ok === true &&
        health.engine === "pi" && health.cwd === config.workspaceDir && health.pid === pid) return health;
    } catch { /* A starting process may not be listening yet. */ }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Release health check failed (status, workspace, engine or process identity).");
}
