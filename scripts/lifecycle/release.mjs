/* 🍞 AI Breadcrumb: @COUPLED scripts/release.mjs, deploy/ecosystem.config.cjs, tests/release.test.mjs
 * @CONTRACT current changes via one rename; failed health restores both link and process.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, loadConfig, readJson } from "../lib.mjs";
import { configure } from "../configure.mjs";
import { runtimeEntry } from "../start.mjs";
import { atomicJson } from "./files.mjs";
import { buildRelease, command } from "./release-build.mjs";
import { assertPortFree, waitForHealth } from "./health.mjs";
import { assertRealDirectoryPath, releaseId, releaseOptions, validateAction } from "./release-options.mjs";

export function releasePath(options, id) {
  releaseId(id);
  const path = join(options.releases, id);
  assertRealDirectoryPath(path);
  runtimeEntry({ root: path });
  const manifest = readJson(join(path, ".release.json"));
  const info = readJson(join(path, "vendor/pi-web-ui/dist/build-info.json"));
  if (manifest.id !== id || !/^[a-f0-9]{40}$/.test(manifest.commit) || info.commit !== manifest.commit)
    throw new Error("Invalid release provenance.");
  return path;
}

function currentRelease(options) {
  let stat;
  try { stat = lstatSync(options.current); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isSymbolicLink()) throw new Error("current must be a managed release symlink.");
  const path = realpathSync(options.current);
  const managed = releasePath(options, basename(path));
  if (path !== managed) throw new Error("current points outside managed releases.");
  return basename(path);
}

function activate(options, id) {
  const path = releasePath(options, id);
  const temporary = join(options.base, `.current-${randomBytes(8).toString("hex")}`);
  try { symlinkSync(path, temporary); renameSync(temporary, options.current); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function shadowConfig(options) {
  const { shared, configDir, current, port } = options;
  const fields = { root: current, workspaceDir: join(shared, "workspace"),
    dataDir: join(shared, "state/web"), agentDir: join(shared, "state/agent"),
    tokenFile: join(configDir, "token"), port, host: "127.0.0.1" };
  const file = join(configDir, "runtime.json");
  if (existsSync(file)) {
    const stored = loadConfig(file, current);
    for (const key of ["workspaceDir", "dataDir", "agentDir", "tokenFile", "port", "host"])
      if (stored[key] !== fields[key]) throw new Error(`Shadow config isolation mismatch: ${key}`);
  }
  for (const path of [fields.workspaceDir, fields.dataDir, fields.agentDir, configDir]) assertRealDirectoryPath(path);
  mkdirSync(fields.workspaceDir, { recursive: true, mode: 0o700 });
  return configure({ configDir, options: fields });
}

export async function runRelease({ action = "check", id, commit, env = process.env,
  root = ROOT, run = command, health = waitForHealth, healthTimeout = 30000 } = {}) {
  validateAction(action, id, commit);
  const options = releaseOptions(env);
  const old = currentRelease(options);
  if (["current"].includes(action)) releasePath(options, id);
  if (["start", "reload"].includes(action) && !old) throw new Error("No current release.");
  if (action === "rollback") {
    const previous = readJson(join(options.shared, "previous.json"));
    id = releaseId(previous.id);
    releasePath(options, id);
  }
  if (["check", "--check-pm2"].includes(action)) return { ...options, action, active: old };
  mkdirSync(options.base, { recursive: true, mode: 0o700 });
  const lock = join(options.base, ".release-lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error("Deployment is locked; inspect the previous operation before retrying."); }
  try {
    // Recheck after locking: another completed deployment may have changed current.
    if (currentRelease(options) !== old) throw new Error("Current release changed while acquiring lock.");
    const pm2Env = { ...env, PM2_HOME: options.pm2Home, PI_DEV_PM2_NAME: options.name,
      PI_DEV_RELEASE_ROOT: options.current, PI_DEV_CONFIG_DIR: options.configDir,
      PI_DEV_NODE: process.execPath, PI_DEV_DEPLOY_ROOT: options.base,
      PI_DEV_LOG_FILE: join(options.shared, "logs/pm2-out.log"),
      PI_DEV_ERROR_LOG_FILE: join(options.shared, "logs/pm2-error.log") };
    const pm2 = args => run("pm2", args, { env: pm2Env });
    const restart = () => pm2(["startOrRestart", join(root, "deploy/ecosystem.config.cjs"), "--only", options.name, "--update-env"]);
    const healthy = async config => {
      const apps = JSON.parse(pm2(["jlist"]));
      const matching = apps.filter(app => app.name === options.name);
      if (matching.length !== 1 || !Number.isInteger(matching[0].pid) || matching[0].pid <= 0 ||
        matching[0].pm2_env?.exec_mode !== "fork_mode") throw new Error("Expected one live fork-mode PM2 process.");
      await health(config, { pid: matching[0].pid, timeout: healthTimeout });
    };
    if (["stop", "delete"].includes(action)) {
      pm2([action, options.name]);
      return { action, active: old };
    }
    const config = shadowConfig(options);
    mkdirSync(join(options.shared, "logs"), { recursive: true, mode: 0o700 });
    if (!old) await assertPortFree(config.host, config.port);
    if (action === "release") buildRelease(options, { id, commit, root, run });
    const target = id ?? old;
    let switched = false;
    try {
      activate(options, target);
      switched = true;
      restart();
      await healthy(config);
      if (old && target !== old) atomicJson(join(options.shared, "previous.json"), { id: old });
    } catch (failure) {
      if (!switched) throw failure;
      try {
        if (old) { activate(options, old); restart(); await healthy(config); }
        else { pm2(["delete", options.name]); unlinkSync(options.current); }
      } catch {
        throw new Error(`Activation failed; recovery also failed. Inspect ${options.current} and the isolated PM2 process.`);
      }
      throw new Error(`Activation failed; ${old ? `restored ${old}` : "removed initial candidate"}.`, { cause: failure });
    }
    return { action, active: target, previous: old };
  } finally { rmSync(lock, { recursive: true }); }
}
