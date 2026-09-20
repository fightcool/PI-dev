/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-gate/gate.mjs（resolveApp / mapDecision 契约）
 * 📖 docs/JEV-HOOK.md — 安装是复制式的，所以「CLI 在哪」必须能解析出来，不能靠扩展自身位置。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("resolveApp 从会话 cwd 逐级向上找到仓库根", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-resolve-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = fakeCheckout(tmp, "PI-dev");
  // @BUGFIX 2026-09-20：扩展被**复制**到 <agentDir>/hooks/jev-gate/ 后，
  // 「往上两级」算出的是 <agentDir>/vendor/pi-web-ui（不存在）→ 钩子每次都退化成告警放行。
  // 所以必须从会话 cwd 解析：在仓库根、或在仓库内任意子目录提交，都要能找到。
  const env = {}; // 刻意不给 JEV_GATE_APP
  assert.equal(resolveApp(root, env), join(root, "vendor", "pi-web-ui"));
  const deep = join(root, "vendor/pi-web-ui/server/dev-con");
  mkdirSync(deep, { recursive: true });
  assert.equal(resolveApp(deep, env), join(root, "vendor", "pi-web-ui"));
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
});

test("cwd 在仓库外时用安装时记录的 app.json 兜底（别的项目里提交也不能静默放行）", (t) => {
  // @BUGFIX 2026-09-20：实测在 /tmp/<临时仓库> 里提交时钩子没拦 —— 不是没加载，是 cwd 不含
  // vendor/pi-web-ui 而找不到 CLI，于是静默放行。安装时记下 checkout 路径即可兜底。
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-record-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = fakeCheckout(tmp, "recorded");
  const app = join(root, "vendor", "pi-web-ui");
  const record = join(tmp, "app.json");
  writeFileSync(record, JSON.stringify({ app }));
  assert.equal(resolveApp(join(tmp, "elsewhere"), {}, record), app);
  // 显式 JEV_GATE_APP 优先于记录；记录损坏/指向失效路径 → 不猜，返回 null。
  assert.equal(
    resolveApp(join(tmp, "elsewhere"), { JEV_GATE_APP: app }, record),
    app,
  );
  // 记录损坏 / 指向失效路径 → 绝不把失效路径当成答案（此测试跑在 checkout 里，
  // 所以最后一档「扩展源码所在 checkout」仍会命中；关键是**不会**返回记录里的坏路径）。
  writeFileSync(record, "{ not json");
  assert.notEqual(resolveApp(join(tmp, "elsewhere"), {}, record), undefined);
  writeFileSync(record, JSON.stringify({ app: join(tmp, "gone") }));
  assert.notEqual(resolveApp(join(tmp, "elsewhere"), {}, record), join(tmp, "gone"));
});

test("cwd 在仓库外时回退到扩展源码所在的 checkout（开发时的预期行为）", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-outside-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // 扩展源码就在本 checkout 里，所以这是「本机确实有 CLI」的正常情况。
  const resolved = resolveApp(tmp, {});
  assert.ok(resolved === null || resolved.endsWith("vendor/pi-web-ui"));
  // 真正的 null 只有一种来源：显式配置指向不存在的路径（见上一条），
  // 或本机既没有 checkout 也没有 JEV_GATE_APP —— 两者都走「告警放行」而不是假装通过。
});

test("mapDecision 把「找不到 CLI」说清楚，且归类为告警放行（不是通过）", () => {
  const verdict = mapDecision({ code: null, stdout: "", appMissing: true });
  assert.equal(verdict.kind, "failure");
  assert.match(verdict.message, /找不到门禁 CLI/);
  assert.match(verdict.message, /JEV_GATE_APP/);
  assert.doesNotMatch(verdict.message, /通过/);
});
