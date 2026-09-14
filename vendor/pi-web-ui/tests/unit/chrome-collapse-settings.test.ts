/**
 * 底部控件自动收缩开关规整单测（见 web/src/chrome-collapse-settings.ts）。
 * 仅测纯函数 normalizeChromeCollapseSettings —— localStorage 存取在 node 环境不可用，
 * load/save 都有 try/catch 兜底，不在单测范围内。
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CHROME_COLLAPSE_SETTINGS,
	normalizeChromeCollapseSettings,
} from "../../web/src/chrome-collapse-settings.js";

describe("normalizeChromeCollapseSettings", () => {
	it("非对象回退默认（默认开启）", () => {
		expect(normalizeChromeCollapseSettings(null)).toEqual(DEFAULT_CHROME_COLLAPSE_SETTINGS);
		expect(normalizeChromeCollapseSettings(undefined)).toEqual(DEFAULT_CHROME_COLLAPSE_SETTINGS);
		expect(normalizeChromeCollapseSettings("yes")).toEqual(DEFAULT_CHROME_COLLAPSE_SETTINGS);
		expect(normalizeChromeCollapseSettings(1)).toEqual(DEFAULT_CHROME_COLLAPSE_SETTINGS);
		expect(DEFAULT_CHROME_COLLAPSE_SETTINGS).toEqual({ autoCollapse: true });
	});

	it("保留合法的布尔值", () => {
		expect(normalizeChromeCollapseSettings({ autoCollapse: true })).toEqual({ autoCollapse: true });
		expect(normalizeChromeCollapseSettings({ autoCollapse: false })).toEqual({ autoCollapse: false });
	});

	it("字段类型错误/缺失回退默认", () => {
		expect(normalizeChromeCollapseSettings({ autoCollapse: "yes" })).toEqual(DEFAULT_CHROME_COLLAPSE_SETTINGS);
		expect(normalizeChromeCollapseSettings({ autoCollapse: 0 })).toEqual(DEFAULT_CHROME_COLLAPSE_SETTINGS);
		expect(normalizeChromeCollapseSettings({})).toEqual(DEFAULT_CHROME_COLLAPSE_SETTINGS);
		expect(normalizeChromeCollapseSettings({ other: false })).toEqual(DEFAULT_CHROME_COLLAPSE_SETTINGS);
	});
});
