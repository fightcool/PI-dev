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
import { dirname, join } from "node:path";
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

test("resolveApp：优先 pm_exec_path（pm2 的 process container 会改写 argv[1]）", (t) => {
  // @WHY 实测现场：服务由 pm2 启动，扩展里 `process.argv[1]` =
  //   `<deploy>/tools/pm2/node_modules/pm2/lib/ProcessContainerFork.js`，
  //   从那里向上找不到 vendor/pi-web-ui → 被判成「版本错位」。pm2 暴露的真实入口在 pm_exec_path。
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-pm2-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const release = fakeCheckout(tmp, "deploy/current");
  const pm2Wrapper = join(
    tmp,
    "deploy/tools/pm2/node_modules/pm2/lib/ProcessContainerFork.js",
  );
  assert.equal(
    resolveApp(
      tmp,
      { pm_exec_path: join(release, "scripts/start.mjs") },
      pm2Wrapper,
    ),
    join(release, "vendor/pi-web-ui"),
    "pm_exec_path 必须优先于 argv[1]",
  );
  // 解析结果保留 `current` 字面量 → 换发布自动跟随（不解符号链接是关键）。
  assert.match(
    resolveApp(
      tmp,
      { pm_exec_path: join(release, "scripts/start.mjs") },
      pm2Wrapper,
    ),
    /deploy\/current/,
  );
});

test("resolveApp：argv[1] 兜底（直接 node 启动，无 pm2）", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-argv-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const release = fakeCheckout(tmp, "deploy/releases/abc123");
  assert.equal(
    resolveApp(tmp, {}, join(release, "scripts/start.mjs")),
    join(release, "vendor/pi-web-ui"),
  );
  // 从 node_modules 深处的 CLI 也要能找到（pi 的 cli 在 @scope/pkg/dist 下，要爬 4-5 层）。
  const deepCli = join(
    release,
    "vendor/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  );
  mkdirSync(dirname(deepCli), { recursive: true });
  writeFileSync(deepCli, "// cli\n");
  assert.equal(resolveApp(tmp, {}, deepCli), join(release, "vendor/pi-web-ui"));
});

test("resolveApp：不给 cwd 兜底 —— cwd 里有 checkout 也不能当答案", (t) => {
  // @WHY 这是本设计最关键的否定性断言：cwd 兜底曾把「宿主入口解析失败」掩盖成「版本错位」，
  //   真问题（argv[1] 在 pm2 下不是应用入口）晚了两周才发现。cwd 只允许出现在诊断信息里。
  const tmp = mkdtempSync(join(tmpdir(), "jev-app-nocwd-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const project = fakeCheckout(tmp, "PI-dev"); // cwd 里确实有一个 checkout
  assert.equal(
    resolveApp(project, {}, "/nonexistent/scripts/unknown.js"),
    null,
  );
  // 显式 JEV_GATE_APP 配错 → null（不静默回退到 cwd 或宿主树）。
  assert.equal(
    resolveApp(
      project,
      { JEV_GATE_APP: join(tmp, "nope") },
      join(project, "scripts/start.mjs"),
    ),
    null,
  );
  // 显式配置正确 → 用它，即使 cwd 与宿主树都在别处。
  const app = join(project, "vendor/pi-web-ui");
  assert.equal(
    resolveApp(tmp, { JEV_GATE_APP: app }, "/nonexistent/x.js"),
    app,
  );
});

test("mapDecision 把「找不到 CLI」说清楚，且归类为告警放行（不是通过）", () => {
  const verdict = mapDecision({ code: null, stdout: "", appMissing: true });
  assert.equal(verdict.kind, "failure");
  assert.match(verdict.message, /找不到门禁 CLI/);
  assert.match(verdict.message, /JEV_GATE_APP/);
  assert.doesNotMatch(verdict.message, /通过/);
});
