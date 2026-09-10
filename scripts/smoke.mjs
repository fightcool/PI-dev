/* 🍞 AI Breadcrumb: @COUPLED scripts/lib.mjs, scripts/lifecycle/health.mjs
 * @CONTRACT Smoke compares the configured workspace, which can differ from the release code root.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "./lib.mjs";

// Bound the complete CLI, including WebSocket close handshakes.
const deadline = setTimeout(() => { console.error("Smoke timed out"); process.exit(1); }, 60000);
deadline.unref();

const config = loadConfig();
const base = `http://${config.host}:${config.port}`;
const token = readFileSync(config.tokenFile, "utf8").trim();
const headers = { Authorization: `Bearer ${token}` };
async function get(path, authenticated = true) {
  return fetch(`${base}${path}`, {
    headers: authenticated ? headers : {},
    signal: AbortSignal.timeout(10000),
  });
}
const healthResponse = await get("/api/health", false);
assert.equal(healthResponse.status, 200);
assert.equal(
  healthResponse.headers.get("set-cookie"),
  null,
  "public health must not disclose token",
);
const health = await healthResponse.json();
assert.equal(health.ok, true);
assert.equal(health.cwd, config.workspaceDir);
assert.equal(health.engine, "pi");
if (process.env.PI_DEV_EXPECTED_PI_VERSION)
  assert.equal(health.piVersion, process.env.PI_DEV_EXPECTED_PI_VERSION);
else assert.equal(typeof health.piVersion, "string");
assert.equal(
  (await get("/", false)).status,
  200,
  "unauthenticated shell must be reachable so the browser can start login",
);
assert.equal(
  (await get("/favicon.ico", false)).status,
  200,
  "favicon must be reachable before authentication",
);
assert.equal(
  (await get("/api/invalid-route", false)).status,
  401,
  "API must require authentication",
);
const page = await get("/");
assert.equal(page.status, 200);
const html = await page.text();
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
  (match) => match[1],
);
assert.ok(assets.length > 0, "frontend entry assets must exist");
for (const asset of assets) {
  const response = await get(asset);
  assert.equal(response.status, 200, `asset ${asset}`);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
}
// No model prompt is sent; this test never spends provider credits.
const unauthenticated = new WebSocket(`ws://${config.host}:${config.port}/ws`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    unauthenticated.close();
    reject(new Error("Unauthenticated WebSocket timeout"));
  }, 10000);
  unauthenticated.addEventListener(
    "open",
    () => {
      clearTimeout(timer);
      unauthenticated.close();
      reject(new Error("WebSocket accepted without credentials"));
    },
    { once: true },
  );
  unauthenticated.addEventListener(
    "error",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
});
const ws = new WebSocket(
  `ws://${config.host}:${config.port}/ws?token=${token}`,
);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    ws.close();
    reject(new Error("WebSocket timeout"));
  }, 10000);
  ws.addEventListener(
    "open",
    () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    },
    { once: true },
  );
  ws.addEventListener(
    "error",
    () => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed"));
    },
    { once: true },
  );
});
console.log(
  `PASS health, cwd, authentication, ${assets.length} frontend assets, WebSocket upgrade`,
);
