/*
 * 🍞 AI Breadcrumb: isolated developer instance, no live config or data reuse.
 * @COUPLED configure.mjs, lib.mjs, vendor/pi-web-ui/web/vite.config.ts
 * @WHY Reserve 8788 for the stable UI, 8790 for release checks, 8791 for dev-con.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

// lib reads CONFIG_DIR during module initialization; establish the boundary first.
const root = fileURLToPath(new URL("../", import.meta.url));
const devDir = join(root, ".dev");
mkdirSync(devDir, { recursive: true, mode: 0o700 });
Object.assign(process.env, {
  PI_DEV_CONFIG_DIR: join(devDir, "config"),
  PI_DEV_STATE_DIR: join(devDir, "state"),
  PI_DEV_PORT: "8890",
  PI_DEV_CWD: root,
  PI_WEB_ORIGIN: "http://localhost:5173",
  PI_WEB_RP_ID: "localhost",
});
const configured = spawnSync(process.execPath, [join(root, "scripts/configure.mjs")], { stdio: "inherit" });
if (configured.error || configured.status !== 0) throw new Error("Development configuration failed.");
const { loadConfig, runtimeEnv } = await import("./lib.mjs");
const config = loadConfig();
if (config.port !== 8890) throw new Error("Development requires port 8890 in .dev/config/runtime.json.");
const app = join(root, "vendor/pi-web-ui");
const require = createRequire(join(app, "package.json"));
const env = {
  ...runtimeEnv(config),
  PI_WEB_ALLOW_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
  PI_WEB_DEV_BACKEND: "http://127.0.0.1:8890",
};
const children = [
  spawn(process.execPath, ["--watch", "--import", require.resolve("tsx"), "server/index.ts"], { cwd: app, env, stdio: "inherit" }),
  spawn(process.execPath, [join(dirname(require.resolve("vite/package.json")), "bin/vite.js"), "--config", "web/vite.config.ts"], { cwd: app, env, stdio: "inherit" }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const guard = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 3000);
  guard.unref();
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", code => stop(code ?? 0));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
console.log("Development UI: http://localhost:5173; private config: .dev/config; backend: 8890");
