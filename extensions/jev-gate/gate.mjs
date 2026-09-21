/* 🍞 AI Breadcrumb — @COUPLED index.ts, state.mjs, ../../tests/jev-hook.test.mjs
 * 📖 docs/JEV-HOOK.md; vendor/pi-web-ui/scripts/jev-gate.ts (CLI contract)
 * @CONTRACT 任一命题 block → 拒绝本次工具调用，返回中文理由、分数、生效阈值供模型修复。
 * 全部 approve/review → 放行；review 必须提示「灰区，未拦」。
 * 门禁失败（包括无法确定 diff）→ 告警放行，绝不能称为通过。
 * JEV_GATE_HOOK=off → 关闭；默认开启。不复制命题或阈值，CLI 从配置/注册表读取。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { detectCommits } from "./command.mjs";
import { redact, runProcess, stagedState } from "./state.mjs";

const require = createRequire(import.meta.url);

/**
 * 门禁 CLI 所在的应用目录（`vendor/pi-web-ui`），找不到返回 null。
 * @WHY **只认正在跑我们的那个文件的所在树**：部署语义下就是 `deploy/current` 指向的 release
 *   （`current` 是符号链接，`path.resolve` 不解符号链接 → 解析结果保留字面量，换发布自动跟随）。
 * @WHY 为什么不再列候选（旧写法：env → 会话 cwd → 安装记录 app.json → 扩展源码 checkout，逐个尝试）：
 *   旧版本不该被咨询 —— 旧 release 会被 `switch-production-release.mjs` 回收，会话 cwd 里的
 *   checkout 又可能是别人正在改的工作副本。判据口径是「遇到运行中的版本不支持 → 部署新版本」，
 *   不是去别处碰运气。
 * @GOTCHA **`process.argv[1]` 在 pm2 下不是应用入口**：pm2 用自己的 process container 重新 fork，
 *   argv[1] = `…/pm2/lib/ProcessContainerFork.js`。pm2 暴露的真实入口在 `pm_exec_path`，优先用它。
 * @GOTCHA **绝不用会话 cwd 兜底**：实测它把「宿主入口解析失败」掩盖成「版本错位」
 *   （日志里 app=<workspace> 而不是 release），真问题晚了两周才被发现。
 *   cwd 只能进诊断输出。
 * @GOTCHA 不能用「扩展文件往上两级」算根目录：本体是**复制**进宿主目录的
 *   （`<agentDir>/hooks/<name>-<hash>/gate.mjs`），那个算法会指向 `<agentDir>/vendor/pi-web-ui`（不存在），
 *   于是钩子每次提交都退化成「找不到 CLI → 告警放行」：看着装好了，其实一次也不会真拦。
 * 解析顺序：显式 `JEV_GATE_APP` → `pm_exec_path` → `process.argv[1]` → null（调用方必须明确告警放行）。
 */
export function resolveApp(
  cwd,
  env = process.env,
  hostEntry = process.argv[1],
) {
  const hasCli = (dir) =>
    Boolean(dir) && existsSync(join(dir, "scripts", "jev-gate.ts"));
  if (env.JEV_GATE_APP)
    return hasCli(env.JEV_GATE_APP) ? resolve(env.JEV_GATE_APP) : null;
  for (const entry of [env.pm_exec_path, hostEntry]) {
    if (!entry || typeof entry !== "string") continue;
    let dir = dirname(resolve(entry));
    for (let level = 0; level <= 6; level += 1) {
      const candidate = join(dir, "vendor", "pi-web-ui");
      if (hasCli(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export async function callCli(state, signal, cwd) {
  const app = resolveApp(cwd, process.env, process.argv[1]);
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
      `找不到门禁 CLI（无 vendor/pi-web-ui/scripts/jev-gate.ts）：pm_exec_path=${process.env.pm_exec_path ?? "-"}，argv[1]=${process.argv[1] ?? "-"}；请设 JEV_GATE_APP 指定（本提示只说事实，不猜别的副本）`,
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
      // 「没判定成」必须留痕到宿主日志：UI 通知在子代理会话里等于没人看见，
      // 而失败放行最怕的就是「看着是绿的，其实一次也没判」（消息本身是固定文案，无 diff/密钥）。
      if (verdict.kind === "failure")
        console.error(`[jev-gate] ${verdict.message}`);
    }
    if (blocked.length) return { block: true, reason: blocked.join("\n") };
  };
}
