/*
 * 🍞 AI Breadcrumb: protocol tests own all runtime state and a bounded child group.
 * @COUPLED vendor/pi-web-ui/tests/run-smoke.mjs, package.json
 * @WHY Old vendor fixtures sometimes only override Web data; give their SDK an
 * isolated agent directory and no inherited provider credentials as well.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const base = mkdtempSync(join(tmpdir(), "pi-protocol-"));
const agentDir = join(base, "agent");
mkdirSync(agentDir);
const allowed = ["PATH", "LANG", "LC_ALL", "TERM", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP"];
const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, PI_WEB_DATA_DIR: join(base, "web"),
  PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_WEB_TOKEN: "" });
const child = spawn(process.execPath, [join(ROOT, "vendor/pi-web-ui/tests/run-smoke.mjs"), ...process.argv.slice(2)], {
  cwd: join(ROOT, "vendor/pi-web-ui"), env, stdio: "inherit", detached: process.platform !== "win32",
});
let timedOut = false;
const terminate = () => {
  try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
};
const timer = setTimeout(() => { timedOut = true; terminate(); }, 10 * 60 * 1000);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (timedOut) console.error("Protocol suite exceeded its ten-minute budget.");
  process.exitCode = timedOut ? 124 : code ?? 1;
} finally {
  clearTimeout(timer);
  if (child.pid) terminate();
  rmSync(base, { recursive: true, force: true });
}
