/* 🍞 @COUPLED jev-gate-pr.mjs, ../../tests/jev-public-surface.test.mjs
 * 📖 docs/PUBLIC-SURFACE.md
 * @CONTRACT 只读 baseSha 中的声明：被审 PR 不能用自己的清单修改本次判据。
 */
import { execFileSync } from "node:child_process";
import { publicSurfaceExcerpt } from "./jev-gate-verdict.mjs";

export function readPublicSurface(cwd, baseSha) {
  const git = (args) => execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const path = "docs/PUBLIC-SURFACE.md";
  // 缺文件不跳过判定；无效 base / Git 故障则抛错，不能冒充文件缺失。
  if (!git(["ls-tree", "--name-only", baseSha, "--", path]).trim()) return "";
  return publicSurfaceExcerpt(git(["show", `${baseSha}:${path}`]));
}
