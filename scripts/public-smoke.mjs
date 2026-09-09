#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const base = process.env.PI_DEV_PUBLIC_URL || `http://${process.env.PI_DEV_PUBLIC_HOST || "127.0.0.1"}:${process.env.PI_DEV_PUBLIC_PORT || "8790"}`;
const tokenFile = process.env.PI_DEV_TOKEN_FILE;
assert.ok(tokenFile, "PI_DEV_TOKEN_FILE is required");
const token = readFileSync(tokenFile, "utf8").trim();
assert.match(token, /^[a-f0-9]{64}$/);
function curl(path, ...args) {
  const r = spawnSync("curl", ["--silent", "--show-error", "--max-time", "10", ...args, `${base}${path}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || `curl ${path} failed`);
  return r.stdout;
}
const unauth = spawnSync("curl", ["--silent", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "10", `${base}/`], { encoding: "utf8" });
assert.equal(unauth.stdout, "401");
const health = JSON.parse(curl("/api/health", "-H", `Authorization: Bearer ${token}`));
assert.equal(health.ok, true);
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?token=${token}`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error("WebSocket timeout")); }, 10000);
  ws.addEventListener("open", () => { clearTimeout(timer); ws.close(); resolve(); }, { once: true });
  ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket failed")); }, { once: true });
});
console.log(`PASS public curl health/authentication and WebSocket upgrade (${base})`);
