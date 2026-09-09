import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "../scripts/lib.mjs";

const script = join(ROOT, "scripts/release.mjs");

test("release check accepts an isolated shadow port", () => {
  const output = execFileSync(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, PI_DEV_SHADOW_PORT: "8791" },
    encoding: "utf8",
  });
  assert.match(output, /PASS shadow port 8791/);
  assert.match(output, /pi-dev-shadow/);
});

test("release check rejects the legacy port", () => {
  assert.throws(
    () => execFileSync(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, PI_DEV_SHADOW_PORT: "8787" },
      encoding: "utf8",
      stdio: "pipe",
    }),
    /Command failed/
  );
});
