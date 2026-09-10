import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { configFixture, writeFile, readJson } from "./helpers/config-fixture.mjs";

// PM2 6 imports ESM from its IPC ProcessContainerFork without changing argv[1].
test("PM2 ESM import wrapper starts the vendor runtime exactly once", async t => {
  const f = configFixture(t);
  f.seed();
  f.artifact();
  const wrapper = join(f.root, "pm2-wrapper.mjs");
  writeFile(wrapper, 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.env.pm_exec_path)); process.disconnect();');
  const child = fork(wrapper, [], { cwd: f.root, silent: true, env: {
    PATH: process.env.PATH, PI_DEV_CONFIG_DIR: f.configDir,
    pm_exec_path: join(f.root, "scripts/start.mjs"), FIXTURE_OBSERVED: f.observed,
  } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(readJson(f.observed).label, "vendor");
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
});
