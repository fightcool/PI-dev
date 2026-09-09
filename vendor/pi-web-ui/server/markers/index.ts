/**
 * markers/index.ts — 聚合内置标记并提供便捷初始化。
 */

import { registerMarker } from "./registry.js";
import { todoMarker } from "./builtins/todo.js";
import { notifyMarker } from "./builtins/notify.js";
import { renameMarker } from "./builtins/rename.js";

let initialized = false;

export function ensureMarkersRegistered(): void {
	if (initialized) return;
	registerMarker(todoMarker);
	registerMarker(notifyMarker);
	registerMarker(renameMarker);
	initialized = true;
}

export { todoMarker, notifyMarker, renameMarker };
export * from "./marker.js";
export * from "./registry.js";
export * from "./store.js";
