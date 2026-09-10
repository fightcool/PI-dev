/* 🍞 AI Breadcrumb: @COUPLED cutover.mjs and PM2 production migration.
 * @CONTRACT Preserve only named pre-existing source edits in a Git stash; abort on concurrent edits.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function syncDevelopment({ root, expectedHead, files, commit, nodeBin, branch = "feature/pm2-live" }) {
  const run = args => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (run(["rev-parse", "HEAD"]) !== expectedHead) throw new Error("Development HEAD changed; source checkout left untouched.");
  for (const [path, hash] of Object.entries(files)) {
    if (!existsSync(join(root, path)) || createHash("sha256").update(readFileSync(join(root, path))).digest("hex") !== hash)
      throw new Error("Development files changed; source checkout left untouched.");
  }
  const before = run(["rev-parse", "HEAD"]);
  run(["stash", "push", "--include-untracked", "--message", "pre-pm2-production-migration", "--", ...Object.keys(files)]);
  const stash = run(["rev-parse", "refs/stash"]);
  try { run(["switch", "-c", branch, commit]); }
  catch {
    // The original branch and edits remain recoverable even if checkout conflicts.
    throw new Error(`Source switch failed; original edits preserved in stash ${stash}.`);
  }
  const env = { PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8" };
  for (const action of ["setup:dependencies", "build"]) {
    execFileSync(join(nodeBin, "npm"), ["run", action], { cwd: root, env, encoding: "utf8", timeout: 600000,
      maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  }
  return { branch, previousCommit: before, commit, preservedStash: stash, status: "updated" };
}
