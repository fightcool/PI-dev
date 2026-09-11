import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore, UI_DEFAULTS_VERSION } from "../../server/client-state.js";

/**
 * UI 偏好默认值的迁移契约（见 ClientStateStore 的 UI_DEFAULTS_VERSION）：
 * 设置是全局共享并整对象落盘的，所以「旧默认值盖进去的存量 true」必须按「未设置」
 * 处理，否则 toolsWrap 这类默认值一改就对所有人失效；而用户**显式**点过的开关
 * （写入时会带上版本号）不能被覆盖。
 */

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "client-settings-defaults-"));
	file = join(dir, "client-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	writeFileSync(file, JSON.stringify({ __settings__: { projects: [], settings, ...extra } }));

describe("UI 默认值迁移（toolsWrap 默认折叠）", () => {
	it("没有版本标记的存量 toolsWrap:true（旧默认盖进去的）→ 按新默认折叠", () => {
		write({ toolsWrap: true });
		expect(new ClientStateStore(file).getSettings("c1").toolsWrap).toBe(false);
	});

	it("带新版本标记的 toolsWrap:true 是用户显式选择 → 保留", () => {
		write({ toolsWrap: true }, { uiDefaultsVersion: UI_DEFAULTS_VERSION });
		expect(new ClientStateStore(file).getSettings("c1").toolsWrap).toBe(true);
	});

	it("保存后写入版本标记，之后的显式选择不再被改动", () => {
		write({ toolsWrap: true });
		const store = new ClientStateStore(file);
		expect(store.getSettings("c1").toolsWrap).toBe(false);
		store.saveSettings("c1", { toolsWrap: true });
		// 新进程（同一文件）读到的就是用户选择
		expect(new ClientStateStore(file).getSettings("c1").toolsWrap).toBe(true);
	});

	it("其它默认值不受影响（questionnaireEnabled 仍为 true）", () => {
		write({ toolsWrap: true });
		expect(new ClientStateStore(file).getSettings("c1").questionnaireEnabled).toBe(true);
	});
});
