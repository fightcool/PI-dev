/*
 * 🍞 AI Breadcrumb: shared build entry for bootstrap, development and releases.
 * @COUPLED scripts/dependencies.mjs, scripts/release.mjs, vendor/pi-web-ui/package.json
 * @WHY Build the vendored application without modifying configuration or user data.
 */
import { existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertInactiveCheckout } from "./lifecycle/build-target.mjs";

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const app = join(root, "vendor/pi-web-ui");
assertInactiveCheckout(root);
const { readFileSync } = await import("node:fs");
const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
const sdk = JSON.parse(readFileSync(join(app, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
if (sdk.version !== pkg.dependencies["@earendil-works/pi-coding-agent"]) throw new Error("Vendored Pi SDK version differs from manifest.");
const result = spawnSync("npm", ["run", "build"], { cwd: app, stdio: "inherit" });
if (result.error || result.status !== 0) throw new Error("Application build failed.");
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const archiveInfo = join(root, "release-source.json");
const source = existsSync(archiveInfo) ? JSON.parse(readFileSync(archiveInfo, "utf8")) : {};
const protocol = readFileSync(join(app, "server/protocol-version.ts"), "utf8").match(/PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1];
mkdirSync(join(app, "dist"), { recursive: true });
writeFileSync(join(app, "dist/build-info.json"), JSON.stringify({
  commit: source.commit ?? (git.status === 0 ? git.stdout.trim() : null),
  appVersion: pkg.version,
  protocolVersion: protocol ? Number(protocol) : null,
  builtAt: new Date().toISOString(),
}, null, 2) + "\n");
