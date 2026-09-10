/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/release.mjs, tests/helpers/release-fixture.mjs
 * @CONTRACT Execute archived builds and actual HTTP health/rollback using a fake PM2 runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/release-fixture.mjs";
import { runRelease } from "../scripts/lifecycle/release.mjs";
import { releaseOptions } from "../scripts/lifecycle/release-options.mjs";

test("release builds only reviewed archive, runs vendor server, and rolls back unhealthy activation", async t => {
  const f = await fixture(t);
  await f.release("release", "first");
  assert.equal(f.current(), join(f.base, "releases/first"));
  assert.ok(!existsSync(join(f.current(), "untracked-private.txt")));
  assert.equal(JSON.parse(readFileSync(join(f.current(), "package.json"))).type, "module");
  assert.equal(f.json("releases/first/vendor/pi-web-ui/dist/build-info.json").commit, f.commit);
  const config = f.json("shared/config/runtime.json");
  assert.equal(config.workspaceDir, join(f.base, "shared/workspace"));
  assert.equal(config.dataDir, join(f.base, "shared/state/web"));
  assert.equal(config.agentDir, join(f.base, "shared/state/agent"));
  assert.equal(config.port, Number(f.env.PI_DEV_SHADOW_PORT));
  const token = readFileSync(config.tokenFile, "utf8");
  const settingsPath = join(config.agentDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath)), custom: "preserve" }));
  await f.release("release", "second");
  assert.equal(f.current(), join(f.base, "releases/second"));
  assert.equal(f.json("shared/previous.json").id, "first");
  assert.equal(f.json("shared/state/agent/settings.json").custom, "preserve");
  assert.equal(readFileSync(config.tokenFile, "utf8"), token);
  assert.deepEqual(f.json("shared/state/agent/settings.json").packages, [join(f.current(), "node_modules/pi-context-prune")]);
  f.failHealth();
  await assert.rejects(f.release("release", "bad"), /restored second/);
  assert.equal(f.current(), join(f.base, "releases/second"));
  assert.equal(f.json("shared/previous.json").id, "first");
  await f.release("rollback");
  assert.equal(f.current(), join(f.base, "releases/first"));
  assert.equal(f.json("shared/previous.json").id, "second");
  const builds = f.events.filter(event => event.file === "npm");
  assert.deepEqual(builds.map(event => event.args), Array(3).fill([["run", "setup:dependencies"], ["run", "build"]]).flat());
  assert.ok(builds.every(event => event.cwd.startsWith(join(f.base, "releases/.build-"))));
  const starts = f.events.filter(event => event.file === "pm2" && event.args[0] === "startOrRestart");
  assert.ok(starts.every(event => event.env.PI_DEV_LOG_FILE === join(f.base, "shared/logs/pm2-out.log")));
  assert.ok(starts.every(event => event.env.PM2_HOME === join(f.base, "shared/pm2")));
  assert.ok(lstatSync(join(f.base, "current")).isSymbolicLink());
});

test("failed build never activates candidate or invokes PM2", async t => {
  const f = await fixture(t);
  f.failBuild("build");
  await assert.rejects(f.release("release", "broken"), /fixture build failure/);
  assert.equal(f.current(), null);
  assert.ok(!existsSync(join(f.base, "releases/broken")));
  assert.ok(!f.events.some(event => event.file === "pm2"));
  assert.ok(!existsSync(join(f.base, ".release-lock")));
});

test("first unhealthy activation cleans current and process", async t => {
  const f = await fixture(t);
  f.failHealth();
  await assert.rejects(f.release("release", "bad"), /removed initial candidate/);
  assert.equal(f.current(), null);
  assert.ok(f.events.some(event => event.file === "pm2" && event.args[0] === "delete"));
});

test("every mutation rejects unsafe options before any command or write", async t => {
  const f = await fixture(t);
  const actions = ["release", "current", "rollback", "start", "reload", "stop", "delete"];
  for (const port of ["8787", "8788", "8791", "65536", "0", "NaN"]) {
    for (const action of actions) {
      await assert.rejects(runRelease({ action, id: ["release", "current"].includes(action) ? "id" : undefined,
        commit: action === "release" ? f.commit : undefined, env: { ...f.env, PI_DEV_SHADOW_PORT: port }, run: f.run }));
    }
  }
  for (const action of ["save", "resurrect", "unknown"])
    await assert.rejects(f.release(action));
  for (const id of ["../escape", "nested/id", ".", "..", "--arg"])
    await assert.rejects(f.release("release", id));
  await assert.rejects(f.release("release", "id", { commit: "HEAD" }), /reviewed/);
  await assert.rejects(f.release("stop", undefined, { env: { ...f.env, PI_DEV_PM2_NAME: "--all" } }));
  assert.equal(f.events.length, 0);
  assert.ok(!existsSync(f.base));
});

test("check is read-only and rejects state escapes and directory current", async t => {
  const f = await fixture(t);
  const check = await f.release("check");
  assert.equal(check.port, Number(f.env.PI_DEV_SHADOW_PORT));
  assert.ok(!existsSync(f.base));
  assert.throws(() => releaseOptions({ ...f.env, PI_DEV_CONFIG_DIR: join(f.temp, "primary") }), /deploy\/shared/);
  mkdirSync(join(f.base, "current"), { recursive: true });
  await assert.rejects(f.release("stop"), /symlink/);
  assert.equal(f.events.length, 0);
});

test("deployment roots must not traverse symlinks", async t => {
  const f = await fixture(t);
  mkdirSync(join(f.temp, "actual"));
  symlinkSync(join(f.temp, "actual"), f.base);
  await assert.rejects(f.release("stop"), /symlinks/);
  assert.equal(f.events.length, 0);
});
