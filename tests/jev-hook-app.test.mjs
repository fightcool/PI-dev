/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-gate/gate.mjs（resolveApp / mapDecision 契约）
 * 📖 docs/JEV-HOOK.md — 安装是复制式的，所以「CLI 在哪」必须能解析出来，不能靠扩展自身位置。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapDecision, resolveApp } from "../extensions/jev-gate/gate.mjs";

/** 造一个假 checkout：`<root>/vendor/pi-web-ui/scripts/jev-gate.ts`。 */
function fakeCheckout(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "vendor/pi-web-ui/scripts"), { recursive: true });
  writeFileSync(
    join(root, "vendor/pi-web-ui/scripts/jev-gate.ts"),
    "// fake CLI\n",
  );
  return root;
}

test("resolveApp：宿主自己没有内核时，从会话 cwd 逐级向上找项目自带的仓库根", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-resolve-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = fakeCheckout(tmp, "PI-dev");
  // @BUGFIX 2026-09-20：扩展被**复制**到 <agentDir>/hooks/jev-gate/ 后，
  // 「往上两级」算出的是 <agentDir>/vendor/pi-web-ui（不存在）→ 钩子每次都退化成告警放行。
  // 所以必须从会话 cwd 解析：在仓库根、或在仓库内任意子目录提交，都要能找到。
  const env = {}; // 刻意不给 JEV_GATE_APP
  // hostEntry 指向一棵**没有** vendor/pi-web-ui 的树（模拟从全局安装启动的 pi）→ 才降级到 cwd。
  const noKernelHost = join(tmp, "global-pi/scripts/cli.mjs");
  assert.equal(
    resolveApp(root, env, noKernelHost),
    join(root, "vendor", "pi-web-ui"),
  );
  const deep = join(root, "vendor/pi-web-ui/server/dev-con");
  mkdirSync(deep, { recursive: true });
  assert.equal(
    resolveApp(deep, env, noKernelHost),
    join(root, "vendor", "pi-web-ui"),
  );
});

test("resolveApp：优先用**运行中宿主自己**那份代码（旧 checkout 不该被咨询）", (t) => {
  // @WHY 实测踩过：会话 cwd 里的 checkout 是别人的工作副本（还没有 `ask` 子命令），
  // 而老实现把 cwd 排在前面 → 每次判定先白跑一次进程（2.4s）才失败。
  // 部署语义下 `current` 指向的 release 才是唯一在跑的代码，必须先命中它。
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-host-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const release = fakeCheckout(tmp, "deploy/releases/abc123");
  const stale = fakeCheckout(tmp, "someone-else-worktree");
  const hostEntry = join(release, "scripts/start.mjs");
  assert.equal(
    resolveApp(stale, {}, hostEntry),
    join(release, "vendor/pi-web-ui"),
    "宿主自己的 release 优先于会话 cwd",
  );
  // 发布切换靠符号链接跟随：解析结果里保留 `current` 字面量，所以换发布自动生效。
  const currentEntry = join(tmp, "deploy/current/scripts/start.mjs");
  // `current` 本身就是符号链接（真实部署就是这样），入口脚本通过它访问 —— 不需要额外创建。
  symlinkSync(release, join(tmp, "deploy/current"), "dir");
  assert.equal(
    resolveApp(stale, {}, currentEntry),
    join(tmp, "deploy/current/vendor/pi-web-ui"),
    "解析结果保留 current（不解符号链接）→ 跟随发布切换",
  );
});

test("resolveApp 优先用 JEV_GATE_APP，指错就返回 null（不静默退回猜测）", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-env-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = fakeCheckout(tmp, "checkout");
  const app = join(root, "vendor", "pi-web-ui");
  // 显式配置正确 → 用它，即使 cwd 在别处。
  assert.equal(resolveApp(tmp, { JEV_GATE_APP: app }), app);
  // 显式配置错 → null（调用方会告警放行），而不是悄悄回退到 cwd 猜测。
  assert.equal(resolveApp(app, { JEV_GATE_APP: join(tmp, "nope") }), null);
  // 也不会回退到「宿主自己的代码」或 cwd：显式配错就是错，不许猜。
  const host = fakeCheckout(tmp, "host");
  assert.equal(
    resolveApp(
      app,
      { JEV_GATE_APP: join(tmp, "nope") },
      join(host, "scripts/start.mjs"),
    ),
    null,
  );
});

test("mapDecision 把「找不到 CLI」说清楚，且归类为告警放行（不是通过）", () => {
  const verdict = mapDecision({ code: null, stdout: "", appMissing: true });
  assert.equal(verdict.kind, "failure");
  assert.match(verdict.message, /找不到门禁 CLI/);
  assert.match(verdict.message, /JEV_GATE_APP/);
  assert.doesNotMatch(verdict.message, /通过/);
});
