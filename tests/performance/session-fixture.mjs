/**
 * Synthetic pi session fixtures for server-side performance probes.
 *
 * The real slow path (attach → first snapshot, switch_session) scales with the
 * number of persisted messages, so a reproducible fixture must be able to
 * generate any history size without touching a real agent directory.
 *
 * Format mirrors the SDK writer (core/session-manager.js appendMessage):
 *   {"type":"session","version":N,"id":…,"timestamp":…,"cwd":…}
 *   {"type":"message","id":…,"parentId":…,"timestamp":…,"message":{…}}
 *
 * 🍞 @COUPLED tests/performance/server-timing.mjs
 * @WHY 只读探针必须能在隔离 agent 目录里造出「1460 条消息 / ~4MB」的会话，
 *      否则无法复现切换卡顿，也不能在不动线上数据的前提下做前后对比。
 * @CONTRACT 只写传入的 agentDir；不读、不写任何真实 agent 目录。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** SDK-compatible per-cwd session dir name: `--<cwd with /,: replaced by ->--`. */
export function sessionDirFor(agentDir, cwd) {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

const CODE_FENCE = [
  "```ts",
  "export function handler(req: Request): Response {",
  "\tconst started = Date.now();",
  "\tconst body = normalize(req.body);",
  "\treturn respond(body, Date.now() - started);",
  "}",
  "```",
].join("\n");

/** One synthetic assistant reply: prose + a fenced code block (worst case for markdown). */
function assistantText(index) {
  return [
    `## 步骤 ${index}`,
    "",
    `这是第 ${index} 段说明文字，用来把会话撑到接近真实的体积：包含列表、行内 \`code\` 与代码块。`,
    "",
    "- 检查输入",
    "- 执行变更",
    "- 记录结果",
    "",
    CODE_FENCE,
  ].join("\n");
}

/**
 * Write one session JSONL with `messages` message entries (alternating
 * user/assistant) and return its absolute path.
 */
export function writeSyntheticSession({ agentDir, cwd, messages, id = "perf-fixture" }) {
  const dir = sessionDirFor(agentDir, cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      version: 2,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    }),
  ];
  let parentId = null;
  for (let i = 0; i < messages; i++) {
    const isUser = i % 2 === 0;
    const entryId = `m${String(i).padStart(7, "0")}`;
    const message = isUser
      ? {
          role: "user",
          content: [{ type: "text", text: `第 ${i / 2 + 1} 轮提问：请检查配置并给出修复步骤。` }],
          timestamp: 1_767_000_000_000 + i * 1000,
        }
      : {
          role: "assistant",
          content: [{ type: "text", text: assistantText(i) }],
          model: "fixture-model",
          stopReason: "endTurn",
          timestamp: 1_767_000_000_500 + i * 1000,
        };
    lines.push(
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId,
        timestamp: new Date(1_767_000_000_000 + i * 1000).toISOString(),
        message,
      }),
    );
    parentId = entryId;
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}
