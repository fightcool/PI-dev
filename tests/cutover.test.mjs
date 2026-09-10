import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutover } from "../scripts/lifecycle/cutover.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-cutover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { root: "/fixture/source", node: "/fixture/old-node", host: "127.0.0.1", port: 8788 };
  const configFile = join(dir, "runtime.json");
  writeFileSync(configFile, JSON.stringify(config));
  const calls = [], reports = [];
  let active = 1, pid = 100;
  const options = { config, configFile, backupFile: join(dir, "runtime-before.json"), node: "/fixture/new-node", waitMs: 100, pollMs: 1 };
  const deps = {
    run(args) {
      calls.push(args.join(" "));
      if (args[0] === "is-enabled") return "enabled";
      if (args[0] === "show") return "loaded";
      if (args[0] === "enable" && args.includes("--now")) pid = 200;
      if (args[0] === "start") pid = 101;
      return "";
    },
    async control(cmd) {
      calls.push(`control ${cmd}`);
      return { ok: true, pid, activeConversations: active, pendingMessages: 0 };
    },
    async sleep() { active = 0; },
    async health(_config, { pid }) { calls.push(`health ${pid}`); },
    report(value) { reports.push(value); },
  };
  return { dir, config, options, deps, calls, reports };
}

test("cutover drains work, retires watchdog, starts PM2 and checks its PID", async t => {
  const f = fixture(t);
  const result = await cutover(f.options, f.deps);
  assert.equal(result.status, "deployed");
  assert.equal(result.pid, 200);
  assert.ok(f.calls.indexOf("stop pi-web-ui-dev-watchdog.timer") < f.calls.indexOf("stop pi-web-ui-dev.service"));
  assert.ok(f.calls.indexOf("stop pi-web-ui-dev.service") < f.calls.indexOf("enable --now pi-dev-pm2.service"));
  assert.ok(f.calls.includes("health 200"));
  assert.equal(JSON.parse(readFileSync(f.options.configFile)).workspaceDir, f.config.root);
});

test("failed PM2 health restores config and verifies the old service", async t => {
  const f = fixture(t);
  f.deps.health = async (_config, { pid }) => { if (pid === 200) throw new Error("fixture unavailable"); };
  await assert.rejects(cutover(f.options, f.deps), /fixture unavailable/);
  assert.deepEqual(JSON.parse(readFileSync(f.options.configFile)), f.config);
  assert.equal(f.reports.at(-1).status, "rolled_back");
  assert.ok(f.calls.includes("disable --now pi-dev-pm2.service"));
  assert.ok(f.calls.includes("start pi-web-ui-dev.service"));
});

test("busy sessions time out without stopping the old service", async t => {
  const f = fixture(t);
  let clock = 0;
  f.deps.now = () => clock;
  f.deps.sleep = async () => { clock += 101; };
  await assert.rejects(cutover(f.options, f.deps), /did not drain/);
  assert.equal(f.reports.at(-1).status, "cancelled");
  assert.ok(!f.calls.some(call => call.startsWith("stop ")));
  assert.equal(f.calls.at(-1), "control unquiesce");
});
