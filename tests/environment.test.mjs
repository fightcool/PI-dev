import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ROOT,
  PROFILES,
  validateConfig,
  runtimeEnv,
  systemdQuote,
  readJson,
} from "../scripts/lib.mjs";
import {
  DEFAULT_GOVERNANCE,
  validateGovernance,
  assessInputBudget,
  assessToolOutput,
} from "../scripts/governance.mjs";

const config = () => ({
  root: ROOT,
  node: process.execPath,
  host: "127.0.0.1",
  port: 8788,
  dataDir: "/tmp/pi-dev-web",
  agentDir: "/tmp/pi-dev-agent",
  tokenFile: "/tmp/pi-dev-token",
  profile: "lean",
});

test("defaults use a dedicated project, service port and lean profile", () => {
  assert.equal(validateConfig(config()).root, ROOT);
  assert.deepEqual(PROFILES.lean, ["pi-context-prune"]);
  assert.ok(PROFILES.full.includes("pi-lens"));
});
for (const invalid of [
  { port: 8787 },
  { port: 80 },
  { port: 65536 },
  { port: "8788" },
  { host: "0.0.0.0" },
  { root: "/root" },
  { profile: "typo" },
  { node: "/usr/bin/node\nOops" },
  { agentDir: "/tmp/pi-dev-web" },
]) {
  test(`reject unsafe config ${JSON.stringify(invalid)}`, () =>
    assert.throws(() => validateConfig({ ...config(), ...invalid })));
}
test("runtime overrides inherited old-instance paths and activates the project venv", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dev-test-"));
  try {
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "a".repeat(64), { mode: 0o600 });
    const env = runtimeEnv(
      { ...config(), tokenFile },
      { PI_WEB_CWD: "/root", PI_WEB_PORT: "8787" },
    );
    assert.equal(env.PI_WEB_CWD, ROOT);
    assert.equal(env.PI_WEB_PORT, "8788");
    assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/pi-dev-agent");
    // 不设置 PI_CODING_AGENT_SESSION_DIR：SDK 0.85.1 不读它写盘，但 pi-web-ui
    // 会把它当 sessionDir 传给非递归的 list()/listAll()，导致历史列表恒为空。
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, undefined);
    assert.equal(env.VIRTUAL_ENV, join(ROOT, ".venv"));
    assert.ok(env.PATH.startsWith(join(ROOT, ".venv/bin")));
    assert.equal(env.PI_WEB_TOKEN.length, 64);
    assert.equal(env.PI_WEB_RP_ID, "dev.ftai.cc");
    assert.equal(env.PI_WEB_ORIGIN, "https://dev.ftai.cc");
    writeFileSync(tokenFile, "");
    assert.throws(() => runtimeEnv({ ...config(), tokenFile }, {}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("request and tool budgets have explicit safety states", () => {
  assert.equal(assessInputBudget(10_000).state, "allow");
  assert.equal(assessInputBudget(DEFAULT_GOVERNANCE.maxInputTokens * 0.7).state, "warn");
  assert.equal(assessInputBudget(DEFAULT_GOVERNANCE.maxInputTokens * 0.85).state, "compact");
  assert.equal(assessInputBudget(DEFAULT_GOVERNANCE.maxInputTokens + 1).state, "blocked");
  assert.equal(assessToolOutput({ bytes: 70_000, lines: 10, tokens: 100 }).truncated, true);
  assert.throws(() => validateGovernance({ compactAtRatio: 0.5 }));
});
test("usage diagnostics reports per-request outliers without prompt content", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dev-usage-"));
  try {
    const csv = join(dir, "usage.csv");
    writeFileSync(csv, "时间,类型,提示词tokens,补全tokens,花费\n2026-01-01,consume,120000,10,1.2\n2026-01-01,error,0,0,0\n2026-01-01,consume,5,2,0.1\n");
    const output = execFileSync(process.execPath, [join(ROOT, "scripts/diagnostics/analyze-usage.mjs"), csv], { encoding: "utf8" });
    const report = JSON.parse(output);
    assert.equal(report.consumeRequests, 2);
    assert.equal(report.maxInputTokens, 120000);
    assert.equal(report.thresholds["100000"], 1);
    assert.equal(Object.hasOwn(report, "details"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("systemd paths preserve spaces, literal specifiers and dollars", () => {
  assert.equal(systemdQuote('/a b/"x"%$'), '"/a b/\\"x\\"%%$$"');
});
test("invalid JSON fails with a contextual error", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dev-json-"));
  try {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{");
    assert.throws(() => readJson(path), /Cannot read valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
