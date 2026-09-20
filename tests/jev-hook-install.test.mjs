/* 🍞 AI Breadcrumb — @COUPLED ../scripts/install-jev-hook.mjs, ../extensions/jev-gate/index.ts
 * 📖 docs/JEV-HOOK.md — global discovery and UI transport without Jev/network calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DefaultResourceLoader, SettingsManager, ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";

const installer = fileURLToPath(new URL("../scripts/install-jev-hook.mjs", import.meta.url));
test("global entry auto-discovers, notifies via UI and uninstalls without touching settings", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-install-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  const install = (action) => execFileSync(process.execPath, [installer, action], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  install("install"); install("install");
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory(), noSkills: true, noThemes: true, noPromptTemplates: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].handlers.has("tool_call"));
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), {});
  const notices = [];
  runner.setUIContext({ notify: (message, level) => notices.push({ message, level }) }, "rpc");
  await runner.emit({ type: "session_start", reason: "startup" });
  assert.match(notices[0].message, /Jev 提交钩子已/);
  assert.equal(await runner.emitToolCall({ type: "tool_call", toolCallId: "no-io", toolName: "bash", input: { command: 'echo "git commit"' } }), undefined);
  assert.equal(existsSync(join(agentDir, "settings.json")), false);
  install("uninstall");
  assert.equal(existsSync(join(agentDir, "extensions/jev-gate.ts")), false);
  writeFileSync(join(agentDir, "extensions/jev-gate.ts"), "// someone else's extension\n");
  assert.throws(() => install("install"));
  assert.throws(() => install("uninstall"));
});
