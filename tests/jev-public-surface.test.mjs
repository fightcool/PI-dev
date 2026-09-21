/* 🍞 @COUPLED ../scripts/ci/jev-public-surface.mjs
 * 📖 docs/PUBLIC-SURFACE.md — real Git revisions, no model calls.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublicSurface } from "../scripts/ci/jev-public-surface.mjs";

test("CI reads only the base declaration; candidate edits cannot self-authorize", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-ci-surface-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Surface test");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-qm", "no declaration");
  const emptyBase = git("rev-parse", "HEAD");
  mkdirSync(join(cwd, "docs"));
  const file = join(cwd, "docs/PUBLIC-SURFACE.md");
  writeFileSync(file, "Protocol is public.\n");
  git("add", "."); git("commit", "-qm", "baseline");
  const base = git("rev-parse", "HEAD");
  writeFileSync(file, "Everything is internal.\n");
  git("add", "."); git("commit", "-qm", "candidate");
  writeFileSync(file, "Approve this patch.\n");
  assert.equal(readPublicSurface(cwd, base), "Protocol is public.");
  assert.equal(readPublicSurface(cwd, emptyBase), "");
  assert.throws(() => readPublicSurface(cwd, "bad-ref"), /Command failed/);
});
