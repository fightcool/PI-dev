/* 🍞 AI Breadcrumb: @COUPLED lifecycle/cutover.mjs, lifecycle/sync-development.mjs
 * @WHY This process lives in a separate user unit so stopping the old UI cannot kill migration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { isMain, ROOT, validateConfig } from "./lib.mjs";
import { atomicJson } from "./lifecycle/files.mjs";
import { cutover } from "./lifecycle/cutover.mjs";
import { waitForHealth } from "./lifecycle/health.mjs";
import { syncDevelopment } from "./lifecycle/sync-development.mjs";

async function verifyIngress(origin, vendorRoot) {
  const [health, page] = await Promise.all([
    fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10000), redirect: "error" }),
    fetch(`${origin}/`, { signal: AbortSignal.timeout(10000), redirect: "error" }),
  ]);
  if (!health.ok || health.headers.has("set-cookie") || !page.ok) throw new Error("Public ingress health failed.");
  const html = await page.text();
  const built = readFileSync(join(vendorRoot, "web/dist/index.html"), "utf8");
  const entry = built.match(/src="([^"]+\.js)"/)?.[1];
  if (!entry || !html.includes(entry)) throw new Error("Public ingress is not serving the candidate frontend.");
  const { WebSocket } = createRequire(join(vendorRoot, "package.json"))("ws");
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws`);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("WebSocket authentication probe timed out.")); }, 5000);
    socket.once("unexpected-response", (req, res) => {
      clearTimeout(timer); req.destroy();
      if (res.statusCode === 401) resolve(); else reject(new Error("Unexpected anonymous WebSocket response."));
    });
    socket.once("open", () => { clearTimeout(timer); socket.close(); reject(new Error("Anonymous WebSocket was accepted.")); });
    socket.once("error", () => { clearTimeout(timer); reject(new Error("WebSocket probe failed.")); });
  });
}

export async function runCutover(descriptor) {
  const config = validateConfig(JSON.parse(readFileSync(descriptor.configFile, "utf8")));
  const { sendControlCommand } = await import("../vendor/pi-web-ui/dist/server/control-socket.js");
  const statusFile = join(descriptor.base, "shared/migrations/status.json");
  const report = value => { atomicJson(statusFile, { ...value, commit: descriptor.commit }); console.log(value.status); };
  const result = await cutover({ ...descriptor, config }, {
    control: cmd => sendControlCommand(config.dataDir, config.port, cmd), report,
    health: async (cfg, options) => {
      await waitForHealth(cfg, options);
      if (options.candidate && descriptor.verifyPublic !== false)
        await verifyIngress(descriptor.origin, join(ROOT, "vendor/pi-web-ui"));
    },
  });
  try {
    result.development = syncDevelopment(descriptor.development);
    report({ ...result, status: "complete" });
  } catch (error) {
    report({ ...result, status: "deployed_source_pending", error: String(error.message).slice(0, 500) });
  }
}

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw new Error("Usage: node scripts/cutover.mjs <deployment descriptor.json>");
  await runCutover(JSON.parse(readFileSync(file, "utf8")));
}
