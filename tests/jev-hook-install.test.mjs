/* 🍞 AI Breadcrumb — @COUPLED ../scripts/install-jev-hook.mjs, ../extensions/jev-gate/index.ts
 * 📖 docs/JEV-HOOK.md — global discovery and UI transport without Jev/network calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  DefaultResourceLoader,
  SettingsManager,
  ExtensionRunner,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const installer = fileURLToPath(
  new URL("../scripts/install-jev-hook.mjs", import.meta.url),
);
test("global entry auto-discovers, notifies via UI and uninstalls without touching settings", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-install-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  const install = (action) =>
    execFileSync(process.execPath, [installer, action], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  install("install");
  install("install");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].handlers.has("tool_call"));
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    {},
  );
  const notices = [];
  runner.setUIContext(
    { notify: (message, level) => notices.push({ message, level }) },
    "rpc",
  );
  await runner.emit({ type: "session_start", reason: "startup" });
  assert.match(notices[0].message, /Jev 提交钩子已/);
  assert.equal(
    await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "no-io",
      toolName: "bash",
      input: { command: 'echo "git commit"' },
    }),
    undefined,
  );
  assert.equal(existsSync(join(agentDir, "settings.json")), false);
  // 兜底 CLI 路径必须随安装落盘（别的项目里提交时靠它找 CLI）。
  const recorded = JSON.parse(
    readFileSync(join(agentDir, "hooks/jev-gate/app.json"), "utf8"),
  );
  assert.match(recorded.app, /vendor\/pi-web-ui$/);
  install("uninstall");
  assert.equal(existsSync(join(agentDir, "extensions/jev-gate.ts")), false);
  // 本体目录也必须一起消失（自包含安装的代价是卸载要清两份）。
  assert.equal(existsSync(join(agentDir, "hooks/jev-gate")), false);
  writeFileSync(
    join(agentDir, "extensions/jev-gate.ts"),
    "// someone else's extension\n",
  );
  assert.throws(() => install("install"));
  assert.throws(() => install("uninstall"));
});

test("upgrades the first-generation (absolute-path) shim instead of refusing it", (t) => {
  // @BUGFIX 2026-09-20：第一版入口是 `export … from "/home/dev/jev-hook/extensions/…"`（绝对路径，
  // 指向临时 worktree）。升级时必须认得它「是自己人写的」，否则安装器会拒绝覆盖，现场就只能手删。
  const cwd = mkdtempSync(join(tmpdir(), "jev-install-upgrade-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions/jev-gate.ts"),
    '// Managed by PI-dev scripts/install-jev-hook.mjs\nexport { default } from "/home/dev/jev-hook/extensions/jev-gate/index.ts";\n',
  );
  const out = execFileSync(process.execPath, [installer, "install"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.match(out, /已安装/);
  assert.match(
    readFileSync(join(agentDir, "extensions/jev-gate.ts"), "utf8"),
    /hooks\/jev-gate\/index\.ts/,
  );
});

test("installed entry is self-contained: no absolute repo/worktree path in the shim or body", (t) => {
  // @BUGFIX 2026-09-20：第一版 shim 是 `export { default } from "/home/dev/jev-hook/extensions/..."`
  // —— 指向一个**临时 worktree**，那个目录一删，所有会话加载扩展都会报错。
  const cwd = mkdtempSync(join(tmpdir(), "jev-install-selfcontained-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  execFileSync(process.execPath, [installer, "install"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const shim = readFileSync(join(agentDir, "extensions/jev-gate.ts"), "utf8");
  assert.match(shim, /from "\.\.\/hooks\/jev-gate\/index\.ts"/);
  // 允许相对路径（../hooks/... 就是相对宿主目录的），只禁**绝对**仓库/worktree 路径。
  assert.doesNotMatch(shim, /\/home\/|\/tmp\/|worktree/);
  // 本体在 extensions/ 之外（否则 pi 会把它也当扩展发现 → 钩子重复触发），且不含仓库绝对路径。
  for (const name of ["index.ts", "command.mjs", "gate.mjs", "state.mjs"]) {
    const body = readFileSync(join(agentDir, "hooks/jev-gate", name), "utf8");
    assert.doesNotMatch(body, /\/home\/dev\//);
  }
});
