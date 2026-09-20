/* 🍞 AI Breadcrumb — @COUPLED index.ts, state.mjs, ../../tests/jev-hook.test.mjs
 * 📖 docs/JEV-HOOK.md; vendor/pi-web-ui/scripts/jev-gate.ts (CLI contract)
 * @CONTRACT 任一命题 block → 拒绝本次工具调用，返回中文理由、分数、生效阈值供模型修复。
 * 全部 approve/review → 放行；review 必须提示「灰区，未拦」。
 * 门禁失败（包括无法确定 diff）→ 告警放行，绝不能称为通过。
 * JEV_GATE_HOOK=off → 关闭；默认开启。不复制命题或阈值，CLI 从配置/注册表读取。
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { detectCommits } from "./command.mjs";
import { redact, runProcess, stagedState } from "./state.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const app = resolve(root, "vendor/pi-web-ui");
const require = createRequire(import.meta.url);

export async function callCli(state, signal) {
  const loader = require.resolve("tsx", { paths: [app] });
  // No --proposition means ALL registered propositions, dynamically read by the CLI.
  // CLI supplies the effective thresholds in reason; do not reclassify its scores here.
  return runProcess(process.execPath, ["--import", pathToFileURL(loader).href,
    resolve(app, "scripts/jev-gate.ts"), "check", "--state-file", "-", "--json"], {
    cwd: app, input: JSON.stringify(state), timeout: 35_000, maxBuffer: 256 * 1024, signal,
  });
}

export function mapDecision(result) {
  const failure = (detail) => ({ kind: "failure", message: `Jev 门禁失败，未完成判定；本次放行：${detail}` });
  if (![0, 1, 2].includes(result.code)) return failure(`CLI 退出码 ${Number.isInteger(result.code) ? result.code : "未知"}（未配凭据或执行失败；原始输出已隐藏）`);
  let data;
  try { data = JSON.parse(result.stdout); } catch { return failure("CLI 返回非 JSON"); }
  if (!data || typeof data !== "object" || data.error || data.errorCode) return failure("CLI 报告内部或上游错误（原始输出已隐藏）");
  if (data.outcome !== ["approve", "block", "review"][result.code]) return failure("CLI 退出码与判定不一致");
  const entries = data.checks && typeof data.checks === "object" && !Array.isArray(data.checks) ? Object.entries(data.checks) : [];
  if (!entries.length || entries.some(([id, score]) => !/^[a-z][a-z0-9_]{0,100}$/.test(id) || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) || typeof data.reason !== "string" || !data.reason.trim()) {
    return failure("CLI 缺少有效分数或理由");
  }
  const prefix = { block: "Jev 已拦截本次提交，请根据判定修复后重新提交", review: "Jev 灰区，未拦", approve: "Jev 判定通过" }[data.outcome];
  return { kind: data.outcome, message: `${prefix}：${redact(data.reason).slice(0, 4000)}\n分数：${entries.map(([id, score]) => `${id}=${score}`).join("，")}` };
}

/** Dependencies can be replaced by offline fixtures; normal bash never performs IO. */
export function createGate({ evaluate = callCli, getState = stagedState, env = process.env } = {}) {
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
        if (state.truncated) notify("Jev：diff 超长，判定仅覆盖前 24000 字符。", "warning");
        verdict = mapDecision(await evaluate(state, ctx.signal));
      } catch {
        // Never echo an arbitrary thrown message: it could contain a credential or diff.
        verdict = { kind: "failure", message: `Jev 门禁失败，未完成判定；本次放行：${commit.unsupported ?? "无法取得 diff，或 CLI 不可用/超时/取消/输出超限（原始输出已隐藏）"}` };
      }
      if (verdict.kind === "block") blocked.push(verdict.message);
      notify(verdict.message, verdict.kind === "approve" ? "info" : "warning");
    }
    if (blocked.length) return { block: true, reason: blocked.join("\n") };
  };
}
