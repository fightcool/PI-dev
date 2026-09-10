/*
 * 🍞 AI Breadcrumb: locked dependency installation for the environment and UI.
 * @COUPLED package-lock.json, vendor/pi-web-ui/package-lock.json, scripts/bootstrap.sh
 * @GOTCHA Refuse shared dependency symlinks and the active service checkout.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { assertInactiveCheckout } from "./lifecycle/build-target.mjs";

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
assertInactiveCheckout(root);
for (const cwd of [root, join(root, "vendor/pi-web-ui")]) {
  const modules = join(cwd, "node_modules");
  if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) {
    throw new Error(`Refusing to replace shared dependencies: ${modules}`);
  }
  const result = spawnSync("npm", ["ci", "--include=dev", "--no-fund", "--no-audit", "--no-progress"], { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Dependency installation failed in ${cwd}`);
}
