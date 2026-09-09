import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ROOT, loadConfig, runtimeEnv } from "../scripts/lib.mjs";

const require = createRequire(
  join(ROOT, "node_modules/pi-web-ui/package.json"),
);
const pty = require("node-pty");

test("native terminal resolves project Python and cwd", async () => {
  const terminal = pty.spawn(
    "python",
    [
      "-c",
      "import os,sys; print(os.getcwd()); print(sys.prefix); print(sys.version_info[:2])",
    ],
    {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: ROOT,
      env: runtimeEnv(loadConfig()),
    },
  );
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error("PTY timeout"));
    }, 10000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0) resolve();
      else reject(new Error(`PTY failed with code ${exitCode}`));
    });
  });
  assert.ok(output.includes(ROOT));
  assert.ok(output.includes(join(ROOT, ".venv")));
  assert.ok(output.includes("(3, 10)"));
});
