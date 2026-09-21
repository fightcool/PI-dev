/* 🍞 AI Breadcrumb — @COUPLED index.ts, ask.mjs（用它跑 CLI）, ../../docs/JEV-TRIM.md §7
 * @WHY **只认一份代码**：扩展要调用的 CLI 必须来自**正在运行的那个宿主自己的代码**。
 *   部署语义下就是 `deploy/current/scripts/start.mjs` → `deploy/current/vendor/pi-web-ui`；
 *   `current` 是指向 `releases/<id>` 的符号链接，所以解析结果**随发布自动跟随**，不需要任何"治愈"。
 * @WHY 为什么不列出候选、逐个试（曾经这么写过）：那是把「版本不一致」当成常态去容错。但
 *   ① 部署切换后旧 release 会被回收（`switch-production-release.mjs` 的 prune 会删历史版本），
 *   ② 会话 cwd 里的 checkout 很可能是**别人正在改的工作副本**（实测遇到过：那份还没有 `ask` 子命令），
 *   于是每次判定都要先白跑一次进程（实测 2.4s）才失败。旧版本根本不该被咨询 ——
 *   遇到「运行中的版本不支持」时，正确动作是**部署新版本**，不是去别处碰运气。
 * @CONTRACT 解析只有两档：
 *   ① `JEV_GATE_APP` 显式覆盖（调试/测试；配错就报错，不降级到别处）；
 *   ② 运行中宿主入口脚本（`process.argv[1]`）所在树里的 `vendor/pi-web-ui`（向上最多 4 层）。
 *   找不到 → 返回 null，调用方**告警放行并说明原因**（绝不猜路径）。
 * @GOTCHA `path.resolve` 只做字面规范化、**不解符号链接** —— 这是刻意的：保留 `current/...` 才能让
 *   解析结果跟着发布切换走（我们要的就是「现在在跑的那份」）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const hasCli = (dir) =>
  Boolean(dir) && existsSync(join(dir, "scripts", "jev-gate.ts"));

/** 从宿主入口脚本往上（最多 `depth` 层）找到第一个含 `vendor/pi-web-ui` 的树根。 */
export function appFromHostEntry(hostEntry, depth = 6) {
  if (!hostEntry || typeof hostEntry !== "string") return null;
  let dir = dirname(resolve(hostEntry));
  for (let level = 0; level <= depth; level += 1) {
    const candidate = join(dir, "vendor", "pi-web-ui");
    if (hasCli(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 解析这次要用的 app（即「CLI 在哪」）。null = 没得用，调用方必须告警放行。
 * @WHY 只认**正在跑我们的那个文件的所在树**，因为部署语义下那就是唯一在跑的代码
 *   （`deploy/current` → 某个 release；`current` 是符号链接，`path.resolve` 不解符号链接，
 *   所以解析结果保留字面量，换发布自动跟随）。旧 release / 别人的工作副本永远不会被选中。
 * @GOTCHA **`process.argv[1]` 在 pm2 下不是应用入口**：pm2 用自己的 process container 重新 fork
 *   应用，argv[1] = `…/pm2/lib/ProcessContainerFork.js`。实测曾因此解析失败，
 *   再被 cwd 降级掩盖成「版本错位」（日志里 app=<会话项目>/vendor/pi-web-ui，
 *   而不是 release）—— 那个降级档已删除。pm2 暴露的真实入口是 `pm_exec_path`，优先用它。
 * @GOTCHA 层级要够深：pi 的 CLI 可能在 `node_modules/@scope/pkg/dist/…`，从那里跑到 checkout 根要 4-5 层。
 * @CONTRACT 不把会话 cwd 当来源：它只属于「当前项目」，与「正在跑的代码」无关；
 *   一旦拿它兜底，解析失败就会被掩盖成版本错位（上面的实测）。cwd 仅作诊断输出。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [hostEntry] 默认取 `process.argv[1]`
 * @returns {string | null}
 */
export function resolveApp(env = process.env, hostEntry = process.argv[1]) {
  const override = env.JEV_GATE_APP;
  if (override) return hasCli(override) ? resolve(override) : null;
  for (const entry of [env.pm_exec_path, hostEntry]) {
    const app = appFromHostEntry(entry);
    if (app) return app;
  }
  return null;
}

/**
 * 跑一个子进程，带超时/输出上限/外部取消。
 * @CONTRACT 超时或取消都 **kill 进程** 后返回 `timedOut`/`aborted`，绝不无限期挂着 ——
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
    child.on("close", (code) => finish({ code, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}
