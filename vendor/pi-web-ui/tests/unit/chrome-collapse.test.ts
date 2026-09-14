/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/chrome-collapse.ts（底部控件自动收缩的判定）
 * 📖 docs/architecture-core.md
 * @CONTRACT 用纯信号组合钉死规则：聚焦输入框永不收起；输出中/离开最底部才收起；
 *   手动值优先于自动规则，并由调用方在滚动/新一轮输出时清空。
 */
import { describe, expect, it } from "vitest";
import { chromeCollapsed, toggledForce, type ChromeSignals } from "../../web/src/chrome-collapse.js";

const signals = (patch: Partial<ChromeSignals> = {}): ChromeSignals => ({
	streaming: false,
	atBottom: true,
	focused: false,
	force: null,
	...patch,
});

describe("底部控件自动收缩判定", () => {
	it("空闲 + 停在最底部 → 展开（什么都不做）", () => {
		expect(chromeCollapsed(signals())).toBe(false);
	});

	it("输出中 → 收起（把竖向空间让给正文）", () => {
		expect(chromeCollapsed(signals({ streaming: true }))).toBe(true);
	});

	it("离开最底部（在翻历史）→ 收起", () => {
		expect(chromeCollapsed(signals({ atBottom: false }))).toBe(true);
	});

	it("输入框聚焦 → 永不收起（正在打字时工具条/状态栏必须可见）", () => {
		expect(chromeCollapsed(signals({ focused: true }))).toBe(false);
		expect(chromeCollapsed(signals({ focused: true, streaming: true }))).toBe(false);
		expect(chromeCollapsed(signals({ focused: true, atBottom: false }))).toBe(false);
		// 手动收起也不能压过聚焦：否则用户点开输入框却看不到工具条。
		expect(chromeCollapsed(signals({ focused: true, force: "collapsed" }))).toBe(false);
	});

	it("手动值优先于自动规则（滑到最底部/输出中也能手动展开）", () => {
		expect(chromeCollapsed(signals({ force: "expanded" }))).toBe(false);
		expect(chromeCollapsed(signals({ streaming: true, force: "expanded" }))).toBe(false);
		expect(chromeCollapsed(signals({ atBottom: false, force: "expanded" }))).toBe(false);
		expect(chromeCollapsed(signals({ force: "collapsed" }))).toBe(true);
		expect(chromeCollapsed(signals({ atBottom: true, force: "collapsed" }))).toBe(true);
	});

	it("toggledForce 按「当前看到的状态」翻转", () => {
		expect(toggledForce(true)).toBe("expanded");
		expect(toggledForce(false)).toBe("collapsed");
	});
});
