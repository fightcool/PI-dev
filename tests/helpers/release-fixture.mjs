/* 🍞 AI Breadcrumb: @COUPLED tests/release.test.mjs, scripts/lifecycle/release.mjs
 * @CONTRACT Test-only git repository, build and managed Node child; never invoke a real PM2 daemon.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { ROOT } from "../../scripts/lib.mjs";
import { runRelease } from "../../scripts/lifecycle/release.mjs";
import { createServer } from "node:net";

export async function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "pi-release-"));
  const repo = join(temp, "source"), base = join(temp, "deploy with spaces");
  mkdirSync(repo);
  cpSync(join(ROOT, "scripts"), join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "deploy"));
  cpSync(join(ROOT, "deploy/ecosystem.config.cjs"), join(repo, "deploy/ecosystem.config.cjs"));
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = { ...process.env, HOME: temp, PI_DEV_DEPLOY_ROOT: base,
    PI_DEV_CONFIG_DIR: join(base, "shared/config"), PI_DEV_STATE_DIR: join(base, "shared/state"),
    PM2_HOME: join(base, "shared/pm2"), PI_DEV_SHADOW_PORT: String(port) };
  delete env.PI_DEV_PORT;
  delete env.PI_DEV_CWD;
  const events = [], children = [];
  let child, failure, healthBroken = false, definition;
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: {
    "setup:dependencies": "node fixture-setup.mjs", build: "node fixture-build.mjs",
  } }));
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, "fixture-setup.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync('setup-ran', process.cwd());`);
  writeFileSync(join(repo, "fixture-build.mjs"), `
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
if (readFileSync('setup-ran','utf8') !== process.cwd()) throw Error('wrong build root');
mkdirSync('vendor/pi-web-ui/dist/server', {recursive:true});
writeFileSync('vendor/pi-web-ui/dist/server/index.js', \`
import {createServer} from 'node:http';
createServer((req,res) => {res.setHeader('Content-Type','application/json');
res.end(JSON.stringify({ok: process.env.FIXTURE_HEALTH !== 'bad',engine:'pi',cwd:process.cwd(),pid:process.pid,piVersion:'fixture'}));
}).listen(Number(process.env.PI_WEB_PORT), process.env.PI_WEB_HOST);
\`);
writeFileSync('vendor/pi-web-ui/dist/build-info.json', JSON.stringify({commit:JSON.parse(readFileSync('release-source.json','utf8')).commit,appVersion:'fixture',builtAt:new Date().toISOString()}));
`);
  function git(args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  git(["init", "--quiet"]);
  git(["add", "."]);
  // Creates a commit only inside this disposable fixture, never the working repository.
  const tree = git(["write-tree"]);
  const commit = execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-m", "release fixture"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "untracked-private.txt"), "must never enter the archive");
  writeFileSync(join(repo, "package.json"), "dirty invalid package file");
  const run = (file, args, opts = {}) => {
    events.push({ file, args, cwd: opts.cwd, env: opts.env });
    if (file === "npm") {
      if (failure === args[1]) throw new Error("fixture build failure");
      return execFileSync(process.execPath, [args[1] === "build" ? "fixture-build.mjs" : "fixture-setup.mjs"],
        { ...opts, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    }
    if (file !== "pm2") return execFileSync(file, args, { ...opts, encoding: "utf8" });
    if (args[0] === "startOrRestart") {
      definition = JSON.parse(execFileSync(process.execPath, ["-e", "console.log(JSON.stringify(require(process.argv[1])))", args[1]],
        { env: opts.env, encoding: "utf8" })).apps[0];
      if (child) child.kill("SIGTERM");
      const root = realpathSync(definition.cwd);
      child = spawn(definition.interpreter, [definition.script], {
        cwd: root, env: { ...opts.env, ...definition.env, FIXTURE_HEALTH: healthBroken && root.endsWith("/bad") ? "bad" : "ok" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      return "";
    }
    if (args[0] === "jlist") return JSON.stringify(child ? Array.from({ length: definition.instances }, () =>
      ({ name: definition.name, pid: child.pid, pm2_env: { exec_mode: `${definition.exec_mode}_mode` } })) : []);
    if (["delete", "stop"].includes(args[0])) { if (child) child.kill("SIGTERM"); child = undefined; return ""; }
    throw new Error(`Unexpected PM2 command: ${args[0]}`);
  };
  t.after(async () => {
    for (const process of children) {
      if (process.exitCode === null && process.signalCode === null) {
        const exited = once(process, "exit"); process.kill("SIGKILL"); await exited;
      }
    }
    rmSync(temp, { recursive: true, force: true });
  });
  return { temp, repo, base, env, commit, events, run,
    release: (action, id, extra = {}) => runRelease({ action, id, commit: action === "release" ? commit : undefined,
      root: repo, env, run, healthTimeout: 1500, ...extra }),
    failBuild: step => { failure = step; }, failHealth: () => { healthBroken = true; },
    current: () => existsSync(join(base, "current")) ? realpathSync(join(base, "current")) : null,
    json: path => JSON.parse(readFileSync(join(base, path), "utf8")),
  };
}
