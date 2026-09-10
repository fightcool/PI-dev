/* 🍞 AI Breadcrumb: @COUPLED scripts/service.mjs, scripts/lifecycle/systemd.mjs
 * @COUPLED deploy/pi-web-ui-dev.service.in, scripts/lifecycle/service-resources.mjs
 * @CONTRACT All lifecycle commands use a fake exec runner and temporary filesystem paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, SERVICE } from "../scripts/lib.mjs";
import { serviceAction, renderUnit } from "../scripts/service.mjs";
import { WATCHDOG_SERVICE, WATCHDOG_TIMER } from "../scripts/lifecycle/systemd.mjs";

function fixture(t, { present = true, active = "inactive", intercept } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-service-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unitDir = join(dir, "units"), configDir = join(dir, "config");
  const config = { root: join(dir, "release"), workspaceDir: join(dir, "workspace"),
    node: process.execPath, host: "127.0.0.1", port: 18790, profile: "lean",
    dataDir: join(dir, "web"), agentDir: join(dir, "agent"), tokenFile: join(dir, "token") };
  const calls = [], events = [];
  const options = { unitDir, configDir, env: {}, getConfig: () => config, log: () => {},
    checkPort: async (value) => { assert.equal(value, config); events.push("port"); },
    exec: (program, args, opts) => {
      assert.equal(opts.timeout, 60_000);
      calls.push([program, ...args]);
      events.push(program === "systemd-analyze" ? "verify" : args[1]);
      const result = intercept?.(program, args, { unitDir, configDir, calls });
      if (result) return result;
      if (program === "systemctl" && args[1] === "show") {
        const main = args.at(-1) === SERVICE;
        return { status: 0, stdout: `LoadState=${main || present ? "loaded" : "not-found"}\nActiveState=${main ? active : "inactive"}\n` };
      }
      return { status: 0, stdout: "" };
    },
  };
  return { dir, config, options, calls, events, unitPath: join(unitDir, SERVICE) };
}
const mutations = (calls) => calls.filter(([program, , action]) => program === "systemctl" && action !== "show");
const ctl = (...args) => ["systemctl", "--user", ...args];
const retirement = [ctl("stop", WATCHDOG_TIMER), ctl("disable", WATCHDOG_TIMER), ctl("stop", WATCHDOG_SERVICE)];

for (const action of ["install", "start", "restart", "stop", "disable"]) {
  test(`${action} rejects invalid config before commands, port checks, or files`, async (t) => {
    const f = fixture(t);
    for (const invalid of [{ host: "0.0.0.0" }, { port: 8787 }, { port: 8791 }, { port: 0 },
      { root: "relative" }, { workspaceDir: "/bad\npath" }, { node: null }]) {
      f.options.getConfig = () => ({ ...f.config, ...invalid });
      await assert.rejects(serviceAction(action, f.options));
    }
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.events, []);
    assert.deepEqual(readdirSync(f.dir), []);
  });
}

for (const action of ["stop", "disable"]) {
  for (const present of [true, false]) {
    test(`${action} handles ${present ? "existing" : "absent"} watchdog before main service`, async (t) => {
      const f = fixture(t, { present });
      await serviceAction(action, f.options);
      assert.deepEqual(mutations(f.calls), [...(present ? retirement : []),
        action === "stop" ? ctl("stop", SERVICE) : ctl("disable", "--now", SERVICE)]);
    });
  }
}

for (const action of ["start", "restart", "status"]) {
  test(`${action} targets only the main service`, async (t) => {
    const f = fixture(t);
    if (action === "status") f.options.getConfig = () => { throw new Error("must not read private config"); };
    await serviceAction(action, f.options);
    assert.deepEqual(f.calls, [ctl(action, SERVICE)]);
  });
}

for (const present of [true, false]) {
  test(`install verifies before replacing live unit, with watchdog ${present ? "present" : "absent"}`, async (t) => {
    const f = fixture(t, { present, intercept(program, args, { unitDir }) {
      if (program === "systemd-analyze") {
        assert.equal(readFileSync(join(unitDir, SERVICE), "utf8"), "old main");
        assert.notEqual(args.at(-1), join(unitDir, SERVICE));
        assert.equal(readFileSync(args.at(-1), "utf8"), renderUnit(f.config, f.options.configDir, {}));
      }
    } });
    mkdirSync(f.options.unitDir);
    writeFileSync(f.unitPath, "old main");
    writeFileSync(join(f.options.unitDir, WATCHDOG_TIMER), "old timer");
    writeFileSync(join(f.options.unitDir, WATCHDOG_SERVICE), "old watchdog");
    await serviceAction("install", f.options);
    assert.deepEqual(mutations(f.calls), [...(present ? retirement : []),
      ctl("daemon-reload"), ctl("enable", "--now", SERVICE)]);
    assert.ok(f.events.indexOf("verify") < f.events.indexOf(present ? "stop" : "port"));
    assert.ok(f.events.indexOf("port") < f.events.indexOf("daemon-reload"));
    assert.equal(readFileSync(f.unitPath, "utf8"), renderUnit(f.config, f.options.configDir, {}));
    assert.equal(readFileSync(join(f.options.unitDir, WATCHDOG_TIMER), "utf8"), "old timer");
    assert.equal(readFileSync(join(f.options.unitDir, WATCHDOG_SERVICE), "utf8"), "old watchdog");
    const backups = readdirSync(f.options.configDir);
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(f.options.configDir, backups[0]), "utf8"), "old main");
    assert.ok(readdirSync(f.options.unitDir).every((name) => !name.startsWith(".pi-dev-stage-")));
  });
}

test("fresh install creates only the native service and never enables watchdogs", async (t) => {
  const f = fixture(t, { intercept: (_, args) => args[1] === "show" &&
    { status: 0, stdout: "LoadState=not-found\nActiveState=inactive\n" } });
  await serviceAction("install", f.options);
  assert.deepEqual(readdirSync(f.options.unitDir), [SERVICE]);
  assert.ok(!mutations(f.calls).some(args => args.includes("enable") && args.some(arg => arg.includes("watchdog"))));
});

for (const missing of [WATCHDOG_TIMER, WATCHDOG_SERVICE]) {
  test(`maintenance supports partially removed watchdog: ${missing} absent`, async (t) => {
    const f = fixture(t, { intercept: (_, args) => args[1] === "show" && args.at(-1) === missing &&
      { status: 0, stdout: "LoadState=not-found\nActiveState=inactive\n" } });
    await serviceAction("stop", f.options);
    assert.deepEqual(mutations(f.calls), [...retirement.filter((call) => call.at(-1) !== missing), ctl("stop", SERVICE)]);
  });
}

test("maintenance stops running watchdogs even after their unit files were removed", async (t) => {
  const f = fixture(t, { intercept: (_, args) => args[1] === "show" &&
    { status: 0, stdout: "LoadState=not-found\nActiveState=active\n" } });
  await serviceAction("stop", f.options);
  assert.deepEqual(mutations(f.calls), [ctl("stop", WATCHDOG_TIMER), ctl("stop", WATCHDOG_SERVICE), ctl("stop", SERVICE)]);
});

for (const failedAction of ["daemon-reload", "enable"]) {
  test(`install reports ${failedAction} failure without claiming success`, async (t) => {
    const f = fixture(t, { intercept: (_, args) => args[1] === failedAction && { status: 1 } });
    let logged = false;
    f.options.log = () => { logged = true; };
    await assert.rejects(serviceAction("install", f.options), /systemctl failed/);
    assert.equal(logged, false);
    assert.equal(mutations(f.calls).at(-1)[2], failedAction);
    assert.deepEqual(readdirSync(f.options.unitDir), [SERVICE]);
  });
}

test("failed verification preserves live unit and leaves watchdog untouched", async (t) => {
  const f = fixture(t, { intercept: (program) => program === "systemd-analyze" && { status: 1 } });
  mkdirSync(f.options.unitDir);
  writeFileSync(f.unitPath, "old main");
  await assert.rejects(serviceAction("install", f.options), /systemd-analyze failed/);
  assert.equal(readFileSync(f.unitPath, "utf8"), "old main");
  assert.deepEqual(readdirSync(f.options.unitDir), [SERVICE]);
  assert.equal(existsSync(f.options.configDir), false);
  assert.deepEqual(mutations(f.calls), []);
  assert.ok(!f.events.includes("port"));
});

for (const active of ["active", "activating", "deactivating", "reloading"]) {
  test(`install refuses ${active} service before writes`, async (t) => {
    const f = fixture(t, { active });
    await assert.rejects(serviceAction("install", f.options), /stop it explicitly/);
    assert.deepEqual(mutations(f.calls), []);
    assert.deepEqual(readdirSync(f.dir), []);
  });
}

test("install catches watchdog restart during verification", async (t) => {
  let queries = 0;
  const f = fixture(t, { intercept(program, args) {
    if (args[1] === "show" && args.at(-1) === SERVICE && ++queries === 2)
      return { status: 0, stdout: "LoadState=loaded\nActiveState=active\n" };
  } });
  await assert.rejects(serviceAction("install", f.options), /stop it explicitly/);
  assert.deepEqual(mutations(f.calls), retirement);
  assert.equal(existsSync(f.unitPath), false);
});

test("busy port prevents unit replacement and enable", async (t) => {
  const f = fixture(t);
  f.options.checkPort = async () => { throw new Error("EADDRINUSE"); };
  await assert.rejects(serviceAction("install", f.options), /EADDRINUSE/);
  assert.deepEqual(mutations(f.calls), retirement);
  assert.deepEqual(readdirSync(f.options.unitDir), []);
});

for (const failure of [{ status: 1, stdout: "" }, { status: null, error: new Error("ENOENT") },
  { status: null, signal: "SIGTERM" }, { status: 0, stdout: "LoadState=error\nActiveState=inactive" },
  { status: 0, stdout: "" }]) {
  test(`watchdog probe fails closed: ${JSON.stringify(failure)}`, async (t) => {
    const f = fixture(t, { intercept: () => failure });
    await assert.rejects(serviceAction("stop", f.options));
    assert.deepEqual(mutations(f.calls), []);
  });
}

for (const [action, unit] of [["stop", WATCHDOG_TIMER], ["disable", WATCHDOG_TIMER], ["stop", WATCHDOG_SERVICE]]) {
  test(`migration propagates ${action} ${unit} failure`, async (t) => {
    const f = fixture(t, { intercept: (_, args) => args[1] === action && args.at(-1) === unit && { status: 1 } });
    await assert.rejects(serviceAction("install", f.options), /systemctl failed/);
    assert.equal(existsSync(f.unitPath), false);
    assert.deepEqual(mutations(f.calls), retirement.slice(0, retirement.findIndex((call) => call[2] === action && call.at(-1) === unit) + 1));
  });
}

test("main command errors are propagated", async (t) => {
  const f = fixture(t, { intercept: () => ({ status: 1 }) });
  await assert.rejects(serviceAction("start", f.options), /systemctl failed/);
});

test("render uses executable root, independent workspace, and context-specific escaping", (t) => {
  const f = fixture(t);
  const config = { ...f.config, root: '/release space/%build/$code/"quoted"',
    workspaceDir: '/work space/%cwd/$work/"quoted"', node: '/node space/%bin/$node' };
  const unit = renderUnit(config, '/config space/%dir/$config/"quoted"', {});
  assert.ok(unit.includes('WorkingDirectory="/work space/%%cwd/$work/\\"quoted\\""'));
  assert.ok(unit.includes('ExecStart="/node space/%%bin/$$node" "/release space/%%build/$$code/\\"quoted\\"/scripts/start.mjs"'));
  assert.ok(unit.includes('Environment="PI_DEV_CONFIG_DIR=/config space/%%dir/$config/\\"quoted\\""'));
  delete config.workspaceDir;
  assert.ok(renderUnit(config, undefined, {}).includes(`WorkingDirectory="${ROOT.replaceAll("%", "%%")}"`));
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=10$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.doesNotMatch(unit, /StartLimitBurst=|@[A-Z_]+@|watchdog/);
  assert.match(unit, /^KillMode=control-group$/m);
});

test("import is inert even with install argv and missing private config", (t) => {
  const f = fixture(t);
  const url = pathToFileURL(join(ROOT, "scripts/service.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `process.argv[2] = 'install'; await import(${JSON.stringify(url)});`], {
    env: { ...process.env, HOME: f.dir, PI_DEV_CONFIG_DIR: f.options.configDir, PATH: f.dir },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(readdirSync(f.dir), []);
});

test("invalid service paths reject before commands or writes", async (t) => {
  const f = fixture(t);
  for (const field of ["configDir", "unitDir"]) {
    await assert.rejects(serviceAction("install", { ...f.options, [field]: "/bad\npath" }), /Service paths/);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(readdirSync(f.dir), []);
});

test("CLI executes validation with a synthetic invalid config", (t) => {
  const f = fixture(t);
  mkdirSync(f.options.configDir);
  writeFileSync(join(f.options.configDir, "runtime.json"), JSON.stringify({ ...f.config, host: "0.0.0.0" }));
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/service.mjs"), "stop"], {
    env: { ...process.env, HOME: f.dir, PI_DEV_CONFIG_DIR: f.options.configDir, PATH: f.dir },
    encoding: "utf8", timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /loopback/);
  assert.doesNotMatch(result.stderr, /systemctl failed/);
});

test("unknown action rejects before config reads and commands", async (t) => {
  const f = fixture(t);
  f.options.getConfig = () => { throw new Error("unexpected config read"); };
  await assert.rejects(serviceAction("remove", f.options), /Usage:/);
  assert.deepEqual(f.calls, []);
});
