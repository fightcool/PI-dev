import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT, loadConfig, runtimeEnv } from "./lib.mjs";

const config = loadConfig();
const child = spawn(
  config.node,
  [
    join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    ...process.argv.slice(2),
  ],
  { cwd: ROOT, env: runtimeEnv(config), stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
