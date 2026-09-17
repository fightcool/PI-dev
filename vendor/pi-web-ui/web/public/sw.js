/**
 * pi-web-ui — Progressive Web App service worker.
 *
 * Strategy overview
 * -----------------
 * pi-web-ui is a WebSocket-first app that needs a live backend, so we do NOT
 * try to make it fully offline. Instead the SW focuses on what makes it a
 * reliable *installable* PWA on mobile/desktop:
 *
 *   - network-first for navigation requests (falls back to the cached app
 *     shell when the network flaps), and
 *   - cache-first for hashed static assets, which Vite fingerprints so a cache
 *     hit is always the right version until a new deploy publishes new hashes.
 *
 * Real-time / dynamic / credential-bearing routes (/ws, /api, /themes,
 * /plugins) are always fetched from the network and never cached, so we never
 * risk serving stale theme/plugin code or caching anything sensitive.
 */

/*
 * @BUGFIX 2026-09-17：缓存名以前是写死的 `-v1`，**永不随部署变化**，而 activate 只删
 *   「不叫 v1」的缓存 —— 等于永远不清自己。上面注释的假设是「Vite 给资源打了 hash，
 *   命中缓存就一定是对的版本，直到新部署发布新 hash」，但漏了一种情况：导航请求在
 *   网络抖动/离线时会回落到 **shell 缓存里的旧 index.html**，它引用的是旧 hash，
 *   而旧 hash 在 static 缓存里永远命中 —— 于是整套旧资源被无期限钉住。
 *   手机装成 PWA 后尤其明显：用户看到的一直是上一个版本的界面。
 *   现在缓存名带 BUILD_ID（构建时由 scripts/stamp-sw.mjs 注入），activate 时删掉
 *   所有**不属于当前 BUILD_ID** 的缓存，新部署即自动汰汰旧资源。
 * @CONTRACT BUILD_ID 那一行的形状必须保持（等号右边是单引号字符串）：
 *   替换脚本按正则匹配它，改成模板串/双引号会让注入静默失效。
 */
const BUILD_ID = '__PI_WEB_BUILD_ID__';

const STATIC_CACHE = `pi-web-ui-static-${BUILD_ID}`;
const SHELL_CACHE = `pi-web-ui-shell-${BUILD_ID}`;

// App root within this origin — "/" for root deployments, "/pi/" behind an
// nginx sub-path reverse proxy. All path checks below are relative to it, so
// the worker behaves identically under either deployment layout.
const SCOPE = new URL("./", self.registration.scope).pathname;

/** Map a request pathname to an app-relative path ("/pi/ws" → "/ws"), or null
 *  when the request lies outside the registration scope (shouldn't happen). */
function appPath(pathname) {
	if (SCOPE === "/") return pathname;
	if (pathname.startsWith(SCOPE)) return "/" + pathname.slice(SCOPE.length);
	return null;
}

self.addEventListener("install", (event) => {
	// Take control as soon as this version activates so the current page is
	// served by the new worker without requiring a second reload.
	self.skipWaiting();
	event.waitUntil(caches.open(SHELL_CACHE));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== SHELL_CACHE).map((k) => caches.delete(k))),
			)
			// Apply to already-open pages immediately.
			.then(() => self.clients.claim()),
	);
});

// Only cache simple, safe GET requests. Everything else goes straight through.
function isCachable(request) {
	const method = request.method;
	if (method !== "GET") return false;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return false;

	// Never cache real-time, dynamic or credential/data endpoints.
	const path = appPath(url.pathname);
	if (
		path === null ||
		path.startsWith("/ws") ||
		path.startsWith("/api") ||
		path.startsWith("/themes") ||
		path.startsWith("/plugins")
	) {
		return false;
	}
	return true;
}

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (!isCachable(request)) {
		// Let the browser/backend handle WebSockets, API calls and cross-origin
		// requests normally.
		return;
	}

	const requestUrl = new URL(request.url);

	// Navigation → app shell. Network-first with cached fallback: users get the
	// latest build when online but can still reopen the app while flaky.
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
					return response;
				})
				.catch(() => caches.match(request).then((cached) => cached || caches.match(SCOPE) || Response.error())),
		);
		return;
	}

	// Static assets (hashed by Vite) → cache-first.
	const path = appPath(requestUrl.pathname);
	const isStatic =
		path !== null &&
		(path.startsWith("/assets/") ||
			path.startsWith("/icons/") ||
			path === "/favicon.svg" ||
			path === "/icon.ico" ||
			path === "/manifest.webmanifest");

	if (isStatic) {
		event.respondWith(
			caches.match(request).then((cached) => {
				if (cached) return cached;
				return fetch(request).then((response) => {
					if (response && response.ok) {
						const copy = response.clone();
						caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
					}
					return response;
				});
			}),
		);
	}
});
