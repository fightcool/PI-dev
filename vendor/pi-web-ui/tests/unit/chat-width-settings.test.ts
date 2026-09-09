/**
 * 宽屏聊天列开关规整单测（见 web/src/chat-width-settings.ts）。
 * 仅测纯函数 normalizeChatWidthSettings —— localStorage 存取在 node 环境不可用，
 * load/save 都有 try/catch 兜底，不在单测范围内。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_WIDTH_SETTINGS, normalizeChatWidthSettings } from "../../web/src/chat-width-settings.js";

describe("normalizeChatWidthSettings", () => {
	it("非对象回退默认（默认关闭）", () => {
		expect(normalizeChatWidthSettings(null)).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings(undefined)).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings("yes")).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings(1)).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
	});

	it("保留合法的布尔值", () => {
		expect(normalizeChatWidthSettings({ wide: true })).toEqual({ wide: true });
		expect(normalizeChatWidthSettings({ wide: false })).toEqual({ wide: false });
	});

	it("字段类型错误/缺失回退默认", () => {
		expect(normalizeChatWidthSettings({ wide: "yes" })).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings({ wide: 1 })).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings({})).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings({ other: false })).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
	});
});
