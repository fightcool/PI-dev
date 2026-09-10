/* 🍞 AI Breadcrumb: @COUPLED scripts/service.mjs, tests/service.test.mjs
 * @CONTRACT exec is a spawnSync-compatible runner; only explicit not-found means absent.
 * @WHY Stop the old timer before its service so maintenance cannot race a restart.
 */
import { spawnSync } from "node:child_process";

export const WATCHDOG_SERVICE = "pi-web-ui-dev-watchdog.service";
export const WATCHDOG_TIMER = "pi-web-ui-dev-watchdog.timer";

export function createSystemd(exec = spawnSync) {
  function command(program, args, capture = false) {
    const result = exec(program, args, {
      stdio: capture ? "pipe" : "inherit", encoding: "utf8", timeout: 60_000,
    });
    if (result.error || result.status !== 0)
      throw new Error(`${program} failed: ${args.join(" ")}`, { cause: result.error });
    return result.stdout?.trim() ?? "";
  }
  const run = (args) => command("systemctl", ["--user", ...args]);
  function state(unit) {
    const output = command("systemctl", ["--user", "show",
      "--property=LoadState,ActiveState", unit], true);
    const values = Object.fromEntries(output.split("\n").map((line) => line.split("=")));
    if (!["loaded", "masked", "not-found"].includes(values.LoadState) || !values.ActiveState)
      throw new Error(`Cannot determine usable systemd state for ${unit}.`);
    return { load: values.LoadState, active: values.ActiveState };
  }
  function retireWatchdog() {
    const timer = state(WATCHDOG_TIMER);
    // A removed unit file can still have an active unit in the manager.
    const needsStop = ({ load, active }) => load !== "not-found" || !["inactive", "failed"].includes(active);
    if (needsStop(timer)) run(["stop", WATCHDOG_TIMER]);
    if (timer.load !== "not-found") run(["disable", WATCHDOG_TIMER]);
    if (needsStop(state(WATCHDOG_SERVICE))) run(["stop", WATCHDOG_SERVICE]);
  }
  function assertStopped(unit) {
    if (!["inactive", "failed"].includes(state(unit).active))
      throw new Error("Service is active; stop it explicitly before reinstalling.");
  }
  return { run, state, retireWatchdog, assertStopped,
    verify: (path) => command("systemd-analyze", ["--user", "verify", path]),
  };
}
