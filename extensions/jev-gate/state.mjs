/* 🍞 AI Breadcrumb — @COUPLED gate.mjs, ../../tests/jev-hook-state.test.mjs
 * 📖 docs/JEV-HOOK.md
 * @CONTRACT Only staged text is sent; credentials are excluded/redacted before CLI stdin.
 */
import { execFile } from "node:child_process";

// @MAGIC Git output capped at 8 MiB; reviewed text at 24k chars, with an explicit marker.
export const DIFF_LIMIT = 24_000;

/** No raw child errors: they can contain arguments, source text or upstream credentials. */
export function runProcess(file, args, { cwd, input = "", timeout = 10_000, maxBuffer = 8 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, timeout, maxBuffer, signal, killSignal: "SIGKILL", encoding: "utf8" }, (error, stdout) => {
      if (error && (typeof error.code !== "number" || error.killed || error.signal)) {
        reject(new Error("子进程不可用、超时、取消或输出超限（原始输出已隐藏）"));
      } else resolve({ code: error?.code ?? 0, stdout });
    });
    child.stdin.on("error", () => { /* Early child exit is reported by execFile callback. */ });
    child.stdin.end(input);
  });
}

export function redact(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[私钥已抹除]")
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[凭据已抹除]")
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, "[不透明长串已抹除]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)\b["']?\s*[:=]\s*)[^\r\n]+/gi, "$1[敏感值已抹除]");
}

export function sanitizeDiff(diff) {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections.map((section) => {
    const header = section.split("\n", 1)[0];
    if (/(?:^|[ /"\\])(?:\.env(?:[. /"\\]|$)|\.ssh[ /\\]|id_(?:rsa|ed25519)|provider-keys\.json|auth\.json|hosts\.yml|[^ /]+\.(?:pem|key)(?:[ "\\]|$))/i.test(header)) {
      return "[敏感文件 diff 已省略]\n";
    }
    return redact(section);
  }).join("");
}

export async function stagedState(commit, signal) {
  const git = async (args, input = "") => {
    const result = await runProcess("git", ["--no-pager", ...args], { cwd: commit.cwd, input, signal });
    if (result.code !== 0) throw new Error("无法读取 Git 暂存差异（Git 执行失败，原始输出已隐藏）");
    return result.stdout;
  };
  let base = [];
  if (commit.amend) {
    const parents = (await git(["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(/\s+/);
    // Root amend compares the index with an empty tree, including SHA-256 repositories.
    const parent = parents[1] ?? (await git(["hash-object", "-t", "tree", "--stdin"])).trim();
    base = [parent];
  }
  const args = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", ...base];
  const raw = await git([...args, "--"]);
  if (!raw.trim()) throw new Error("暂存差异为空，未获得可审内容");
  const safe = sanitizeDiff(raw);
  const truncated = safe.length > DIFF_LIMIT;
  const diff = safe.slice(0, DIFF_LIMIT) + (truncated ? "\n[diff 已截断：仅审查前 24000 字符]" : "");
  const summary = redact(await git([...args, "--stat", "--"])).slice(0, 1200);
  return {
    objective: `审查并提交以下暂存改动（仅有暂存摘要，未提供原始任务目标）：\n${summary || "当前暂存改动"}`,
    diff,
    truncated,
  };
}
