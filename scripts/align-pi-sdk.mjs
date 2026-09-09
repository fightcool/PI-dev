import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const webUi = join(ROOT, "node_modules/pi-web-ui");
const rootSdk = join(ROOT, "node_modules/@earendil-works/pi-coding-agent");
const nestedSdk = join(
  webUi,
  "node_modules/@earendil-works/pi-coding-agent",
);

if (!existsSync(webUi) || !existsSync(rootSdk))
  throw new Error("Install dependencies before aligning the Pi SDK.");

if (existsSync(nestedSdk) || lstatSafe(nestedSdk)) rmSync(nestedSdk, { recursive: true, force: true });
mkdirSync(join(webUi, "node_modules/@earendil-works"), { recursive: true });
symlinkSync(rootSdk, nestedSdk, "junction");
console.log(`Aligned pi-web-ui to ${rootSdk}`);

function lstatSafe(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
