/* 🍞 AI Breadcrumb: @COUPLED scripts/release.mjs, scripts/lifecycle/release.mjs
 * @CONTRACT Validate every CLI action before touching deployment state or invoking PM2.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { absolutePath, validatePort } from "../lib.mjs";

export const ACTIONS = ["check", "--check-pm2", "release", "current", "rollback", "start", "reload", "stop", "delete"];
export function releaseId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || id === "." || id === "..")
    throw new Error("Invalid release id.");
  return id;
}
export function contained(parent, path) {
  const rel = relative(parent, path);
  return rel !== "" && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel);
}
export function assertRealDirectoryPath(path) {
  let next = resolve(path);
  while (true) {
    if (existsSync(next) || (() => { try { return lstatSync(next).isSymbolicLink(); } catch { return false; } })()) {
      if (!lstatSync(next).isDirectory() || realpathSync(next) !== next)
        throw new Error(`Deployment directory cannot traverse symlinks: ${path}`);
    }
    const parent = resolve(next, "..");
    if (parent === next) break;
    next = parent;
  }
}
export function releaseOptions(env = process.env) {
  const base = absolutePath(env.PI_DEV_DEPLOY_ROOT || "/srv/pi-dev", "deploy root");
  if (base === "/" || base === "/srv" || base === "/home") throw new Error("Choose a dedicated deployment directory.");
  const shared = join(base, "shared");
  const configDir = absolutePath(env.PI_DEV_CONFIG_DIR || join(shared, "config"), "shadow config");
  const pm2Home = absolutePath(env.PM2_HOME || join(shared, "pm2"), "PM2 home");
  if (!contained(shared, configDir) || !contained(shared, pm2Home) || configDir === pm2Home)
    throw new Error("Shadow config and PM2 home must be separate directories under deploy/shared.");
  const name = env.PI_DEV_PM2_NAME || "pi-dev-shadow";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid PM2 name.");
  const port = validatePort(Number(env.PI_DEV_SHADOW_PORT ?? 8790));
  if (port === 8788) throw new Error("Shadow must not use the primary port 8788.");
  for (const path of [base, configDir, pm2Home, join(base, "releases"), join(shared, "logs"),
    join(shared, "state"), join(shared, "workspace")]) assertRealDirectoryPath(path);
  return { base, shared, configDir, pm2Home, name, port, releases: join(base, "releases"), current: join(base, "current") };
}
export function validateAction(action, id, commit) {
  if (!ACTIONS.includes(action)) throw new Error(`Usage: ${ACTIONS.join("|")}; release <id> --commit=<full SHA>`);
  if (["release", "current"].includes(action)) releaseId(id);
  else if (id !== undefined) throw new Error("This action does not accept a release id.");
  if (action === "release" && !/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw new Error("Release requires an explicitly reviewed full --commit=<SHA>.");
  if (action !== "release" && commit !== undefined) throw new Error("Only release accepts --commit.");
}
