/* 🍞 AI Breadcrumb — @COUPLED jev-gate/gate.mjs::resolveApp（同源逻辑）, ask.mjs（用它跑 CLI）
 * @WHY 为什么这里和 jev-gate/gate.mjs 有一段**故意重复**的 app 解析：每个装到宿主的扩展是**独立副本**
 *   （内容寻址目录，互不 import），共享一个 lib 需要先改安装器布局 —— 那是后续重构（见
 *   docs/JEV-HARNESS-PLAN.md §8 待办）。此处保持与 gate 完全相同的三档兜底顺序，行为可预期。
 * @CONTRACT 解析顺序：`JEV_GATE_APP` → 会话 cwd 逐级向上找 `vendor/pi-web-ui` → 安装时记录的 `app.json`
 *   → 扩展自带的 checkout。找不到就返回 null，**调用方必须告警放行**（绝不假装成功）。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 与 gate.mjs 完全相同的两条路径推导（**别改成 dirname(import.meta.url) 那种写法**）：
 *   - `SELF_ROOT` = `../../`：源码树里 = 仓库根（`vendor/pi-web-ui` 就在旁边）；
 *     装到宿主后 = `<agentDir>`（hooks/<name>-<hash>/ 往上两级）。
 *   - `APP_RECORD` = **本体目录里的** app.json：安装器把「CLI 在哪个 checkout」写在这里。
 * @GOTCHA 这两个路径写错**不会报错**，只会让兜底永远读不到记录 → 在别的项目里静默不生效。
 */
const SELF_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const APP_RECORD = fileURLToPath(new URL("./app.json", import.meta.url));

const hasCli = (dir) =>
  Boolean(dir) && existsSync(join(dir, "scripts", "jev-gate.ts"));

function readRecordedApp(recordPath) {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8"));
    return typeof parsed?.app === "string" && parsed.app ? parsed.app : null;
  } catch {
    return null;
  }
}

export function resolveApp(cwd, env = process.env, recordPath = APP_RECORD) {
  if (env.JEV_GATE_APP)
    return hasCli(env.JEV_GATE_APP) ? resolve(env.JEV_GATE_APP) : null;
  for (let dir = cwd ? resolve(cwd) : null; dir; dir = dirname(dir)) {
    const candidate = join(dir, "vendor", "pi-web-ui");
    if (hasCli(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  for (const candidate of [
    readRecordedApp(recordPath),
    resolve(SELF_ROOT, "vendor", "pi-web-ui"),
  ]) {
    if (hasCli(candidate)) return resolve(candidate);
  }
  return null;
}

/**
 * 跑一个子进程，带超时/输出上限/外部取消。
 * @CONTRACT 超时或取消都 **kill 进程** 后返回 `timedOut`/`aborted`，绝不无限期挂着——
 *   这个调用在 `tool_result` 钩子路径上，挂住就是把用户的 agent 卡死。
 */
export function runProcess(
  command,
  args,
  { cwd, input, timeout, maxBuffer = 4 * 1024 * 1024, signal } = {},
) {
  return new Promise((settle) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      settle(result);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, aborted: true });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeout ?? 20_000);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    const collect = (chunk, which) => {
      if (stdout.length + stderr.length > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      if (which === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (c) => collect(String(c), "out"));
    child.stderr.on("data", (c) => collect(String(c), "err"));
    child.on("error", (err) =>
      finish({ code: null, stdout, stderr: String(err?.message ?? err) }),
    );
    child.on("close", (code) => finish({ code, stdout, stderr, overflow }));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}
