/* 🍞 AI Breadcrumb: @COUPLED scripts/start.mjs, scripts/lib.mjs, scripts/lifecycle/files.mjs
 * @COUPLED tests/helpers/config-fixture.mjs, tests/configure.test.mjs
 * @CONTRACT Execute only copied scripts and synthetic artifacts; never start a server or install packages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { configFixture, managedPackages, readJson, snapshot, SYNTHETIC_TOKEN,
  writeFile, writeJson } from "./helpers/config-fixture.mjs";

function decoys(f) {
  const override = f.artifact(join(f.root, "override.mjs"), "override");
  const npmRoot = join(f.root, "node_modules/@mariozechner/pi-web-ui");
  writeJson(join(npmRoot, "package.json"), { name: "@mariozechner/pi-web-ui", type: "module",
    main: "dist/server/index.js", exports: "./dist/server/index.js", bin: { "pi-web-ui": "dist/server/index.js" } });
  f.artifact(join(npmRoot, "dist/server/index.js"), "npm-package");
  for (const command of ["npm", "npx", "pi-web-ui"]) {
    const path = join(f.root, "node_modules/.bin", command);
    writeFile(path, `#!/bin/sh\nprintf 'unexpected ${command}' > "$FIXTURE_OBSERVED"\nexit 73\n`);
    chmodSync(path, 0o700);
  }
  return override;
}

function start(f, overrides = {}) {
  return f.run("start.mjs", [], { ...overrides,
    env: { FIXTURE_OBSERVED: f.observed, ...overrides.env } });
}

test("runtimeEntry uses the exact vendor artifact and imports remain inert", async (t) => {
  const f = configFixture(t), before = snapshot(f.dir);
  const { runtimeEntry } = await import(pathToFileURL(join(f.root, "scripts/start.mjs")).href);
  assert.deepEqual(snapshot(f.dir), before);
  assert.throws(() => runtimeEntry({ root: f.root }), /Vendor runtime missing/);
  const entry = f.artifact();
  assert.equal(runtimeEntry({ root: f.root }), entry);
  assert.equal(existsSync(f.observed), false);
  assert.equal(f.hasPrivateFiles(), false);
});

test("start CLI executes vendor artifact with workspace cwd and executable-root environment", (t) => {
  const f = configFixture(t);
  f.seed();
  const entry = f.artifact(), override = decoys(f);
  const stale = { PI_CODING_AGENT_SESSION_DIR: join(f.dir, "stale/sessions"), PI_DEV_WEB_UI_ENTRY: override,
    NODE_PATH: join(f.dir, "stale/node_modules"), npm_package_json: join(f.dir, "stale/package.json"),
    npm_config_local_prefix: join(f.dir, "stale"), INIT_CWD: join(f.dir, "stale") };
  const result = start(f, { cwd: f.home, env: { ...stale, PATH: "/stale/bin", VIRTUAL_ENV: "/stale/venv",
    PI_WEB_HOST: "0.0.0.0", PI_WEB_PORT: "8787", PI_WEB_CWD: "/stale/workspace", PI_WEB_DATA_DIR: "/stale/web",
    PI_CODING_AGENT_DIR: "/stale/agent", PI_WEB_ENGINE: "stale", PI_WEB_TOKEN: "synthetic-stale-token",
    PI_SKIP_VERSION_CHECK: "0", PI_TELEMETRY: "1", FIXTURE_SENTINEL: "preserved" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "vendor");
  const observed = readJson(f.observed), env = observed.env;
  assert.equal(observed.label, "vendor");
  assert.equal(observed.entry, pathToFileURL(entry).href);
  assert.equal(observed.cwd, f.workspaceDir);
  assert.notEqual(observed.cwd, f.root);
  assert.equal(env.PI_WEB_CWD, f.workspaceDir);
  assert.equal(env.VIRTUAL_ENV, join(f.root, ".venv"));
  assert.equal(env.PATH, [join(f.root, ".venv/bin"), join(f.root, "node_modules/.bin"),
    dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"));
  assert.equal(env.PI_WEB_HOST, "127.0.0.1");
  assert.equal(env.PI_WEB_PORT, "8890");
  assert.equal(env.PI_WEB_DATA_DIR, join(f.stateDir, "web"));
  assert.equal(env.PI_CODING_AGENT_DIR, join(f.stateDir, "agent"));
  assert.equal(env.PI_WEB_ENGINE, "pi");
  assert.equal(env.PI_WEB_TOKEN, SYNTHETIC_TOKEN);
  assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(env.PI_TELEMETRY, "0");
  assert.equal(env.PI_WEB_RP_ID, "dev.ftai.cc");
  assert.equal(env.PI_WEB_ORIGIN, "https://dev.ftai.cc");
  assert.equal(env.FIXTURE_SENTINEL, "preserved");
  for (const key of Object.keys(stale)) assert.equal(Object.hasOwn(env, key), false, key);
  assert.deepEqual(readJson(f.settingsFile).packages, managedPackages(f.root));
});

for (const vendor of ["missing", "directory"]) {
  test(`start rejects ${vendor} vendor artifact despite npm package and entry override, before writes`, (t) => {
    const f = configFixture(t);
    f.seed({}, { custom: "untouched", packages: managedPackages(join(f.dir, "old-root")) });
    const override = decoys(f);
    if (vendor === "directory") mkdirSync(join(f.root, "vendor/pi-web-ui/dist/server/index.js"), { recursive: true });
    const before = snapshot(f.dir), result = start(f, { env: { PI_DEV_WEB_UI_ENTRY: override } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Vendor runtime missing: .*vendor\/pi-web-ui\/dist\/server\/index\.js/);
    assert.equal(existsSync(f.observed), false);
    assert.deepEqual(snapshot(f.dir), before);
  });
}

test("vendor import failure is propagated without npm or override fallback", (t) => {
  const f = configFixture(t);
  f.seed({}, { packages: managedPackages(f.root) });
  const override = decoys(f);
  writeFile(join(f.root, "vendor/pi-web-ui/dist/server/index.js"), 'throw new Error("synthetic vendor failure");\n');
  const before = snapshot(f.dir), result = start(f, { env: { PI_DEV_WEB_UI_ENTRY: override } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /synthetic vendor failure/);
  assert.equal(existsSync(f.observed), false);
  assert.deepEqual(snapshot(f.dir), before);
});

for (const legacy of [false, true]) {
  test(`start from moved root migrates managed packages and preserves ${legacy ? "legacy" : "explicit"} workspace`, (t) => {
    const f = configFixture(t), movedRoot = f.copyRoot("new release");
    const custom = { defaultModel: "synthetic-model", compaction: { enabled: false },
      packages: ["npm:custom-package", { source: "npm:filtered", extensions: [] }] };
    f.seed({ profile: "full" }, { ...custom, packages: [...custom.packages, ...managedPackages(f.root, "full")] });
    if (legacy) {
      const config = readJson(f.runtimeFile);
      delete config.workspaceDir;
      writeJson(f.runtimeFile, config);
    }
    const originalRuntime = readFileSync(f.runtimeFile, "utf8");
    f.artifact(undefined, "old-vendor");
    const entry = f.artifact(join(movedRoot, "vendor/pi-web-ui/dist/server/index.js"), "moved-vendor");
    const result = start(f, { root: movedRoot, env: { PI_WEB_RP_ID: "fixture.invalid", PI_WEB_ORIGIN: "https://fixture.invalid" } });
    assert.equal(result.status, 0, result.stderr);
    const observed = readJson(f.observed);
    assert.equal(observed.entry, pathToFileURL(entry).href);
    assert.equal(observed.label, "moved-vendor");
    assert.equal(observed.cwd, legacy ? f.root : f.workspaceDir);
    assert.equal(observed.env.PI_WEB_CWD, observed.cwd);
    assert.equal(observed.env.VIRTUAL_ENV, join(movedRoot, ".venv"));
    assert.ok(observed.env.PATH.startsWith(`${join(movedRoot, ".venv/bin")}:`));
    assert.equal(observed.env.PI_WEB_DATA_DIR, join(f.stateDir, "web"));
    assert.equal(observed.env.PI_CODING_AGENT_DIR, join(f.stateDir, "agent"));
    assert.equal(observed.env.PI_WEB_RP_ID, "fixture.invalid");
    assert.equal(observed.env.PI_WEB_ORIGIN, "https://fixture.invalid");
    assert.deepEqual(readJson(f.settingsFile), { ...custom, packages: [...custom.packages, ...managedPackages(movedRoot, "full")] });
    assert.equal(readFileSync(f.runtimeFile, "utf8"), originalRuntime);
    assert.equal(readFileSync(f.tokenFile, "utf8"), `${SYNTHETIC_TOKEN}\n`);
  });
}

test("start CLI rejects --port=8787 before settings migration or vendor argument parsing", (t) => {
  const f = configFixture(t);
  f.seed({}, { defaultModel: "synthetic-model", packages: managedPackages(join(f.dir, "old-root")) });
  f.artifact();
  const before = snapshot(f.dir);
  const result = f.run("start.mjs", ["--port=8787"], { env: { FIXTURE_OBSERVED: f.observed } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Start accepts no CLI overrides/);
  assert.equal(existsSync(f.observed), false);
  assert.deepEqual(snapshot(f.dir), before);
});

for (const field of ["root", "workspaceDir"]) {
  for (const path of ["/root", "/root/project"]) {
    test(`start rejects stored ${field}=${path} before private writes`, (t) => {
      const f = configFixture(t);
      f.seed({ [field]: path }, { packages: managedPackages(join(f.dir, "old-root")) });
      f.artifact();
      const before = snapshot(f.dir), result = start(f);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not use \/root/);
      assert.equal(existsSync(f.observed), false);
      assert.deepEqual(snapshot(f.dir), before);
    });
  }
}

for (const invalid of ["missing runtime", "malformed runtime", "8787", "8791", "overlapping state", "invalid token", "invalid packages"]) {
  test(`start rejects ${invalid} before artifact execution or private writes`, (t) => {
    const f = configFixture(t);
    if (invalid !== "missing runtime") f.seed({}, { packages: managedPackages(join(f.dir, "stale-root")) });
    f.artifact();
    if (invalid === "malformed runtime") writeFile(f.runtimeFile, "{");
    if (["8787", "8791"].includes(invalid)) writeJson(f.runtimeFile, { ...readJson(f.runtimeFile), port: Number(invalid) });
    if (invalid === "overlapping state") writeJson(f.runtimeFile, { ...readJson(f.runtimeFile), agentDir: join(f.stateDir, "web/nested") });
    if (invalid === "invalid token") writeFile(f.tokenFile, "synthetic-invalid-token");
    if (invalid === "invalid packages") writeJson(f.settingsFile, { packages: "invalid" });
    const before = snapshot(f.dir), result = start(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot read valid JSON|reserved|separate, non-nested|Invalid private access token|packages must be an array/);
    assert.equal(existsSync(f.observed), false);
    assert.deepEqual(snapshot(f.dir), before);
  });
}
