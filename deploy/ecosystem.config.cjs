module.exports = {
  apps: [
    {
      name: process.env.PI_DEV_PM2_NAME || "pi-dev-shadow",
      cwd: process.env.PI_DEV_RELEASE_ROOT || process.cwd(),
      script: "scripts/start.mjs",
      interpreter: process.env.PI_DEV_NODE || process.execPath,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: process.env.PI_DEV_PM2_MAX_MEMORY || "1536M",
      time: true,
      merge_logs: true,
      out_file: process.env.PI_DEV_LOG_FILE || "./shared/logs/pm2-out.log",
      error_file: process.env.PI_DEV_ERROR_LOG_FILE || "./shared/logs/pm2-error.log",
      env: {
        NODE_ENV: "production",
        PI_DEV_CONFIG_DIR: process.env.PI_DEV_CONFIG_DIR,
        PI_WEB_RP_ID: process.env.PI_WEB_RP_ID || "ftai.cc",
        PI_WEB_ORIGIN: process.env.PI_WEB_ORIGIN || "https://ftai.cc",
      },
    },
  ],
};
