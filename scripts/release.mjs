#!/usr/bin/env node
/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/release.mjs, tests/release.test.mjs
 * @CONTRACT release <id> --commit=<reviewed full SHA>; no dirty working files are packaged.
 */
import { runRelease } from "./lifecycle/release.mjs";

try {
  const args = process.argv.slice(2);
  const action = args.shift() ?? "check";
  let commit;
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith("--commit=") && commit === undefined) commit = arg.slice(9);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("Too many release arguments.");
  const result = await runRelease({ action, id: positional[0], commit });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
