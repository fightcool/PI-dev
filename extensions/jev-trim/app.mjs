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

/**
 * 所有**可尝试**的 app 候选（按优先级去重）。
 * @WHY 为什么不只取第一个：实测踩到过 —— 会话 cwd 里有一个**旧 checkout**（还没有 `ask` 子命令），
 *   而 cwd 优先级高于安装记录，于是每次判定都 `退出码 3：未知命令: ask`（内容原样放行，看着像「没生效」）。
 *   所以候选全列出来逐个尝试：版本偏差能自愈，只在**全部**失败时才告警放行。
 * @returns {string[]}
 */
export function resolveAppCandidates(
  cwd,
  env = process.env,
  recordPath = APP_RECORD,
) {
  /** @type {string[]} */
  const candidates = [];
  const push = (dir) => {
    if (!dir || !hasCli(dir)) return;
    const abs = resolve(dir);
    if (!candidates.includes(abs)) candidates.push(abs);
  };
  push(env.JEV_GATE_APP);
  // 顺序：env → **安装时记录的 checkout** → 会话 cwd → 本体自带。
  // @WHY 为什么记录排在 cwd 前面：记录的那个就是**本体所在的那份 checkout**，协议/子命令与本体同版本；
  //   而会话 cwd 里的 checkout 可能是别人的工作副本（实测就吃过：那份还没有 `ask` 子命令 → 每次判定
  //   先白跑 2.4s 才失败）。记录路径不存在时 `push` 会直接跳过，所以「优先」不会付代价。
  push(readRecordedApp(recordPath));
  for (let dir = cwd ? resolve(cwd) : null; dir; dir = dirname(dir)) {
    push(join(dir, "vendor", "pi-web-ui"));
    if (dirname(dir) === dir) break;
  }
  push(resolve(SELF_ROOT, "vendor", "pi-web-ui"));
  return candidates;
}

export function resolveApp(cwd, env = process.env, recordPath = APP_RECORD) {
  return resolveAppCandidates(cwd, env, recordPath)[0] ?? null;
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
