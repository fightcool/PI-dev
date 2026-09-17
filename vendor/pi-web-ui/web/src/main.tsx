import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
// Load the workspace only after authentication; public login never imports chat/Markdown.
const App = lazy(() => import("./App").then((module) => ({ default: module.App })));
import { LanguageProvider } from "./i18n";
import "./styles.css";
import { applyTheme, loadTheme } from "./theme";
import { initAuthToken } from "./auth-token";
import { installScrollbarGutterVar } from "./scrollbar-gutter";
import { appBase } from "./base-url";
import { PasskeyGate } from "./components/PasskeyGate";
// 端到端性能打点（`__piPerf()` 可在控制台读出瀑布）——见 perf-trace.ts。
import { perfMark } from "./perf-trace";

// 吸收地址栏 ?token=（PI_WEB_TOKEN 鉴权入口）并持久化，须在首次请求前执行
initAuthToken();

// Apply the persisted theme before first render so there's no flash of the
// wrong palette. The full stylesheet swap happens via an injected <link>.
applyTheme(loadTheme());
// 首帧前实测滚动条宽（scrollbar-gutter 预留 gutter 的宽度）→ 宽屏消息列与
// 输入列的对齐补偿变量 --msgs-gutter，见 scrollbar-gutter.ts。
installScrollbarGutterVar();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<LanguageProvider>
			<PasskeyGate>
				<Suspense
					fallback={
						<div className="boot-wait" role="status" aria-label="Loading">
							…
						</div>
					}
				>
					<App />
				</Suspense>
			</PasskeyGate>
		</LanguageProvider>
	</StrictMode>,
);
perfMark("render:called");

// PWA: register the service worker only in production builds so the Vite dev
// server (live reload / HMR) is never intercepted or cached. The scope is
// derived from the page URL (appBase), so sub-path deployments like /pi/ get
// a worker scoped to the app root instead of the site root.
//
// @BUGFIX 2026-09-17：只 register 是不够的。已装在手机上的旧 worker 只会按浏览器自己的
//   节奏去校验 sw.js，用户可能长时间停在上一个版本的界面（PWA 独立窗口里连硬刷都不好使）。
//   现在做两件事：① 每次加载与每次回到前台都主动 update() 查一次新版；② 新 worker 接管后
//   （controllerchange）自动重载一次页面，让新 HTML 去引用新 hash 的资源。
// @GOTCHA reloading 这个哨兵必不可少：sw.js 里调了 skipWaiting()+clients.claim()，
//   controllerchange 可能连续触发，没有哨兵会陷入「刷新 → 接管 → 再刷新」的循环。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
	// Register after load so it never blocks first paint.
	window.addEventListener("load", () => {
		const base = appBase();
		navigator.serviceWorker
			.register(`${base}sw.js`, { scope: base })
			.then((reg) => {
				// 立刻查一次：本次加载就能拿到刚部署的版本。
				void reg.update().catch(() => {});
				// 从后台切回前台时再查一次（手机上 PWA 常常几天不重启进程）。
				document.addEventListener("visibilitychange", () => {
					if (document.visibilityState === "visible") void reg.update().catch(() => {});
				});
			})
			.catch((err) => {
				console.warn("Service worker registration failed:", err);
			});
		let reloading = false;
		// @GOTCHA 首次安装不能刷新，而「controllerchange 时 controller 是否存在」区分不了这个：
		//   新 worker 接管后 controller 总是有值。必须在**监听之前**先记下当前页是不是已经
		//   被某个 worker 接管：没被接管 = 首次安装，页面本就是最新的，刷新纯属多余。
		const hadController = Boolean(navigator.serviceWorker.controller);
		navigator.serviceWorker.addEventListener("controllerchange", () => {
			if (reloading || !hadController) return;
			reloading = true;
			window.location.reload();
		});
	});
}
