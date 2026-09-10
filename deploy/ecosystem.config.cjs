/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/release.mjs, scripts/lifecycle/pm2-manager.mjs
 * @CONTRACT One fork process; state and logs remain under deploy/shared across current switches.
 * 📖 docs/PM2-PRODUCTION.md
 */
const path = require("node:path");
const base = path.resolve(process.env.PI_DEV_DEPLOY_ROOT || "/srv/pi-dev");
const root = process.env.PI_DEV_RELEASE_ROOT || path.join(base, "current");
const production = process.env.PI_DEV_INSTANCE === "production";
const heap = process.env.PI_DEV_HEAP_MB ?? (production ? "2048" : "1024");
const memory = process.env.PI_DEV_PM2_MAX_MEMORY ?? (production ? "3G" : "1536M");
if (!/^[1-9][0-9]*$/.test(heap) || !Number.isSafeInteger(Number(heap) * 1024 ** 2))
  throw new Error("PI_DEV_HEAP_MB must be a positive integer in MiB.");
const match = /^([1-9][0-9]*)(M|G)$/.exec(memory);
const bytes = match && Number(match[1]) * (match[2] === "G" ? 1024 ** 3 : 1024 ** 2);
if (!Number.isSafeInteger(bytes) || bytes <= Number(heap) * 1024 ** 2)
  throw new Error("PI_DEV_PM2_MAX_MEMORY must exceed the heap, using an integer M or G value.");
module.exports = {
  apps: [{
    name: process.env.PI_DEV_PM2_NAME || "pi-dev-shadow",
    cwd: root,
    script: path.join(root, "scripts/start.mjs"),
    interpreter: process.env.PI_DEV_NODE || process.execPath,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    restart_delay: 1000,
    kill_timeout: 30000,
    max_memory_restart: memory,
    node_args: [`--max-old-space-size=${heap}`],
    time: true,
    merge_logs: true,
    out_file: process.env.PI_DEV_LOG_FILE || path.join(base, "shared/logs/pm2-out.log"),
    error_file: process.env.PI_DEV_ERROR_LOG_FILE || path.join(base, "shared/logs/pm2-error.log"),
    env: {
      NODE_ENV: "production",
      PI_DEV_CONFIG_DIR: process.env.PI_DEV_CONFIG_DIR || path.join(base, "shared/config"),
      PI_WEB_RP_ID: process.env.PI_WEB_RP_ID || "dev.ftai.cc",
      PI_WEB_ORIGIN: process.env.PI_WEB_ORIGIN || "https://dev.ftai.cc",
    },
  }],
};
