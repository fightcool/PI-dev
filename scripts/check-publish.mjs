import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const result = spawnSync("git", ["ls-files", "-z"], {
  cwd: ROOT,
  encoding: "utf8",
});
let files;
if (result.status === 0 && !result.error) {
  files = result.stdout.split("\0").filter(Boolean);
} else {
  const fallback = spawnSync("find", [ROOT, "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.venv/*", "-not", "-path", "*/.tools/*", "-not", "-path", "*/.git/*"], { encoding: "utf8" });
  if (fallback.status !== 0) throw new Error("Cannot enumerate deliverable files.");
  files = fallback.stdout.split("\n").filter(Boolean).map((file) => file.slice(ROOT.length + 1));
}
if (files.length === 0)
  throw new Error(
    "Stage the explicit deliverable files before running this check.",
  );
const forbidden =
  /(^|\/)(node_modules|\.venv|\.tools|\.pi|\.pi-web|\.pi-lens|artifacts|sessions|uploads)(\/|$)|(^|\/)(auth|models|mcp|runtime)\.json$|(^|\/)token$|\.env($|\.)|\.(pem|key|enc|db|sqlite3?|jsonl|log)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
];
let failed = false;
for (const file of files) {
  if (forbidden.test(file) && !file.endsWith(".example")) {
    console.error(`FAIL private/runtime path tracked: ${file}`);
    failed = true;
  }
  const content = readFileSync(join(ROOT, file));
  const isBinary = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|svg)$/i.test(file);
  if (!isBinary && (content.includes(0) || content.length > 5 * 1024 * 1024)) {
    console.error(`FAIL binary/oversized file: ${file}`);
    failed = true;
  }
  const source = content.toString("utf8");
  if (!/\/vscode-editor\/(?:client\/entry|src\/client)\.(?:m?js)$/.test(file) &&
    secretPatterns.some((pattern) => pattern.test(source))) {
    console.error(`FAIL suspected secret in ${file} (value redacted)`);
    failed = true;
  }
}
console.log(
  `${failed ? "FAIL" : "PASS"} publication check: ${files.length} tracked files; manual review still required`,
);
process.exitCode = failed ? 1 : 0;
