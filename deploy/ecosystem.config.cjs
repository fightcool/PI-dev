/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/release.mjs
 * @CONTRACT One fork process; state and logs remain under deploy/shared across current switches.
 */
const path = require("node:path");
const base = path.resolve(process.env.PI_DEV_DEPLOY_ROOT || "/srv/pi-dev");
const root = process.env.PI_DEV_RELEASE_ROOT || path.join(base, "current");
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
    max_memory_restart: "1536M",
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
