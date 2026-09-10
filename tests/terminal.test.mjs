/*
 * 🍞 AI Breadcrumb: PTY toolchain regression, independent of live configuration.
 * @COUPLED scripts/lib.mjs, vendor/pi-web-ui/package.json
 * @WHY Fixtures own their token/data paths; npm test never reads operator credentials.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, runtimeEnv } from "../scripts/lib.mjs";

const require = createRequire(join(ROOT, "vendor/pi-web-ui/package.json"));
const pty = require("node-pty");

test("native terminal resolves project Python and cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dev-pty-"));
  let terminal;
  try {
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "a".repeat(64), { mode: 0o600 });
    terminal = pty.spawn("python", ["-c", "import os,sys; print(os.getcwd()); print(sys.prefix); print(sys.version_info[:2])"], {
      name: "xterm-color", cols: 80, rows: 24, cwd: ROOT,
      env: runtimeEnv({ root: ROOT, node: process.execPath, host: "127.0.0.1", port: 8890,
        profile: "lean", dataDir: join(dir, "web"), agentDir: join(dir, "agent"), tokenFile }),
    });
    let output = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { terminal.kill(); reject(new Error("PTY timeout")); }, 10000);
      terminal.onData(data => { output += data; });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode === 0) resolve(); else reject(new Error(`PTY failed with code ${exitCode}`));
      });
    });
    assert.ok(output.includes(ROOT));
    assert.ok(output.includes(join(ROOT, ".venv")));
    assert.ok(output.includes("(3, 10)"));
  } finally {
    terminal?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
