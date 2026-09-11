#!/usr/bin/env node
/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED sync needed: scripts/pm2.mjs, scripts/lifecycle/pm2-manager.mjs, deploy/pi-dev-pm2.service.in
 *   @COUPLED scripts/maintenance/switch-production-release.mjs, tests/release-prune.test.mjs
 *   📖 see: docs/PM2-PRODUCTION.md
 *   @WHY deploy 每个版本都是自包含目录（应用依赖 + 构建产物，实测约 1.6 GiB），迁到独立磁盘
 *        才能止住系统盘增长；程序版本与私有数据边界不变。
 *   @GOTCHA 必须在服务 cgroup 之外执行（systemd-run --user --unit=…）。两个 unit 都是
 *        KillMode=control-group，跑在 pi-dev-pm2.service 里的脚本会随 unit 一起被杀。
 *        启动时读 /proc/self/cgroup 自检并拒绝，不靠人工记得。
 *   @GOTCHA cp -a 会原样保留指回旧根的绝对符号链接（tools/python-env/bin/python、
 *        releases/<id>/.venv、current）。不重写就会在旧目录清理后全部悬空。
 *   @CONTRACT 停 unit → 复制 → 重写指回旧根的绝对链接 → 用新 root 重装 unit → 启动 → 验收；
 *        任一步失败则用旧 root 重装 unit 并启动。旧目录原样保留，既不回滚也不删除。
 *        默认 dry-run，--apply 才落盘。存在在飞构建时拒绝执行。
 * ──────────────────────────────────────────────────
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { waitForHealth } from "../lifecycle/health.mjs";

const DEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE = "pi-dev-pm2.service";
const APP = "pi-dev-web";
/** @MAGIC 30 分钟：比一次完整发布构建（含全部测试套件）更长，用于判定「构建仍在进行」。 */
const BUILD_FRESH_MS = 30 * 60 * 1000;
/** @MAGIC 服务重启并完成健康检查的等待上限。 */
const HEALTH_TIMEOUT_MS = 90_000;

const log = (...parts) => console.log(new Date().toISOString(), "migrate:", ...parts);
const sh = (file, args, opts = {}) => execFileSync(file, args, {
  encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"], ...opts,
}).trim();
const systemctl = (args, allowFail = false) => {
  try { return sh("systemctl", ["--user", ...args]); }
  catch (error) { if (allowFail) return "failed"; throw error; }
};
const unitState = unit => systemctl(["show", "--property=ActiveState", unit]).split("=")[1] ?? "unknown";
const inactive = unit => ["inactive", "failed"].includes(unitState(unit));

/** 只覆盖部署根目录；PM2_HOME 与实例名必须由新 root 派生，不能继承旧值。 */
function managerEnv(root) {
  const env = { ...process.env, PI_DEV_DEPLOY_ROOT: root };
  delete env.PM2_HOME;
  delete env.PI_DEV_PM2_NAME;
  return env;
}
const manager = (action, root) => sh(process.execPath, [join(DEV_ROOT, "scripts/pm2.mjs"), action],
  { env: managerEnv(root) });

function assertOutsideServiceCgroup() {
  const cgroup = readFileSync("/proc/self/cgroup", "utf8");
  if (cgroup.includes(SERVICE))
    throw new Error(`Refusing to run inside ${SERVICE}: stopping the unit would kill this process. ` +
      "Run it out of band, e.g. systemd-run --user --unit=pi-dev-deploy-migrate --collect …");
}

function validateNewRoot(value, oldRoot) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("New deploy root must be an absolute path.");
  const root = resolve(value);
  if (["/", "/home", "/srv", "/tmp", "/var", "/usr", "/etc"].includes(root))
    throw new Error("Choose a dedicated deployment root.");
  if (root.split(sep).length < 3) throw new Error("Deploy root must not be a top-level directory.");
  if (root === oldRoot) throw new Error("New deploy root equals the current one.");
  if (root.startsWith(oldRoot + sep) || oldRoot.startsWith(root + sep))
    throw new Error("Deploy roots must not contain each other.");
  return root;
}

/** 在飞构建的目录会被同步写入；复制它等于复制一个不一致的版本树。 */
function assertNoBuildInFlight(oldRoot) {
  const releases = join(oldRoot, "releases");
  const fresh = readdirSync(releases, { withFileTypes: true })
    .filter(entry => entry.name.startsWith(".build-") && entry.isDirectory())
    .filter(entry => Date.now() - statSync(join(releases, entry.name)).mtimeMs < BUILD_FRESH_MS)
    .map(entry => entry.name);
  if (fresh.length) throw new Error(`Release build in flight (${fresh.join(", ")}); wait for it to finish.`);
}

/** 把指回旧根的绝对符号链接重写到新根；current 也由这一遍顺带修正。 */
function rewriteAbsoluteLinks(root, oldRoot, newRoot, collect = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (target === oldRoot || target.startsWith(oldRoot + sep)) {
        const next = newRoot + target.slice(oldRoot.length);
        unlinkSync(path);
        symlinkSync(next, path);
        collect.push({ path, from: target, to: next });
      }
    } else if (entry.isDirectory()) rewriteAbsoluteLinks(path, oldRoot, newRoot, collect);
  }
  return collect;
}

function assertRuntimeTree(root) {
  for (const path of [join(root, "tools/node/bin/node"), join(root, "tools/pm2/node_modules/pm2/bin/pm2"),
    join(root, "current/deploy/ecosystem.config.cjs"), join(root, "releases")]) {
    if (!existsSync(path)) throw new Error(`Copied tree is incomplete: ${path}`);
  }
  const current = join(root, "current");
  if (!lstatSync(current).isSymbolicLink()) throw new Error("current must remain a symlink after the copy.");
  if (!realpathSync(current).startsWith(join(root, "releases") + sep))
    throw new Error("current does not resolve under the new releases directory.");
}

async function verifyServing(root, config) {
  const status = JSON.parse(manager("status", root));
  const app = status.apps?.find(entry => entry.name === APP);
  if (status.state !== "active" || !app || app.status !== "online" || !Number.isInteger(app.pid) || app.pid <= 0)
    throw new Error(`Expected one online ${APP} process after the restart.`);
  if (!status.buildInfo?.path?.startsWith(join(root, "releases") + sep))
    throw new Error(`build-info is not served from ${root}.`);
  await waitForHealth(config, { pid: app.pid, timeout: HEALTH_TIMEOUT_MS });
  return { pid: app.pid, buildInfo: status.buildInfo };
}

const args = process.argv.slice(2);
const FLAGS = ["--apply", "--dry-run"];
const apply = args.includes("--apply");
const positional = args.filter(arg => !arg.startsWith("--"));
const unknown = args.filter(arg => arg.startsWith("--") && !FLAGS.includes(arg));
if (positional.length !== 1 || unknown.length)
  throw new Error("Usage: migrate-deploy-root.mjs <newDeployRoot> [--apply]   (dry-run unless --apply)");

assertOutsideServiceCgroup();
const oldRoot = resolve(process.env.PI_DEV_DEPLOY_ROOT ?? join(homedir(), ".local/share/pi-dev/deploy"));
const newRoot = validateNewRoot(positional[0], oldRoot);
const configDir = resolve(process.env.PI_DEV_CONFIG_DIR ?? join(homedir(), ".config/pi-dev"));
const config = JSON.parse(readFileSync(join(configDir, "runtime.json"), "utf8"));

log(`old=${oldRoot}`);
log(`new=${newRoot}`);
log(`config=${configDir} host=${config.host} port=${config.port} workspace=${config.workspaceDir}`);

assertNoBuildInFlight(oldRoot);
if (existsSync(newRoot) && readdirSync(newRoot).length)
  throw new Error(`New deploy root is not empty: ${newRoot}`);
if (!lstatSync(join(oldRoot, "current"), { throwIfNoEntry: false })?.isSymbolicLink())
  throw new Error("Current deploy root has no managed current symlink.");
const releaseId = basename(realpathSync(join(oldRoot, "current")));
log(`current release=${releaseId}`);

if (!apply) {
  log("dry-run: would stop the unit, copy the tree, rewrite absolute links, reinstall and start the unit");
  log(`dry-run: ${readdirSync(join(oldRoot, "releases")).filter(n => !n.startsWith(".build-")).length} release(s) to copy`);
  process.exit(0);
}

let switched = false;
try {
  log("phase: stop");
  if (!inactive(SERVICE)) systemctl(["stop", SERVICE]);
  for (let i = 0; i < 60 && !inactive(SERVICE); i += 1) sh("sleep", ["1"]);
  if (!inactive(SERVICE)) throw new Error("Unit did not stop within 60s.");
  log(`unit state=${unitState(SERVICE)}`);

  log("phase: copy");
  mkdirSync(newRoot, { recursive: true, mode: 0o700 });
  sh("cp", ["-a", `${oldRoot}/.`, newRoot]);
  // 复制来的 PM2 运行时状态属于已经停掉的旧 supervisor；新 supervisor 会重建。
  for (const name of ["pm2.pid", "pub.sock", "rpc.sock"])
    rmSync(join(newRoot, "shared/pm2", name), { force: true });
  assertRuntimeTree(newRoot);
  const links = rewriteAbsoluteLinks(newRoot, oldRoot, newRoot);
  log(`rewrote ${links.length} absolute symlink(s)`);
  if (links.length) log(JSON.stringify(links, null, 2));

  log("phase: install");
  manager("install", newRoot);

  log("phase: start");
  manager("start", newRoot);
  switched = true;

  log("phase: verify");
  const verified = await verifyServing(newRoot, config);
  log(`serving pid=${verified.pid} build=${verified.buildInfo.commit} from=${verified.buildInfo.path}`);
  log(`DONE. old tree kept at ${oldRoot} for rollback; remove it only after a verification window.`);
} catch (failure) {
  log(`FAILED: ${failure.message}`);
  if (switched || !inactive(SERVICE)) {
    log("rollback: reinstalling the unit against the old deploy root");
    try {
      manager("install", oldRoot);
      manager("start", oldRoot);
      await verifyServing(oldRoot, config);
      log(`rollback complete; service is serving from ${oldRoot}`);
    } catch (recovery) {
      log(`rollback ALSO FAILED: ${recovery.message}`);
      log(`inspect ${join(homedir(), ".config/systemd/user", SERVICE)} and the PM2 process manually`);
    }
  }
  throw failure;
}
