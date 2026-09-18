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

// 2026-09-18 生产事故的形状：2 条排队消息没有任何运行在消费（active=0）。
// 修复前：参数 pending=2 一直挡着门禁，白等 45 分钟后 aborted；现在不该再等一秒。
test("orphaned queued messages no longer block the drain", async t => {
  const f = fixture(t);
  const base = f.deps.control;
  // 真实的“旧服务”快照：没有活跃对话，但有 2 条排不上用场的排队消息。
  f.deps.control = async (cmd) => ({
    ...(await base(cmd)),
    activeConversations: 0,
    pendingMessages: 2,
    drainableMessages: 0,
    orphanedMessages: 2,
  });
  f.deps.sleep = async () => {};
  const result = await cutover(f.options, f.deps);
  assert.equal(result.status, "deployed");
  assert.ok(f.calls.includes("stop pi-web-ui-dev.service"), "没被孤儿队列挡在门外，照样完成切换");
  assert.equal(f.reports.find(r => r.drainNote)?.drainNote.includes("没有任何运行在消费"), true, "要照实报出孤儿队列");
  // 排空阶段只查一次就放行（初始 + 排空 + 切换后核对新实例 = 3 次；旧实现会在这重循环）。
  assert.ok(f.calls.filter(c => c === "control status").length <= 3, "不为孤儿队列反复轮询");
});

// 真的在飞的工作停住了：早退并点名，而不是等满总超时（用户为这种闷等埋过单）。
test("a stalled drain aborts early and names the holder", async t => {
  const f = fixture(t);
  f.deps.control = async (cmd) => {
    f.calls.push(`control ${cmd}`);
    return {
      ok: true, pid: 100, activeConversations: 1, pendingMessages: 1,
      drainableMessages: 1, orphanedMessages: 0,
      drainHolders: [{ id: "01a0aff8", streaming: true, queued: 1, idleSeconds: 900 }],
    };
  };
  let clock = 0;
  f.deps.now = () => clock;
  f.deps.sleep = async () => { clock += 6 * 60_000; }; // 每次轮询推进 6 分钟 → 越过 5 分钟停滞阈值
  await assert.rejects(cutover(f.options, f.deps), /排空停滞/);
  assert.ok(!f.calls.some(call => call.startsWith("stop ")), "早退不该碰服务");
  assert.equal(f.calls.at(-1), "control unquiesce");
});
