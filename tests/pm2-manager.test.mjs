/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/pm2-manager.mjs, deploy/ecosystem.config.cjs
 * @CONTRACT Temporary paths and fake commands only; no user config or live processes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pm2Action, pm2Options, renderPm2Unit, PM2_SERVICE } from "../scripts/lifecycle/pm2-manager.mjs";

function fixture(t, suffix = "runtime") {
  const home = mkdtempSync(join(tmpdir(), "pi-pm2-manager-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base = join(home, suffix), config = join(home, 'private config %$"');
  mkdirSync(config, { recursive: true });
  const env = { PI_DEV_DEPLOY_ROOT: base, PI_DEV_CONFIG_DIR: config };
  const options = pm2Options(env, home), calls = [], output = [], states = {};
  const file = (path, content = "fixture") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const release = join(base, "releases/abc");
  file(join(release, "deploy/ecosystem.config.cjs"));
  file(join(release, "vendor/pi-web-ui/dist/build-info.json"), JSON.stringify({ commit: "a".repeat(40), token: "SECRET" }));
  file(options.node); file(options.runtime); file(options.pm2);
  symlinkSync(release, options.current);
  const exec = (program, args, opts) => {
    calls.push({ program, args, opts });
    if (program === "systemctl" && args[1] === "show")
      return { status: 0, stdout: `LoadState=loaded\nActiveState=${states[args.at(-1)] ?? "inactive"}\n` };
    return { status: 0, stdout: "" };
  };
  return { home, base, env, options, calls, output, states, file,
    args: { env, home, exec, uid: 1000, alive: () => true, log: line => output.push(line) } };
}

test("install stages a private foreground unit without starting, enabling, or reading config", t => {
  const f = fixture(t);
  pm2Action("install", f.args);
  const unit = join(f.home, ".config/systemd/user", PM2_SERVICE);
  const text = readFileSync(unit, "utf8");
  for (const line of ["Type=simple", "Restart=on-failure", "KillMode=control-group", "TimeoutStopSec=45", "UMask=0077",
    "MemoryHigh=3G", "MemoryMax=4G", 'Environment=PI_DEV_HEAP_MB=2048', 'Environment=PI_DEV_PM2_MAX_MEMORY=3G'])
    assert.ok(text.includes(line), line);
  assert.match(text, /pm2-runtime" start .*ecosystem.config.cjs" --only pi-dev-web/);
  assert.equal(statSync(unit).mode & 0o777, 0o600);
  assert.ok(f.calls.some(c => c.program === "systemd-analyze"));
  assert.ok(f.calls.some(c => c.args.includes("daemon-reload")));
  assert.ok(!f.calls.some(c => c.args.some(a => ["start", "enable", "enable-linger"].includes(a))));
});

test("unit quoting preserves spaces, quotes, dollar signs and systemd percent specifiers", t => {
  const f = fixture(t, 'runtime space %$"');
  const unit = renderPm2Unit(f.options);
  const exec = unit.split("\n").find(line => line.startsWith("ExecStart="));
  assert.ok(exec.includes('runtime space %%$$\\"'));
  const working = unit.split("\n").find(line => line.startsWith("WorkingDirectory="));
  assert.ok(working.includes('runtime space %%$"'));
  const config = unit.split("\n").find(line => line.includes("PI_DEV_CONFIG_DIR="));
  assert.ok(config.includes('private config %%$\\"'));
  assert.ok(!/@[A-Z0-9_]+@/.test(unit));
});

test("inactive status never invokes PM2 and linked metadata is allowlisted", t => {
  const f = fixture(t);
  const result = pm2Action("status", f.args);
  assert.deepEqual(result.apps, []);
  assert.equal(result.buildInfo.commit, "a".repeat(40));
  assert.ok(f.calls.every(c => c.program === "systemctl"));
  assert.ok(!f.output.join("").includes("SECRET"));
});

test("active status reports process metrics without environments or arbitrary fields", t => {
  const f = fixture(t);
  f.states[PM2_SERVICE] = "active";
  f.file(join(f.options.pm2Home, "pm2.pid"), "100");
  const exec = f.args.exec;
  f.args.exec = (program, args, opts) => {
    if (program !== f.options.node) return exec(program, args, opts);
    assert.deepEqual(args, [f.options.pm2, "jlist"]);
    assert.equal(opts.env.PM2_HOME, f.options.pm2Home);
    return { status: 0, stdout: JSON.stringify([{ name: "pi-dev-web", pid: 101, token: "SECRET", monit: { memory: 512 },
      pm2_env: { status: "online", restart_time: 0, pm_uptime: Date.now() - 1000, env: { TOKEN: "SECRET" } } },
    { name: "unrelated-SECRET", pid: 102 }]) };
  };
  const result = pm2Action("status", f.args);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0].restarts, 0);
  assert.equal(result.apps[0].rss, 512);
  assert.ok(result.apps[0].uptimeMs >= 1000);
  assert.ok(!f.output.join("").includes("SECRET"));
});

test("active but unready supervisor does not bootstrap PM2", t => {
  const f = fixture(t);
  f.states[PM2_SERVICE] = "active";
  assert.throws(() => pm2Action("status", f.args), /not ready/);
  assert.ok(f.calls.every(c => c.program === "systemctl"));
});

for (const action of ["start", "restart", "stop"]) test(`${action} delegates only to systemd`, t => {
  const f = fixture(t);
  pm2Action(action, f.args);
  assert.ok(f.calls.every(c => c.program === "systemctl"));
  assert.deepEqual(f.calls.at(-1).args, ["--user", action, PM2_SERVICE]);
});

test("start refuses the old service, watchdog, or an unmanaged PM2 daemon", t => {
  const f = fixture(t);
  for (const unit of ["pi-web-ui-dev.service", "pi-web-ui-dev-watchdog.timer", "pi-web-ui-dev-watchdog.service"]) {
    f.states[unit] = "active";
    assert.throws(() => pm2Action("start", f.args), /previous UI manager/);
    f.states[unit] = "inactive";
  }
  f.file(join(f.options.pm2Home, "pm2.pid"), "100");
  assert.throws(() => pm2Action("restart", f.args), /unmanaged PM2/);
  assert.ok(!f.calls.some(c => c.args.includes("start") || c.args.includes("restart")));
});

test("install refuses active unit and verification failure preserves existing unit", t => {
  const f = fixture(t);
  f.states[PM2_SERVICE] = "active";
  assert.throws(() => pm2Action("install", f.args), /Stop the PM2 unit/);
  f.states[PM2_SERVICE] = "inactive";
  const unit = join(f.home, ".config/systemd/user", PM2_SERVICE);
  f.file(unit, "previous unit");
  const exec = f.args.exec;
  f.args.exec = (program, args, opts) => program === "systemd-analyze" ? { status: 1, stderr: "SECRET" } : exec(program, args, opts);
  assert.throws(() => pm2Action("install", f.args), error => !error.message.includes("SECRET"));
  assert.equal(readFileSync(unit, "utf8"), "previous unit");
});

test("options reject unsafe paths, unsupported names and invalid memory before commands", t => {
  const f = fixture(t);
  for (const override of [{ PI_DEV_DEPLOY_ROOT: "/" }, { PI_DEV_CONFIG_DIR: "relative" },
    { PI_DEV_CONFIG_DIR: "/missing-pi-config" }, { PM2_HOME: "/tmp/elsewhere" }, { PI_DEV_PM2_NAME: "other" },
    { PI_DEV_HEAP_MB: "0" }, { PI_DEV_PM2_MAX_MEMORY: "3G\nExecStart=bad" }, { PI_DEV_PM2_MAX_MEMORY: "2G" },
    { PI_DEV_PM2_MAX_MEMORY: "5G" }, { PI_DEV_MEMORY_MAX: "2G" }])
    assert.throws(() => pm2Action("install", { ...f.args, env: { ...f.env, ...override } }));
  assert.throws(() => pm2Action("logs", f.args), /Usage/);
  assert.throws(() => pm2Action("status", { ...f.args, uid: 0 }), /never root/);
  assert.equal(f.calls.length, 0);
});

test("default deployment root is independent of the checkout", t => {
  const f = fixture(t);
  assert.equal(pm2Options({ PI_DEV_CONFIG_DIR: f.options.configDir }, f.home).base, join(f.home, ".local/share/pi-dev/deploy"));
});

test("ecosystem validates memory settings and retains one fork process", () => {
  const require = createRequire(import.meta.url), modulePath = resolve("deploy/ecosystem.config.cjs");
  const keys = ["PI_DEV_INSTANCE", "PI_DEV_HEAP_MB", "PI_DEV_PM2_MAX_MEMORY"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const load = () => { delete require.cache[modulePath]; return require(modulePath).apps[0]; };
  try {
    for (const key of keys) delete process.env[key];
    const shadow = load();
    assert.equal(shadow.max_memory_restart, "1536M");
    assert.deepEqual(shadow.node_args, ["--max-old-space-size=1024"]);
    process.env.PI_DEV_INSTANCE = "production";
    const app = load();
    assert.equal(app.instances, 1); assert.equal(app.exec_mode, "fork");
    assert.equal(app.max_memory_restart, "3G");
    assert.deepEqual(app.node_args, ["--max-old-space-size=2048"]);
    process.env.PI_DEV_HEAP_MB = "2048 --require=bad";
    assert.throws(load, /positive integer/);
    process.env.PI_DEV_HEAP_MB = "2048";
    process.env.PI_DEV_PM2_MAX_MEMORY = "garbage";
    assert.throws(load, /must exceed/);
  } finally {
    for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    delete require.cache[modulePath];
  }
});
