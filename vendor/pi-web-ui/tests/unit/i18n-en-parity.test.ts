import { describe, expect, it } from "vitest";
import { zh } from "../../web/src/i18n.js";
import { en } from "../../web/src/i18n-en.js";

/**
 * 英文词典拆分后的契约（见 i18n-en.ts 的 @WHY）：
 *  - 键集合必须与 zh 完全一致（类型上也强制，这里再加一道运行时护栏，防止有人
 *    用 `as` 绕过去）；
 *  - 每个键的 `{占位符}` 集合必须一致，否则替换会静默丢参；
 *  - 值不能为空串（空串会让界面出现空白处，很难发现）。
 */

/** Placeholder names used by a string, e.g. "{n} more" → ["n"]. */
const placeholders = (value: string) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

const zhKeys = Object.keys(zh) as (keyof typeof zh)[];

describe("英文词典与中文词典一致", () => {
	it("键集合完全一致（无漏译、无多余键）", () => {
		expect(Object.keys(en).sort()).toEqual([...zhKeys].sort());
	});

	it("每个键的占位符一致", () => {
		const mismatched = zhKeys.filter((key) => placeholders(en[key]).join(",") !== placeholders(zh[key]).join(","));
		expect(mismatched).toEqual([]);
	});

	it("没有空字符串（漏译会让界面出现空白）", () => {
		const empty = (Object.keys(en) as (keyof typeof en)[]).filter((key) => String(en[key]).trim() === "");
		expect(empty).toEqual([]);
	});
});
