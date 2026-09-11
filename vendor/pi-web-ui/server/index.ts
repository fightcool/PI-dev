/**
 * pi-web-ui server entry.
 * 🍞 @COUPLED initial-snapshot-gate.ts / web/src/use-chat.ts: pi hello supplies
 * one full baseline after plugins; later get_state remains a full resync.
 *
 * - Serves the built frontend (web/dist) in production; in dev, Vite serves it
 *   on :5173 and proxies /ws to this server.
 * - Exposes /api/health and a WebSocket endpoint at /ws carrying the chat
 *   protocol defined in protocol.ts.
 *
 * Env:
 *   PI_WEB_PORT     HTTP port (default 8787)
 *   PI_WEB_CWD      workspace the agent operates in (default: process.cwd())
 *   PI_WEB_DATA_DIR where per-client UI state is stored (client-state.json,
 *   default: <home>/.pi-web). Chat sessions are NOT stored here — they live
 *   in the pi agent's global TUI session dir (~/.pi/agent/sessions/--<cwd>--/)
 *   via the SDK default, so this web UI, the dev instance, and the pi CLI/TUI
 *   all share one conversation list per project.
 *   PI_CODING_AGENT_DIR  pi config dir (auth/models/skills) — passed to the SDK
 */
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import compression from "compression";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { InitialSnapshotGate } from "./initial-snapshot-gate.js";
import { logPhase, startTrace, type TimingTrace } from "./timing.js";

/**
 * Upper bound on waiting for an in-flight disk catch-up reload before sending the
 * baseline anyway (see the hello handler). Reloads measure well under this; the
 * bound only exists so a stuck reload can never leave the chat pane empty.
 * @MAGIC 1500ms ≫ observed reload cost (open + runtime creation, ~0.1–0.3s).
 */
const BASELINE_DISK_SYNC_MAX_MS = 1500;
import { PROTOCOL_VERSION } from "./protocol-version.js";
import { AgentService, workspacePath, QuiesceRejectedError } from "./agent-service.js";
import { isAbsoluteWirePath, wireToAbs } from "./files-service.js";
import { previewKind } from "./text-sniff.js";
import { startControlServer } from "./control-socket.js";
import { scheduleUploadCleanup } from "./uploads.js";
import { ensureWindowsBash, windowsBashDir } from "./ensure-bash.js";
import { listThemes, resolveThemeFile } from "./themes.js";
import { isManaged, managedRefusal } from "./managed.js";
import { parseTabs, tabsRefusal } from "./tabs.js";
import {
	installPack,
	isKnownPack,
	listPacks,
	loadServerStrings,
	readPackFile,
	removePack,
	unloadServerStrings,
} from "./locales.js";
import {
	PluginManager,
	resolvePluginClientFile,
	type PluginConversationSnapshot,
	type PluginRunEvent,
} from "./plugins.js";
import { McpBridge } from "./mcp-bridge.js";
import { WebAuthnAuth } from "./webauthn-auth.js";
import type {
	BgServer,
	ClientMessage,
	CommandDef,
	PromptAttachment,
	ServerMessage,
	UiSubagentTemplate,
} from "./protocol.js";

/** 从 CLI 参数中取 flag 值：支持 --flag value 与 --flag=value 两种写法。
 *  让 `node dist/server/index.js --host 0.0.0.0 --port 9000` 这类直接启动也能生效，
 *  而不只是经由 bin/pi-web-ui.mjs 的 env 转发。bin 仍是主入口，此处仅作兜底。 */
function cliFlag(name: string): string | undefined {
	const eq = `${name}=`;
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === name && i + 1 < process.argv.length) return process.argv[i + 1];
		if (a.startsWith(eq)) return a.slice(eq.length);
	}
	return undefined;
}

const PORT = Number(cliFlag("--port") ?? process.env.PI_WEB_PORT ?? 8787);
const CWD = resolve(cliFlag("--cwd") ?? process.env.PI_WEB_CWD ?? process.cwd());
const DATA_DIR = resolve(cliFlag("--data-dir") ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));

/** Bind address. Default is loopback ONLY — the service is a local personal
 *  tool and should not be reachable from the network unless explicitly asked
 *  (e.g. PI_WEB_HOST=0.0.0.0 for LAN access / Docker port mapping). */
const HOST = cliFlag("--host") ?? process.env.PI_WEB_HOST ?? "127.0.0.1";
/** Optional strict hostname allowlist (comma-separated) — only used when set.
 *  Origin / Host same-authority matching happens regardless. */
const ALLOW_HOSTS = (process.env.PI_WEB_ALLOW_HOSTS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
/** Optional extra Origins allowed through the same-authority check (comma-
 *  separated, e.g. reverse-proxy setups where the browser origin differs
 *  from the Host the backend sees). */
const ALLOW_ORIGINS = (process.env.PI_WEB_ALLOW_ORIGINS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
/** 可选共享口令（PI_WEB_TOKEN）：设置后所有 HTTP/WS 请求必须携带——
 *  Authorization: Bearer / X-PI-Token 头、?token= 查询参数或 pi_web_token cookie
 *  任一匹配即可；供 0.0.0.0 / 反代等暴露场景兜底，未设置则行为不变。 */
const AUTH_TOKEN = process.env.PI_WEB_TOKEN?.trim() ?? "";
/** Query tokens are a compatibility mode; disable in exposed deployments. */
const ALLOW_QUERY_TOKEN = process.env.PI_WEB_ALLOW_QUERY_TOKEN !== "0";

/** 语言包下载根（语言包仓库的 raw 文件地址；版本 tag 优先、main 兜底，见 locales.ts）。 */
const LOCALE_BASE_URL =
	process.env.PI_WEB_LOCALE_BASE_URL?.trim() || "https://raw.githubusercontent.com/xing-shuyin/pi-web-ui";
/**
 * 本包版本 —— 下载语言包时优先取同版本 tag，保证 key 对齐。
 *
 * Read on first use, not here. `resolvePkgRoot()` is hoisted, but it reads
 * `here`, which is a `const` declared further down: calling it at module-init
 * time throws on the temporal dead zone, the catch swallows it, and the
 * version was silently "" — so the language packs never used the version tag
 * and always fell back to `main`. Reading it lazily costs one branch and
 * gives the real number.
 */
let appVersionCache: string | null = null;
function appVersion(): string {
	if (appVersionCache === null) {
		try {
			const pkg = JSON.parse(readFileSync(join(resolvePkgRoot(), "package.json"), "utf8")) as { version?: string };
			appVersionCache = pkg.version ?? "";
		} catch {
			appVersionCache = "";
		}
	}
	return appVersionCache;
}
// Root of the SDK default per-project session dirs — chat transcripts live in
// <SESSION_DIR_ROOT>/--<cwd>--/, shared with the pi CLI/TUI (getAgentDir
// honors PI_CODING_AGENT_DIR).
const SESSION_DIR_ROOT = join(getAgentDir(), "sessions");

// Windows 轻量 bash 兜底：把 <home>/.pi-web/bin 前置到 PATH（SDK 的 bash 工具经
// findBashOnPath 会找到其中的 bash.exe），并在无 Git Bash 时后台下载 busybox-w32。
// 终端面板的 shell 探测链也已包含该目录（见 terminals.ts resolveShell）。
if (process.platform === "win32") {
	process.env.PATH = `${windowsBashDir()}${delimiter}${process.env.PATH ?? ""}`;
	void ensureWindowsBash();
}

const app = express();
app.use(express.json({ limit: "10mb" }));

const webauthn = new WebAuthnAuth(
	DATA_DIR,
	process.env.PI_WEB_RP_ID ?? "localhost",
	process.env.PI_WEB_ORIGIN ?? "http://localhost:8787",
);
void webauthn.load();
app.post(["/api/auth/register/options", "/dev/api/auth/register/options"], async (_req, res) => {
	try {
		res.json(await webauthn.registrationOptions());
	} catch (e) {
		// A credential is intentionally single-registration. Do not let an
		// already-registered device crash Express via an unhandled rejection;
		// return a recoverable client error instead.
		res.status(409).json({ error: e instanceof Error ? e.message : "注册不可用" });
	}
});
app.post(["/api/auth/register/verify", "/dev/api/auth/register/verify"], async (req, res) => {
	try {
		res.json(await webauthn.registration(req.body));
	} catch {
		res.status(400).json({ error: "认证失败" });
	}
});
app.post(["/api/auth/login/options", "/dev/api/auth/login/options"], async (_req, res) =>
	res.json(await webauthn.authenticationOptions()),
);
app.post(["/api/auth/login/verify", "/dev/api/auth/login/verify"], async (req, res) => {
	try {
		const t = await webauthn.authentication(req.body);
		res.setHeader("Set-Cookie", `pi_web_session=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
		res.json({ verified: true });
	} catch {
		res.status(401).json({ error: "认证失败" });
	}
});
/**
 * 认证面固定窗口限流（§4 复核结论：恢复码与口令登录此前无限频）。
 * 单用户实例部署在回环 + 反向代理后，远端地址可能都是代理地址，因此按
 * 「socket 远端地址」分桶（实际等同全局窗口）。命中即 429 + Retry-After。
 * @MAGIC AUTH_WINDOW_MS=60_000 / AUTH_MAX_ATTEMPTS=10（每窗口每桶）。
 */
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_ATTEMPTS = 10;
const authAttempts = new Map<string, { count: number; resetAt: number }>();
function authRateLimited(bucket: string, now = Date.now()): { limited: boolean; retryAfterSec: number } {
	const entry = authAttempts.get(bucket);
	if (!entry || entry.resetAt <= now) {
		authAttempts.set(bucket, { count: 1, resetAt: now + AUTH_WINDOW_MS });
		return { limited: false, retryAfterSec: 0 };
	}
	entry.count += 1;
	if (entry.count > AUTH_MAX_ATTEMPTS) return { limited: true, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
	return { limited: false, retryAfterSec: 0 };
}
/** 成功即清空该桶，避免正常用户被自己之前的失败计数拖累。 */
function authRateLimitReset(bucket: string): void {
	authAttempts.delete(bucket);
}
const authBucket = (req: { socket?: { remoteAddress?: string } }, kind: string): string => `${kind}:${req.socket?.remoteAddress ?? "unknown"}`;

app.post(["/api/auth/recovery", "/dev/api/auth/recovery"], async (req, res) => {
	const bucket = authBucket(req, "recovery");
	const gate = authRateLimited(bucket);
	if (gate.limited) {
		res.setHeader("Retry-After", String(gate.retryAfterSec));
		return res.status(429).json({ error: "尝试过于频繁，请稍后重试" });
	}
	const t = await webauthn.recovery(String(req.body?.code ?? ""));
	if (!t) return res.status(401).json({ error: "恢复码无效" });
	authRateLimitReset(bucket);
	res.setHeader("Set-Cookie", `pi_web_session=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
	res.json({ verified: true });
});
app.post(["/api/auth/revoke", "/dev/api/auth/revoke"], async (req, res) => {
	await webauthn.revoke(String(req.body?.token ?? ""));
	res.json({ ok: true });
});

/** Same-origin transition login: the secret is accepted only in a POST body and
 * exchanged for an HttpOnly cookie. WebAuthn is intentionally not claimed here. */
app.get(["/login", "/dev/login"], (_req, res) => {
	if (!AUTH_TOKEN) {
		res.status(404).send("登录未启用");
		return;
	}
	res
		.type("html")
		.send(
			`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录</title><style>body{font:16px system-ui;max-width:28rem;margin:15vh auto;padding:1rem}input,button{font:inherit;padding:.6rem;margin:.4rem 0;width:100%}code{background:#f2f2f2;padding:.1rem .35rem;border-radius:4px} .row{display:flex;gap:.4rem} .row input{flex:1} .row button{width:auto;flex:none}</style><script>function toggle(s){var i=document.getElementById('t');i.type=i.type==='password'?'text':'password';s.textContent=i.type==='password'?'显示':'隐藏'}</script><h1>同域登录</h1><p>请输入服务器访问口令。口令不会写入 URL 或浏览器存储。</p><p>口令在服务器上，运行 <code>cat ~/.config/pi-dev/token</code> 查看。</p><form method="post" action="/dev/login"><div class="row"><input id="t" name="token" type="password" autocomplete="current-password" required><button type="button" onclick="toggle(this)">显示</button></div><button>登录</button></form>`,
		);
});
app.use(express.urlencoded({ extended: false }));
app.post(["/login", "/dev/login"], (req, res) => {
	const bucket = authBucket(req, "login");
	const gate = authRateLimited(bucket);
	if (gate.limited) {
		res.setHeader("Retry-After", String(gate.retryAfterSec));
		res.status(429).type("html").send('尝试过于频繁，请稍后重试。<a href="/login">返回</a>');
		return;
	}
	const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
	if (!token || token !== AUTH_TOKEN) {
		res.status(401).type("html").send('登录失败：口令不正确。<a href="/login">重试</a>');
		return;
	}
	res.setHeader(
		"Set-Cookie",
		`pi_web_token=${encodeURIComponent(AUTH_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
	);
	res.redirect("/");
});

/** 从请求中提取候选 token：头 / 查询参数 / cookie（浏览器导航场景靠 cookie 续命）。 */
function requestTokens(req: { headers: IncomingMessage["headers"]; url?: string }): string[] {
	const out: string[] = [];
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.startsWith("Bearer ")) out.push(auth.slice(7).trim());
	const header = req.headers["x-pi-token"];
	if (typeof header === "string") out.push(header.trim());
	try {
		if (ALLOW_QUERY_TOKEN) {
			const q = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
			if (q) out.push(q.trim());
		}
	} catch {
		/* ignore malformed url */
	}
	const cookie = req.headers.cookie;
	if (typeof cookie === "string") {
		for (const part of cookie.split(";")) {
			const [k, ...rest] = part.trim().split("=");
			if (k === "pi_web_token") out.push(rest.join("=").trim());
		}
	}
	return out.filter(Boolean);
}

function tokenOk(req: Parameters<typeof requestTokens>[0]): boolean {
	if (requestTokens(req).includes(AUTH_TOKEN)) return true;
	const cookie = req.headers.cookie;
	const match = typeof cookie === "string" ? cookie.match(/(?:^|;\s*)pi_web_session=([^;]+)/) : null;
	return !!match && webauthn.valid(decodeURIComponent(match[1]));
}

/** 请求携带的 pi_web_token cookie 值（未带/损坏时为空串）。 */
function cookieToken(req: { headers: IncomingMessage["headers"] }): string {
	const cookie = req.headers.cookie;
	if (typeof cookie !== "string") return "";
	for (const part of cookie.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === "pi_web_token") return rest.join("=").trim();
	}
	return "";
}

if (AUTH_TOKEN) {
	// The shell page and its immutable frontend assets must be reachable before
	// the browser can run auth-token.ts and establish the HttpOnly cookie. API,
	// WebSocket, and workspace data remain protected below.
	const isPublicUiAsset = (path: string): boolean =>
		path === "/favicon.ico" ||
		path === "/favicon.svg" ||
		path === "/manifest.webmanifest" ||
		path === "/sw.js" ||
		path.startsWith("/assets/") ||
		path.startsWith("/icons/");
	// /api/health 保持开放：无敏感信息，容器/监控探针需要它。
	// 但绝不能因命中 /api/health 就反射下发真实 token cookie（安全漏洞：issue #45）。
	app.use((req, res, next) => {
		const ok = tokenOk(req);
		const cookie = cookieToken(req);
		// 浏览器经 ?token= 首次进入后下发 HttpOnly cookie，后续导航/资源请求免带参数。
		// 重要：只要请求携带着有效 token（query/header/cookie 任一匹配）就把 cookie 刷新为
		// 当前 AUTH_TOKEN——服务端重启改了 PI_WEB_TOKEN 后，旧 cookie 经一次正确的
		// ?token= 进入即被重新同步，无需用户清缓存（issue #71）。
		if (ok) {
			if (cookie !== encodeURIComponent(AUTH_TOKEN)) {
				res.setHeader(
					"Set-Cookie",
					`pi_web_token=${encodeURIComponent(AUTH_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
				);
			}
		} else if (cookie) {
			// 请求带的 cookie 已是失效旧值（服务端口令已更换）——立即让其过期，
			// 避免浏览器被残留 cookie 卡死一年（本来也不该再信任它鉴权）。
			res.setHeader("Set-Cookie", "pi_web_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
		}
		if (req.path === "/api/health" || req.path.startsWith("/api/auth/") || isPublicUiAsset(req.path) || ok) {
			next();
			return;
		}
		if (req.path === "/" || req.path === "/dev/" || req.path === "/dev") {
			next();
			return;
		}

		res
			.status(401)
			.send(
				cookie
					? "unauthorized: PI_WEB_TOKEN required — 服务端口令已变更？已清除旧 token cookie，请用当前 ?token= 重新进入"
					: "unauthorized: PI_WEB_TOKEN required (?token=…)",
			);
	});
}

/** 引擎选择：PI_WEB_ENGINE=pi|dsh（默认 pi）。重启生效。 */
const ENGINE: "pi" | "dsh" = process.env.PI_WEB_ENGINE === "dsh" ? "dsh" : "pi";

/** PI_WEB_MANAGED=1: this instance is updated by whoever deploys it. */
const MANAGED = isManaged();
/** PI_WEB_TABS: the tabs this instance offers. null = all of them, as before. */
const TABS = parseTabs();

/**
 * 健康端点：探针必须能匿名拿到 `ok`，但**绝对工作区路径/进程号/版本**只在
 * 「已鉴权」或「直连回环且未经代理转发」时返回（§4 复核：公网暴露绝对路径与 PID 无必要）。
 * @GOTCHA 反向代理若注入 X-Forwarded-*，远端请求即便落到回环也不返回详情；
 *          容器/CI 的健康探针直连回环、不带转发头，因此仍然拿到完整字段。
 */
const healthForwarded = (req: { headers: IncomingMessage["headers"] }): boolean =>
	Boolean(req.headers["x-forwarded-for"] || req.headers["x-forwarded-proto"] || req.headers["x-real-ip"]);
const healthLoopback = (req: { socket?: { remoteAddress?: string } }): boolean => {
	const address = req.socket?.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
};
app.get("/api/health", (req, res) => {
	const detailed = (AUTH_TOKEN ? tokenOk(req) : false) || (healthLoopback(req) && !healthForwarded(req));
	res.json({
		ok: true,
		engine: ENGINE,
		...(detailed ? { piVersion: VERSION, cwd: CWD, pid: process.pid } : {}),
	});
});

/**
 * Stream a workspace file over HTTP.
 *
 * Media preview (no download param): only image/video kinds are served —
 * text goes over the WebSocket, and exe/jar/etc. are never exposed here.
 * express's sendFile handles Range requests, so video seeking works.
 *
 * Download (?download=1): any file kind is served with
 * Content-Disposition: attachment so the browser saves it instead of
 * rendering. Path is validated against the workspace root either way.
 */
app.get("/api/file", async (req, res) => {
	try {
		const raw = typeof req.query.path === "string" ? req.query.path : "";
		// Resolve against the requesting client's workspace (the opened
		// project), not the server's startup cwd — they can differ when the
		// client switched projects or restored a previous workspace. Fall
		// back to the server cwd for requests without a known client.
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		const absWire = isAbsoluteWirePath(raw);
		let abs: string;
		if (absWire) {
			abs = wireToAbs(raw);
		} else {
			const wp = workspacePath(root, raw);
			if (!wp) {
				res.status(400).end("path outside workspace");
				return;
			}
			abs = wp.abs;
		}
		const name = basename(abs);
		const kind = previewKind(name);
		const isDownload = req.query.download === "1";
		if (!isDownload && kind !== "image" && kind !== "video") {
			res.status(400).end("not a previewable media file");
			return;
		}
		const st = await stat(abs);
		if (!st.isFile()) {
			res.status(400).end("not a file");
			return;
		}
		if (isDownload) {
			// res.download sets Content-Disposition: attachment and RFC 5987
			// filename* encoding for non-ASCII names.
			res.download(abs, name);
		} else {
			res.sendFile(abs);
		}
	} catch {
		res.status(404).end("not found");
	}
});

// Production: serve the built frontend from web/dist. Resolve relative to this
// module so it works when installed as a package (global/npx/Docker), not just
// from the repo root. In dev, Vite serves the UI on :5173 and proxies /ws.
const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/dist/server or <pkg>/server
// Resolve the package root robustly: dev runs from <repo>/server (tsx), prod
// from <pkg>/dist/server — the ancestor that actually has package.json wins.
function resolvePkgRoot(): string {
	// 可选：显式指定 pkgRoot（如部署在自定义目录时），否则按候选路径探测。
	if (process.env.PI_WEB_PKG_ROOT) return process.env.PI_WEB_PKG_ROOT;
	const candidates = [resolve(here, ".."), resolve(here, "..", ".."), resolve(here, "..", "..", "..")];
	for (const c of candidates) {
		if (existsSync(join(c, "package.json"))) return c;
	}
	return candidates[0];
}
const pkgRoot = resolvePkgRoot();
// Theme CSS files: complete standalone stylesheets. Builtin themes ship in
// <pkg>/themes (npm files whitelist); user themes can be dropped into
// <dataDir>/themes and are served alongside (user wins on id collision).
const BUILTIN_THEMES_DIR = join(pkgRoot, "themes");
const USER_THEMES_DIR = join(DATA_DIR, "themes");

app.get("/api/themes", (_req, res) => {
	res.json({ themes: listThemes(BUILTIN_THEMES_DIR, USER_THEMES_DIR) });
});
// 语言包：核心只随包发布中英，其余按需下载到 <dataDir>/locales/<code>.json。
// 手工放进去的同名 JSON 也会被识别（离线安装）。PI_WEB_TOKEN 鉴权自动覆盖。
/**
 * PI_WEB_LOCALE — the language a first visit falls back to.
 *
 * It is a fallback, not an override: an explicit choice, and then the
 * browser's own languages, come first (web/src/pick-locale.ts). It rides on
 * /api/locales because the client already asks for that at boot, so naming a
 * default costs no extra request.
 */
const DEFAULT_LOCALE = (process.env.PI_WEB_LOCALE ?? "").trim().toLowerCase() || null;

app.get("/api/locales", (_req, res) => {
	res.json({ packs: listPacks(DATA_DIR), defaultLocale: DEFAULT_LOCALE });
});
app.get("/api/locales/:code", (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(404).end("unknown locale");
		return;
	}
	const pack = readPackFile(DATA_DIR, code);
	if (!pack) {
		res.status(404).end("locale not installed");
		return;
	}
	res.setHeader("Cache-Control", "no-cache");
	res.json(pack);
});
app.post("/api/locales/:code/install", async (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(400).json({ error: `unknown locale: ${code}` });
		return;
	}
	try {
		const meta = await installPack(DATA_DIR, code, { baseUrl: LOCALE_BASE_URL, version: appVersion() });
		// 新包可能自带 serverStrings（issue #91 v2）——重扫注册，无表则跳过。
		loadServerStrings(DATA_DIR);
		res.json({ ok: true, ...meta });
	} catch (e) {
		res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
	}
});
app.delete("/api/locales/:code", (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(404).end("unknown locale");
		return;
	}
	if (!removePack(DATA_DIR, code)) {
		res.status(404).end("locale not installed");
		return;
	}
	unloadServerStrings(code);
	res.json({ ok: true });
});
// Serve a theme's full CSS file so the frontend can swap the whole stylesheet.
// Registered before the SPA catch-all below (otherwise it'd return index.html).
app.get("/themes/:id.css", (req, res) => {
	const file = resolveThemeFile(BUILTIN_THEMES_DIR, USER_THEMES_DIR, req.params.id);
	if (!file) {
		res.status(404).end("theme not found");
		return;
	}
	res.setHeader("Content-Type", "text/css; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.sendFile(file);
});

// Plugin client bundles: <dataDir>/plugins/<id>/client/* served at
// /plugins/<id>/client/* so the frontend can import() plugin views. Only the
// client/ subtree is exposed — manifest.json and the server-side index.mjs
// (which may hold credentials) never leave the machine. Registered BEFORE the
// SPA catch-all below.
const PLUGINS_DIR = join(DATA_DIR, "plugins");
// 插件 HTTP 路由挂载点：host.route("GET", "/inbox") 实际暴露为
// /plugins-api/<id>/inbox。PI_WEB_TOKEN 鉴权（上方 app.use）自动覆盖；
// 响应已在前面过了 express.json。注意不要在此 catch-all 里消费 body。
app.all(["/plugins-api/:id/*", "/plugins-api/:id"], (req, res) => {
	const rest = String((req.params as unknown as Record<string, string | undefined>)[0] ?? "");
	pluginMgr.handleHttp(String(req.params.id ?? ""), req.method, rest, req, res);
});
app.get("/plugins/:id/client/*", (req, res) => {
	// express 4 的通配参数在运行时落在 params[0]，但类型声明里没有 —— 显式取
	const rest = String((req.params as unknown as Record<string, string | undefined>)[0] ?? "");
	const abs = resolvePluginClientFile(PLUGINS_DIR, req.params.id, rest);
	if (!abs) {
		res.status(404).end("plugin not found");
		return;
	}
	// .mjs 常不在老 mime 表里，手动定 Content-Type 保证 import() 可用
	if (/\.(mjs|js)$/.test(abs)) {
		res.setHeader("Content-Type", "text/javascript; charset=utf-8");
	}
	res.setHeader("Cache-Control", "no-cache"); // 开发期改文件即生效
	res.sendFile(abs, (err) => {
		if (err && !res.headersSent)
			res
				.status((err as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 404 ? 404 : 500)
				.end("not found");
	});
});
/** Set in the env of the replacement child spawned by a self-update restart. */
const RESTART_CHILD_ENV = "PI_WEB_RESTART_CHILD";
const webDist = join(pkgRoot, "web", "dist");
if (existsSync(webDist)) {
	app.get("/favicon.ico", (_req, res) => {
		res.sendFile(join(webDist, "icon.ico"));
	});
	// gzip/deflate 响应压缩：前端 bundle ~1MB，局域网/反代场景传输量降到 ~1/4；
	// 对 API JSON 同样生效，WS 升级不受影响
	app.use(compression());
	app.use(
		express.static(webDist, {
			// Vite 产物文件名带内容 hash，可永久强缓存——业务发版后 hash 变化自然失效，
			// index.html 由下方 catch-all 处理（sendFile 不走这里）
			setHeaders(res, filePath) {
				if (filePath.includes(`${sep}assets${sep}`)) {
					res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
				}
			},
		}),
	);
	app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
		// Callback form: a failed stat here (npm i -g is mid-replacement of the
		// package dir) responds 503 instead of crashing the request pipeline
		// with an unhandled ENOENT stack trace.
		res.sendFile(join(webDist, "index.html"), (err) => {
			if (err && !res.headersSent) {
				res.status(503).send("正在更新 pi-web-ui，请稍后刷新…");
			}
		});
	});
} else if (process.env[RESTART_CHILD_ENV]) {
	// Auto-restart replacement of a self-update whose npm install did not
	// complete (Windows: locked files / rollback can leave the global package
	// without web/dist). Fail loudly with a repair hint instead of serving a
	// UI-less 404 with no explanation.
	console.error(
		"✖ 更新后的安装不完整（缺少 web/dist/index.html）。\n" + "  请手动执行 npm i -g pi-web-ui@latest 修复后重新启动。",
	);
	process.exit(1);
}

const httpServer = createServer(app);
const wss = new WebSocketServer({
	noServer: true,
	// 上调入站帧上限：右键上传走单帧 base64（100MB 文件 → ~133MB 帧），
	// ws 默认 maxPayload 只有 100MB，超限会直接断连。
	maxPayload: 256 * 1024 * 1024,
	// Per-message deflate: big-session snapshots serialize to multi-MB JSON
	// strings; wire-level compression cuts that several-fold. threshold keeps
	// tiny messages (notices/heartbeats) uncompressed to save CPU.
	perMessageDeflate: { threshold: 16 * 1024 },
});

// ---------------------------------------------------------------------------
// Origin / Host admission for WebSocket upgrades.
//
// Browsers attach an Origin header; non-browser clients (curl, ws scripts)
// usually don't — they're admitted by the network layer / reverse proxy.
// Rules (checked in order):
//   4. No Origin header → admit (non-browser client).
//   5. Anything else → 403 + close.
//
// Dev-mode note: the Vite dev server (:5173) proxies /ws to the backend on
// :8788, so their authorities differ — the dev:server script sets
// PI_WEB_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 for that.
// LAN / reverse-proxy setups add their own origin the same way.
// ---------------------------------------------------------------------------

/** "host" or "host:port" → { hostname, port }. */
function parseAuthority(a: string): { hostname: string; port: string } {
	try {
		const u = new URL(`http://${a}`);
		return { hostname: u.hostname.toLowerCase(), port: u.port || "80" };
	} catch {
		return { hostname: "", port: "" };
	}
}

function originAllowed(req: IncomingMessage): boolean {
	const hostHeader = (req.headers.host ?? "").toLowerCase();
	const host = parseAuthority(hostHeader);
	if (ALLOW_HOSTS.length > 0 && !ALLOW_HOSTS.includes(host.hostname)) {
		return false;
	}
	const origin = req.headers.origin;
	if (!origin) return true; // non-browser client
	const o = origin.toLowerCase();
	if (ALLOW_ORIGINS.includes(o)) return true;
	if (o === "null") return false; // file:// pages etc. are not trusted
	const ori = parseAuthority(o.replace(/^[a-z]+:\/\//, ""));
	if (ori.hostname === host.hostname && ori.port === host.port) return true;
	// Browsers treat host:port pairs on the SAME host as different origins —
	// do not accept them. (Dev-mode proxying is handled by PI_WEB_ALLOW_ORIGINS
	// set in the dev:server script; LAN/reverse-proxy setups add their origin.)
	return false;
}

httpServer.on("upgrade", (req, socket, head) => {
	let pathname = "/";
	try {
		pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	} catch {
		/* fall through to the path check below */
	}
	if (pathname !== "/ws") {
		socket.destroy();
		return;
	}
	if (!originAllowed(req)) {
		// Reject cross-origin browser pages outright. The browser sees a failed
		// WS connect; the page's own reconnect loop then backs off and retries.
		socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	if (AUTH_TOKEN && !tokenOk(req)) {
		socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

// Heartbeat: lets clients detect half-open connections (server killed without
// closing sockets, sleep/wake, network partitions). Idle connections otherwise
// carry no traffic and TCP keepalive defaults are far too slow (~2h).
const heartbeatTimer = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "heartbeat" } satisfies ServerMessage));
		}
	}
}, 10_000);

// 引擎分发：PI_WEB_ENGINE=dsh 时使用 DeepSeek Harness 引擎（server/dsh/），
// 默认 pi 引擎。同一 wire 协议，前端无感知（ready/health 携带 engine 字段）。
import { DshAgentService } from "./dsh/dsh-agent-service.js";

/** dispatch 表所需的方法契约（pi 的 ClientSession 与 dsh 的 DshClientSession
 *  都结构兼容；dsh 引擎对不支持的功能做简化实现）。 */

/** TerminalManager 的 dispatch 面（两个引擎共用同一实现类）。 */
export interface TerminalManagerLike {
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title?: string,
		opts?: { forceBash?: boolean; locale?: string },
	): unknown;
	input(id: string, data: string): void;
	resize(id: string, cols: number, rows: number): void;
	kill(id: string): void;
	rename(id: string, title: string): void;
	runCommand(id: string, command: CommandDef, cols: number, rows: number, fallbackCwd: string): unknown;
}

export interface DispatchSession {
	cwd: string;
	/** In-flight disk catch-up reload for the active conversation, if any.
	 *  Optional: the DSH engine session has no equivalent. */
	diskSyncPending?(): Promise<void> | null;
	/** Page of earlier messages for the ACTIVE conversation (tail-first history).
	 *  Optional: the DSH engine session has no equivalent. */
	loadHistory?(opts: { before?: string; limit?: number; all?: boolean }): void;
	prompt(text: string, attachments?: PromptAttachment[], queue?: boolean): Promise<void>;
	/** Remove one queued prompt text (steer/followUp) — the ✕ on a pending bubble. */
	removeQueued(kind: "steer" | "followUp", text: string): void;
	abort(): Promise<void>;
	abortBash(): Promise<void>;
	/** 手动重试上次失败的模型调用（自动重试次数用完、已停止标红后）。 */
	retryLast(): Promise<void>;
	killBackgroundServer(port?: number, taskId?: string): Promise<boolean>;
	killAllBackgroundServers(): Promise<string[]>;
	listBgServers(): Promise<void>;
	newChat(): Promise<void>;
	editMessage(messageId: string, text: string, attachments?: PromptAttachment[]): Promise<void>;
	cycleModel(): Promise<void>;
	cycleThinking(): void;
	flushSnapshot(forceFull?: boolean): void;
	pushSlashCommands(): Promise<void>;
	refreshSessions(): Promise<void>;
	pushProjects(): Promise<void>;
	removeProject(path: string): Promise<void>;
	deleteSession(path: string): Promise<void>;
	renameSession(path: string, name: string): Promise<void>;
	renameConversation(id: string, name: string): Promise<void>;
	dismissConversation(id: string): Promise<void>;
	switchSession(path: string): Promise<void>;
	switchConversation(id: string): Promise<void>;
	listFiles(path?: string): Promise<void>;
	searchFiles(query: string, reqId: number): Promise<void>;
	searchSessions(query: string, reqId: number): Promise<void>;
	scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		opts?: { path?: string; hash?: string },
	): Promise<void>;
	readFile(path: string): Promise<void>;
	writeFile(path: string, text: string): Promise<void>;
	uploadFile(dirPath: string, name: string, data: string): Promise<void>;
	listModels(): Promise<void>;
	setModel(modelId: string): Promise<void>;
	// -- DEV-CON channels（接口由 ClientSession 实现；DSH 引擎给出显式不支持回执） --
	pushChannelState(): void;
	selectChannel(msg: Extract<ClientMessage, { type: "channel_select" }>): Promise<void>;
	clearChannelBinding(commandId: string, conversationId?: string): Promise<void>;
	saveChannelConfig(
		commandId: string,
		channel: Extract<ClientMessage, { type: "channel_save" }>["channel"],
		expectedConfigRevision?: number,
	): Promise<void>;
	deleteChannelConfig(commandId: string, channelId: string, expectedConfigRevision?: number): Promise<void>;
	setChannelDefault(input: {
		commandId: string;
		scope: "instance" | "project";
		selection: { channelId: string; credentialKeyName?: string | null; modelId: string } | null;
		expectedConfigRevision?: number;
	}): Promise<void>;
	queryChannelAccount(commandId: string, channelId: string): Promise<void>;
	/** P4 候选：系统资源只读快照。 */
	listResources(reqId: number): Promise<void>;
	/** P4 运维：存储占用明细（只读、有界遍历）。 */
	listStorage(reqId: number): Promise<void>;
	/** P4 运维：设置用量历史保留天数。 */
	setUsageRetention(maxAgeDays: number): void;
	/** P4 运维：诊断包（只读元数据）。 */
	listDiagnostics(reqId: number): Promise<void>;
	/** P4 运维：开关资源告警。 */
	setOpsAlerts(enabled: boolean): void;
	/** P4 首个切片：跨渠道/项目/时间的用量历史（只读聚合）。 */
	queryUsageHistory(
		reqId: number,
		query: { groupBy: "channel" | "project" | "model" | "source" | "day"; from?: number; to?: number },
	): Promise<void>;
	setThinking(level: string): void;
	setCwd(path: string): Promise<void>;
	completePath(path: string): Promise<void>;
	makeDir(path: string): Promise<void>;
	checkUpdate(): Promise<void>;
	checkUpdatesAll(force?: boolean): Promise<void>;
	resolveDialog(id: number, value: string | boolean | null): void;
	installPiAgent(): Promise<void>;
	setProviderApiKey(provider: string, apiKey: string): Promise<void>;
	clearProviderApiKey(provider: string): Promise<void>;
	listModelsConfig(): Promise<void>;
	saveModelConfig(providerId: string, config: unknown): Promise<void>;
	deleteModelConfig(providerId: string): Promise<void>;
	listProviders(): Promise<void>;
	listProviderKeys(): void;
	addProviderKey(provider: string, apiKey: string, name?: string): Promise<void>;
	activateProviderKey(provider: string, keyName: string): Promise<void>;
	removeProviderKey(provider: string, keyName: string): Promise<void>;
	fetchModelsList(reqId: number, baseUrl: string, apiKey?: string, authHeader?: boolean, api?: string): Promise<void>;
	refreshProviderModels(providerId: string, reqId: number): Promise<void>;
	cloneProvider(provider: string, reqId: number): Promise<void>;
	getTerminalManager(conversationId?: string): TerminalManagerLike | undefined;
	getTerminalCwd(conversationId?: string): string;
	listCommands(): Promise<void>;
	saveCommands(commands: CommandDef[]): Promise<void>;
	setGoal(goal: string, opts?: { reviewModel?: string; maxRounds?: number; locked?: boolean }): Promise<void>;
	clearGoal(): Promise<void>;
	startGoalWizard(text: string, opts?: { wizardModel?: string; maxRounds?: number; locked?: boolean }): Promise<void>;
	setGoalPrefs(opts?: { reviewModel?: string; maxRounds?: number; locked?: boolean }): Promise<void>;
	pushSettings(): void;
	setSettings(partial: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		editSoftEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
	}): Promise<void>;
	reloadExtensions(): Promise<void>;
	/** DSH engine only: list/rescan <dataDir>/dsh-patches user patch files. */
	listDshPatches?(): Promise<void>;
	rescanDshPatches?(): Promise<void>;
	/** DSH engine only: answer a model ask_user_question dialog. */
	answerQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
	): Promise<void>;
	savePreset(name: string): Promise<void>;
	applyPreset(name: string): Promise<void>;
	deletePreset(name: string): Promise<void>;
	/** Upsert 一个子代理模板（全局共享）。 */
	saveSubagentTemplate(template: UiSubagentTemplate): Promise<void>;
	/** 当前客户端的服务端语言（issue #91 v2：归一化 UI 代码，zh/EN/ja/…）。 */
	getLang(): string;
	/** Browser UI locale report (hello.locale / set_locale) — persist per
	 *  client and refresh lang-aware prompts (streaming-safe). */
	setLocale(locale: string): Promise<void>;
	/** 删除一个子代理模板。 */
	deleteSubagentTemplate(name: string): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	activeConversations(): number;
	pendingMessages(): number;
}

/** 引擎无关的服务接口（index.ts attach 流程 + 插件扩展点所需）。 */
export interface EngineService {
	attach(clientId: string, send: (msg: ServerMessage) => void, trace?: TimingTrace): Promise<DispatchSession>;
	detach(clientId: string, send: (msg: ServerMessage) => void): void;
	get(clientId: string): DispatchSession | undefined;
	disposeAll(): Promise<void>;
	noteSocketOpen(): void;
	noteSocketClose(): void;
	isQuiesced(): boolean;
	quiesce(): void;
	unquiesce(): void;
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number };
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
	};
	activeConversations(): number;
	pendingMessages(): number;
	applyPluginAgentTools(): void;
	applyPluginCommandCatalog(): void;
	refreshBackgroundServers(): void;
	/** Browser UI locale report (hello.locale / set_locale) — persist per
	 *  client and refresh lang-aware prompts (streaming-safe). */
	setLocale(clientId: string, locale: string): Promise<void>;
	onQuit?: (() => boolean) | undefined;
	onToolEvent?:
		| ((ev: {
				phase: "start" | "end";
				toolName: string;
				conversationId: string;
				durationMs?: number;
				isError?: boolean;
		  }) => void)
		| undefined;
	/** 运行轨迹事件转发（pi 引擎发射；dsh 引擎暂不发射，插件收不到即无轨迹）。 */
	onRunEvent?: ((ev: PluginRunEvent) => void) | undefined;
	/** 对话切换通知（切历史会话/切 running 对话/新对话/切项目，pi 引擎）。 */
	onConversationChanged?: (() => void) | undefined;
	/** 当前打开对话的快照（pi 引擎；dsh 引擎无此方法，插件回退空态）。 */
	readConversationForPlugins?: (() => PluginConversationSnapshot | null) | undefined;
	pluginToolsProvider?: (() => unknown[]) | undefined;
	pluginCommandsProvider?: (() => unknown[]) | undefined;
	pluginBgTasksProvider?: (() => BgServer[]) | undefined;
	pluginStopBgTask?: ((taskId: string) => boolean) | undefined;
	onClientCwdChanged?: ((cwd: string) => void) | undefined;
}

const service: EngineService =
	ENGINE === "dsh"
		? new DshAgentService(CWD, join(DATA_DIR, "client-state.json"), DATA_DIR, getAgentDir())
		: new AgentService(
				CWD,
				// Per-client persisted UI state: last-used workspace + recent projects.
				join(DATA_DIR, "client-state.json"),
			);

// Server-string tables (issue #91 v2): packs' `serverStrings` sections feed
// pick() lookup for non-zh/en UI languages (missing key → English fallback).
loadServerStrings(DATA_DIR);
// Optional UI plugins (<dataDir>/plugins/<id>/): scanned on every client
// attach so freshly dropped plugins appear without a server restart.
const pluginMgr = new PluginManager(DATA_DIR, CWD, join(pkgRoot, "plugins", "catalog.json"));
// MCP 工具桥：读取 <dataDir>/mcp.json 启动外部 MCP 服务器（stdio），把它们的
// 工具并入与插件工具相同的 customTools 管线；单服务器失败不炸进程。
const mcpBridge = new McpBridge(DATA_DIR, (...a) => console.log("[mcp]", ...a));
void mcpBridge.load().then(() => {
	if (mcpBridge.getTools().length) service.applyPluginAgentTools();
});
// 插件扩展点：SDK 工具执行事件（bash/读文件等 start+end）转发给已注册的插件。
service.onToolEvent = (ev) => pluginMgr.emitToolEvent(ev);
service.onRunEvent = (ev) => pluginMgr.emitRunEvent(ev);
// 插件扩展点：对话切换通知（轨迹视图切会话后即重拉；dsh 引擎暂无）。
service.onConversationChanged = () => pluginMgr.emitConversationChanged();
// 插件扩展点：当前打开对话的快照（轨迹视图直接显示打开对话的时间线；
// dsh 引擎无此方法时回退 null，插件显示空态）。
pluginMgr.conversationProvider = () => service.readConversationForPlugins?.() ?? null;
// 插件扩展点：插件注册的 AI 工具（registerAgentTool）+ MCP 桥工具 → 会话创建时
// 带上 + 变化时动态注入/移除已有会话。
service.pluginToolsProvider = () => [...pluginMgr.getAgentTools(), ...mcpBridge.getTools()];
pluginMgr.onAgentToolsChanged = () => service.applyPluginAgentTools();
// 插件扩展点：插件斜杠命令（registerCommand）→ 命令选择器目录 + prompt 拦截执行。
pluginMgr.onCommandsChanged = () => service.applyPluginCommandCatalog();
service.pluginCommandsProvider = () => pluginMgr.listCommands();
// 插件扩展点：插件常驻后台任务（registerBackgroundTask）→ 并入「后台任务」面板。
pluginMgr.onBgTasksChanged = () => service.refreshBackgroundServers();
service.pluginBgTasksProvider = () => pluginMgr.bgTasks();
service.pluginStopBgTask = (taskId) => pluginMgr.stopPluginBgTask(taskId);
// 插件宿主工作区实时跟随当前项目：任意客户端 set_cwd 成功后同步给
// PluginManager，编辑器等工作区跟随型插件随即切根（详见 plugins.ts notifyCwd）。
service.onClientCwdChanged = (cwd) => pluginMgr.notifyCwd(cwd);

// ---------------------------------------------------------------------------
// Self-update
// ---------------------------------------------------------------------------
// In-app updates now run `npm i -g pi-web-ui@latest` in a visible terminal
// tab (frontend-initiated); after it finishes the user restarts via
// `pi-web-ui server restart`. The PI_WEB_RESTART_CHILD port-wait handshake
// below stays: an externally orchestrated replacement child still needs it.

function scheduleQuit(): boolean {
	const isLaunchd = process.platform === "darwin" && process.ppid === 1;
	const isSystemd = process.platform === "linux" && !!process.env.INVOCATION_ID;
	const inDocker = existsSync("/.dockerenv");
	if (isLaunchd || isSystemd || inDocker) {
		setTimeout(() => {
			console.log("pi-web-ui:quit — shutting down (supervisor will restart)…");
			if (isSystemd) process.exit(3);
			void shutdown();
		}, 300);
		return true;
	}
	setTimeout(() => {
		console.log("pi-web-ui:quit — shutting down (restart to reload)…");
		void shutdown();
	}, 300);
	return true;
}
service.onQuit = scheduleQuit;

/** 背压相对倍数：socket 未发送积压超过「最近一份 snapshot 大小 × 此倍数」时丢弃
 *  （issue #11 及其评论区的自适应建议）。固定 1MB 阈值在长会话下单份 snapshot 可达
 *  ~10MB——连半份都没发完就丢，前端频繁跳帧；短会话又太迟钝。相对阈值语义稳定在
 *  「缓冲堆了约 N 份快照」，不随会话长短漂移。 */
const SNAPSHOT_BACKPRESSURE_FACTOR = 3;
/** 背压绝对下限：低于此积压永不丢快照（小会话的相对阈值只有几 KB，会被
 *  正常的消息突发误伤，见 send() 内注释）。 */
const SNAPSHOT_BACKPRESSURE_MIN_BYTES = 262_144;
/** 背压丢弃后的延迟重发间隔。 */
const SNAPSHOT_RETRY_MS = 250;

/**
 * Multi-tab serialization sharing: emit() hands the SAME message object to
 * every socket of a client, but each send() used to JSON.stringify it
 * separately — N open tabs serialized the same multi-MB snapshot N times per
 * push. Keyed by object identity (WeakMap): a new snapshot is a new object,
 * so the cache self-invalidates and never grows.
 */
const serializedCache = new WeakMap<ServerMessage, string>();
function serializeShared(msg: ServerMessage): string {
	let s = serializedCache.get(msg);
	if (s === undefined) {
		s = JSON.stringify(msg);
		serializedCache.set(msg, s);
	}
	return s;
}

wss.on("connection", (ws) => {
	// Count attached sockets (the control socket reports REAL sockets, not
	// cached client-session objects).
	service.noteSocketOpen();
	let clientId: string | null = null;
	let closed = false;
	const initialSnapshot = new InitialSnapshotGate();
	/** 最近一份全量 snapshot 的估算字节数（UTF-16 ×2），供背压相对阈值用（issue #11）。 */
	let lastSnapshotBytes = 0;
	/** Commands received while the session is still being created — replayed after attach. */
	let pending: ClientMessage[] = [];
	/** Ends the opt-in startup trace (timing.ts) once plugins + first snapshot
	 *  are settled, or when the socket closes first. Set by the hello handler. */
	let finishHelloTrace: ((extra?: Record<string, string | number | boolean>) => void) | undefined;
	/** 背压丢快照后的延迟重发定时器（去重：一次只排一个）。 */
	let snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;

	// 协议层错误（非法帧/未 masked 帧等）：不注册 handler 会作为 uncaught
	// exception 打崩整个进程（issue #11 附带发现）。记日志并按坏连接关闭。
	ws.on("error", (err) => {
		console.error(`[ws] socket error${clientId ? ` (${clientId})` : ""}:`, err.message);
		try {
			ws.close();
		} catch {
			/* already closing */
		}
	});

	const send = (msg: ServerMessage): void => {
		if (closed || ws.readyState !== WebSocket.OPEN) return;
		// A reused ClientSession may broadcast while this socket loads plugins.
		// Its first snapshot must be full and follow the renderer catalog.
		if (
			ENGINE === "pi" &&
			(msg.type === "snapshot" || msg.type === "snapshot_delta") &&
			!initialSnapshot.canSendSnapshot
		)
			return;
		// 发送背压（issue #11）：socket 消费不过来时（前端慢/网络差），堆里会堆积
		// 每份可达 ~10MB 的全量 snapshot 字符串，低内存主机直接 OOM。snapshot 是全量
		// 幂等的且稍后必有更新的一份，可以安全丢弃——在序列化之前丢，连
		// stringify 的分配都省掉。ready/notice/error/tool_delta 等消息必须送达。
		// 阈值相对化（评论区建议）：用「最近一份 snapshot 的字节数 × 倍数」做基准，
		// 首份无基准不丢（首次必达）。wire.length 是 UTF-16 字符数，×2 估算字节。
		// 下限保护（小会话误伤修复）：小会话一份 snapshot 才 ~1KB，相对阈值只有几
		// KB——前面一批 settings_state/slash_commands 的正常突发就能把 bufferedAmount
		// 抬过阈值，把紧随其后的 snapshot_delta 静默丢掉；而丢弃后若无后续事件就
		// 再也没有快照，客户端永远停在旧状态（前端靠 rev 缺口 get_state 自愈，
		// 协议测试则直接卡死）。绝对下限保证小会话永不触发背压。
		if (
			(msg.type === "snapshot" || msg.type === "snapshot_delta") &&
			lastSnapshotBytes > 0 &&
			ws.bufferedAmount > Math.max(SNAPSHOT_BACKPRESSURE_MIN_BYTES, SNAPSHOT_BACKPRESSURE_FACTOR * lastSnapshotBytes)
		) {
			// 真正的慢客户端：丢弃是安全的，但不能「丢完就没了」——安排一次延迟
			// 重发，等缓冲排空后快照最终必达（否则若此后再无事件，客户端将永久
			// 停留在旧快照）。重发仍走 flushSnapshot：缓冲未排空则再次顺延。
			if (!snapshotRetryTimer) {
				snapshotRetryTimer = setTimeout(() => {
					snapshotRetryTimer = null;
					service.get(clientId ?? "")?.flushSnapshot();
				}, SNAPSHOT_RETRY_MS);
			}
			return;
		}
		const wire = serializeShared(msg);
		if (msg.type === "snapshot") lastSnapshotBytes = wire.length * 2;
		ws.send(wire);
	};

	// Plugins broadcast to every open socket; unregister on close below.
	// Plugins broadcast to every open socket; unregister on close below. The
	// cid getter lets plugins target THIS socket via host.sendTo(clientId).
	const removePluginSender = pluginMgr.addSender(send, () => clientId);

	const dispatchUnsafe = (msg: ClientMessage): void => {
		if (!clientId) {
			pending.push(msg);
			return;
		}
		const cs = service.get(clientId);
		if (!cs) {
			// Session not ready yet (hello processing) — hold the command.
			pending.push(msg);
			return;
		}
		// Managed instances do not install software on themselves, and tabs this
		// instance does not offer stay closed. Both refusals live here, on the
		// server, because hiding them in the client would still leave the message
		// reachable to anything that can open the socket. See managed.ts / tabs.ts.
		const refusal = managedRefusal(msg.type, MANAGED) ?? tabsRefusal(msg.type, TABS);
		if (refusal) {
			send({ type: "notice", level: "error", text: refusal });
			return;
		}
		switch (msg.type) {
			case "prompt":
				void cs.prompt(msg.text, msg.attachments, msg.queue);
				break;
			case "queue_remove":
				cs.removeQueued(msg.kind, msg.text);
				break;
			case "abort":
				void cs.abort();
				break;
			case "abort_bash":
				void cs.abortBash();
				break;
			case "retry_last":
				void cs.retryLast();
				break;
			case "kill_background_server":
				void cs.killBackgroundServer(msg.port, msg.taskId);
				break;
			case "kill_background_servers":
				void cs.killAllBackgroundServers();
				break;
			case "list_bg_servers":
				void cs.listBgServers();
				break;
			case "new_chat":
				void cs.newChat();
				break;
			case "edit_message":
				void cs.editMessage(msg.messageId, msg.text, msg.attachments);
				break;
			case "cycle_model":
				void cs.cycleModel();
				break;
			case "cycle_thinking":
				cs.cycleThinking();
				break;
			case "get_state":
				// Startup requests share the full snapshot sent after plugin loading.
				// Once initialized, every rev/seq-gap resync remains authoritative.
				if (ENGINE !== "pi" || initialSnapshot.canSendSnapshot) cs.flushSnapshot(true);
				break;
			case "get_commands":
				void cs.pushSlashCommands();
				break;
			case "load_history":
				// 尾部优先历史的「载入更早/搜索前补全」；DSH 引擎没有等价实现。
				cs.loadHistory?.({ before: msg.before, limit: msg.limit, all: msg.all });
				break;
			case "list_sessions":
				void cs.refreshSessions();
				break;
			case "list_projects":
				void cs.pushProjects();
				break;
			case "remove_project":
				void cs.removeProject(msg.path);
				break;
			case "delete_session":
				void cs.deleteSession(msg.path);
				break;
			case "rename_session":
				void cs.renameSession(msg.path, msg.name);
				break;
			case "rename_conversation":
				void cs.renameConversation(msg.id, msg.name);
				break;
			case "dismiss_conversation":
				void cs.dismissConversation(msg.id);
				break;
			case "switch_session":
				void cs.switchSession(msg.path);
				break;
			case "switch_conversation":
				void cs.switchConversation(msg.id);
				break;
			case "list_files":
				void cs.listFiles(msg.path);
				break;
			case "search_files":
				void cs.searchFiles(msg.query, msg.reqId);
				break;
			case "search_sessions":
				void cs.searchSessions(msg.query, msg.reqId);
				break;
			case "scm_status":
				void cs.scmQuery("status", msg.reqId);
				break;
			case "scm_history":
				void cs.scmQuery("history", msg.reqId);
				break;
			case "scm_filediff":
				void cs.scmQuery("filediff", msg.reqId, { path: msg.path });
				break;
			case "scm_commit":
				void cs.scmQuery("commit", msg.reqId, { hash: msg.hash });
				break;
			case "read_file":
				void cs.readFile(msg.path);
				break;
			case "write_file":
				void cs.writeFile(msg.path, msg.text);
				break;
			case "upload_file":
				void cs.uploadFile(msg.dirPath, msg.name, msg.data);
				break;
			case "list_models":
				void cs.listModels();
				break;
			case "set_model":
				void cs.setModel(msg.modelId);
				break;
			case "set_thinking":
				cs.setThinking(msg.level);
				break;
			case "set_cwd":
				void cs.setCwd(msg.path);
				break;
			case "set_locale":
				// UI language report — per-client persist + lang-aware prompt
				// refresh (streaming-safe). Engine-agnostic via DispatchSession.
				void service.setLocale(clientId, msg.locale);
				break;
			case "complete_path":
				void cs.completePath(msg.path);
				break;
			case "make_dir":
				void cs.makeDir(msg.path);
				break;
			case "check_update":
				void cs.checkUpdate();
				break;
			case "check_updates_all":
				void cs.checkUpdatesAll(msg.force === true);
				break;
			case "dialog_response":
				cs.resolveDialog(msg.id, msg.value);
				break;
			case "install_pi_agent":
				void cs.installPiAgent();
				break;
			case "set_provider_api_key":
				void cs.setProviderApiKey(msg.provider, msg.apiKey);
				break;
			case "clear_provider_api_key":
				void cs.clearProviderApiKey(msg.provider);
				break;
			case "list_models_config":
				void cs.listModelsConfig();
				break;
			case "save_model_config":
				void cs.saveModelConfig(msg.providerId, msg.config);
				break;
			case "delete_model_config":
				void cs.deleteModelConfig(msg.providerId);
				break;
			case "list_providers":
				void cs.listProviders();
				break;
			case "fetch_models":
				void cs.fetchModelsList(msg.reqId, msg.baseUrl, msg.apiKey, msg.authHeader, msg.api);
				break;
			case "refresh_provider_models":
				void cs.refreshProviderModels(msg.providerId, msg.reqId);
				break;
			case "clone_provider":
				void cs.cloneProvider(msg.provider, msg.reqId);
				break;
			case "list_provider_keys":
				cs.listProviderKeys();
				break;
			case "add_provider_key":
				void cs.addProviderKey(msg.provider, msg.apiKey, msg.name);
				break;
			case "activate_provider_key":
				void cs.activateProviderKey(msg.provider, msg.keyName);
				break;
			case "remove_provider_key":
				void cs.removeProviderKey(msg.provider, msg.keyName);
				break;
			case "terminal_create": {
				const tm = cs.getTerminalManager(msg.conversationId);
				if (tm)
					tm.create(
						msg.terminalId,
						msg.cwd,
						msg.cols,
						msg.rows,
						cs.getTerminalCwd(msg.conversationId),
						msg.title,
						msg.locale ? { locale: msg.locale } : undefined,
					);
				break;
			}
			case "terminal_input":
				cs.getTerminalManager(msg.conversationId)?.input(msg.terminalId, msg.data);
				break;
			case "terminal_resize":
				cs.getTerminalManager(msg.conversationId)?.resize(msg.terminalId, msg.cols, msg.rows);
				break;
			case "terminal_kill":
				cs.getTerminalManager(msg.conversationId)?.kill(msg.terminalId);
				break;
			case "rename_terminal":
				cs.getTerminalManager(msg.conversationId)?.rename(msg.terminalId, msg.title);
				break;
			case "run_command":
				cs.getTerminalManager(msg.conversationId)?.runCommand(
					msg.terminalId,
					msg.command,
					msg.cols,
					msg.rows,
					cs.getTerminalCwd(msg.conversationId),
				);
				break;
			case "list_commands":
				void cs.listCommands();
				break;
			case "save_commands":
				void cs.saveCommands(msg.commands);
				break;
			case "set_goal":
				void cs.setGoal(msg.goal, {
					reviewModel: msg.reviewModel,
					maxRounds: msg.maxRounds,
					locked: msg.locked,
				});
				break;
			case "clear_goal":
				void cs.clearGoal();
				break;
			case "start_goal_wizard":
				void cs.startGoalWizard(msg.text, {
					wizardModel: msg.wizardModel,
					maxRounds: msg.maxRounds,
					locked: msg.locked,
				});
				break;
			case "set_goal_prefs":
				void cs.setGoalPrefs({
					reviewModel: msg.reviewModel,
					maxRounds: msg.maxRounds,
					locked: msg.locked,
				});
				break;
			case "get_settings":
				cs.pushSettings();
				break;
			case "set_settings":
				void (cs as unknown as { setSettings: (p: Record<string, unknown>) => Promise<void> }).setSettings({
					promptMode: msg.promptMode,
					customSystemPrompt: msg.customSystemPrompt,
					promptTemplate: (msg as { promptTemplate?: string }).promptTemplate,
					promptOverrides: (msg as { promptOverrides?: Record<string, string> }).promptOverrides,
					disabledSkills: msg.disabledSkills,
					disabledExtensions: msg.disabledExtensions,
					disabledPlugins: msg.disabledPlugins,
					terminalToolsEnabled: msg.terminalToolsEnabled,
					terminalBash: msg.terminalBash,
					terminalBashIdleMs: msg.terminalBashIdleMs,
					editSoftEnabled: (msg as { editSoftEnabled?: boolean }).editSoftEnabled,
					questionnaireEnabled: (msg as { questionnaireEnabled?: boolean }).questionnaireEnabled,
					goalModeEnabled: (msg as { goalModeEnabled?: boolean }).goalModeEnabled,
					thinkingWrap: msg.thinkingWrap,
					toolsWrap: msg.toolsWrap,
					visionBridgeEnabled: msg.visionBridgeEnabled,
					visionBridgeModel: msg.visionBridgeModel,
					visionBridgePromptMode: msg.visionBridgePromptMode,
					visionBridgePrompt: msg.visionBridgePrompt,
					subagentDefaultModel: (msg as { subagentDefaultModel?: string | null }).subagentDefaultModel,
					retryMaxAttempts: (msg as { retryMaxAttempts?: number }).retryMaxAttempts,
					reviewPrompt: msg.reviewPrompt,
					reviewDisabledSkills: msg.reviewDisabledSkills,
					markersEnabled: (msg as { markersEnabled?: boolean }).markersEnabled,
					disabledMarkers: (msg as { disabledMarkers?: string[] }).disabledMarkers,
					quickPhrases: (msg as { quickPhrases?: string[] }).quickPhrases,
					quickPhrasesEnabled: (msg as { quickPhrasesEnabled?: boolean }).quickPhrasesEnabled,
					quickPhrasesSeeded: (msg as { quickPhrasesSeeded?: boolean }).quickPhrasesSeeded,
				});
				break;
			case "extensions_reload":
				void cs.reloadExtensions();
				break;
			case "plugin_message":
				pluginMgr.handleMessage(msg.pluginId, msg.payload, clientId ?? undefined);
				break;
			case "plugin_settings": {
				const r = pluginMgr.savePluginSettings(msg.pluginId, msg.values ?? {}, () => cs?.getLang() ?? "en");
				if (r.error) {
					cs?.emitNotice("error", `插件设置保存失败：${r.error}`, `Failed to save plugin settings: ${r.error}`);
				} else {
					cs?.emitNotice("info", "插件设置已保存", "Plugin settings saved");
				}
				break;
			}
			case "plugins_reload":
				void pluginMgr.reload(() => cs?.getLang() ?? "en").then(() => pluginMgr.pushToAll());
				break;
			case "plugin_catalog_add": {
				const r = pluginMgr.addCatalogEntry(msg.entry ?? {}, () => cs?.getLang() ?? "en");
				if (r.error) {
					cs?.emitNotice("error", `添加到插件列表失败：${r.error}`, `Failed to add to plugin list: ${r.error}`);
				} else {
					cs?.emitNotice("info", "已添加到插件列表", "Added to the plugin list");
				}
				break;
			}
			case "plugin_catalog_remove": {
				const r = pluginMgr.removeCatalogEntry(msg.id, () => cs?.getLang() ?? "en");
				if (r.error) {
					cs?.emitNotice("error", `从插件列表移除失败：${r.error}`, `Failed to remove from plugin list: ${r.error}`);
				} else {
					cs?.emitNotice("info", "已从插件列表移除", "Removed from the plugin list");
				}
				break;
			}
			case "dsh_patches_list":
				void cs.listDshPatches?.();
				break;
			case "dsh_patches_rescan":
				void cs.rescanDshPatches?.();
				break;
			case "question_answer":
				void cs.answerQuestion?.(msg.id, msg.answers, msg.cancelled);
				break;
			case "save_preset":
				void cs.savePreset(msg.name);
				break;
			case "save_subagent_template":
				void cs.saveSubagentTemplate(msg.template);
				break;
			case "delete_subagent_template":
				void cs.deleteSubagentTemplate(msg.name);
				break;
			case "apply_preset":
				void cs.applyPreset(msg.name);
				break;
			case "delete_preset":
				void cs.deletePreset(msg.name);
				break;
			// -- DEV-CON channels ----------------------------------------
			case "list_channels":
				cs.pushChannelState();
				break;
			case "channel_select":
				void cs.selectChannel(msg);
				break;
			case "channel_binding_clear":
				void cs.clearChannelBinding(msg.commandId, msg.conversationId);
				break;
			case "channel_save":
				void cs.saveChannelConfig(msg.commandId, msg.channel, msg.expectedConfigRevision);
				break;
			case "channel_delete":
				void cs.deleteChannelConfig(msg.commandId, msg.channelId, msg.expectedConfigRevision);
				break;
			case "channel_set_default":
				void cs.setChannelDefault({
					commandId: msg.commandId,
					scope: msg.scope,
					selection: msg.selection,
					expectedConfigRevision: msg.expectedConfigRevision,
				});
				break;
			case "channel_query_account":
				void cs.queryChannelAccount(msg.commandId, msg.channelId);
				break;
			case "usage_history_query":
				void cs.queryUsageHistory(msg.reqId, { groupBy: msg.groupBy, from: msg.from, to: msg.to });
				break;
			case "list_resources":
				void cs.listResources(msg.reqId);
				break;
			case "list_storage":
				void cs.listStorage(msg.reqId);
				break;
			case "set_usage_retention":
				cs.setUsageRetention(msg.maxAgeDays);
				break;
			case "list_diagnostics":
				void cs.listDiagnostics(msg.reqId);
				break;
			case "set_ops_alerts":
				cs.setOpsAlerts(msg.enabled);
				break;
			default:
				break;
		}
	};

	/**
	 * 入口防护（P0「入口安全」）：畸形/越界命令只能影响本条命令。
	 * 之前 dispatch 里的同步异常会冒泡到 ws 的 message 处理器并终止进程；
	 * 这里统一包一层，并把失败变成可见的 notice。
	 */
	const dispatch = (msg: ClientMessage): void => {
		try {
			dispatchUnsafe(msg);
		} catch (err) {
			send({ type: "notice", level: "error", text: `命令处理失败：${(err as Error).message}` });
		}
	};

	ws.on("message", (data) => {
		let msg: ClientMessage;
		try {
			const parsed: unknown = JSON.parse(data.toString());
			// 非对象帧（null / 字符串 / 数字 / 数组，或 type 不是字符串）会让
			// 后面的 msg.type 直接抛错并杀死进程 —— 在这里就丢掉。
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
			if (typeof (parsed as { type?: unknown }).type !== "string") return;
			msg = parsed as ClientMessage;
		} catch {
			return;
		}

		if (msg.type === "hello") {
			const cid = msg.clientId || randomUUID();
			clientId = cid;
			// Startup phase trace (PI_WEB_TIMING=1): attach() records the session
			// phases, this handler records hello → plugins → first snapshot, so a
			// single log line covers the whole cold start.
			const trace = startTrace(`attach ${cid}`);
			service
				.attach(cid, send, trace)
				.then((cs) => {
					if (closed) return;
					let traced = false;
					finishHelloTrace = (extra = {}) => {
						if (traced) return;
						traced = true;
						trace?.end({ engine: ENGINE, ...extra });
					};
					trace?.mark("hello");
					send({
						type: "ready",
						clientId: cid,
						serverVersion: VERSION,
						protocolVersion: PROTOCOL_VERSION,
						engine: ENGINE,
						// This package's own version. `serverVersion` is the pi SDK's,
						// and the client used to learn ours from the update check —
						// which a managed instance never runs.
						appVersion: appVersion(),
						managed: MANAGED,
						tabs: TABS ? [...TABS] : undefined,
					});
					// Open the gate and push the authoritative baseline. Plugin activation used to
					// gate this (with a 5s fallback), so a slow/hung plugin showed the user an
					// empty chat pane for seconds; renderer fences arrive later and
					// plugin-fence.ts re-renders the misses when the catalog lands.
					//
					// @PERF One exception: a disk catch-up reload (another device wrote while we
					// were away) is already in flight. Its own full flush would be dropped by the
					// still-closed gate, so flushing NOW would send the STALE transcript and the
					// reload would send a second full one — two multi-hundred-KB transfers plus a
					// visible old→new jump. Wait for it instead (bounded, so a stuck reload can
					// never leave the pane empty).
					const baseline = () => {
						if (ENGINE === "pi") initialSnapshot.complete(() => cs.flushSnapshot(true));
						trace?.mark("snapshot-sent");
						// The user-visible number is now known: end the main trace here. Plugin
						// activation continues behind it and is logged separately (logPhase).
						finishHelloTrace?.({ snapWireB: lastSnapshotBytes, activeConvs: service.activeConversations() });
					};
					const diskSync = cs.diskSyncPending?.();
					if (diskSync) {
						void Promise.race([diskSync, delay(BASELINE_DISK_SYNC_MAX_MS)]).then(() => {
							if (!closed) baseline();
						});
					} else {
						baseline();
					}
					const pluginsStartedAt = performance.now();
					// Plugin catalog: re-scan + activate new dirs on every attach so
					// freshly dropped plugins show up without a server restart.
					pluginMgr
						.ensureLoaded(() => service.get(cid)?.getLang() ?? "en")
						.then((plugins) => {
							if (closed) return;
							send({ type: "plugins", plugins, epoch: pluginMgr.epoch });
							// 插件市场列表（可一键安装的清单）随附推一次。
							send({
								type: "plugin_catalog",
								entries: pluginMgr.catalog(),
								epoch: pluginMgr.catalogEpochValue,
							});
							// 让各插件向新接入的客户端推送自身初始状态（onAttach 钩子）——
							// 插件不要依赖客户端挂载后自己拉（见 plugins.ts onAttach 注释）。
							pluginMgr.notifyAttach(cid);
							// 插件命令可能在本客户端 attach 过程中才注册（首载竞态）——
							// 重推一次目录，保证选择器完整。
							service.applyPluginCommandCatalog();
						})
						.catch(() => {
							// Plugin failure must not prevent the initial authoritative state.
						})
						.then(() => {
							if (closed) return;
							// Plugin activation cost, recorded but no longer on the critical path.
							logPhase(`attach ${cid}`, "plugins", performance.now() - pluginsStartedAt);
						});
					// hello may carry the UI locale — persist it before replaying
					// anything queued during startup (issue #91).
					if (msg.locale) void service.setLocale(cid, msg.locale);
					// Replay anything that arrived while the session was starting.
					const queued = pending;
					pending = [];
					for (const m of queued) dispatch(m);
				})
				.catch((err: unknown) => {
					// Admission refused (quiesce): close the socket so the browser
					// reconnect loop keeps retrying until admission reopens. Do NOT
					// leave a half-alive connection that can only show an error.
					if (err instanceof QuiesceRejectedError) {
						closed = true;
						if (ws.readyState === WebSocket.OPEN) {
							ws.close(4403, "quiesced");
						}
						ws.terminate?.();
						return;
					}
					// Real init failure (bad agent dir etc.) — keep the connection
					// open so the user can see the error and fix it.
					send({
						type: "notice",
						level: "error",
						text: `会话初始化失败：${(err as Error).message}`,
						textEn: `Failed to initialize session: ${(err as Error).message}`,
					});
				});
			return;
		}

		dispatch(msg);
	});

	ws.on("close", () => {
		service.noteSocketClose();
		closed = true;
		finishHelloTrace?.();
		pending = [];
		removePluginSender();
		if (snapshotRetryTimer) {
			clearTimeout(snapshotRetryTimer);
			snapshotRetryTimer = null;
		}
		if (clientId) service.detach(clientId, send);
	});
});

// When spawned by the old process as an auto-restart replacement, wait for
// the old instance to release the port before binding (it exits right after
// spawning us). Probe by attempting a connection: refused = free.
if (process.env[RESTART_CHILD_ENV] === "1") {
	const deadline = Date.now() + 20_000;
	const portFree = () =>
		new Promise<boolean>((resolve) => {
			const sock = createConnection({ port: PORT, host: "127.0.0.1" });
			sock.once("connect", () => {
				sock.destroy();
				resolve(false); // busy — old instance still up
			});
			sock.once("error", () => resolve(true)); // refused → free
			sock.setTimeout(500, () => {
				sock.destroy();
				resolve(false);
			});
		});
	while (Date.now() < deadline) {
		if (await portFree()) break;
		await new Promise((r) => setTimeout(r, 300));
	}
}

httpServer.listen(PORT, HOST, () => {
	console.log("");
	console.log("  ⚡ pi-web-ui — web chat for the pi coding agent");
	console.log(`    http://localhost:${PORT}`);
	console.log(`    workspace   : ${CWD}`);
	console.log(`    session dir : ${SESSION_DIR_ROOT}`);
	console.log(`    pi SDK      : v${VERSION}`);
	console.log(`    bind        : ${HOST}:${PORT}`);
	console.log("");
});

// 上传文件保留期清理：启动扫一次 + 每 6 小时一次（best-effort，见 uploads.ts）
scheduleUploadCleanup();

// Local control socket (status / quiesce / unquiesce) — same data dir the
// CLI uses, so `pi-web-ui server status|quiesce|unquiesce` just works.
const stopControl = startControlServer({ service, dataDir: DATA_DIR, port: PORT });

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("\nshutting down…");
	clearInterval(heartbeatTimer);
	stopControl();
	pluginMgr.dispose();
	mcpBridge.dispose();
	await service.disposeAll();
	wss.close();
	httpServer.close();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
