/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/styles.css（被测件：.chan-dialog* 的层叠结果）,
 *   ../../web/src/components/ChannelDialog.tsx（三段式结构：头/体/脚，只有体滚）
 * @CONTRACT 「头脚固定、只有内容区滚动」是这个弹窗的**结构承诺**，不能只靠肉眼验：
 *   ① .chan-dialog 自身 overflow 必须是 hidden（一旦回落到 .modal 的 overflow-y:auto，
 *      整个弹窗变成滚动容器，body 的 flex:1 1 auto/min-height:0 就夹不住，内容不滚）；
 *   ② .chan-dialog-body 必须有 overflow-y:auto + min-height:0；
 *   ③ 桌面与窄屏**两套断点下都成立**（真实事故：窄屏规则被误写进 min-width:641px 桌面块，
 *      三类选择器特异性压过单类，把 overflow:hidden 丢了）；
 *   ④ 头部里的 .modal-close 不得带全局那套 sticky 负边距（会把 body 拽到标题下面）。
 * @WHY 用正则按断点切块解析，而不是 jsdom 取 computedStyle：jsdom 不实现 @media 匹配，
 *   也不做特异性层叠计算，恰好测不出这次的事故。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 注释必须先剥掉再解析。
 * @GOTCHA 选择器用 `[^{}]+` 抓取时，前面那条 `/* … *\/` 注释会被并进选择器串里，
 *   于是 ".chan-dialog" 永远匹配不到（本文件第一版就栽在这，两个断言取到 null/0）。
 */
const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

/** 把顶层 @media 块整体摘出来（只需一层嵌套，样式表里没有嵌套 media）。 */
function mediaBlocks(source: string): { cond: string; body: string }[] {
	const out: { cond: string; body: string }[] = [];
	const re = /@media([^{]+)\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source))) {
		let depth = 1;
		let i = re.lastIndex;
		while (i < source.length && depth > 0) {
			if (source[i] === "{") depth++;
			else if (source[i] === "}") depth--;
			i++;
		}
		out.push({ cond: m[1].trim(), body: source.slice(re.lastIndex, i - 1) });
	}
	return out;
}

/**
 * 顶层规则 = 去掉所有 @media 块之后剩下的部分。
 * @GOTCHA 不能用 /g 正则边遍历边改 lastIndex：改了之后 exec 会从新位置继续，
 *   跳过的区间里若还有 @media 就漏掉，导致顶层内容被错误保留/丢弃。改成手写扫描。
 */
function topLevel(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const at = source.indexOf("@media", i);
		if (at < 0) break;
		const brace = source.indexOf("{", at);
		if (brace < 0) break;
		out += source.slice(i, at);
		let depth = 1;
		let j = brace + 1;
		while (j < source.length && depth > 0) {
			if (source[j] === "{") depth++;
			else if (source[j] === "}") depth--;
			j++;
		}
		i = j;
	}
	return out + source.slice(i);
}

/** 取某个选择器（整串精确匹配，允许逗号分组里出现）在一段 CSS 里的所有声明块。 */
function declsFor(source: string, selector: string): string[] {
	const out: string[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source))) {
		const selectors = m[1].split(",").map((s) => s.trim());
		if (selectors.includes(selector)) out.push(m[2]);
	}
	return out;
}

/** 同一属性多次声明时，后写的生效（同特异性下的层叠）。 */
function lastValue(blocks: string[], prop: string): string | null {
	let value: string | null = null;
	for (const b of blocks) {
		const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g");
		let m: RegExpExecArray | null;
		while ((m = re.exec(b))) value = m[1].trim();
	}
	return value;
}

const top = topLevel(css);
const medias = mediaBlocks(css);
/** 桌面断点（min-width:641px 且不带 max-width 上限）与窄屏断点（max-width:640px）。 */
const desktop = medias.filter((b) => /min-width:\s*641px/.test(b.cond) && !/max-width/.test(b.cond));
const narrow = medias.filter((b) => /max-width:\s*640px/.test(b.cond));

describe(".chan-dialog 的「只有内容区滚动」是层叠后仍成立的", () => {
	it("顶层：弹窗自身 overflow:hidden，内容区 overflow-y:auto + min-height:0", () => {
		expect(lastValue(declsFor(top, ".chan-dialog"), "overflow")).toBe("hidden");
		const body = declsFor(top, ".chan-dialog-body");
		expect(lastValue(body, "overflow-y")).toBe("auto");
		expect(lastValue(body, "min-height")).toBe("0");
		expect(lastValue(body, "flex")).toBe("1 1 auto");
	});

	it("桌面断点里不得出现改弹窗尺寸/overflow 的规则（窄屏规则误写进桌面块就是本次事故）", () => {
		for (const block of desktop) {
			for (const sel of [".chan-dialog", ".chan-form-dialog", ".chan-account-modal"]) {
				for (const decl of declsFor(block.body, sel)) {
					expect(decl).not.toMatch(/max-height|overflow|max-width|(?:^|;)\s*width\s*:/);
				}
			}
		}
	});

	it("窄屏断点：改了 max-height 就必须同时重申 overflow:hidden（否则回落到 .modal 的 auto）", () => {
		for (const block of narrow) {
			for (const sel of [".chan-dialog", ".chan-form-dialog", ".chan-account-modal"]) {
				for (const decl of declsFor(block.body, sel)) {
					if (/max-height/.test(decl)) expect(decl).toMatch(/overflow\s*:\s*hidden/);
				}
			}
		}
	});

	/**
	 * @BUGFIX 全局 .modal-close 是「sticky + margin-bottom:-42px + align-self:flex-end」的
	 * 负边距方案（它假设弹窗自身就是滚动容器）。本弹窗是三段式，那套会让 × 按钮落到
	 * **头部下沿之外**、盖在内容区第一行上（用户截图：× 压在「基本信息」上）。
	 * 只覆盖 position 不够 —— margin-bottom 与 align-self 都必须一起归零。
	 */
	it("头部的关闭按钮必须完全脱离全局那套 sticky 负边距方案", () => {
		const head = declsFor(top, ".chan-dialog-head .modal-close");
		expect(head.length).toBeGreaterThan(0);
		expect(lastValue(head, "position")).toBe("static");
		expect(lastValue(head, "margin-bottom")).toBe("0");
		// align-self:flex-end 会把它推到交叉轴末端，在 baseline 对齐的头部里就是「掉下去」。
		expect(lastValue(head, "align-self")).toBe("center");
	});
});
