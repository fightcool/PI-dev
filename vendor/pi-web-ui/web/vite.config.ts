import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const backend = process.env.PI_WEB_DEV_BACKEND ?? "http://localhost:8788";

// Dev: Vite serves the web UI on :5173 and proxies the WebSocket + any API
// traffic to the backend server (which runs separately via `npm run dev:server`).
// The dev backend is pinned to :8788 (see the dev:server script) so it never
// collides with a globally-installed pi-web-ui running on the default :8787.
export default defineConfig({
	root: __dirname,
	plugins: [react()],
	build: {
		outDir: join(__dirname, "dist"),
		emptyOutDir: true,
		// 构建目标必须 ≥ es2021（逻辑赋值 ||= 的原生支持）。Vite 默认的
		// "modules"(=es2020) 会让 esbuild 降级 ||=，而 esbuild 降级 + 压缩写只写
		// 变量时会丢掉声明：`let r; f(r ||= {})` → `f(void 0 || (r = {}))`，严格模式
		// 下抛 ReferenceError。xterm 6 的 requestMode() 正是这个写法，被坑后 vim 等
		// 会发 DECRQM 查询的 TUI 一启动就把终端解析器打断，表现为“终端僵住、
		// 敲什么都没反应”。浏览器下限不变：||= 在 Chrome 85 / Safari 14 / FF 79 已支持。
		target: "es2022",
		rollupOptions: {
			output: {
				// 手动分包：大体积第三方库拆出主 chunk，利于浏览器缓存——
				// 业务代码变动时不让用户重新下载 xterm / markdown 渲染器
				manualChunks(id) {
					// Pin React's complete runtime and CommonJS helpers together. Object-form
					// chunks let Markdown capture React's shared dependencies and make the
					// public login import the entire Markdown renderer through React.
					if (id.includes("commonjsHelpers") || /\/node_modules\/(react|react-dom|scheduler)\//.test(id))
						return "react";
					if (/\/node_modules\/(react-markdown|remark-[^/]+|rehype-[^/]+|highlight.js)\//.test(id)) return "markdown";
					if (id.includes("/node_modules/@xterm/")) return "xterm";
				},
			},
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": backend,
			"/themes": backend,
			"/plugins": backend,
			"/ws": {
				target: backend.replace(/^http/, "ws"),
				ws: true,
				// Don't leak sockets when the backend is down/restarting (avoids
				// ERR_INSUFFICIENT_RESOURCES from accumulated dead proxy sockets).
				configure(proxy) {
					proxy.on("error", (_err, _req, socket) => {
						(socket as { destroy?: () => void } | undefined)?.destroy?.();
					});
					proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
						socket.on("error", () => {});
					});
				},
			},
		},
	},
});
