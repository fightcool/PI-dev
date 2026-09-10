/**
 * 插件视图加载器：把 <dataDir>/plugins/<id>/client/entry.mjs 动态加载进页面。
 *
 * 插件客户端模块的约定（ESM，默认导出）：
 *   export default {
 *     // 挂载到宿主给的 DOM 容器；返回清理函数（可选），切走/卸载时调用。
 *     mount(container: HTMLElement, ctx: PluginViewContext): void | (() => void)
 *   }
 *
 * 与主应用的通信只有两条窄通道（不共享 React 实例，插件可用任何技术栈）：
 *   ctx.send(payload)   → WS 上行 {type:"plugin_message", pluginId, payload}
 *   ctx.onData(cb)      ← WS 下行 plugin_data（按 pluginId 过滤后回调）
 *
 * plugin_data 的分发走 window CustomEvent（同主题切换的事件模式），
 * use-chat 收到消息后 emitPluginData，这里订阅并按插件扇出。
 */
import type { UiPluginInfo } from "./types";
import { appUrl } from "./base-url";

export interface PluginViewContext {
	pluginId: string;
	/** 上行一条消息给插件的服务端入口（index.mjs 的 onMessage 处理器）。 */
	send: (payload: unknown) => void;
	/** 订阅服务端广播；返回取消订阅函数。 */
	onData: (cb: (payload: unknown) => void) => () => void;
}

/** 上下文传给插件 fenced-code renderer（与视图 mount 的窄通道同一套）。 */
export interface FenceRenderContext {
	pluginId: string;
	/** 上行一条消息给插件的服务端入口（index.mjs 的 onMessage 处理器）。 */
	send: (payload: unknown) => void;
	/** 订阅服务端广播；返回取消订阅函数。 */
	onData: (cb: (payload: unknown) => void) => () => void;
}

/** 插件把 ```lang 围栏渲染成自定义 DOM 的工厂函数。返回 null 表示不渲染
 *  （回退普通代码块）。可以是任意技术栈——主应用只负责把返回的 DOM 挂进
 *  消息流，不共享 React 实例。 */
export type FenceRenderer = (code: string, ctx: FenceRenderContext) => HTMLElement | null | Promise<HTMLElement | null>;

export interface PluginViewModule {
	mount(container: HTMLElement, ctx: PluginViewContext): void | (() => void);
	/** 可选：fenced-code 渲染器（manifest "renderers" 声明的语言）。 */
	renderers?: Record<string, FenceRenderer>;
}

export interface LoadedPluginView {
	info: UiPluginInfo;
	module: PluginViewModule;
}

const PLUGIN_DATA_EVENT = "pi-web-ui:plugin-data";

/** use-chat 调用：把服务端 plugin_data 消息转成分发事件。 */
export function emitPluginData(pluginId: string, payload: unknown): void {
	window.dispatchEvent(new CustomEvent(PLUGIN_DATA_EVENT, { detail: { pluginId, payload } }));
}

function subscribeAll(cb: (pluginId: string, payload: unknown) => void): () => void {
	const handler = (e: Event) => {
		const d = (e as CustomEvent).detail as {
			pluginId: string;
			payload: unknown;
		};
		cb(d.pluginId, d.payload);
	};
	window.addEventListener(PLUGIN_DATA_EVENT, handler);
	return () => window.removeEventListener(PLUGIN_DATA_EVENT, handler);
}

/**
 * 🍞 AI Breadcrumb: @COUPLED app/use-app-views.ts, components/PluginView.tsx.
 * @CONTRACT Sync only reconciles eligibility; request loads a single visited view.
 * @GOTCHA An import cannot be cancelled: record identity fences disable/re-enable
 * and epoch races before either publishing a module or recording a failure.
 */
export function createPluginViewLoader(
	importView: (url: string) => Promise<{ default?: PluginViewModule }> = (url) => import(/* @vite-ignore */ url),
) {
	type Record = { info: UiPluginInfo; loaded?: LoadedPluginView; pending?: Promise<void>; failed?: boolean };
	const records = new Map<string, Record>();
	const listeners = new Set<(views: LoadedPluginView[]) => void>();
	let lastEpoch = -1;
	const snapshot = () => [...records.values()].flatMap((record) => (record.loaded ? [record.loaded] : []));
	const notify = () => {
		const views = snapshot();
		for (const listener of listeners) listener(views);
	};
	return {
		subscribe(cb: (views: LoadedPluginView[]) => void): () => void {
			listeners.add(cb);
			cb(snapshot());
			return () => {
				listeners.delete(cb);
			};
		},
		sync(plugins: UiPluginInfo[], epoch: number): void {
			if (epoch !== lastEpoch) {
				lastEpoch = epoch;
				records.clear();
			}
			const eligible = plugins.filter(isPluginView);
			const active = new Set(eligible.map((p) => p.id));
			for (const id of records.keys()) {
				if (!active.has(id)) records.delete(id);
			}
			for (const info of eligible) {
				const record = records.get(info.id);
				if (record) record.info = info;
				else records.set(info.id, { info });
			}
			// Cleanup is published synchronously, even while other imports are pending.
			notify();
		},
		request(id: string): Promise<void> {
			const record = records.get(id);
			if (!record || record.loaded || record.failed) return Promise.resolve();
			if (record.pending) return record.pending;
			const current = () => records.get(id) === record;
			const url = appUrl(`/plugins/${encodeURIComponent(id)}/client/entry.mjs?e=${lastEpoch}`);
			record.pending = Promise.resolve()
				.then(() => (current() ? importView(url) : undefined))
				.then((mod) => {
					if (!current() || !mod) return;
					if (!mod.default || typeof mod.default.mount !== "function") {
						throw new Error("entry.mjs 缺少 default.mount");
					}
					record.loaded = { info: record.info, module: mod.default };
					notify();
				})
				.catch((err) => {
					if (!current()) return;
					record.failed = true;
					console.error(`[plugin:${id}] 客户端加载失败:`, err);
				})
				.finally(() => {
					record.pending = undefined;
				});
			return record.pending;
		},
	};
}

export function isPluginView(plugin: UiPluginInfo): boolean {
	return plugin.hasClient && plugin.view !== false && !plugin.error;
}

const viewLoader = createPluginViewLoader();
export const subscribeLoadedPluginViews = viewLoader.subscribe;
export const syncPluginViews = viewLoader.sync;
export const requestPluginView = viewLoader.request;

/** 组装传给插件 mount() 的上下文（send 由 App 注入真正的 ws 发送函数）。 */
export function makePluginContext(
	pluginId: string,
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void,
): PluginViewContext {
	return {
		pluginId,
		send: (payload) => send({ type: "plugin_message", pluginId, payload }),
		onData: (cb) =>
			subscribeAll((pid, payload) => {
				if (pid === pluginId) cb(payload);
			}),
	};
}
