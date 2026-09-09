import { describe, expect, it } from "vitest";
import { makeAskUserQuestionTool } from "../../server/agent-service.js";
import type { QuestionAnswer, UiQuestion } from "../../server/protocol.js";

/**
 * 标准 pi 引擎的 ask_user_question customTool 单测（零 token / 零会话）。
 * 只验证工具本体的行为：schema 参数存在、execute 桥到 clientSession.askUser、
 * 用户取消 → 抛「用户取消了提问」、无问题 → 报错。浏览器渲染部分由
 * dsh-question-dialog.test.ts（前端）覆盖，服务端透传由协议类型保证。
 */

/** 构造一个最小 clientSession mock，记录收到的提问并返回预设结果。 */
function mockSession(ask: (q: UiQuestion[], sig: { aborted?: boolean }) => Promise<QuestionAnswer[] | null>) {
	const invoked = { questions: [] as UiQuestion[], sig: {} as { aborted?: boolean } };
	return {
		invoked,
		askUser: (questions: UiQuestion[], sig: { aborted?: boolean }) => {
			invoked.questions = questions;
			invoked.sig = sig;
			return ask(questions, sig);
		},
	};
}

const QUESTIONS: UiQuestion[] = [
	{
		id: "q1",
		question: "Which one?",
		options: [{ label: "A", description: "Opt A", preview: "**A preview**" }, { label: "B" }],
		multiSelect: false,
	},
];

describe("makeAskUserQuestionTool", () => {
	it("工具定义里带 schema 参数（questions 必填）", () => {
		const tool = makeAskUserQuestionTool(mockSession(async () => []));
		expect(tool.name).toBe("ask_user_question");
		// TypeBox schema 的 JSON 序列化应包含 questions 字段。
		const parsed = JSON.parse(JSON.stringify(tool.parameters));
		expect(parsed.properties.questions).toBeDefined();
		expect(parsed.required).toContain("questions");
	});

	it("execute 调用 clientSession.askUser，把 selected/custom 拼成文本返回", async () => {
		const session = mockSession(async () => [{ id: "q1", selected: ["A"], custom: "extra" }]);
		const tool = makeAskUserQuestionTool(session);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		const result = (await tool.execute("t1", { questions: QUESTIONS }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};

		expect(session.invoked.questions).toHaveLength(1);
		expect(session.invoked.questions[0].id).toBe("q1");
		expect(result.content[0].text).toContain("q1: A (wrote: extra)");
	});

	it("用户取消（askUser 返回 null）→ 抛「用户取消了提问」", async () => {
		const session = mockSession(async () => null);
		const tool = makeAskUserQuestionTool(session);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		await expect(tool.execute("t2", { questions: QUESTIONS }, undefined, undefined, ctx)).rejects.toThrow(
			"用户取消了提问",
		);
	});

	it("无问题 → 报错", async () => {
		const session = mockSession(async () => []);
		const tool = makeAskUserQuestionTool(session);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		await expect(tool.execute("t3", { questions: [] }, undefined, undefined, ctx)).rejects.toThrow(
			"requires at least one question",
		);
	});
});
