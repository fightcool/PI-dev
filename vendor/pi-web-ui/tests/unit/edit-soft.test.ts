/**
 * edit_soft 纯函数单测（零 token、零 server）。
 *
 * 覆盖 3 类匹配：
 *   1. 精确子串匹配 → 保留行首/行尾空白（等价普通 edit）；
 *   2. 宽松「逐行核心」匹配（忽略缩进差异）→ 整行原样写 newText；
 *   3. 报错：找不到 / 不唯一 / 空 oldText / 重叠。
 */
import { describe, expect, it } from "vitest";
import { applySoftEdits, oldTextCores } from "../../server/edit-soft-tool.js";

function run(content: string, edits: { oldText: string; newText: string }[], path = "a.js") {
	return applySoftEdits(content, edits, path);
}

describe("edit_soft applySoftEdits", () => {
	it("精确子串匹配保留周围空白", () => {
		const { newContent } = run("  const x = 1;  \n", [{ oldText: "const x = 1;  ", newText: "const y = 2;  " }]);
		expect(newContent).toBe("  const y = 2;  \n");
	});

	it("宽松单行：行首缩进差异（tab vs 空格）也能命中，整行按 newText 原样写入", () => {
		const { newContent } = run("\tconst x = 1;\n  foo();\n", [{ oldText: "  const x = 1;", newText: "const y = 9;" }]);
		expect(newContent).toBe("const y = 9;\n  foo();\n");
	});

	it("宽松多行块：忽略每行缩进，newText 原样写入", () => {
		const { newContent } = run("    if (a) {\n      b();\n    }\n", [
			{ oldText: "if (a) {\n  b();\n}", newText: "if (a) {\n  bb();\n}" },
		]);
		expect(newContent).toBe("if (a) {\n  bb();\n}\n");
	});

	it("制表符 vs 空格也能命中", () => {
		const { newContent } = run("\t\tfoo();\n", [{ oldText: "  foo();", newText: "bar();" }]);
		expect(newContent).toBe("bar();\n");
	});

	it("找不到时抛出带路径的错误", () => {
		expect(() => run("const x = 1;\n", [{ oldText: "const z = 9;", newText: "z" }])).toThrow(/Could not find the text/);
	});

	it("空 oldText 报错", () => {
		expect(() => run("a;\n", [{ oldText: "", newText: "x" }])).toThrow(/must not be empty/);
	});

	it("多个匹配报错（不唯一）", () => {
		expect(() => run("a;\nb;\na;\n", [{ oldText: "a;", newText: "c;" }])).toThrow(/unique/i);
	});

	it("重叠 edits 报错", () => {
		expect(() =>
			run("const a = 1;\n", [
				{ oldText: "const a = 1;", newText: "x" },
				{ oldText: "a = 1;", newText: "y" },
			]),
		).toThrow(/overlap/);
	});

	it("多 edit 逆序应用，左侧偏移稳定", () => {
		const { newContent } = run("const a = 1;\nconst b = 2;\n", [
			{ oldText: "const a = 1;", newText: "const a = 9;" },
			{ oldText: "const b = 2;", newText: "const b = 8;" },
		]);
		expect(newContent).toBe("const a = 9;\nconst b = 8;\n");
	});
});

describe("edit_soft oldTextCores", () => {
	it("去掉尾部空行并逐行 trim", () => {
		expect(oldTextCores("  if (a) {\n    b();\n}")).toEqual(["if (a) {", "b();", "}"]);
		expect(oldTextCores("  x = 1;\n")).toEqual(["x = 1;"]);
	});
});
