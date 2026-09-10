/* 🍞 AI Breadcrumb: @COUPLED scripts/configure.mjs, scripts/lib.mjs, scripts/lifecycle/files.mjs
 * @COUPLED tests/helpers/config-fixture.mjs, tests/start.test.mjs
 * @CONTRACT Pure validation and real CLI tests never use active private configuration or dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configFixture, managedPackages, readJson, snapshot, SYNTHETIC_TOKEN,
  writeFile, writeJson } from "./helpers/config-fixture.mjs";

const customSettings = (f) => ({
  defaultModel: "synthetic-custom-model", defaultProvider: "synthetic-provider",
  compaction: { enabled: false, reserveTokens: 0 }, custom: { enabled: true },
  packages: ["npm:custom-extension@1.2.3", "npm:pi-lens@4.1.5", "./local-extension",
    join(f.dir, "custom/pi-context-prune"), { source: "npm:custom-filtered", extensions: ["extension.mjs"] }],
});

async function pureFactory(f) {
  return (await import(pathToFileURL(join(f.root, "scripts/configure.mjs")).href)).createConfig;
}

test("createConfig is pure and derives private paths from explicit options", async (t) => {
  const f = configFixture(t), before = snapshot(f.dir);
  const createConfig = await pureFactory(f);
  assert.deepEqual(createConfig(f.options), { root: f.root, workspaceDir: f.workspaceDir,
    node: process.execPath, host: "127.0.0.1", port: 8890, profile: "lean",
    dataDir: join(f.stateDir, "web"), agentDir: join(f.stateDir, "agent"), tokenFile: f.tokenFile });
  assert.deepEqual(snapshot(f.dir), before);
  assert.equal(f.hasPrivateFiles(), false);
});

test("createConfig accepts independent release paths and full profile without writing", async (t) => {
  const f = configFixture(t), createConfig = await pureFactory(f), before = snapshot(f.dir);
  const overrides = { root: join(f.dir, "release"), profile: "full", port: 65535,
    dataDir: join(f.dir, "web"), agentDir: join(f.dir, "agent"), tokenFile: join(f.dir, "secret") };
  const config = createConfig({ ...f.options, ...overrides });
  for (const [key, value] of Object.entries(overrides)) assert.equal(config[key], value);
  assert.equal(config.workspaceDir, f.workspaceDir);
  assert.deepEqual(snapshot(f.dir), before);
});

test("createConfig rejects reserved ports and invalid state without filesystem effects", async (t) => {
  const f = configFixture(t), createConfig = await pureFactory(f), before = snapshot(f.dir);
  const invalid = [{ port: 8787 }, { port: 8791 }, { port: 0 }, { port: 1023 }, { port: 65536 },
    { port: 8890.5 }, { port: NaN }, { port: "8890" }, { host: "0.0.0.0" }, { profile: "unknown" },
    { root: "relative" }, { root: "/root" }, { root: "/root/project" }, { root: "/tmp/../root/project" },
    { workspaceDir: "/root" }, { workspaceDir: "/root/workspace" }, { workspaceDir: "/tmp/../root/workspace" },
    { workspaceDir: "relative" }, { node: "/bad\nnode" }, { stateDir: "relative" },
    { tokenFile: "/bad\0token" }, { agentDir: join(f.stateDir, "web") },
    { agentDir: join(f.stateDir, "web/nested") }, { dataDir: join(f.stateDir, "agent/nested") },
    { typo: "unknown" }];
  for (const options of invalid) assert.throws(() => createConfig({ ...f.options, ...options }));
  assert.deepEqual(snapshot(f.dir), before);
});

test("configure CLI honors PI_DEV_CONFIG_DIR, STATE_DIR, PORT=8890 and CWD", (t) => {
  const f = configFixture(t), config = f.configure();
  assert.deepEqual(config, { root: f.root, workspaceDir: f.workspaceDir, node: process.execPath,
    host: "127.0.0.1", port: 8890, profile: "lean", dataDir: join(f.stateDir, "web"),
    agentDir: join(f.stateDir, "agent"), tokenFile: f.tokenFile });
  assert.match(readFileSync(f.tokenFile, "utf8"), /^[a-f0-9]{64}\n$/);
  const settings = readJson(f.settingsFile);
  assert.deepEqual(settings.packages, managedPackages(f.root));
  assert.equal(settings.defaultProjectTrust, "ask");
  assert.equal(settings.enableInstallTelemetry, false);
  assert.deepEqual(readdirSync(f.home), []);
  assert.equal(existsSync(join(f.root, "node_modules")), false);
  for (const path of [f.configDir, config.dataDir, config.agentDir]) assert.equal(statSync(path).mode & 0o077, 0);
  for (const path of [f.runtimeFile, f.tokenFile, f.settingsFile]) assert.equal(statSync(path).mode & 0o077, 0);
});

test("configure CLI flags override environment and resolve relative workspace/state paths", (t) => {
  const f = configFixture(t);
  const config = f.configure(["--port=8892", "--profile=full", "--workspace=other workspace", "--state-dir=other state"]);
  assert.equal(config.port, 8892);
  assert.equal(config.profile, "full");
  assert.equal(config.workspaceDir, join(f.workspaceDir, "other workspace"));
  assert.equal(config.dataDir, join(f.workspaceDir, "other state/web"));
  assert.equal(config.agentDir, join(f.workspaceDir, "other state/agent"));
  assert.deepEqual(readJson(join(config.agentDir, "settings.json")).packages, managedPackages(f.root, "full"));
  assert.equal(existsSync(f.stateDir), false);
});

test("repeat configure preserves synthetic token, custom settings and package specifications", (t) => {
  const f = configFixture(t), custom = customSettings(f);
  f.seed({}, { ...custom, packages: [...custom.packages, ...managedPackages(f.root)] });
  const tokenBefore = readFileSync(f.tokenFile, "utf8"), settingsBefore = readFileSync(f.settingsFile, "utf8");
  for (let i = 0; i < 2; i++) {
    f.configure();
    assert.equal(readFileSync(f.tokenFile, "utf8"), tokenBefore);
    assert.equal(readFileSync(f.settingsFile, "utf8"), settingsBefore);
  }
  assert.equal(tokenBefore, `${SYNTHETIC_TOKEN}\n`);
});

test("profile switches migrate only managed packages and remove duplicates across movable roots", (t) => {
  const f = configFixture(t), custom = customSettings(f), oldRoot = join(f.dir, "old release");
  f.seed({ root: oldRoot }, { ...custom, packages: [...custom.packages,
    ...managedPackages(oldRoot, "full"), ...managedPackages(oldRoot)] });
  f.configure(["--profile=full"]);
  assert.deepEqual(readJson(f.settingsFile), { ...custom, packages: [...custom.packages, ...managedPackages(f.root, "full")] });
  const movedRoot = f.copyRoot("moved release");
  const config = f.configure(["--profile=lean"], { root: movedRoot });
  assert.equal(config.root, movedRoot);
  assert.equal(config.workspaceDir, f.workspaceDir);
  assert.equal(config.dataDir, join(f.stateDir, "web"));
  assert.equal(config.agentDir, join(f.stateDir, "agent"));
  assert.equal(config.tokenFile, f.tokenFile);
  assert.deepEqual(readJson(f.settingsFile), { ...custom, packages: [...custom.packages, ...managedPackages(movedRoot)] });
  f.configure(["--profile=full"], { root: movedRoot });
  assert.deepEqual(readJson(f.settingsFile).packages, [...custom.packages, ...managedPackages(movedRoot, "full")]);
  assert.equal(readFileSync(f.tokenFile, "utf8"), `${SYNTHETIC_TOKEN}\n`);
});

const cliInvalid = [
  ["reserved legacy port", ["--port=8787"], {}],
  ["reserved dev-con port", ["--port=8791"], {}],
  ["reserved environment port", [], { PI_DEV_PORT: "8791" }],
  ["nonnumeric port", [], { PI_DEV_PORT: "invalid" }],
  ["privileged port", ["--port=80"], {}],
  ["unknown profile", ["--profile=unknown"], {}],
  ["non-loopback host", ["--host=0.0.0.0"], {}],
  ["root workspace", ["--workspace=/root"], {}],
  ["root descendant workspace", ["--workspace=/root/project"], {}],
  ["root environment workspace", [], { PI_DEV_CWD: "/root/project" }],
  ["unknown flag", ["--unknown=value"], {}],
  ["relative state environment", [], { PI_DEV_STATE_DIR: "relative" }],
  ["state control character", [], { PI_DEV_STATE_DIR: "/bad\nstate" }],
];
for (const [name, args, env] of cliInvalid) {
  test(`configure CLI rejects ${name} before any writes`, (t) => {
    const f = configFixture(t), before = snapshot(f.dir);
    const result = f.run("configure.mjs", args, { env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Error:/);
    assert.deepEqual(snapshot(f.dir), before);
    assert.equal(f.hasPrivateFiles(), false);
  });
}

for (const relationship of ["same", "web-in-agent", "agent-in-web"]) {
  test(`configure CLI rejects ${relationship} state directories before writes`, (t) => {
    const f = configFixture(t), path = join(f.dir, "overlap"), before = snapshot(f.dir);
    const dataDir = relationship === "web-in-agent" ? join(path, "nested") : path;
    const agentDir = relationship === "agent-in-web" ? join(path, "nested") : path;
    const result = f.run("configure.mjs", [`--data-dir=${dataDir}`, `--agent-dir=${agentDir}`]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /separate, non-nested/);
    assert.deepEqual(snapshot(f.dir), before);
  });
}

for (const state of ["malformed runtime", "invalid stored runtime", "malformed settings", "invalid packages"]) {
  test(`configure rejects ${state} without changing existing private files`, (t) => {
    const f = configFixture(t);
    f.seed({}, { packages: managedPackages(f.root), custom: "preserved" });
    // Existing state includes both directories, making any content mutation observable.
    f.configure();
    if (state === "malformed runtime") writeFile(f.runtimeFile, "{");
    if (state === "invalid stored runtime") writeJson(f.runtimeFile, { ...readJson(f.runtimeFile), host: "0.0.0.0" });
    if (state === "malformed settings") writeFile(f.settingsFile, "{");
    if (state === "invalid packages") writeJson(f.settingsFile, { packages: "not-an-array" });
    const before = snapshot(f.dir), result = f.run("configure.mjs");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot read valid JSON|loopback|packages must be an array/);
    assert.deepEqual(snapshot(f.dir), before);
  });
}
