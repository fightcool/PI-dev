/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-trim/{config,stats}.mjs（读写同一份文件）
 * 📖 docs/JEV-TRIM.md —— 开关与统计口径
 * @WHY 为什么要单独的脚本：宿主进程的环境变量改不了（pi-web-ui 服务一启动 env 就定了），所以
 *   「开/关 dry-run」必须靠**文件**；而收益（省了多少字符/token）与代价（墙钟、成本、跳过原因）
 *   必须能一条命令看到 —— 没有这个数，就没资格把 mode 从 dry-run 改成 on。
 * @CONTRACT 只读统计 + 只写 `<agentDir>/dev-con/jev-trim-settings.json`（0600，合并写入，不动其它字段）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadFileConfig,
  readTrimConfig,
  trimSettingsPath,
} from "../extensions/jev-trim/config.mjs";
import { trimStatsPath } from "../extensions/jev-trim/stats.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "show";
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);
const agentDir =
  flag("--agent-dir") ??
  process.env.PI_CODING_AGENT_DIR ??
  join(homedir(), ".pi", "agent");

const percent = (value) => `${(value * 100).toFixed(1)}%`;

function readStats() {
  const path = trimStatsPath(agentDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function summarize(rows) {
  const judged = rows.filter((row) => row.ok === true);
  const failed = rows.filter((row) => row.ok === false);
  const changed = judged.filter((row) => row.changed === true);
  const skipped = new Map();
  for (const row of rows) {
    if (!row.skipped) continue;
    skipped.set(row.skipped, (skipped.get(row.skipped) ?? 0) + 1);
  }
  const reasons = new Map();
  for (const row of failed)
    reasons.set(
      row.reason ?? "unknown",
      (reasons.get(row.reason ?? "unknown") ?? 0) + 1,
    );
  const charsBefore = changed.reduce(
    (sum, row) => sum + (row.charsBefore ?? row.chars ?? 0),
    0,
  );
  const charsAfter = changed.reduce(
    (sum, row) => sum + (row.charsAfter ?? 0),
    0,
  );
  const walls = judged.map((row) => row.wallMs ?? 0).sort((a, b) => a - b);
  const api = judged.map((row) => row.apiMs ?? 0);
  const cost = judged.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const cache = judged.reduce((acc, row) => {
    acc[row.cache ?? "unknown"] = (acc[row.cache ?? "unknown"] ?? 0) + 1;
    return acc;
  }, {});
  return {
    rows: rows.length,
    judged: judged.length,
    failed: failed.length,
    changed: changed.length,
    unchanged: judged.length - changed.length,
    skipped: Object.fromEntries(skipped),
    failures: Object.fromEntries(reasons),
    charsBefore,
    charsAfter,
    savedChars: charsBefore - charsAfter,
    savedRatio: charsBefore > 0 ? 1 - charsAfter / charsBefore : 0,
    wallP50: walls.length ? walls[Math.floor(walls.length / 2)] : 0,
    wallMax: walls.length ? walls[walls.length - 1] : 0,
    apiMax: api.length ? Math.max(...api) : 0,
    cost,
    cache,
  };
}

function printStats() {
  const rows = readStats();
  if (rows.length === 0) {
    console.log(
      `没有统计（${trimStatsPath(agentDir)}）。先设 JEV_TRIM=dry-run 并开新会话跑几轮。`,
    );
    return 0;
  }
  const s = summarize(rows);
  if (has("--json")) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }
  console.log(`统计：${trimStatsPath(agentDir)}（${s.rows} 条）`);
  console.log(
    `判定 ${s.judged} 次（成功 ${s.judged - s.failed} / 失败 ${s.failed}），其中会改动 ${s.changed} 次、判完不改 ${s.unchanged} 次`,
  );
  console.log(
    `字符：${s.charsBefore} → ${s.charsAfter}（省 ${s.savedChars}，${percent(s.savedRatio)}，≈ ${Math.round(s.savedChars / 4)} token）`,
  );
  console.log(
    `耗时：墙钟 p50 ${s.wallP50}ms / max ${s.wallMax}ms（其中模型 API max ${s.apiMax}ms —— 差值就是 CLI 冷启动开销）`,
  );
  console.log(`成本：$${s.cost.toFixed(6)}；缓存 ${JSON.stringify(s.cache)}`);
  const skips = Object.entries(s.skipped);
  if (skips.length)
    console.log(`跳过：${skips.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const fails = Object.entries(s.failures);
  if (fails.length)
    console.log(`失败原因：${fails.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return 0;
}

function printShow() {
  const file = loadFileConfig(agentDir);
  const cfg = readTrimConfig(process.env, file);
  console.log(
    `配置来源：环境变量 ${process.env.JEV_TRIM ? `JEV_TRIM=${process.env.JEV_TRIM}` : "（未设）"} > ${trimSettingsPath(agentDir)} > 默认`,
  );
  console.log(`有效配置：${JSON.stringify(cfg, null, 2)}`);
  console.log(
    cfg.mode === "off"
      ? "当前关闭（off）。量收益：node scripts/jev-trim.mjs mode dry-run"
      : cfg.mode === "dry-run"
        ? "当前 dry-run：只统计不改写。看收益：node scripts/jev-trim.mjs stats；真要裁：… mode on"
        : "当前 on：会真的改写工具结果（每次改写都留可见标记）。",
  );
  return 0;
}

function setMode(mode) {
  if (!["off", "dry-run", "on"].includes(mode))
    throw new Error("mode 只能是 off / dry-run / on");
  const path = trimSettingsPath(agentDir);
  const dir = join(agentDir, "dev-con");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    current = {};
  }
  writeFileSync(
    path,
    `${JSON.stringify({ ...current, mode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  const size = statSync(path).size;
  console.log(
    `已写入 ${path}（mode=${mode}，${size} 字节，权限 0600）。新会话即生效；现有会话 /reload。`,
  );
  return 0;
}

try {
  if (command === "stats") process.exit(printStats());
  else if (command === "show") process.exit(printShow());
  else if (command === "mode") process.exit(setMode(args[1] ?? ""));
  else {
    console.log(
      "用法：node scripts/jev-trim.mjs stats|show|mode <off|dry-run|on> [--agent-dir <dir>] [--json]",
    );
    process.exit(2);
  }
} catch (err) {
  console.error(`FAIL: ${err?.message ?? err}`);
  process.exit(3);
}
