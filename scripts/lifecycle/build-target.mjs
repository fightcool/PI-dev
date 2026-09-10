/* 🍞 AI Breadcrumb: @COUPLED scripts/build.mjs, scripts/dependencies.mjs
 * @CONTRACT Never mutate the application directory of either active process manager.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function assertInactiveCheckout(root, run = spawnSync) {
  const show = (unit, fields) => {
    const result = run("systemctl", ["--user", "show", unit, ...fields.flatMap(field => ["-p", field])], { encoding: "utf8" });
    return Object.fromEntries((result.stdout ?? "").trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
  };
  const active = value => ["active", "activating", "reloading"].includes(value);
  const old = show("pi-web-ui-dev.service", ["ActiveState", "WorkingDirectory", "ExecStart"]);
  const matches = path => path && existsSync(path) && realpathSync(path) === root;
  if (active(old.ActiveState) && (matches(old.WorkingDirectory) || (old.ExecStart ?? "").includes(join(root, "scripts/start.mjs"))))
    throw new Error("Use an isolated checkout; this directory belongs to the active systemd UI.");
  const manager = show("pi-dev-pm2.service", ["ActiveState", "WorkingDirectory"]);
  if (active(manager.ActiveState) && manager.WorkingDirectory && matches(join(manager.WorkingDirectory, "current")))
    throw new Error("Build a new release; this directory belongs to the active PM2 application.");
}
