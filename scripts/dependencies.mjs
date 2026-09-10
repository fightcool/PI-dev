/*
 * 🍞 AI Breadcrumb: locked dependency installation for the environment and UI.
 * @COUPLED package-lock.json, vendor/pi-web-ui/package-lock.json, scripts/bootstrap.sh
 * @GOTCHA Refuse shared dependency symlinks and the active service checkout.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const service = spawnSync("systemctl", ["--user", "show", "pi-web-ui-dev.service", "-p", "ActiveState", "-p", "WorkingDirectory", "-p", "ExecStart"], { encoding: "utf8" });
const props = Object.fromEntries((service.stdout ?? "").trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
const isRunningCheckout = (props.WorkingDirectory && existsSync(props.WorkingDirectory) && realpathSync(props.WorkingDirectory) === root)
  || (props.ExecStart ?? "").includes(join(root, "scripts/start.mjs"));
if (["active", "activating", "reloading"].includes(props.ActiveState) && isRunningCheckout) {
  throw new Error("Install dependencies in a separate checkout or stop this instance explicitly first.");
}
for (const cwd of [root, join(root, "vendor/pi-web-ui")]) {
  const modules = join(cwd, "node_modules");
  if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) {
    throw new Error(`Refusing to replace shared dependencies: ${modules}`);
  }
  const result = spawnSync("npm", ["ci", "--include=dev", "--no-fund", "--no-audit", "--no-progress"], { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Dependency installation failed in ${cwd}`);
}
