/* 🍞 AI Breadcrumb — @COUPLED ../../extensions/jev-gate/index.ts
 * 📖 docs/JEV-HOOK.md
 * Opt-in live Jev acceptance: synthetic agent responses, REAL SDK tool_call and Git execution.
 * Agent/model credentials are isolated; only the existing Jev CLI resolves its own named key.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

if (process.argv[2] !== "--live") throw new Error("Explicit --live required (calls configured Jev service)");
const timer = setTimeout(() => { console.error("FAIL: live hook acceptance timeout"); process.exit(1); }, 90_000);
const cwd = mkdtempSync(join(tmpdir(), "jev-hook-live-"));
let session;
const notices = [];
const originalWarn = console.warn;
console.warn = (message) => { notices.push(String(message)); originalWarn(message); };
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
const write = (name, text) => writeFileSync(join(cwd, name), text);
try {
  git("init", "-q"); git("config", "user.name", "Jev hook acceptance"); git("config", "user.email", "jev@example.invalid");
  const original = 'export function greet(name: string): string { return "Hello " + name; }\n';
  write("api.ts", original); git("add", "api.ts"); git("commit", "-qm", "Maintain greet public API compatibility");
  const initial = git("rev-parse", "HEAD");
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: join(cwd, "isolated-agent"), settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/jev-gate/index.ts", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: join(cwd, "models-unused.json"),
    modelsStorePath: join(cwd, "store-unused.json"), allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "e2e-placeholder-not-a-real-key");
  ({ session } = await createAgentSession({ cwd, agentDir: join(cwd, "isolated-agent"), resourceLoader,
    settingsManager, sessionManager: SessionManager.inMemory(cwd), modelRuntime,
    model: modelRuntime.getModel("anthropic", "claude-sonnet-4-20250514"), tools: ["bash"],
  }));
  await session.bindExtensions({});
  const results = [];
  session.subscribe((event) => { if (event.type === "tool_execution_end") results.push(event); });
  async function attempt(label) {
    let first = true;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-20250514",
        content: first ? [{ type: "toolCall", id: label, name: "bash", arguments: { command: `git commit -m '${label}'` } }] : [{ type: "text", text: "Done" }],
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      first = false;
      stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message);
      return stream;
    };
    await session.prompt(`Execute the prepared commit attempt ${label}.`);
    const result = results.find((r) => r.toolCallId === label);
    assert.ok(result, "SDK must actually attempt the bash tool");
    console.log(`${label}: isError=${result.isError}`);
    for (const part of result.result.content) if (part.type === "text") console.log(part.text);
    return result;
  }
  console.log("[1/2] Breaking public export removal → expect block");
  write("api.ts", "// Public greet API removed without any replacement.\nexport const version = 2;\n"); git("add", "api.ts");
  const bad = await attempt("breaking-api");
  assert.equal(bad.isError, true);
  assert.equal(git("rev-parse", "HEAD"), initial, "blocked commit must not change HEAD");
  assert.match(JSON.stringify(bad.result.content), /Jev 已拦截/);
  console.log("PASS: block left HEAD unchanged");
  console.log("[2/2] Compatible comment with concrete behavior test → expect allow");
  write("api.ts", "// Greet the caller by name.\n" + original);
  write("api.test.ts", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./api.ts";\ntest("greet returns the name in the greeting", () => { assert.equal(greet("Ada"), "Hello Ada"); });\n');
  git("add", "api.ts", "api.test.ts");
  const noticeStart = notices.length;
  const good = await attempt("compatible-comment-and-test");
  assert.ok(notices.slice(noticeStart).some((m) => /Jev (灰区，未拦|判定通过)/.test(m)), "allow must be a real decision, not failure-open");
  assert.equal(good.isError, false);
  assert.notEqual(git("rev-parse", "HEAD"), initial, "allowed commit must advance HEAD");
  console.log("PASS: allowed commit advanced HEAD");
} finally {
  console.warn = originalWarn;
  session?.dispose();
  clearTimeout(timer);
  rmSync(cwd, { recursive: true, force: true });
}
