import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncDevelopment } from "../scripts/lifecycle/sync-development.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-source-switch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "original"]);
  git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(root, "source.txt"), "old");
  git(["add", "source.txt"]); git(["commit", "-qm", "old"]);
  const expectedHead = git(["rev-parse", "HEAD"]);
  writeFileSync(join(root, "source.txt"), "new");
  git(["add", "source.txt"]); git(["commit", "-qm", "new"]);
  const commit = git(["rev-parse", "HEAD"]);
  git(["switch", "--detach", expectedHead]);
  writeFileSync(join(root, "source.txt"), "operator edit");
  writeFileSync(join(root, "proposal.md"), "operator proposal");
  const files = Object.fromEntries(["source.txt", "proposal.md"].map(p => [p, createHash("sha256").update(readFileSync(join(root, p))).digest("hex")]));
  const nodeBin = join(root, "tools"); mkdirSync(nodeBin);
  writeFileSync(join(nodeBin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PWD/commands.log"\n', { mode: 0o700 });
  return { root, git, options: { root, expectedHead, commit, files, nodeBin } };
}

test("source update retains exact operator edits in stash before switching and building", t => {
  const f = fixture(t);
  const result = syncDevelopment(f.options);
  assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "new");
  assert.equal(f.git(["show", `${result.preservedStash}:source.txt`]), "operator edit");
  assert.equal(f.git(["show", `${result.preservedStash}^3:proposal.md`]), "operator proposal");
  assert.deepEqual(readFileSync(join(f.root, "commands.log"), "utf8").trim().split("\n"), ["run setup:dependencies", "run build"]);
});

test("concurrent operator edit prevents stash and source switching", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "proposal.md"), "new concurrent edit");
  assert.throws(() => syncDevelopment(f.options), /files changed/);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.options.expectedHead);
  assert.equal(f.git(["stash", "list"]), "");
});
