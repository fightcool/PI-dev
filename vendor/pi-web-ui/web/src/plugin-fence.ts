/**
 * fenced-code 渲染插件机制（renderer plugins）。
 *
 * 主应用把 `` ```lang `` 围栏交给「认领」该语言的插件渲染成自定义 DOM
 * （mermaid 插件认领 "mermaid"、plantuml 插件认领 "plantuml" 等）。与视图
 * 插件（顶栏 tab）不同，renderer 插件是**命中了才懒加载**：平常聊天从不下载
 * 其 bundle，只有某条消息真的出现一个 `` ```lang `` 围栏时才动态 import。
 *
 * 数据流：
 *   server 推 plugins 清单（含 renderers / view 字段）
 *     → syncFenceRenderers() 构建「语言 → 插件 id」注册表
 *     → Markdown.tsx 遇到 fence 时调 renderFence(lang, code)
 *     → 按需 import 该插件的 client/entry.mjs，取 default.renderers[lang]
 *     → 调用 renderer(code, ctx) 得到 DOM，挂进消息流；返回 null = 回退普通代码块
 *
 * 插件的 renderer 可以是任意技术栈（不共享 React 实例），上下文与视图 mount
 * 同一套窄通道（send / onData）。
 */

import type { UiPluginInfo } from "./types";
import type { FenceRenderContext, FenceRenderer, PluginViewModule } from "./plugin-loader";
import { appUrl } from "./base-url";

/** plugin_data 分发事件（与 plugin-loader 同一事件名，use-chat emitPluginData 触发）。 */
const PLUGIN_DATA_EVENT = "pi-web-ui:plugin-data";

interface RendererEntry {
	pluginId: string;
	renderer: FenceRenderer;
}

/** 语言 → 插件 id（注册表，由 syncFenceRenderers 从 plugins 清单构建）。 */
let registry = new Map<string, string>();
/** 语言 → 已加载成功的 renderer（同一页面内复用，避免重复下载）。 */
let cache = new Map<string, RendererEntry>();
/** 语言 → 加载失败（同一 epoch 内不再重试，坏 bundle 不反复刷错误）。 */
let failed = new Set<string>();
/** 服务端重载纪元；变化时丢弃全部缓存并清空失败记录（?e= 强制重拉）。 */
let lastEpoch = -1;

/** 注册表版本：每次 syncFenceRenderers() 使注册表实际变化时 +1。
 *  attach 时历史消息快照先于 plugins 清单到达（服务端 attach 流程决定），
 *  PluginFenceBlock 订阅它：清单一到就重试未命中的围栏（详见该组件）。 */
let registryVersion = 0;
const registryListeners = new Set<() => void>();
function notifyRegistry(): void {
	registryVersion++;
	for (const l of registryListeners) l();
}

/** 订阅注册表变化（返回取消函数）。 */
export function subscribeFenceRegistry(cb: () => void): () => void {
	registryListeners.add(cb);
	return () => {
		registryListeners.delete(cb);
	};
}

/** 当前注册表版本（配合 useSyncExternalStore / 重试判定）。 */
export function getFenceRegistryVersion(): number {
	return registryVersion;
}

/** 底层 WS 发送（App 注入 send）。renderer 通过它上行 plugin_message。 */
let wsSend: ((msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => boolean) | null = null;

/** App 挂载时注入真正的 ws send（与 PluginView 同一来源）。 */
export function setFenceSend(
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => boolean,
): void {
	wsSend = send;
}

/**
 * 从 plugins 清单构建「语言 → 插件」注册表。epoch 变化（plugins_reload）时
 * 丢弃全部已加载 renderer 并清空失败记录，让改过的 bundle 有机会重拉。
 */
export function syncFenceRenderers(plugins: UiPluginInfo[], epoch: number): void {
	if (epoch !== lastEpoch) {
		lastEpoch = epoch;
		cache.clear();
		failed.clear();
	}
	const next = new Map<string, string>();
	for (const p of plugins) {
		if (p.error || !p.renderers) continue;
		for (const lang of p.renderers) {
			if (!next.has(lang)) next.set(lang, p.id);
		}
	}
	// 比较新旧注册表，仅在实际变化时通知（plugins_reload 同清单不算变化，
	// 避免每个 renderer 插件版本号引发全页消息重渲染）。
	let changed = next.size !== registry.size;
	if (!changed) {
		for (const [k, v] of next) {
			if (registry.get(k) !== v) {
				changed = true;
				break;
			}
		}
	}
	if (!changed) return;
	// 清理清单里已消失的语言（插件被删/禁用）。注意这里迭代的是快照
	//（cache/failed 的 key 集），循环体里 delete 不影响本趟遍历。
	for (const lang of cache.keys()) {
		if (!next.has(lang)) cache.delete(lang);
	}
	for (const lang of failed) {
		if (!next.has(lang)) failed.delete(lang);
	}
	registry = next;
	notifyRegistry();
}

/**
 * 渲染一个 `` ```lang `` 围栏。返回渲染好的 DOM（由调用方挂进消息流），
 * 无插件认领 / 加载失败 / renderer 返回 null 时返回 null（回退普通代码块）。
 */
export async function renderFence(lang: string, code: string): Promise<HTMLElement | null> {
	const pluginId = registry.get(lang);
	if (!pluginId) return null;

	let entry = cache.get(lang);
	if (!entry && !failed.has(lang)) {
		try {
			// @vite-ignore：URL 运行时才知道。?e=<epoch> 缓存击穿。
			// appUrl 补上应用根前缀（nginx 子路径部署兼容）。
			const mod = (await import(
				/* @vite-ignore */ appUrl(`/plugins/${encodeURIComponent(pluginId)}/client/entry.mjs?e=${lastEpoch}`)
			)) as { default?: PluginViewModule };
			const renderer = mod.default?.renderers?.[lang];
			if (typeof renderer === "function") {
				entry = { pluginId, renderer };
				cache.set(lang, entry);
			} else {
				failed.add(lang);
				console.error(`[plugin:${pluginId}] entry.mjs 未提供 renderers["${lang}"]`);
			}
		} catch (err) {
			failed.add(lang);
			console.error(`[plugin:${pluginId}] renderer 加载失败（${lang}）:`, err);
		}
	}
	if (!entry) return null;

	const ctx: FenceRenderContext = {
		pluginId: entry.pluginId,
		send: (payload) => {
			wsSend?.({ type: "plugin_message", pluginId: entry!.pluginId, payload });
		},
		onData: (cb) => {
			const handler = (e: Event) => {
				const d = (e as CustomEvent).detail as { pluginId?: unknown; payload?: unknown };
				if (d.pluginId === entry!.pluginId) cb(d.payload);
			};
			window.addEventListener(PLUGIN_DATA_EVENT, handler);
			return () => window.removeEventListener(PLUGIN_DATA_EVENT, handler);
		},
	};

	try {
		const result = await entry.renderer(code, ctx);
		return result instanceof HTMLElement ? result : null;
	} catch (err) {
		console.error(`[plugin:${entry.pluginId}] renderer("${lang}") 执行失败:`, err);
		return null;
	}
}

/** 当前是否有插件认领该语言（测试 / 日志用）。 */
export function hasFenceRenderer(lang: string): boolean {
	return registry.has(lang);
}
