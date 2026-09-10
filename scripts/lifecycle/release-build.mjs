/* 🍞 AI Breadcrumb: @COUPLED scripts/release.mjs, scripts/lifecycle/release-options.mjs
 * @WHY Only git archives of reviewed commits enter releases; builds never touch source dependencies.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJson } from "../lib.mjs";
import { atomicJson } from "./files.mjs";
import { runtimeEntry } from "../start.mjs";

export function command(file, args, options = {}) {
  try { return execFileSync(file, args, { encoding: "utf8", timeout: 600000,
    maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options }); }
  catch { throw new Error(`Command failed: ${file} ${args[0] ?? ""}`); }
}

function assertArchiveTree(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Archived symlink is not a build input: ${entry.name}`);
    if (entry.isDirectory()) assertArchiveTree(join(path, entry.name));
  }
}

export function buildRelease(options, { id, commit, root, run = command }) {
  const { releases } = options;
  const target = join(releases, id);
  try { lstatSync(target); throw new Error(`Release already exists: ${id}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const verified = run("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: root }).trim();
  if (verified !== commit) throw new Error("Commit did not resolve exactly.");
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const staging = join(releases, `.build-${randomBytes(8).toString("hex")}`);
  const archive = `${staging}.tar`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    run("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: root });
    run("tar", ["-xf", archive, "-C", staging]);
    assertArchiveTree(staging);
    const env = { ...process.env, PI_DEV_BUILD_COMMIT: commit };
    atomicJson(join(staging, "release-source.json"), { commit });
    // @CONTRACT setup:dependencies installs both roots; build writes dist/build-info.json.
    run("npm", ["run", "setup:dependencies"], { cwd: staging, env });
    run("npm", ["run", "build"], { cwd: staging, env });
    runtimeEntry({ root: staging });
    const info = readJson(join(staging, "vendor/pi-web-ui/dist/build-info.json"));
    if (info.commit !== commit || typeof info.appVersion !== "string" || !Number.isFinite(Date.parse(info.builtAt)))
      throw new Error("Build provenance does not match the reviewed commit.");
    atomicJson(join(staging, ".release.json"), { id, commit, builtAt: info.builtAt });
    renameSync(staging, target);
    return target;
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
