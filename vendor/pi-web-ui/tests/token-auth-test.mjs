// PI_WEB_TOKEN optional auth — protocol smoke test (zero token).
//
// When PI_WEB_TOKEN is set on the server:
//   1. /api/health stays open (monitoring probes)
//   2. The shell and immutable UI assets are public; protected API/WS routes
//      without a valid token → 401
//   3. ?token= query param accepted + Set-Cookie pi_web_token issued
//   4. Authorization: Bearer / X-PI-Token headers accepted
//   5. WS upgrade without token → rejected; with ?token= → connects
//   6. Re-entry via ?token= refreshes the cookie (idempotent, issue #71#1)
//   7. Server restart with a NEW PI_WEB_TOKEN while the browser still holds the
//      old cookie: stale cookie gets expired on 401, one ?token=new entry
//      re-syncs the cookie, no manual cache clearing needed (issue #71#2)
// Without PI_WEB_TOKEN everything behaves as before (no auth middleware).
//
// Usage: npm run build && node tests/token-auth-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const PORT = Number(process.argv[2] || 8975);
const TOKEN = "s3cret-token-xyz";
const TOKEN2 = "s3cret-token-xyz-2";
const base = mkdtempSync(join(tmpdir(), "pi-web-tokenauth-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ok - ${name}`);
	} else {
		failed++;
		console.error(`  FAIL - ${name} ${extra}`);
	}
}

/** Spawn the built server with the given PI_WEB_TOKEN; resolve when /api/health is up. */
function startServer(token, opts = {}) {
	const { port = PORT, data = dataDir, agent = agentDir, allowQueryToken, extraEnv = {} } = opts;
	const server = spawn(NODE, ["dist/server/index.js"], {
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_DATA_DIR: data,
			PI_WEB_CWD: workdir,
			PI_CODING_AGENT_DIR: agent,
			PI_WEB_TOKEN: token,
			...(allowQueryToken === undefined ? {} : { PI_WEB_ALLOW_QUERY_TOKEN: allowQueryToken ? "1" : "0" }),
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	server.stdout.on("data", () => {});
	server.stderr.on("data", () => {});
	return (async () => {
		for (let i = 0; i < 60; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/api/health`);
				if (res.ok) return server;
			} catch {
				/* not up yet */
			}
			await sleep(300);
		}
		throw new Error("server did not become ready");
	})();
}

/** 认证面加固用例（§4 复核）：限流 + 健康端点详情收敛。 */
async function hardeningChecks(token) {
	// 健康端点：直连回环（无转发头）→ 完整字段；带 X-Forwarded-* → 只回 ok/engine。
	const direct = await fetch(`http://127.0.0.1:${PORT}/api/health`);
	const directBody = await direct.json();
	check("health: direct loopback probe keeps cwd/pid/version", typeof directBody.cwd === "string" && Number.isInteger(directBody.pid) && typeof directBody.piVersion === "string");
	const forwarded = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { "x-forwarded-for": "203.0.113.7" } });
	const forwardedBody = await forwarded.json();
	check(
		"health: forwarded request hides cwd/pid/version",
		forwardedBody.ok === true && forwardedBody.engine === "pi" && forwardedBody.cwd === undefined && forwardedBody.pid === undefined && forwardedBody.piVersion === undefined,
		JSON.stringify(forwardedBody),
	);
	const authed = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.7" } });
	const authedBody = await authed.json();
	check("health: authenticated request keeps details even when forwarded", typeof authedBody.cwd === "string");

	// 恢复码限流：第 11 次尝试必须是 429 + Retry-After（前 10 次按无效码回 401）。
	let limited = null;
	for (let i = 1; i <= 11; i++) {
		const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/recovery`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: `wrong-code-${i}` }),
		});
		if (res.status === 429) { limited = res; break; }
		if (res.status !== 401) { check("recovery: invalid code → 401 before the limit", false, `status ${res.status}`); return; }
	}
	check("recovery: rate limit kicks in with 429", Boolean(limited));
	check("recovery: 429 carries Retry-After", Boolean(limited && Number(limited.headers.get("retry-after")) >= 1), limited?.headers.get("retry-after") ?? "none");

	// 口令登录共用同一类限流（独立桶）：连续错误口令最终 429。
	let loginLimited = false;
	for (let i = 1; i <= 11; i++) {
		const res = await fetch(`http://127.0.0.1:${PORT}/login`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: `token=wrong-${i}`,
			redirect: "manual",
		});
		if (res.status === 429) { loginLimited = true; break; }
	}
	check("login: wrong token is rate limited with 429", loginLimited);
}

/** `?token=` 回落可用开关关闭（§4 S6 的文档化缓解手段，这里做回归保护）。 */
async function queryTokenDisabledCheck() {
	const port = PORT + 3;
	const base = mkdtempSync(join(tmpdir(), "pi-web-querytoken-"));
	const server = await startServer(TOKEN, { port, data: join(base, "data"), agent: join(base, "agent"), allowQueryToken: false });
	try {
		const origin = `http://127.0.0.1:${port}`;
		const viaQuery = await fetch(`${origin}/api/themes?token=${TOKEN}`);
		check("PI_WEB_ALLOW_QUERY_TOKEN=0 → query token rejected on a protected route", viaQuery.status === 401, `status ${viaQuery.status}`);
		const viaHeader = await fetch(`${origin}/api/themes`, { headers: { authorization: `Bearer ${TOKEN}` } });
		check("PI_WEB_ALLOW_QUERY_TOKEN=0 → header token still accepted", viaHeader.status === 200, `status ${viaHeader.status}`);
		const cookie = (viaHeader.headers.get("set-cookie") ?? "").split(";")[0];
		const viaCookie = await fetch(`${origin}/api/themes`, { headers: { cookie } });
		check("PI_WEB_ALLOW_QUERY_TOKEN=0 → cookie session still accepted", viaCookie.status === 200, `status ${viaCookie.status}`);
	} finally {
		await stopServer(server);
	}
}

async function stopServer(server) {
	if (server?.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
}

/** Minimal cookie jar: collect Set-Cookie (incl. expiry) from a response. */
let jar = "";
function jarHeader(res) {
	const all = [];
	for (const h of ["set-cookie"]) {
		if (res.headers.has(h)) all.push(res.headers.get(h));
	}
	return all.join("; ");
}
function applyJar(res) {
	const set = jarHeader(res);
	if (!set) return;
	// replace any existing pi_web_token entry with the newest one
	const entry = set.split("; ").find((part) => part.startsWith("pi_web_token="));
	if (!entry) return;
	const value = entry.split("=").slice(1).join("=") ?? "";
	const expires = value === "" || value.includes("Max-Age=0");
	jar = expireJar(jar);
	if (!expires) jar = `pi_web_token=${value}`;
}
function expireJar(incoming) {
	return (incoming || "")
		.split("; ")
		.filter((part) => part && !part.startsWith("pi_web_token="))
		.join("; ");
}
function httpGet(path, headers = {}) {
	return fetch(`http://127.0.0.1:${PORT}${path}`, {
		headers: jar ? { cookie: jar, ...headers } : headers,
	});
}

/** WS connect that resolves only when the socket opens; rejects otherwise. */
function wsTry(path, headers = {}) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, headers && { headers });
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error("timeout"));
		}, 4000);
		ws.on("open", () => {
			clearTimeout(timer);
			ws.close();
			resolve(true);
		});
		ws.on("error", (err) => {
			clearTimeout(timer);
			resolve({ error: err.message }); // upgrade rejection surfaces here
		});
	});
}

let server = null;
try {
	server = await startServer(TOKEN);

	// 1. health is open even with token auth enabled
	const h = await fetch(`http://127.0.0.1:${PORT}/api/health`);
	check("health open without token", h.status === 200);

	// 1b. health must NOT reflect the real token via Set-Cookie (issue #45)
	const hc = jarHeader(h);
	check(
		"health does NOT leak pi_web_token in Set-Cookie",
		!hc.includes(`pi_web_token=${encodeURIComponent(TOKEN)}`),
		hc || "<no set-cookie>",
	);
	check("health issues no Set-Cookie at all", hc === "", hc || "<no set-cookie>");

	// 2. the shell is public so the browser can load the auth gate; APIs remain protected
	const r1 = await httpGet("/");
	check("GET / without token → 200 shell", r1.status === 200);
	const asset = await httpGet("/favicon.svg");
	check("favicon asset is public", asset.status === 200);
	const r2 = await httpGet("/?token=wrong");
	check("GET / with wrong token → 200 shell", r2.status === 200);
	const api = await httpGet("/api/themes");
	check("GET /api/themes without token → 401", api.status === 401);

	// 2b. existing-cookie-but-wrong-token requests keep the public shell
	// available, but clear the stale cookie so the next authenticated request
	// cannot accidentally reuse it.
	const r2b = await httpGet("/", { cookie: `pi_web_token=${encodeURIComponent("nope")}` });
	check("GET / with stale cookie value → 200 shell", r2b.status === 200);
	const sc2b = jarHeader(r2b);
	check(
		"401 with stale cookie expires it (Max-Age=0)",
		sc2b.includes("Max-Age=0") && sc2b.includes("pi_web_token=;"),
		sc2b,
	);

	// 3. query-param token accepted and cookie issued
	const r3 = await httpGet(`/?token=${encodeURIComponent(TOKEN)}`);
	check("GET / with ?token= → 200", r3.status === 200);
	const setCookie = jarHeader(r3);
	check(
		"Set-Cookie issues HttpOnly pi_web_token",
		setCookie.includes("pi_web_token=") && setCookie.toLowerCase().includes("httponly"),
		setCookie,
	);
	applyJar(r3);

	// 3b. re-entry with the same valid ?token= is idempotent (issue #71#1):
	// cookie still matches the server token, so no refresh needed but 200 anyway
	const r3b = await httpGet(`/?token=${encodeURIComponent(TOKEN)}`);
	check("GET / again with same ?token= → 200", r3b.status === 200);

	// 4. header-based tokens accepted
	const r4 = await httpGet("/", { authorization: `Bearer ${TOKEN}` });
	check("Authorization: Bearer accepted", r4.status === 200);
	const r5 = await httpGet("/", { "x-pi-token": TOKEN });
	check("X-PI-Token header accepted", r5.status === 200);

	// 5. WS handshake enforcement
	const wsNoToken = await wsTry("/ws");
	check("WS without token rejected", typeof wsNoToken === "object", JSON.stringify(wsNoToken));
	const wsOk = await wsTry(`/ws?token=${encodeURIComponent(TOKEN)}`);
	check("WS with ?token= connects", wsOk === true, JSON.stringify(wsOk));
	const wsBad = await wsTry("/ws?token=nope");
	check("WS with wrong token rejected", typeof wsBad === "object");

	// ---- issue #71#2: server token changed while the browser still holds the old cookie ----
	await stopServer(server);
	server = await startServer(TOKEN2); // restart with a NEW secret

	// 7a. old cookie alone still gets expired while the public shell remains
	// reachable (no cache clearing needed later).
	const stale1 = await httpGet("/");
	check("GET / with stale cookie after token change → 200 shell", stale1.status === 200);
	const scStale = jarHeader(stale1);
	check(
		"stale cookie expired on 401 (Max-Age=0)",
		scStale.includes("Max-Age=0") && scStale.includes("pi_web_token=;"),
		scStale,
	);
	check("stale-cookie shell does not expose an auth error", !(await stale1.text()).includes("口令已变更"), "<body>");
	applyJar(stale1); // jar now empty — browser would have dropped the cookie

	// 7b. one correct ?token= entry re-syncs the cookie to the new secret
	const heal = await httpGet(`/?token=${encodeURIComponent(TOKEN2)}`);
	check("GET /?token=new after token change → 200", heal.status === 200);
	const scHeal = jarHeader(heal);
	check(
		"healed cookie now carries the NEW token",
		scHeal.includes(`pi_web_token=${encodeURIComponent(TOKEN2)}`),
		scHeal,
	);
	applyJar(heal);

	// 7c. subsequent plain navigation works from the healed cookie alone
	const healedNav = await httpGet("/");
	check("GET / with healed cookie (no query) → 200", healedNav.status === 200);
	const wsHealed = await wsTry("/ws", { cookie: jar });
	check("WS with healed cookie connects", wsHealed === true, JSON.stringify(wsHealed));

	// 8. 认证面加固（§4 复核结论：限流 + 健康端点详情收敛 + query token 可关）。
	await hardeningChecks(TOKEN2);
	await queryTokenDisabledCheck();

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	await stopServer(server);
	process.exit(failed === 0 ? 0 : 1);
}
