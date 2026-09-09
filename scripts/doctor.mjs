import { existsSync, readFileSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadConfig, readJson } from "./lib.mjs";

let failed = false;
function check(ok, message) {
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) failed = true;
}
const config = loadConfig();
check(
  process.version ===
    `v${readFileSync(join(ROOT, ".node-version"), "utf8").trim()}`,
  `Node ${process.version}`,
);
const python = spawnSync(join(ROOT, ".venv/bin/python"), ["--version"], {
  encoding: "utf8",
});
const expectedPython = readFileSync(
  join(ROOT, ".python-version"),
  "utf8",
).trim();
check(
  python.status === 0 && python.stdout.trim() === `Python ${expectedPython}`,
  `project Python ${expectedPython}`,
);
const pkg = readJson(join(ROOT, "package.json"));
for (const [name, version] of Object.entries(pkg.dependencies)) {
  const path = join(ROOT, "node_modules", name, "package.json");
  check(
    existsSync(path) && readJson(path).version === version,
    `${name}@${version}`,
  );
}
check(
  existsSync(join(ROOT, "vendor/pi-web-ui/web/dist/index.html")),
  "built vendor Web frontend",
);
const webUiSdk = readJson(
  join(ROOT, "node_modules/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/package.json"),
);
check(webUiSdk.version === "0.85.1", `Web UI Pi SDK ${webUiSdk.version}`);
check(
  config.root === ROOT && config.port !== 8787,
  "dedicated project cwd and port",
);
for (const dir of [config.dataDir, config.agentDir])
  check(
    (statSync(dir).mode & 0o077) === 0,
    "private state directory permissions",
  );
check(
  (statSync(config.tokenFile).mode & 0o077) === 0,
  "private access token permissions",
);
const gib = totalmem() / 1024 ** 3;
console.log(
  `${gib >= 7.5 ? "PASS" : "WARN"} physical RAM: ${gib.toFixed(2)} GiB; provision at least 8 GiB (guest OS reserves some memory)`,
);
if (process.argv.includes("--require-8g"))
  check(gib >= 7.5, "8 GiB class guest RAM gate");
console.log(
  `${existsSync(join(config.agentDir, "auth.json")) ? "INFO" : "WARN"} provider authorization is a separate manual setup; file presence does not prove a working model call`,
);
process.exitCode = failed ? 1 : 0;
