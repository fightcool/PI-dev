import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInactiveCheckout } from "../scripts/lifecycle/build-target.mjs";

test("build guard recognizes PM2 current symlink and leaves other checkouts usable", t => {
  const base = mkdtempSync(join(tmpdir(), "pi-active-build-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const release = join(base, "release"); mkdirSync(release); symlinkSync(release, join(base, "current"));
  const run = (_file, args) => ({ stdout: args.includes("pi-dev-pm2.service") ? `ActiveState=active\nWorkingDirectory=${base}` : "ActiveState=inactive" });
  assert.throws(() => assertInactiveCheckout(release, run), /active PM2/);
  assert.doesNotThrow(() => assertInactiveCheckout(join(base, "development"), run));
});

test("legacy service is detected by executable path even with a separate workspace", () => {
  const run = (_file, args) => ({ stdout: args.includes("pi-web-ui-dev.service")
    ? "ActiveState=active\nWorkingDirectory=/workspace\nExecStart=/release/scripts/start.mjs" : "ActiveState=inactive" });
  assert.throws(() => assertInactiveCheckout("/release", run), /active systemd/);
});
