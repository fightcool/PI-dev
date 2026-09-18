/// <reference lib="dom" />
/**
 * 底部控件自动收缩开关（纯前端 localStorage，不经过 server）。
 *
 * - 默认开启：输出中 / 向上翻阅会话时自动收起目标条与输入工具条，
 *   把竖向空间让给正文；滑到最底部、聚焦输入框或点一下展开即恢复。
 *   底部状态栏不参与（它显示即时监控：连接/渠道、上下文占用、缓存命中率、实时速率）。
 * - 关闭后完全不干预（等同改动前行为）。
 * - normalize/load 为纯函数，可单测（tests/unit/chrome-collapse-settings.test.ts）。
 */

import { useSyncExternalStore } from "react";

export const CHROME_COLLAPSE_SETTINGS_KEY = "pi-web-ui:chrome-collapse";

export interface ChromeCollapseSettings {
	/** 是否启用「输出中/翻历史时自动收起底部控件」。 */
	autoCollapse: boolean;
}

export const DEFAULT_CHROME_COLLAPSE_SETTINGS: ChromeCollapseSettings = { autoCollapse: true };

/** 规整设置值：非对象 / 字段类型错误一律回退默认值。 */
export function normalizeChromeCollapseSettings(raw: unknown): ChromeCollapseSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CHROME_COLLAPSE_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		autoCollapse: typeof o.autoCollapse === "boolean" ? o.autoCollapse : DEFAULT_CHROME_COLLAPSE_SETTINGS.autoCollapse,
	};
}

/** 读取持久化的开关（localStorage 不可用 / 数据损坏时回退默认开启）。 */
export function loadChromeCollapseSettings(): ChromeCollapseSettings {
	try {
		const raw = localStorage.getItem(CHROME_COLLAPSE_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_CHROME_COLLAPSE_SETTINGS };
		return normalizeChromeCollapseSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_CHROME_COLLAPSE_SETTINGS };
	}
}

/** 保存并广播变更（localStorage 不可写时静默忽略）。 */
export function saveChromeCollapseSettings(s: ChromeCollapseSettings): void {
	const norm = normalizeChromeCollapseSettings(s);
	try {
		localStorage.setItem(CHROME_COLLAPSE_SETTINGS_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	cached = norm;
	for (const l of listeners) l();
}

// ---- 订阅：单例 listener 集合。----------------------------------------------

let cached: ChromeCollapseSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): boolean {
	if (!cached) cached = loadChromeCollapseSettings();
	return cached.autoCollapse;
}

/** 是否启用底部控件自动收缩（设置面板切换后即时生效，无需刷新）。 */
export function useAutoCollapseChrome(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}
