#!/usr/bin/env node
/* 🍞 AI Breadcrumb Navigation
 * @COUPLED .github/workflows/jev-gate.yml（唯一调用方：PR 上的 `jev-gate` job）,
 *   config/jev-settings.ci.json（被冻结的门禁配置：模型/端点/逐判定项阈值，**不含密钥**）,
 *   vendor/pi-web-ui/scripts/jev-gate.ts（被驱动的 CLI：`check --state-file <path|->`）,
 *   docs/JEV-DECISION-GATE.md §2.2（给人看的说明：口径、跳过语义、为什么不做成必过）
 * @WHY 为什么要有这个东西：门禁**不会自己跑**（没有 hook、没有定时器）。2026-09-20 实测：
 *   跑了几小时、真实调用 0 次 —— 唯一那次还是我手工触发的。AGENTS.md 写了「提交前要跑」，
 *   但那是纪律不是机制；这个 job 是**机制**：每个 PR 都用它自己的 diff 真的问一遍。
 * @CONTRACT 退出码（与 CLI 的 check 对齐，别自创第二套）：
 *   0 = 没有 block（approve 或 review）；1 = 任一判定项 block（**只有 block 才让 job 变红**，用户定的门槛）；
 *   3 = 门禁没跑成（缺密钥 / 上游错误 / CLI 崩 / JSON 解析失败）—— **出错绝不能是绿色**，
 *   否则「门禁坏了」会伪装成「门禁通过了」，那正是这次要根治的病。
 * @GOTCHA 密钥只以**名字**存在于仓库（config/jev-settings.ci.json 的 credentialRef）；
 *   正文从环境变量 JEV_OPENROUTER_KEY 读进内存后只写进**临时** agentDir（0600），
 *   job 结束即删；任何输出都不得包含密钥（CLI 自己也会抹，见 sanitizeUpstreamDetail）。
 * @MAGIC JEV_MAX_DIFF_CHARS=60000（上游 state+问题限 32k tokens；diff 再长就该人看了）,
 *   JEV_CHILD_TIMEOUT_MS=120000（CLI 自带 30s 看门狗，这里再兜一层）。
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SKIP_TEXT,
  describeChecks,
  skipReason,
  verdictOf,
} from "./jev-gate-verdict.mjs";
import { readPublicSurface } from "./jev-public-surface.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const CONFIG_PATH = join(ROOT, "config", "jev-settings.ci.json");
const KEY_NAME = "ci";
const MAX_DIFF_CHARS = Number(process.env.JEV_MAX_DIFF_CHARS ?? 60_000);
const CHILD_TIMEOUT_MS = Number(process.env.JEV_CHILD_TIMEOUT_MS ?? 120_000);

/** CI 上给人看的输出走 stdout；`::error::`/`::warning::`/`::notice::` 是 GitHub 注解（本地跑也无害）。 */
const log = (msg) => process.stdout.write(`${msg}\n`);
const annotate = (kind, msg) =>
  process.stdout.write(`::${kind}::${msg.replace(/\n/g, " ")}\n`);

/**
 * 出错一律**抛**，由最外层统一收口 —— 不在这里 `process.exit`。
 * @GOTCHA `process.exit()` **不会执行 finally**（Node 直接终止）。临时 agentDir 里有密钥副本，
 *   所以「出错就 exit」等于每次失败都往 /tmp 里留一份密钥 —— 2026-09-20 实测踩到，
 *   现在改成抛异常 → finally 清理 → 最外层再 exit。
 */
class GateError extends Error {}

function fail(message) {
  annotate("error", message);
  throw new GateError(message);
}

/** 取一个 git 命令的 stdout（cwd = 仓库根；maxBuffer 给大，因为 diff 可能很大）。 */
function git(args, { allowFail = false } = {}) {
  const run = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0 && !allowFail) {
    fail(
      `git ${args[0]} 失败：${(run.stderr || run.error?.message || "").trim().slice(0, 400)}`,
    );
  }
  return (run.stdout ?? "").trim();
}

/** 被审内容（state）：objective 给人/模型一点意图，diff 是真正要判的东西。 */
function buildState(baseSha) {
  const title = process.env.JEV_OBJECTIVE?.trim();
  const objective =
    title && title.length > 0 ? title.slice(0, 800) : defaultObjective(baseSha);
  const raw = git(["diff", "--no-color", "--unified=3", `${baseSha}...HEAD`], {
    allowFail: true,
  });
  const truncated = raw.length > MAX_DIFF_CHARS;
  const diff = truncated
    ? `${raw.slice(0, MAX_DIFF_CHARS)}\n\n[……diff 过长，已按 ${MAX_DIFF_CHARS} 字符截断（完整长度 ${raw.length}）……]`
    : raw;
  return {
    objective,
    diff,
    truncated,
    diffChars: raw.length,
    publicSurface: readPublicSurface(ROOT, baseSha),
  };
}

function defaultObjective(baseSha) {
  const subjects = git(
    ["log", "--no-merges", "--format=%s", `${baseSha}..HEAD`],
    { allowFail: true },
  );
  return subjects.length > 0
    ? subjects.slice(0, 800)
    : "（无法从提交信息推断目标：请按 diff 本身判断）";
}

/** 临时 agentDir：配置从仓库里的冻结配置抄一份，密钥从环境变量写一份（0600），只用一次。 */
function makeAgentDir(apiKey) {
  const dir = mkdtempSync(join(tmpdir(), "jev-ci-"));
  mkdirSync(join(dir, "dev-con"), { recursive: true });
  writeFileSync(
    join(dir, "dev-con", "jev-settings.json"),
    readFileSync(CONFIG_PATH, "utf8"),
    { mode: 0o600 },
  );
  const keyFile = join(dir, "provider-keys.json");
  writeFileSync(
    keyFile,
    JSON.stringify({
      openrouter: {
        activeKeyName: KEY_NAME,
        keys: [{ name: KEY_NAME, apiKey }],
      },
    }),
    {
      mode: 0o600,
    },
  );
  chmodSync(keyFile, 0o600);
  return dir;
}

/** 跑一次门禁（全部判定项：CLI 不给 --proposition 时默认问全部）。 */
function runGate(agentDir, statePath) {
  const run = spawnSync(
    "npm",
    [
      "run",
      "jev",
      "--",
      "check",
      "--state-file",
      statePath,
      "--json",
      "--agent-dir",
      agentDir,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    },
  );
  if (run.error) fail(`门禁 CLI 无法启动：${run.error.message}`);
  if (run.status === null)
    fail(`门禁 CLI 超时（>${CHILD_TIMEOUT_MS}ms）或被杀：这不是通过`);
  const stdout = run.stdout ?? "";
  let decision = null;
  try {
    decision = JSON.parse(stdout.slice(stdout.indexOf("{")));
  } catch {
    decision = null;
  }
  return { status: run.status, decision, stderr: (run.stderr ?? "").trim() };
}

function run() {
  // @CONTRACT 只返回退出码、绝不自己 exit：临时目录的清理必须在 finally 里跑完（见 fail 的 @GOTCHA）。
  const baseArg = (process.argv[2] ?? process.env.JEV_BASE_SHA ?? "").trim();
  if (baseArg.length === 0) {
    fail(
      "用法：node scripts/ci/jev-gate-pr.mjs <base-sha|ref>（CI 传 PR 的 base sha；本地可传 origin/<默认分支>）",
    );
  }
  // 允许传 ref（本地方便），但**立刻归一到 commit sha**：后面用三点 diff（merge-base），
  // 传一个会移动的 ref 会让两次运行审不同范围。
  const baseSha = git(["rev-parse", "--verify", `${baseArg}^{commit}`], {
    allowFail: true,
  });
  if (!/^[0-9a-f]{40}$/.test(baseSha))
    fail(`无法解析 base：${baseArg}（不是本仓库里已知的提交或 ref）`);
  if (!existsSync(CONFIG_PATH)) fail(`缺少冻结配置：${CONFIG_PATH}`);

  const apiKey = (process.env.JEV_OPENROUTER_KEY ?? "").trim();
  if (apiKey.length === 0) {
    // 没有凭据 = 门禁**没跑**。绝不假装通过：清楚地写「跳过」，并且不把它说成绿。
    log(SKIP_TEXT["no-credential"]);
    log(
      "  要让它真的跑：仓库 Settings → Secrets and variables → Actions 里加 JEV_OPENROUTER_KEY。",
    );
    annotate(
      "warning",
      "Jev 门禁被跳过：未配置 JEV_OPENROUTER_KEY（跳过 ≠ 通过）",
    );
    return 0;
  }

  const state = buildState(baseSha);
  const postSkip = skipReason({
    hasCredential: true,
    diffChars: state.diff.trim().length,
  });
  if (postSkip === "empty-diff") {
    log(SKIP_TEXT["empty-diff"]);
    annotate("notice", "Jev 门禁：空 diff，无需判定");
    return 0;
  }
  log(
    `Jev 门禁：base=${baseSha.slice(0, 12)} diff=${state.diffChars} 字符${state.truncated ? "（已截断）" : ""}`,
  );

  const agentDir = makeAgentDir(apiKey);
  try {
    const statePath = join(agentDir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        objective: state.objective,
        // 判据要按本仓口径判断「什么是公共接口」；没有声明时这个字段缺失，判定照旧。
        publicSurface: state.publicSurface || undefined,
        diff: state.diff,
      }),
      { mode: 0o600 },
    );
    const { status, decision, stderr } = runGate(agentDir, statePath);
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const verdict = verdictOf({ decision, status });

    if (verdict.kind === "error") {
      log("门禁没有给出有效判定 —— 这不是通过。");
      log(`原因：${verdict.error}`);
      if (decision?.error) log(`上游/配置问题：${decision.error}`);
      else if (stderr) log(`CLI 输出：${stderr.slice(0, 600)}`);
      fail(
        "Jev 门禁未能判定（缺密钥 / 上游错误 / CLI 失败）；重跑该 job，别把它当成通过",
      );
    }

    const outcome = decision.outcome;
    log(`结论：${outcome}（score 表）`);
    for (const line of describeChecks(decision, config)) log(line);
    log(`理由：${decision.reason || decision.reasonEn || "（无）"}`);
    if (decision.audit) {
      log(
        `审计：model=${decision.audit.model} cache=${decision.audit.cache} requestId=${decision.audit.requestId ?? "-"}`,
      );
    }

    const summary = [
      `## Jev 门禁：${outcome}`,
      "",
      `- base: \`${baseSha.slice(0, 12)}\`，diff ${state.diffChars} 字符${state.truncated ? "（**已截断**）" : ""}`,
      ...describeChecks(decision, config),
      `- 理由：${decision.reason || decision.reasonEn || "（无）"}`,
      "",
      "> 门槛：**只有 block 才让它变红**；review（灰区）只提醒。门禁抖动约 ±0.06，别当精确判决。",
    ].join("\n");
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    }

    if (verdict.kind === "block") {
      annotate(
        "error",
        `Jev 门禁阻断：${decision.reason || decision.reasonEn || "见 job 输出"}`,
      );
      return 1;
    }
    if (verdict.kind === "review")
      annotate(
        "warning",
        `Jev 门禁转人工（未拦截）：${decision.reason || decision.reasonEn || ""}`,
      );
    return 0;
  } finally {
    // 临时 agentDir 里有密钥副本：无论成败都删掉；删不掉必须说出来（不能静默留一份密钥）。
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(
        `::warning::临时 agentDir 清理失败：${agentDir}（${err instanceof Error ? err.message : String(err)}）\n`,
      );
    }
  }
}

try {
  process.exit(run());
} catch (err) {
  if (!(err instanceof GateError)) {
    process.stdout.write(
      `::error::Jev 门禁脚本异常：${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  process.exit(3);
}
