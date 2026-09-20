/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-gate/command.mjs, ../extensions/jev-gate/gate.mjs
 * 📖 docs/JEV-HOOK.md — offline command recognition and verdict contracts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectCommits } from "../extensions/jev-gate/command.mjs";
import { createGate, mapDecision } from "../extensions/jev-gate/gate.mjs";

for (const command of [
  "git commit", "git commit --amend --no-edit", "git -C /tmp/demo commit -m 'fix'",
  "git -c x=y commit", "git -c user.name=Test commit -m hi", "command git commit",
  "cd /tmp/demo && git commit -m 'message'", "git add file && git commit -m fix",
  "git -C /tmp -C demo commit", "git commit -m 'text with --amend'", "git commit -m '--dry-run'",
  "git commit -m 'git commit'", "git commit -m \"hi; echo text\"", "git \\\ncommit -m hi",
]) test(`detect: ${command}`, () => assert.equal(detectCommits(command, "/work").length, 1));

for (const command of [
  "git log --grep commit", 'echo "git commit"', "git commit-tree HEAD", "'git commit'",
  "printf '%s' 'git commit'", "bash -c 'git commit'", "echo git commit",
  "cat <<'EOF'\ngit commit\nEOF", "cat <<-EOF\ngit commit\nEOF", "# git commit\necho done",
  "git commit --dry-run", "git commit -h", "git --help commit", "git show 'git commit'",
  'echo "$(git commit)"', "if false; then\ngit commit\nfi", "git commit | cat", "git commit || true",
  "git commit -m 'unterminated", "for x in commit; do echo git; done",
]) test(`ignore: ${command}`, () => assert.deepEqual(detectCommits(command, "/work"), []));

test("cwd and amend come from syntax, never message text", () => {
  assert.deepEqual(detectCommits("cd /tmp && git -C 'repo with spaces' commit --amend", "/work"), [
    { cwd: "/tmp/repo with spaces", amend: true, unsupported: undefined },
  ]);
  assert.equal(detectCommits("git commit -m '--amend'", "/work")[0].amend, false);
  assert.match(detectCommits("git add file && git commit", "/work")[0].unsupported, /拆成两次/);
  assert.match(detectCommits("git commit -am fix", "/work")[0].unsupported, /提交选项/);
});

const cli = (outcome, score = 0.5, extra = {}) => ({
  code: { approve: 0, block: 1, review: 2 }[outcome],
  stdout: JSON.stringify({ outcome, reason: `示例命题=${score}（独立阈值 0.8/0.2）`, checks: { example: score }, ...extra }),
});
const event = { toolName: "bash", input: { command: "git commit -m test" } };
const ctx = { cwd: "/tmp" };

for (const [outcome, score] of [["block", 0.1], ["review", 0.5], ["approve", 0.9]]) {
  test(`${outcome} maps to block only for block and reports score/threshold`, async () => {
    const notices = [];
    const gate = createGate({ env: {}, getState: async () => ({ diff: "patch" }), evaluate: async () => cli(outcome, score) });
    const result = await gate(event, ctx, (...args) => notices.push(args));
    assert.equal(result?.block, outcome === "block" ? true : undefined);
    assert.match(notices[0][0], new RegExp(`example=${score}`));
    assert.match(notices[0][0], /0\.8\/0\.2/);
    if (outcome === "review") assert.match(notices[0][0], /灰区，未拦/);
    if (outcome === "block") assert.match(result.reason, /修复后重新提交/);
  });
}

for (const result of [
  { code: 3, stdout: "credentials missing" }, { code: 7, stdout: "upstream secret" },
  { code: 0, stdout: "not json" }, { ...cli("block"), code: 0 },
  cli("review", 0.5, { error: "upstream secret" }), cli("approve", 2),
  cli("block", null), cli("approve", 0.8, { checks: {} }),
]) test(`failed CLI is not approval: ${JSON.stringify(result)}`, async () => {
  const notices = [];
  const gate = createGate({ env: {}, getState: async () => ({ diff: "patch" }), evaluate: async () => result });
  assert.equal(await gate(event, ctx, (...args) => notices.push(args)), undefined);
  assert.equal(mapDecision(result).kind, "failure");
  assert.match(notices[0][0], /未完成判定；本次放行/);
  assert.doesNotMatch(notices[0][0], /upstream secret/);
  assert.equal(notices[0][1], "warning");
});

for (const stage of ["diff", "cli"]) test(`${stage} throw fails open with warning and hides error`, async () => {
  const fail = async () => { throw new Error("never expose confidential text"); };
  const gate = createGate({ env: {}, getState: stage === "diff" ? fail : async () => ({}), evaluate: fail });
  const notices = [];
  assert.equal(await gate(event, ctx, (message) => notices.push(message)), undefined);
  assert.match(notices[0], /未完成判定/);
  assert.doesNotMatch(notices[0], /confidential/);
});

test("ordinary commands, other tools and off switch do no IO", async () => {
  const fail = () => assert.fail("must not do IO");
  const gate = createGate({ env: {}, getState: fail, evaluate: fail });
  assert.equal(await gate({ toolName: "read", input: {} }, ctx, fail), undefined);
  assert.equal(await gate({ toolName: "bash", input: { command: "git log --grep commit" } }, ctx, fail), undefined);
  assert.equal(await createGate({ env: { JEV_GATE_HOOK: "off" }, getState: fail })(event, ctx, fail), undefined);
});

test("unready index warns without judging stale state", async () => {
  const notices = [];
  const gate = createGate({ env: {}, getState: () => assert.fail("stale diff"), evaluate: () => assert.fail("no network") });
  assert.equal(await gate({ ...event, input: { command: "git add file && git commit" } }, ctx, (m) => notices.push(m)), undefined);
  assert.match(notices[0], /拆成两次/);
});
