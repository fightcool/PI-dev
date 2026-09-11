#!/usr/bin/env node
/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/release.mjs, scripts/lifecycle/release-prune.mjs, tests/release.test.mjs
 * @COUPLED tests/release-prune.test.mjs; 📖 docs/PM2-SHADOW.md「命令」
 * @CONTRACT release <id> --commit=<reviewed full SHA>; no dirty working files are packaged.
 * @CONTRACT prune [--keep=N] [--apply]：默认 dry-run；--keep/--apply 只对 prune 有效。
 */
import { runRelease } from "./lifecycle/release.mjs";

try {
  const args = process.argv.slice(2);
  const action = args.shift() ?? "check";
  let commit, keep, apply = false, dryRun = false;
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith("--commit=") && commit === undefined) commit = arg.slice(9);
    else if (arg.startsWith("--keep=")) {
      if (keep !== undefined) throw new Error("Duplicate --keep.");
      const raw = arg.slice(7);
      if (!/^\d{1,3}$/.test(raw)) throw new Error("--keep must be a non-negative integer.");
      keep = Number(raw);
    } else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("Too many release arguments.");
  if (action !== "prune" && (keep !== undefined || apply || dryRun))
    throw new Error("--keep, --apply and --dry-run are only valid for prune.");
  if (apply && dryRun) throw new Error("--apply and --dry-run are mutually exclusive.");
  const result = await runRelease({ action, id: positional[0], commit, keep, apply });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
