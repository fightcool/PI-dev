/**
 * 🍞 AI Breadcrumb Navigation — @COUPLED=rehype-highlight-subset.ts（构建 lowlight 实例）、
 *    Markdown.tsx（插件装配）、docs/PERF-SESSION-LOAD.md §P1-13.
 * @WHY `rehype-highlight` 静态依赖 lowlight 的 `common`（37 门语法 ≈ 300 KB），
 *      即使我们把自动嗅探限定在 20 门、其余只在显式标注时用，那 300 KB 也照样进包。
 *      这里改为**按名单 import** 语法模块 + 自建 lowlight 实例，包体只含实际注册的语法。
 * @GOTCHA 名单必须覆盖用户会显式写出的语言（```swift 之类）：未注册的语言会回落成
 *      不高亮的普通代码块（不再是“报错”，也不是乱高亮）。加语言＝加一行 import + 名单。
 * @MAGIC 名单与 Markdown.tsx 的 detectSubset 同源：这里注册的是「可用」集合，
 *      detect 子集是「自动嗅探」集合（子集 ⊆ 注册集合）。
 */
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** Grammar name → implementation. Keys are the names authors write in ``` fences. */
export const highlightGrammars = {
	bash,
	c,
	cpp,
	csharp,
	css,
	diff,
	go,
	graphql,
	ini,
	java,
	javascript,
	json,
	kotlin,
	lua,
	makefile,
	markdown,
	perl,
	php,
	python,
	r,
	ruby,
	rust,
	scss,
	shell,
	sql,
	swift,
	typescript,
	xml,
	yaml,
};

/** Shared instance; also the registry the rehype plugin highlights against. */
export const lowlight = createLowlight(highlightGrammars);

/** Names actually bundled — asserted by tests so the list cannot silently drift. */
export const bundledLanguages = Object.keys(highlightGrammars).sort();
