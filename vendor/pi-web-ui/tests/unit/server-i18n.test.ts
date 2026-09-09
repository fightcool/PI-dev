/**
 * server/i18n.ts 单测：locale 归一 + 翻译表注册/查表/回退（issue #91 v2）。
 * 纯函数 + 内存注册表，无磁盘/端口。
 */
import { describe, expect, it } from "vitest";
import {
	bilingual,
	extractServerStrings,
	getServerBlock,
	getServerString,
	isZh,
	pick,
	registerServerStrings,
	registeredServerLangs,
	resolveServerLang,
	unregisterServerStrings,
} from "../../server/i18n.js";

describe("resolveServerLang", () => {
	it("zh variants → zh", () => {
		expect(resolveServerLang("zh")).toBe("zh");
		expect(resolveServerLang("zh-CN")).toBe("zh");
		expect(resolveServerLang("zh_TW")).toBe("zh");
		expect(resolveServerLang("ZH-hk")).toBe("zh");
		expect(resolveServerLang("  zh  ")).toBe("zh");
	});
	it("other codes pass through normalized (v2: no longer collapsed to en)", () => {
		expect(resolveServerLang("en")).toBe("en");
		expect(resolveServerLang("en-US")).toBe("en");
		expect(resolveServerLang("ja")).toBe("ja");
		expect(resolveServerLang("pt-BR")).toBe("pt");
		expect(resolveServerLang("DE")).toBe("de");
	});
	it("missing/empty/unknown → en (English default)", () => {
		expect(resolveServerLang(undefined)).toBe("en");
		expect(resolveServerLang(null)).toBe("en");
		expect(resolveServerLang("")).toBe("en");
		expect(resolveServerLang("   ")).toBe("en");
		expect(resolveServerLang("zht")).toBe("zht"); // well-formed code, passes through
	});
});

describe("pick / isZh / bilingual", () => {
	it("pick returns the matching variant", () => {
		expect(pick("zh", "甲", "A")).toBe("甲");
		expect(pick("en", "甲", "A")).toBe("A");
	});
	it("pick without key falls back to English for third languages", () => {
		expect(pick("ja", "甲", "A")).toBe("A");
	});
	it("pick interpolates {expr} slots from vars on table hits only", () => {
		registerServerStrings("xx", { "k.i": "残り{n}件（{m}）" });
		expect(pick("xx", "剩${1}个", "${1} left", "k.i", { n: 3, m: "x" })).toBe("残り3件（x）");
		// zh/en inline stay pre-evaluated (vars ignored)
		expect(pick("zh", "剩3个", "3 left", "k.i", { n: 3, m: "x" })).toBe("剩3个");
		expect(pick("en", "剩3个", "3 left", "k.i", { n: 3, m: "x" })).toBe("3 left");
		// unknown slots stay literal; null vars skipped
		registerServerStrings("xx", { "k.u": "a{b}c{d}" });
		expect(pick("xx", "甲", "A", "k.u", { b: null as unknown as string })).toBe("ac{d}");
		unregisterServerStrings("xx");
	});
	it("isZh", () => {
		expect(isZh("zh")).toBe(true);
		expect(isZh("en")).toBe(false);
		expect(isZh("ja")).toBe(false);
	});
	it("bilingual puts English first, dedupes", () => {
		expect(bilingual("A", "甲")).toBe("A\n甲");
		expect(bilingual("", "甲")).toBe("甲");
		expect(bilingual("A", "")).toBe("A");
		expect(bilingual("same", "same")).toBe("same");
	});
});

describe("translator tables", () => {
	it("hit → translation; miss → English; zh ignores table", () => {
		registerServerStrings("xx", { "demo.hello": "XX-HELLO" });
		expect(pick("xx", "甲", "A", "demo.hello")).toBe("XX-HELLO");
		expect(pick("xx", "甲", "A", "demo.missing")).toBe("A");
		expect(pick("zh", "甲", "A", "demo.hello")).toBe("甲");
		expect(pick("en", "甲", "A", "demo.hello")).toBe("A");
		expect(getServerString("xx", "demo.hello")).toBe("XX-HELLO");
		expect(registeredServerLangs()).toContain("xx");
		unregisterServerStrings("xx");
		expect(pick("xx", "甲", "A", "demo.hello")).toBe("A");
		expect(registeredServerLangs()).not.toContain("xx");
	});
	it("codes normalize (PT-br → pt)", () => {
		registerServerStrings("PT-br", { k: "v" });
		expect(getServerString("pt-BR", "k")).toBe("v");
		unregisterServerStrings("pt");
	});
	it("getServerBlock splits \\n-joined hits, passes through zh/en arrays", () => {
		registerServerStrings("xxb", { "blk.g": "l1\nl2\nl3" });
		expect(getServerBlock("xxb", "blk.g", ["甲"], ["A"])).toEqual(["l1", "l2", "l3"]);
		expect(getServerBlock("xxb", "blk.missing", ["甲"], ["A"])).toEqual(["A"]);
		expect(getServerBlock("zh", "blk.g", ["甲"], ["A"])).toEqual(["甲"]);
		unregisterServerStrings("xxb");
	});
});

describe("extractServerStrings", () => {
	it("pulls code + non-empty string table from a pack file", () => {
		expect(extractServerStrings({ code: "ja", serverStrings: { a: "ア", b: "" } })).toEqual({
			code: "ja",
			table: { a: "ア" },
		});
	});
	it("null when missing/unusable", () => {
		expect(extractServerStrings(null)).toBeNull();
		expect(extractServerStrings({ code: "ja" })).toBeNull();
		expect(extractServerStrings({ code: "ja", serverStrings: { a: 1 } })).toBeNull();
		expect(extractServerStrings({ code: "", serverStrings: { a: "b" } })).toBeNull();
		expect(extractServerStrings({ code: "ja", serverStrings: {} })).toBeNull();
	});
});
