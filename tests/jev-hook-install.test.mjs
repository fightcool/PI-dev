/* 🍞 AI Breadcrumb — @COUPLED ../scripts/install-jev-hook.mjs, ../extensions/jev-gate/index.ts
 * 📖 docs/JEV-HOOK.md — global discovery and UI transport without Jev/network calls.
 * 安装是**内容寻址**的：入口 `extensions/jev-gate-<hash>.ts` + 本体 `hooks/jev-gate-<hash>/`。
 * 名字里的哈希不是装饰：宿主进程按扩展**路径**缓存已加载的 factory，同名覆盖会让新会话继续跑旧代码。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const HASHED_SHIM = /^jev-gate-[0-9a-f]{8}\.ts$/;
const HASHED_BODY = /^jev-gate-[0-9a-f]{8}$/;

function onlyEntry(dir, pattern) {
  const found = readdir(dir).filter((name) => pattern.test(name));
  assert.equal(
    found.length,
    1,
    `${dir} 里应恰好一个匹配 ${pattern}：${found.join("、")}`,
  );
  return found[0];
}
const readdir = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

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
  const shimName = onlyEntry(join(agentDir, "extensions"), HASHED_SHIM);
  const bodyName = onlyEntry(join(agentDir, "hooks"), HASHED_BODY);
  // shim 与本体必须是**同一份内容哈希**（否则入口会指向不存在的本体）。
  assert.equal(shimName, `${bodyName}.ts`);
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
  // 本体在 extensions/ 之外，所以这里只会发现入口这一个扩展（放进去会被加载两次）。
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
    readFileSync(join(agentDir, "hooks", bodyName, "app.json"), "utf8"),
  );
  assert.match(recorded.app, /vendor\/pi-web-ui$/);
  install("uninstall");
  assert.equal(readdir(join(agentDir, "extensions")).length, 0);
  assert.equal(readdir(join(agentDir, "hooks")).length, 0);
  // 别人的同名扩展仍然拒碰（装、卸都拒）。
  writeFileSync(
    join(agentDir, "extensions/jev-gate.ts"),
    "// someone else's extension\n",
  );
  assert.throws(() => install("install"));
  assert.throws(() => install("uninstall"));
});

test("upgrades the first-generation (absolute-path, fixed-name) install instead of refusing it", (t) => {
  // @BUGFIX 2026-09-20：第一版入口是 `export … from "/home/dev/jev-hook/extensions/…"`（绝对路径，
  // 指向临时 worktree），名字还是固定的 `jev-gate.ts`。升级时必须认得它「是自己人写的」并清掉，
  // 否则现场要么被拒、要么同时存在两个入口（钩子加载两次）。
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
  assert.match(out, /已清理 1 个旧版本/);
  assert.equal(existsSync(join(agentDir, "extensions/jev-gate.ts")), false);
  const shimName = onlyEntry(join(agentDir, "extensions"), HASHED_SHIM);
  assert.match(
    readFileSync(join(agentDir, "extensions", shimName), "utf8"),
    /hooks\/jev-gate-[0-9a-f]{8}\/index\.ts/,
  );
});

test("reinstall from changed sources yields a new entry name and drops the stale one", (t) => {
  // @BUGFIX 2026-09-20：宿主按扩展**路径**缓存 factory。实测：重装同名入口后，新会话仍在跑旧代码
  // （在一个 cwd=/tmp 的新会话里提交，钩子依旧找不到 CLI 而静默放行）。内容寻址让路径随代码变。
  const cwd = mkdtempSync(join(tmpdir(), "jev-install-reseed-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  const extensionsDir = join(agentDir, "extensions");
  const hooksDir = join(agentDir, "hooks");
  mkdirSync(join(hooksDir, "jev-gate-deadbeef"), { recursive: true });
  writeFileSync(join(hooksDir, "jev-gate-deadbeef/.managed-by"), "ours\n");
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(
    join(extensionsDir, "jev-gate-deadbeef.ts"),
    '// Managed by PI-dev scripts/install-jev-hook.mjs\nexport { default } from "../hooks/jev-gate-deadbeef/index.ts";\n',
  );
  execFileSync(process.execPath, [installer, "install"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(existsSync(join(extensionsDir, "jev-gate-deadbeef.ts")), false);
  assert.equal(existsSync(join(hooksDir, "jev-gate-deadbeef")), false);
  assert.equal(
    readdir(extensionsDir).filter((n) => HASHED_SHIM.test(n)).length,
    1,
  );
  // 没带标记的同名目录是别人的，拒绝动它。
  mkdirSync(join(hooksDir, "jev-gate-cafebabe"), { recursive: true });
  assert.throws(() =>
    execFileSync(process.execPath, [installer, "install"], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }),
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
  const shimName = onlyEntry(join(agentDir, "extensions"), HASHED_SHIM);
  const bodyName = onlyEntry(join(agentDir, "hooks"), HASHED_BODY);
  const shim = readFileSync(join(agentDir, "extensions", shimName), "utf8");
  assert.match(shim, /from "\.\.\/hooks\/jev-gate-[0-9a-f]{8}\/index\.ts"/);
  // 允许相对路径（../hooks/... 就是相对宿主目录的），只禁**绝对**仓库/worktree 路径。
  assert.doesNotMatch(shim, /\/home\/|\/tmp\/|worktree/);
  // 本体在 extensions/ 之外（否则 pi 会把它也当扩展发现 → 钩子重复触发），且不含仓库绝对路径。
  for (const name of ["index.ts", "command.mjs", "gate.mjs", "state.mjs"]) {
    const body = readFileSync(join(agentDir, "hooks", bodyName, name), "utf8");
    assert.doesNotMatch(body, /\/home\/dev\//);
  }
});
