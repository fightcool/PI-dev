/* 🍞 AI Breadcrumb: @COUPLED tests/configure.test.mjs, tests/start.test.mjs
 * @CONTRACT Copy only lifecycle source; all config, dependencies, tokens and artifacts are synthetic.
 * @GOTCHA Child environments are allowlisted so developer credentials and Node preload hooks cannot leak in.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
export const SYNTHETIC_TOKEN = "0123456789abcdef".repeat(4);
export const MANAGED = {
  lean: ["pi-context-prune"],
  full: ["pi-context-prune", "pi-lens", "pi-subagents", "pi-mcp-adapter",
    "@howaboua/pi-codex-conversion", "@narumitw/pi-goal"],
};
export const managedPackages = (root, profile = "lean") =>
  MANAGED[profile].map((name) => join(root, "node_modules", name));
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}
export const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

// Include directories and modes so rejection tests also detect premature mkdir/chmod.
export function snapshot(dir) {
  const result = {};
  function visit(path, relative) {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, `Fixture must not contain symlinks: ${relative}`);
    result[relative] = { mode: stat.mode & 0o777,
      content: stat.isFile() ? readFileSync(path, "utf8") : null };
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), join(relative, name));
  }
  visit(dir, ".");
  return result;
}

export function configFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-lifecycle-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function copyRoot(name) {
    const root = join(dir, name);
    for (const file of ["configure.mjs", "lib.mjs", "start.mjs", "lifecycle/files.mjs"]) {
      const target = join(root, "scripts", file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(sourceRoot, "scripts", file), target);
    }
    writeJson(join(root, "package.json"), { private: true, type: "module" });
    return root;
  }
  const root = copyRoot("code root");
  const home = join(dir, "home"), configDir = join(dir, "private config");
  const stateDir = join(dir, "private state"), workspaceDir = join(dir, "workspace");
  for (const path of [home, workspaceDir]) mkdirSync(path);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: dir, TMP: dir, TEMP: dir, PATH: dirname(process.execPath),
    PI_DEV_CONFIG_DIR: configDir, PI_DEV_STATE_DIR: stateDir, PI_DEV_PORT: "8890", PI_DEV_CWD: workspaceDir };
  const runtimeFile = join(configDir, "runtime.json"), tokenFile = join(configDir, "token");
  const settingsFile = join(stateDir, "agent/settings.json");
  const options = { root, configDir, stateDir, workspaceDir, port: 8890, node: process.execPath };
  function run(script, args = [], overrides = {}) {
    const result = spawnSync(process.execPath, [join(overrides.root ?? root, "scripts", script), ...args], {
      cwd: overrides.cwd ?? workspaceDir, env: { ...env, ...overrides.env },
      encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  }
  function configure(args = [], overrides = {}) {
    const result = run("configure.mjs", args, overrides);
    assert.equal(result.status, 0, result.stderr);
    return readJson(runtimeFile);
  }
  function seed(config = {}, settings = undefined) {
    writeFile(tokenFile, `${SYNTHETIC_TOKEN}\n`);
    writeJson(runtimeFile, { root, workspaceDir, node: process.execPath, host: "127.0.0.1", port: 8890,
      profile: "lean", dataDir: join(stateDir, "web"), agentDir: join(stateDir, "agent"), tokenFile, ...config });
    if (settings !== undefined) writeJson(settingsFile, settings);
  }
  function artifact(path = join(root, "vendor/pi-web-ui/dist/server/index.js"), label = "vendor") {
    writeFile(path, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FIXTURE_OBSERVED, JSON.stringify({ label: ${JSON.stringify(label)},
  entry: import.meta.url, cwd: process.cwd(), env: process.env }));
console.log(${JSON.stringify(label)});
`);
    return path;
  }
  return { dir, root, home, configDir, stateDir, workspaceDir, env, runtimeFile, tokenFile, settingsFile,
    options, run, configure, seed, artifact, copyRoot, observed: join(dir, "observed.json"),
    hasPrivateFiles: () => existsSync(configDir) || existsSync(stateDir) };
}
