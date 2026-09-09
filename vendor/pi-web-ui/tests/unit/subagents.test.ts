import { describe, expect, it, vi } from "vitest";
import { makeSubagentTools, subagentTitle, withSubagentOwner, type SubagentToolHost } from "../../server/subagents.js";

/** 一个假的 host，工具调用不会真正执行会话（只验证走通与参数透传）。 */
function makeHostSpies() {
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async (_prompt, type, _cwd) => `sa-${type}-abc`),
		getSubagent: vi.fn(() => undefined),
		listSubagents: vi.fn(() => []),
		steerSubagent: vi.fn(async () => {}),
		stopSubagent: vi.fn(async () => {}),
		listTemplates: vi.fn(() => [{ name: "reviewer", description: "只读审查" }]),
		isTemplateUsable: vi.fn((name: string) => name === "reviewer"),
	};
	return host;
}

describe("subagents tools", () => {
	it("注册 7 个 subagent_* 工具", () => {
		const host = makeHostSpies();
		const tools = makeSubagentTools(host);
		expect(tools.map((t) => t.name)).toEqual([
			"subagent_spawn",
			"subagent_get_result",
			"subagent_steer",
			"subagent_list",
			"subagent_stop",
			"subagent_wait_all",
			"subagent_templates",
		]);
		// 全部有 description + 参数 schema。
		for (const tool of tools) {
			expect(tool.description.length).toBeGreaterThan(10);
			expect(tool.parameters).toBeDefined();
		}
	});

	it("subagent_spawn 透传 prompt/type/cwd/template/model 给 host", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host, () => "zh");
		const ctx = { cwd: "/root/proj" } as never;
		const result = await spawn.execute!(
			"t1",
			{ prompt: "调研", type: "explore", template: "reviewer", cwd: "/other", model: "anthropic/claude-opus-4-5" },
			undefined,
			undefined,
			ctx as never,
		);
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"调研",
			"explore",
			"/other",
			"reviewer",
			"anthropic/claude-opus-4-5",
		);
		// 结果文本含 convId（host 返回值）与类型。
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("sa-explore-abc");
		expect(text.text).toContain("模板：reviewer");
		expect(text.text).toContain("模型：anthropic/claude-opus-4-5");
	});

	it("subagent_spawn 未传 cwd 时用 ctx.cwd；不传 template/model 时按缺省", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host);
		await spawn.execute!("t1", { prompt: "p" } as never, undefined, undefined, { cwd: "/root/proj" } as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith("p", "general", "/root/proj", undefined, undefined);
	});

	it("subagent_spawn 模板不存在/停用时不启动并提示", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host, () => "zh");
		const result = await spawn.execute!("t1", { prompt: "p", template: "ghost" } as never, undefined, undefined, {
			cwd: "/x",
		} as never);
		expect(host.spawnSubagent).not.toHaveBeenCalled();
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("不可用");
		expect(text.text).toContain("ghost");
	});

	it("subagent_get_result 对未知 runId 提示未找到", async () => {
		const host = makeHostSpies();
		const [, getResult] = makeSubagentTools(host, () => "zh");
		const result = await getResult.execute!("t1", { runId: "nope" } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("未找到");
	});

	it("subagent_steer / subagent_stop 透传 runId", async () => {
		const host = makeHostSpies();
		const [, , steer, , stop] = makeSubagentTools(host);
		await steer.execute!("t1", { runId: "sa-1", message: "改方向" } as never, undefined, undefined, {} as never);
		await stop.execute!("t1", { runId: "sa-1" } as never, undefined, undefined, {} as never);
		expect(host.steerSubagent).toHaveBeenCalledWith("sa-1", "改方向");
		expect(host.stopSubagent).toHaveBeenCalledWith("sa-1");
	});

	it("subagent_list 汇总 host 返回", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-1",
				type: "explore",
				title: "调研",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 3,
				output: "…",
			},
		]);
		const [, , , list] = makeSubagentTools(host);
		const result = await list.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("sa-1");
		expect(text.text).toContain("explore");
		expect(text.text).toContain("running");
	});

	it("subagent_templates 列出宿主返回的可用模板", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "reviewer", description: "只读审查" },
			{ name: "reporter", description: "报告整理" },
		]);
		const tools = makeSubagentTools(host);
		const templatesTool = tools.find((t) => t.name === "subagent_templates")!;
		const result = await templatesTool.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("reviewer");
		expect(text.text).toContain("reporter");
		expect(text.text).toContain("subagent_spawn");
	});

	it("subagent_templates 空清单给出引导文案", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const tools = makeSubagentTools(host, () => "zh");
		const templatesTool = tools.find((t) => t.name === "subagent_templates")!;
		const result = await templatesTool.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("当前没有");
	});

	it("subagent_get_result 报错子代理明确标出错误文本", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-err",
			type: "general",
			title: "调研",
			prompt: "",
			state: "done",
			streaming: false,
			error: "Error from provider (Console Go): Upstream request failed: [400] Provider returned error",
			messageCount: 2,
			output: "",
		});
		const [, getResult] = makeSubagentTools(host, () => "zh");
		const result = await getResult.execute!("t1", { runId: "sa-err" } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("error（报错）");
		expect(text.text).toContain("400");
	});

	it("subagent_wait_all 等到全部终态后汇总结果（含错误标记）", async () => {
		const host = makeHostSpies();
		const sa1 = {
			convId: "sa-1",
			type: "explore",
			title: "调研 A",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 3,
			output: "结论 A",
		};
		const sa2 = {
			convId: "sa-2",
			type: "review",
			title: "审查 B",
			prompt: "",
			state: "done",
			streaming: false,
			error: "provider 400",
			messageCount: 2,
			output: "",
		};
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (id === "sa-2" ? sa2 : sa1));
		const tools = makeSubagentTools(host, () => "zh");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!(
			"t1",
			{ runIds: ["sa-1", "sa-2"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("全部 2 个子代理已收口");
		expect(text.text).toContain("结论 A");
		expect(text.text).toContain("provider 400");
	});

	it("subagent_wait_all 空 runIds 时等当前全部运行中的子代理", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-a",
				type: "general",
				title: "A",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
			{
				convId: "sa-b",
				type: "general",
				title: "B",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
		]);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-a"
				? {
						convId: "sa-a",
						type: "general",
						title: "A",
						prompt: "",
						state: "done",
						streaming: false,
						messageCount: 2,
						output: "OK A",
					}
				: {
						convId: "sa-b",
						type: "general",
						title: "B",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
					},
		);
		const tools = makeSubagentTools(host, () => "zh");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!("t1", { timeoutSeconds: 1 } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		// sa-b 一直运行 → 超时返回未完成名单
		expect(text.text).toContain("1 个仍在运行");
		expect(text.text).toContain("sa-b");
	});
});

describe("subagentTitle", () => {
	it("取 prompt 首行并截断", () => {
		expect(subagentTitle("调研 RPC 路径")).toBe("调研 RPC 路径");
		expect(subagentTitle("第一行\n第二行")).toBe("第一行");
		expect(subagentTitle("x".repeat(80))).toHaveLength(41);
	});
});

describe("subagents language (issue #91)", () => {
	it("默认英文：未知 runId / 空模板清单返回英文", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const tools = makeSubagentTools(host);
		const [, getResult] = tools;
		const r1 = await getResult.execute!("t1", { runId: "nope" } as never, undefined, undefined, {} as never);
		expect((r1.content?.[0] as { text: string }).text).toContain("not found");
		const templatesTool = tools.find((t) => t.name === "subagent_templates")!;
		const r2 = await templatesTool.execute!("t1", {} as never, undefined, undefined, {} as never);
		expect((r2.content?.[0] as { text: string }).text).toContain("No subagent templates");
	});

	it("工具 definition 中英内联（英文在前）", () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host);
		expect(spawn.description).toContain("subagent");
		// 中文半句仍在（zh 会话行为不变）
		expect(spawn.description).toContain("子代理");
	});
});

describe("withSubagentOwner (issue #95)", () => {
	it("包装后 spawn 自动把 ownerId（真正的派发会话）作为父对话传入", async () => {
		const host = makeHostSpies();
		// c1 的 runtime 用它自己的工具派发：即使此刻 UI 正看着别的会话（active），
		// 子代理父对话也必须记到 c1（工具调用方），否则左栏会错组/沉底。
		const owned = withSubagentOwner(host, "c1");
		const tools = makeSubagentTools(owned);
		const [spawn] = tools;
		await spawn.execute!("t1", { prompt: "p" } as never, undefined, undefined, { cwd: "/p1" } as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith("p", "general", "/p1", undefined, undefined, "c1");
	});

	it("包装不影响其余 host 方法透传", async () => {
		const host = makeHostSpies();
		const owned = withSubagentOwner(host, "c1");
		expect(owned.listTemplates()).toEqual([{ name: "reviewer", description: "只读审查" }]);
		expect(owned.isTemplateUsable("reviewer")).toBe(true);
		expect(owned.isTemplateUsable("ghost")).toBe(false);
	});
});

describe("subagent parent retention", () => {
	it("有存活子代理指向父对话时保留父对话", () => {
		type Conv = { id: string; parentId?: string };
		const convs = new Map<string, Conv>([
			["c1", { id: "c1" }],
			["sa-1", { id: "sa-1", parentId: "c1" }],
		]);
		const hasLiveChild = (id: string) => [...convs.values()].some((child) => child.parentId === id);
		expect(hasLiveChild("c1")).toBe(true);
		convs.delete("sa-1");
		expect(hasLiveChild("c1")).toBe(false);
	});
});
