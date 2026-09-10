/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/service-resources.mjs, scripts/service.mjs
 * @CONTRACT Resource failures must precede manager commands and filesystem mutations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SERVICE } from "../scripts/lib.mjs";
import { renderUnit, serviceAction } from "../scripts/service.mjs";
import { serviceResources } from "../scripts/lifecycle/service-resources.mjs";

const recommended = { PI_DEV_HEAP_MB: "2048", PI_DEV_MEMORY_HIGH: "3G", PI_DEV_MEMORY_MAX: "4G" };
function fixture(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-resources-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { root: dir, workspaceDir: dir, node: process.execPath, host: "127.0.0.1",
    port: 8890, profile: "lean", dataDir: join(dir, "web"), agentDir: join(dir, "agent"), tokenFile: join(dir, "token") };
  const calls = [];
  const options = { env, getConfig: () => config, unitDir: join(dir, "units"), configDir: join(dir, "config"),
    log: () => {}, checkPort: async () => { calls.push("port"); },
    exec: (program, args) => { calls.push([program, ...args]); return {
      status: 0, stdout: "LoadState=not-found\nActiveState=inactive\n",
    }; } };
  return { dir, config, options, calls };
}

test("default resources remain unchanged", t => {
  const f = fixture(t);
  assert.deepEqual(serviceResources({}), { HEAP_MB: "1024", MEMORY_HIGH: "1536M", MEMORY_MAX: "2G" });
  const lines = renderUnit(f.config, f.options.configDir, {}).split("\n");
  for (const line of ["Environment=NODE_OPTIONS=--max-old-space-size=1024", "MemoryHigh=1536M", "MemoryMax=2G"])
    assert.ok(lines.includes(line));
});

test("8 GiB recommendation is opt-in and reaches the installed unit", async t => {
  const f = fixture(t, recommended);
  await serviceAction("install", f.options);
  const lines = readFileSync(join(f.options.unitDir, SERVICE), "utf8").split("\n");
  for (const line of ["Environment=NODE_OPTIONS=--max-old-space-size=2048", "MemoryHigh=3G", "MemoryMax=4G"])
    assert.ok(lines.includes(line));
  assert.ok(f.calls.some(call => Array.isArray(call) && call.includes("enable")));
});

const invalid = [
  ...["", "0", "-1", "1.5", "1e3", "2048M", "2048\nExecStart=/bad", "9007199254740992"]
    .map(value => ({ PI_DEV_HEAP_MB: value })),
  ...["", "0G", "-1G", "1.5G", "infinity", "50%", "2GB", " 2G", "2G\nTasksMax=infinity", "9007199254740992G"]
    .flatMap(value => [{ PI_DEV_MEMORY_HIGH: value }, { PI_DEV_MEMORY_MAX: value }]),
  { PI_DEV_HEAP_MB: "1536" }, { PI_DEV_MEMORY_HIGH: "1G" }, { PI_DEV_MEMORY_MAX: "1G" },
];
for (const [index, env] of invalid.entries()) {
  test(`invalid resource case ${index + 1} fails before commands or writes`, async t => {
    const f = fixture(t, env);
    await assert.rejects(serviceAction("install", f.options), /PI_DEV_|Resource limits/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(readdirSync(f.dir), []);
  });
}

test("equivalent integer M/G limits are accepted", () => {
  assert.deepEqual(serviceResources({ ...recommended, PI_DEV_MEMORY_HIGH: "3072M", PI_DEV_MEMORY_MAX: "4096M" }),
    { HEAP_MB: "2048", MEMORY_HIGH: "3072M", MEMORY_MAX: "4096M" });
});

test("invalid install-time overrides cannot prevent an explicit maintenance stop", async t => {
  const f = fixture(t, { PI_DEV_HEAP_MB: "invalid" });
  await serviceAction("stop", f.options);
  assert.deepEqual(f.calls.at(-1), ["systemctl", "--user", "stop", SERVICE]);
  assert.deepEqual(readdirSync(f.dir), []);
});
