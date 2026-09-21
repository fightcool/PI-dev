/* 🍞 AI Breadcrumb — @COUPLED gate.mjs, ../../tests/jev-hook-state.test.mjs
 * 📖 docs/JEV-HOOK.md
 * @CONTRACT Only staged text is sent; credentials are excluded/redacted before CLI stdin.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// @MAGIC Git output capped at 8 MiB; reviewed text at 24k chars, with an explicit marker.
export const DIFF_LIMIT = 24_000;
// @MAGIC 对外接口声明摘录上限：state 与问题共享 32k token 上限，diff 已占大头，声明只留要点。
export const PUBLIC_SURFACE_LIMIT = 4_000;

/**
 * 本仓的「对外接口声明」（`docs/PUBLIC-SURFACE.md`）。
 * @WHY 判据 `change_preserves_public_api` 的默认口径是「任何导出名都算公共接口」，于是同仓内部重构
 *   每次都被判成破坏性变更（实测两次 block：0.07 / 0.11）。声明的存在让判据按**本仓**口径办事。
 * @CONTRACT 文件缺失/为空/读不到 → 返回 ""，判定照旧（拿不到声明不是跳过门禁的理由）；
 *   超长按字符截断并留标记（宁可少给，也不给半句让人误读的口径）。
 */
export async function publicSurfaceAt(cwd) {
  try {
    const text = (await readFile(join(cwd, "docs", "PUBLIC-SURFACE.md"), "utf8")).trim();
    if (!text) return "";
    return text.length <= PUBLIC_SURFACE_LIMIT
      ? text
      : `${text.slice(0, PUBLIC_SURFACE_LIMIT)}\n\n[……对外接口声明过长，已截断……]`;
  } catch {
    return "";
  }
}

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
  const publicSurface = await publicSurfaceAt(commit.cwd);
  return {
    objective: `审查并提交以下暂存改动（仅有暂存摘要，未提供原始任务目标）：\n${summary || "当前暂存改动"}`,
    // 判据要按本仓口径判断「什么是公共接口」；没有声明时字段缺席，判定照旧。
    ...(publicSurface ? { publicSurface } : {}),
    diff,
    truncated,
  };
}
