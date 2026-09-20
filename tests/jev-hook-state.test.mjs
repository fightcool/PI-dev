/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-gate/state.mjs
 * 📖 docs/JEV-HOOK.md — real temporary Git repos; no model/network calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DIFF_LIMIT, runProcess, sanitizeDiff, stagedState } from "../extensions/jev-gate/state.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "jev-index-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.name", "Hook test");
  git("config", "user.email", "hook@example.invalid");
  const write = (name, text) => writeFileSync(join(cwd, name), text);
  return { cwd, git, write };
}

test("state includes staged diff and excludes unstaged working changes", async (t) => {
  const { cwd, git, write } = fixture(t);
  write("api.ts", "export const answer = 1;\n");
  git("add", "api.ts"); git("commit", "-qm", "initial");
  write("api.ts", "export const answer = 2;\n"); git("add", "api.ts");
  write("api.ts", "export const answer = 999;\n");
  const state = await stagedState({ cwd, amend: false });
  assert.match(state.diff, /\+export const answer = 2/);
  assert.doesNotMatch(state.diff, /999/);
  assert.match(state.objective, /api.ts/);
});

test("amend includes HEAD changes plus index relative to first parent", async (t) => {
  const { cwd, git, write } = fixture(t);
  write("api.ts", "export const answer = 1;\n"); git("add", "."); git("commit", "-qm", "first");
  write("api.ts", "export const answer = 2;\n"); git("add", "."); git("commit", "-qm", "second");
  write("extra.ts", "export const extra = true;\n"); git("add", ".");
  const state = await stagedState({ cwd, amend: true });
  assert.match(state.diff, /-export const answer = 1/);
  assert.match(state.diff, /\+export const answer = 2/);
  assert.match(state.diff, /\+export const extra = true/);
});

test("root amend, empty index and oversized diff are explicit", async (t) => {
  const { cwd, git, write } = fixture(t);
  write("api.ts", "export const answer = 1;\n"); git("add", "."); git("commit", "-qm", "first");
  assert.match((await stagedState({ cwd, amend: true })).diff, /\+export const answer = 1/);
  await assert.rejects(stagedState({ cwd, amend: false }), /暂存差异为空/);
  write("big.txt", "short words\n".repeat(4000)); git("add", ".");
  const state = await stagedState({ cwd, amend: false });
  assert.equal(state.truncated, true);
  assert.match(state.diff, /diff 已截断/);
  assert.ok(state.diff.length < DIFF_LIMIT + 100);
});

test("sensitive files and secret-shaped content never enter state", () => {
  const opaque = "aB12".repeat(12);
  const patch = `diff --git a/.env b/.env\n+PASSWORD=short-sensitive-value\ndiff --git a/code.ts b/code.ts\n+const credential = '${opaque}';\n+const apiKey = 'short-sensitive-value';\n+const ok = 3;\n`;
  const safe = sanitizeDiff(patch);
  assert.doesNotMatch(safe, /short-sensitive-value/);
  assert.ok(!safe.includes(opaque));
  assert.match(safe, /敏感文件 diff 已省略/);
  assert.match(safe, /const ok = 3/);
});

test("child timeout is bounded and raw output is hidden", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 }), /超时/);
});
