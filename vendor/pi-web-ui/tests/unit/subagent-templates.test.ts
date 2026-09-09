import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, SubagentTemplatesStore, type SubagentTemplate } from "../../server/subagent-templates.js";

/** 每个用例一个临时目录，用后即焚。 */
const dirs: string[] = [];
function tmpStore(): SubagentTemplatesStore {
	const dir = mkdtempSync(join(tmpdir(), "satpl-"));
	dirs.push(dir);
	return new SubagentTemplatesStore(join(dir, "subagent-templates.json"));
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base: SubagentTemplate = {
	name: "reviewer",
	description: "只读审查子代理",
	promptMode: "replace",
	systemPrompt: "你是一名严格的代码审查者。",
	enabledSkills: ["code-review"],
	enabledExtensions: ["npm:pi-scm"],
	model: "",
	enabled: true,
};

describe("SubagentTemplatesStore", () => {
	it("首次加载以内置默认模板为种子（不落盘）", () => {
		const store = tmpStore();
		const names = store.list().map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["review", "implement", "research", "scout", "audit", "delegate"]));
		for (const t of store.list()) {
			expect(t.enabled).toBe(true);
			expect(t.promptMode).toMatch(/^(replace|append)$/);
		}
	});

	it("upsert / get / list / remove 基础流程（默认之上增删）", () => {
		const store = tmpStore();
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length);
		expect(store.upsert(base)).toBeNull();
		expect(store.get("reviewer")).toEqual(base);
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length + 1);
		// 同名覆盖
		expect(store.upsert({ ...base, description: "v2" })).toBeNull();
		expect(store.get("reviewer")!.description).toBe("v2");
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length + 1);
		store.remove("reviewer");
		expect(store.get("reviewer")).toBeUndefined();
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length);
		// 删除不存在的名字静默
		store.remove("nope");
	});

	it("用户改动后落盘，此后以文件为准（默认模板可被删除且不再复活）", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		const a = new SubagentTemplatesStore(file);
		// 删除内置 review + 新增自定义 —— 触发落盘
		a.remove("review");
		a.upsert({ ...base, enabled: false });
		// 新实例重读磁盘：review 不再出现（用户已删）、reviewer 保留
		const b = new SubagentTemplatesStore(file);
		expect(b.get("review")).toBeUndefined();
		expect(b.get("reviewer")).toEqual({ ...base, enabled: false });
		expect(b.list()).toHaveLength(DEFAULT_TEMPLATES.length - 1 + 1);
		const raw = JSON.parse(readFileSync(file, "utf8")) as SubagentTemplate[];
		expect(raw.find((t) => t.name === "review")).toBeUndefined();
	});

	it("非法名称拒绝保存", () => {
		const store = tmpStore();
		expect(store.upsert({ ...base, name: "   " })).toMatch(/名称/);
		expect(store.upsert({ ...base, name: "x".repeat(61) })).toMatch(/名称/);
		expect(store.upsert({ ...base, name: "  合法 名称 " })).toBeNull();
		// 名字做空白折叠
		expect(store.get("合法 名称")).toBeDefined();
	});

	it("持久化到磁盘并可重载（全局共享语义）", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		const a = new SubagentTemplatesStore(file);
		a.upsert({ ...base, enabled: false });
		// 新实例重读磁盘
		const b = new SubagentTemplatesStore(file);
		expect(b.get("reviewer")).toEqual({ ...base, enabled: false });
		expect(b.get("reviewer")!.enabled).toBe(false);
		const raw = JSON.parse(readFileSync(file, "utf8")) as SubagentTemplate[];
		expect(raw).toHaveLength(DEFAULT_TEMPLATES.length + 1);
	});

	it("容忍脏数据：非法条目丢弃、字段缺失补默认", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(
			file,
			JSON.stringify([{ name: "ok", systemPrompt: "x" }, { name: "", systemPrompt: "bad-name" }, "garbage", 42]),
		);
		const store = new SubagentTemplatesStore(file);
		const list = store.list();
		expect(list).toHaveLength(1);
		expect(list[0]).toEqual({
			name: "ok",
			description: "",
			promptMode: "append",
			systemPrompt: "x",
			enabledSkills: [],
			enabledExtensions: [],
			model: "",
			enabled: true,
		});
	});

	it("model 字段归一：空白 → 空串（跟随主对话）；脏类型 → 空串", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(
			file,
			JSON.stringify([{ name: "a", model: "anthropic/claude-opus-4-5" }, { name: "b", model: 42 }, { name: "c" }]),
		);
		const store = new SubagentTemplatesStore(file);
		expect(store.get("a")!.model).toBe("anthropic/claude-opus-4-5");
		expect(store.get("b")!.model).toBe("");
		expect(store.get("c")!.model).toBe("");
		// upsert 时同样归一
		store.upsert({ ...base, name: "withModel", model: "  dashscope/qwen-max " });
		expect(store.get("withModel")!.model).toBe("dashscope/qwen-max");
	});

	it("list 返回副本（外部修改不影响库内）", () => {
		const store = tmpStore();
		store.upsert(base);
		const copy = store.list().find((t) => t.name === "reviewer")!;
		copy.enabledSkills.push("hack");
		expect(store.get("reviewer")!.enabledSkills).toEqual(["code-review"]);
	});
});
