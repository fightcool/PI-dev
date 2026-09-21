/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-trim/index.ts, ../scripts/install-jev-hook.mjs
 * 📖 ../docs/JEV-HARNESS-PLAN.md §3-P0
 * @WHY 单测（jev-trim.test.mjs）钉纯逻辑；这里钉**装上宿主后**的行为：用 pi 真实的
 *   DefaultResourceLoader + ExtensionRunner 跑 `tool_result`，验证
 *   ① 默认 off 时零介入；② 各种「不该动手」的情况一律原样放行并留下跳过原因；
 *   ③ 判定失败（这里故意让 CLI 找不到）**必须放行**，且统计里能看到失败原因 —— 「看着是绿的其实没判」
 *   是最危险的失败模式。
 * @CONTRACT 全程零网络：`JEV_GATE_APP` 指向不存在的目录 → 判定必然失败 → 走放行路径。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const TRIM_SOURCE = join(
  fileURLToPath(new URL("../extensions/", import.meta.url)),
  "jev-trim",
);

const bigText = (chars = 20_000) =>
  `段一 ${"x".repeat(chars / 2)}\n\n段二 ${"y".repeat(chars / 2)}`;

async function withTrim(t, { env, sourceDir = TRIM_SOURCE, objective = "" }) {
  const cwd = mkdtempSync(join(tmpdir(), "jev-trim-cwd-"));
  // 临时 agentDir：不跑真安装器（那会把 gate 也装上），直接用 additionalExtensionPaths 加载本体。
  const agentDir = mkdtempSync(join(tmpdir(), "jev-trim-ext-"));
  const previous = { ...process.env };
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir }, env);
  t.after(() => {
    for (const key of Object.keys(env)) delete process.env[key];
    for (const [key, value] of Object.entries(previous))
      process.env[key] = value;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [join(sourceDir, "index.ts")],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1, "只应加载这一个扩展");
  const session = SessionManager.inMemory(cwd);
  if (objective) session.appendMessage({ role: "user", content: objective });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    session,
    {},
  );
  const notices = [];
  runner.setUIContext(
    { notify: (message, level) => notices.push({ message, level }) },
    "rpc",
  );
  await runner.emit({ type: "session_start", reason: "startup" });
  const statsPath = join(agentDir, "dev-con", "jev-trim.jsonl");
  const stats = () =>
    existsSync(statsPath)
      ? readFileSync(statsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const emit = (overrides = {}) =>
    runner.emitToolResult({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "ls" },
      content: [{ type: "text", text: bigText() }],
      isError: false,
      ...overrides,
    });
  return { runner, emit, stats, notices, agentDir };
}

test("默认 off：完全不介入，连统计都不写", async (t) => {
  const { emit, stats } = await withTrim(t, { env: {} });
  assert.equal(await emit(), undefined);
  assert.deepEqual(stats(), []);
});

test("dry-run：判定失败时原样放行，并留痕失败原因（不许静默）", async (t) => {
  const { emit, stats, notices } = await withTrim(t, {
    // 指向不存在的目录：resolveApp 必然返回 null → 判定失败 → 必须放行。
    env: { JEV_TRIM: "dry-run", JEV_GATE_APP: "/nonexistent/pi-web-ui" },
    objective: "修缓存测试",
  });
  assert.equal(await emit(), undefined, "失败必须原样放行");
  const rows = stats();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, "dry-run");
  assert.equal(rows[0].ok, false);
  // 「问的是哪份代码」必须留痕：`app-not-found`（没找到 CLI）与 `deploy-outdated`（找到但版本旧）
  // 处置办法完全不同，而两者曾经都表现为「静默不生效」。
  assert.ok("app" in rows[0], "失败记录也必须带 app 字段");
  // 这里钉的是**不变量**：失败必须放行、必须留痕、理由必须非空可定位（不是「静默通过」）。
  assert.equal(typeof rows[0].reason, "string");
  assert.ok(rows[0].reason.length > 0);
  assert.ok(rows[0].chars >= 20_000);
  assert.ok(
    notices.some((n) => n.level === "warning" && /原样放行/.test(n.message)),
    "失败要告警可见",
  );
});

test("不该动手的情况一律跳过并记原因：isError / 太短 / 取不到目标", async (t) => {
  const { emit, stats } = await withTrim(t, { env: { JEV_TRIM: "on" } });
  // ① 错误结果：错误正文往往就是全部信息，一律不裁。
  assert.equal(
    await emit({
      isError: true,
      content: [{ type: "text", text: bigText() }],
    }),
    undefined,
  );
  // ② 小于阈值：不为小输出付一次网络往返。
  assert.equal(
    await emit({ content: [{ type: "text", text: "很短的结果" }] }),
    undefined,
  );
  // ③ 取不到目标（会话里没有 user 消息）→ 无法判断「相关性」，放弃。
  assert.equal(await emit(), undefined);
  assert.deepEqual(
    stats().map((row) => row.skipped),
    ["is-error", "below-min-chars", "no-objective"],
  );
  assert.ok(
    stats().every((row) => row.skipped && row.chars !== undefined),
    "跳过也要留下可复盘的原因",
  );
});

test("超过每会话上限后不再判定（连续大输出不许把每轮都拖成秒级）", async (t) => {
  const { runner, stats } = await withTrim(t, {
    env: {
      JEV_TRIM: "on",
      JEV_TRIM_MAX_PER_SESSION: "1",
      JEV_GATE_APP: "/nonexistent/pi-web-ui",
    },
    objective: "修缓存测试",
  });
  const emit = (id) =>
    runner.emitToolResult({
      type: "tool_result",
      toolCallId: id,
      toolName: "bash",
      input: { command: "ls" },
      content: [{ type: "text", text: bigText() }],
      isError: false,
    });
  await emit("call-1");
  await emit("call-2");
  const rows = stats();
  // 第一条：进了判定（失败放行）；第二条：被会话上限挡住（跳过，连网络都不碰）。
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[1].skipped, "session-cap");
});
