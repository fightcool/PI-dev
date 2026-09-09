#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";

const root = realpathSync(new URL("..", import.meta.url).pathname);
const base = resolve(process.env.PI_DEV_DEPLOY_ROOT || "/srv/pi-dev");
const releases = join(base, "releases");
const current = join(base, "current");
const name = process.env.PI_DEV_PM2_NAME || "pi-dev-shadow";
const ecosystem = join(root, "deploy/ecosystem.config.cjs");
const pm2Home = process.env.PM2_HOME || join(base, "pm2");
const configDir = resolve(process.env.PI_DEV_CONFIG_DIR || join(process.env.HOME || "/tmp", ".config/pi-dev"));
const port = Number(process.env.PI_DEV_SHADOW_PORT || 8790);
function fail(message) { throw new Error(message); }
function check(condition, message) { if (condition) console.log(`PASS ${message}`); else fail(message); }
function command(cmd, args, cwd, env = {}) { const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, PM2_HOME: pm2Home, ...env } }); if (r.error || r.status !== 0) fail(`${cmd} failed: ${args.join(" ")}`); }
function run(args, env = {}) { command("pm2", args, undefined, env); }
function releasePath(id) { const p = resolve(releases, id); if (!p.startsWith(`${releases}/`) || !existsSync(join(p, "scripts/start.mjs"))) fail(`invalid release: ${id}`); return p; }
function requireReleases() { check(existsSync(releases), `release directory ${releases}`); return readdirSync(releases, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name); }
function activate(id) { const p = releasePath(id); mkdirSync(base, { recursive: true, mode: 0o755 }); const tmp = join(base, `.current-${process.pid}-${Date.now()}`); symlinkSync(p, tmp); if (existsSync(current)) { const old = join(base, `.current-old-${process.pid}`); renameSync(current, old); renameSync(tmp, current); unlinkSync(old); } else renameSync(tmp, current); console.log(`current -> ${p}`); }
function newestPrevious(active) {
  return requireReleases().filter(x => x !== active).sort((a, b) => statSync(join(releases, b)).mtimeMs - statSync(join(releases, a)).mtimeMs)[0];
}
function reloadAndHealth() {
  run(["reload", ecosystem, "--only", name, "--update-env"], { PI_DEV_RELEASE_ROOT: current });
  const result = spawnSync(process.execPath, [join(current, "scripts/smoke.mjs")], { cwd: current, stdio: "inherit", env: { ...process.env, PI_DEV_RELEASE_ROOT: current, PI_DEV_CONFIG_DIR: configDir, PM2_HOME: pm2Home } });
  if (result.error || result.status !== 0) fail("release health check failed; active release was not accepted");
}
function buildRelease(target) { command("tar", ["--exclude=.git", "--exclude=node_modules", "-cf", "-", "-C", root, "."], undefined); }
const action = process.argv[2];
if (action === "--check-pm2") { check(existsSync(ecosystem), "PM2 ecosystem file"); console.log("PASS PM2 dry-run configuration"); }
else if (!action) { check(existsSync(join(root, "scripts/start.mjs")), `release entry ${root}`); check(existsSync(join(root, "package-lock.json")), "release lockfile"); check(existsSync(configDir), `config directory ${configDir}`); check(Number.isInteger(port) && port > 1024 && port !== 8787, `shadow port ${port}`); check(/^[A-Za-z0-9_.-]+$/.test(name), `PM2 name ${name}`); check(existsSync(ecosystem), "PM2 ecosystem file"); }
else if (action === "release") { const id = process.argv[3] || process.env.PI_DEV_RELEASE_ID || `${Date.now()}`; const target = resolve(releases, id); if (existsSync(target)) fail(`release exists: ${id}`); mkdirSync(target, { recursive: true }); const copy = spawnSync("bash", ["-c", `tar --exclude=.git --exclude=node_modules -cf - -C ${JSON.stringify(root)} . | tar -xf - -C ${JSON.stringify(target)}`], {stdio:"inherit"}); if(copy.status!==0) fail("release copy failed"); command("npm", ["ci"], target); if (existsSync(join(target,"vendor/pi-web-ui/package.json"))) command("npm", ["run","build"], target); activate(id); reloadAndHealth(); }
else if (action === "current") { activate(process.argv[3] || process.env.PI_DEV_RELEASE_ID); reloadAndHealth(); }
else if (action === "rollback") { const active = existsSync(current) ? basename(realpathSync(current)) : ""; const previous = newestPrevious(active); if (!previous) fail("no previous release"); activate(previous); reloadAndHealth(); }
else if (["start","reload"].includes(action)) run([action, ecosystem, "--only", name, "--update-env"], { PI_DEV_RELEASE_ROOT: current });
else if (["stop","delete"].includes(action)) run([action === "delete" ? "delete" : "stop", name]);
else if (["save","resurrect"].includes(action)) run([action]); else fail("Usage: release [id]|current <id>|rollback|start|reload|stop|delete|save|resurrect");
console.log(JSON.stringify({ action: action || "check", base, current, pm2Home }, null, 2));
