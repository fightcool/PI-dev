/* 🍞 AI Breadcrumb — @COUPLED index.ts, state.mjs, ../../tests/jev-hook.test.mjs
 * 📖 docs/JEV-HOOK.md; vendor/pi-web-ui/scripts/jev-gate.ts (CLI contract)
 * @CONTRACT 任一命题 block → 拒绝本次工具调用，返回中文理由、分数、生效阈值供模型修复。
 * 全部 approve/review → 放行；review 必须提示「灰区，未拦」。
 * 门禁失败（包括无法确定 diff）→ 告警放行，绝不能称为通过。
 * JEV_GATE_HOOK=off → 关闭；默认开启。不复制命题或阈值，CLI 从配置/注册表读取。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { detectCommits } from "./command.mjs";
import { redact, runProcess, stagedState } from "./state.mjs";

const SELF_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

/**
 * 门禁 CLI 所在的应用目录（`vendor/pi-web-ui`），找不到返回 null。
 * @GOTCHA 不能用「扩展文件往上两级」算根目录 —— 扩展本体是**复制**进宿主目录的
 *   （`<agentDir>/hooks/jev-gate/gate.mjs`），那个算法会指向 `<agentDir>/vendor/pi-web-ui`（不存在），
 *   于是钩子在每次提交时都退化成「找不到 CLI → 告警放行」：看着装好了，其实一次也不会真拦。
 * 解析顺序：显式 `JEV_GATE_APP` → 从**会话 cwd** 逐级向上找仓库根 →
 *   扩展源码所在的 checkout（开发时有效）→ null（调用方必须明确告警放行，绝不假装通过）。
 */
export function resolveApp(cwd, env = process.env) {
  const hasCli = (dir) =>
    Boolean(dir) && existsSync(join(dir, "scripts", "jev-gate.ts"));
  if (env.JEV_GATE_APP)
    return hasCli(env.JEV_GATE_APP) ? resolve(env.JEV_GATE_APP) : null;
  for (let dir = cwd ? resolve(cwd) : null; dir; dir = dirname(dir)) {
    const candidate = join(dir, "vendor", "pi-web-ui");
    if (hasCli(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  const selfCandidate = resolve(SELF_ROOT, "vendor", "pi-web-ui");
  return hasCli(selfCandidate) ? selfCandidate : null;
}

export async function callCli(state, signal, cwd) {
  const app = resolveApp(cwd);
  if (!app) return { code: null, stdout: "", appMissing: true };
  const loader = require.resolve("tsx", { paths: [app] });
  // No --proposition means ALL registered propositions, dynamically read by the CLI.
  // CLI supplies the effective thresholds in reason; do not reclassify its scores here.
  return runProcess(
    process.execPath,
    [
      "--import",
      pathToFileURL(loader).href,
      resolve(app, "scripts/jev-gate.ts"),
      "check",
      "--state-file",
      "-",
      "--json",
    ],
    {
      cwd: app,
      input: JSON.stringify(state),
      timeout: 35_000,
      maxBuffer: 256 * 1024,
      signal,
    },
  );
}

export function mapDecision(result) {
  const failure = (detail) => ({
    kind: "failure",
    message: `Jev 门禁失败，未完成判定；本次放行：${detail}`,
  });
  if (result.appMissing)
    return failure(
      "本机找不到门禁 CLI（无 vendor/pi-web-ui/scripts/jev-gate.ts）：请设 JEV_GATE_APP 指向 checkout，或在仓库目录内提交",
    );
  if (![0, 1, 2].includes(result.code))
    return failure(
      `CLI 退出码 ${Number.isInteger(result.code) ? result.code : "未知"}（未配凭据或执行失败；原始输出已隐藏）`,
    );
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return failure("CLI 返回非 JSON");
  }
  if (!data || typeof data !== "object" || data.error || data.errorCode)
    return failure("CLI 报告内部或上游错误（原始输出已隐藏）");
  if (data.outcome !== ["approve", "block", "review"][result.code])
    return failure("CLI 退出码与判定不一致");
  const entries =
    data.checks &&
    typeof data.checks === "object" &&
    !Array.isArray(data.checks)
      ? Object.entries(data.checks)
      : [];
  if (
    !entries.length ||
    entries.some(
      ([id, score]) =>
        !/^[a-z][a-z0-9_]{0,100}$/.test(id) ||
        typeof score !== "number" ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1,
    ) ||
    typeof data.reason !== "string" ||
    !data.reason.trim()
  ) {
    return failure("CLI 缺少有效分数或理由");
  }
  const prefix = {
    block: "Jev 已拦截本次提交，请根据判定修复后重新提交",
    review: "Jev 灰区，未拦",
    approve: "Jev 判定通过",
  }[data.outcome];
  return {
    kind: data.outcome,
    message: `${prefix}：${redact(data.reason).slice(0, 4000)}\n分数：${entries.map(([id, score]) => `${id}=${score}`).join("，")}`,
  };
}

/** Dependencies can be replaced by offline fixtures; normal bash never performs IO. */
export function createGate({
  evaluate = callCli,
  getState = stagedState,
  env = process.env,
} = {}) {
  return async (event, ctx, notify) => {
    if (event.toolName !== "bash" || env.JEV_GATE_HOOK === "off") return;
    const commits = detectCommits(event.input.command, ctx.cwd);
    if (!commits.length) return;
    const blocked = [];
    for (const commit of commits) {
      let verdict;
      try {
        if (commit.unsupported) throw new Error(commit.unsupported);
        const state = await getState(commit, ctx.signal);
        if (state.truncated)
          notify("Jev：diff 超长，判定仅覆盖前 24000 字符。", "warning");
        verdict = mapDecision(await evaluate(state, ctx.signal, ctx.cwd));
      } catch {
        // Never echo an arbitrary thrown message: it could contain a credential or diff.
        verdict = {
          kind: "failure",
          message: `Jev 门禁失败，未完成判定；本次放行：${commit.unsupported ?? "无法取得 diff，或 CLI 不可用/超时/取消/输出超限（原始输出已隐藏）"}`,
        };
      }
      if (verdict.kind === "block") blocked.push(verdict.message);
      notify(verdict.message, verdict.kind === "approve" ? "info" : "warning");
    }
    if (blocked.length) return { block: true, reason: blocked.join("\n") };
  };
}
