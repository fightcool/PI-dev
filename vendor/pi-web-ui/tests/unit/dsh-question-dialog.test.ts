// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { DshQuestionDialog } from "../../web/src/components/DshQuestionDialog.js";
import { LanguageProvider } from "../../web/src/i18n.js";

/**
 * DshQuestionDialog 测试（jsdom）：验证
 *   1. 富渲染：question/detail 按 markdown（rawHtml），选项描述/预览富文本
 *   2. 向导式：一次只显示一题；单选点选项自动切下一题；末题点选项自动提交
 *   3. 上一步可回头修改；底部取消发送 cancelled 回答
 * 全部确定性、零 token、零模型 —— 不依赖 DSH 引擎是否真发 preview。
 */

type Question = Parameters<typeof DshQuestionDialog>[0]["question"];

const baseQuestion: Question = {
	id: "q1",
	questions: [
		{
			id: "c1",
			question: "Which **one**?",
			detail: "Pick an <em>option</em> below.",
			options: [
				{ label: "A", description: "Opt **A**", preview: "**preview A**\n\n- a1\n- a2" },
				{ label: "B", description: "Opt B" },
			],
		},
	],
};

const wizardQuestion: Question = {
	id: "q2",
	questions: [
		{ id: "c1", question: "Q1", options: [{ label: "A" }, { label: "B" }] },
		{ id: "c2", question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
	],
};

let root: Root | null = null;

function mount(question: Question = baseQuestion, send: (msg: unknown) => boolean = () => true) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(DshQuestionDialog, {
					question,
					send: (msg) => {
						sent.push(msg);
						return send(msg);
					},
				}),
			),
		);
	});
	return { container, sent };
}

function click(container: HTMLElement, sel: string | HTMLElement) {
	const el = typeof sel === "string" ? (container.querySelector(sel) as HTMLElement) : sel;
	if (!el) throw new Error(`cannot find ${sel}`);
	act(() => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
});

describe("DshQuestionDialog rich rendering", () => {
	it("question 按 markdown 渲染（**粗体** → <strong>）", () => {
		const { container } = mount();
		const strong = container.querySelector(".question-head strong");
		expect(strong?.textContent).toBe("one");
	});

	it("detail 里的内嵌 HTML 按 rawHtml 渲染成 <em>", () => {
		const c = mount();
		expect(c.container.querySelector(".set-hint em")?.textContent).toBe("option");
	});

	it("选项描述按 markdown 渲染", () => {
		const c = mount();
		expect(c.container.querySelector(".question-option .set-row-desc strong")?.textContent).toBe("A");
	});

	it("未选中带 preview 选项时无预览框，选中后出现富文本预览", () => {
		const c = mount();
		expect(c.container.querySelector(".question-preview")).toBeNull();

		// 点击带 preview 的选项 A（单选 → 自动提交；组件不被卸载，预览仍在）
		click(c.container, ".question-option");

		const preview = c.container.querySelector(".question-preview");
		expect(preview).not.toBeNull();
		expect(preview?.querySelector(".question-preview-label")?.textContent?.length).toBeGreaterThan(0);
		// preview markdown 渲染：**preview A** → <strong>，列表 → <li>
		expect(preview?.querySelector("strong")?.textContent).toBe("preview A");
		expect(preview?.querySelectorAll("li").length).toBe(2);
	});
});

describe("DshQuestionDialog wizard", () => {
	it("多题时每次只显示一题，点选项直接进入下一题", () => {
		const c = mount(wizardQuestion);
		expect(c.container.textContent).toContain("Q1");
		expect(c.container.textContent).not.toContain("Q2");

		click(c.container, ".question-option"); // 选第一题 A

		expect(c.container.textContent).toContain("Q2");
		expect(c.container.textContent).not.toContain("Q1");
		// 进度指示可见
		expect(c.container.querySelector(".question-progress")?.textContent).toContain("2");
		expect(c.container.textContent).toContain("2 /");
	});

	it("单选点选项即选中（标记 ●），上一步可返回并已记住选择", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".question-option"); // 第一题选 A → 切到第二题

		// 回退后第一题仍在，且 A 已选中
		click(c.container, ".dialog-prev");
		expect(c.container.textContent).toContain("Q1");
		const activeRows = c.container.querySelectorAll(".question-option.active").length;
		expect(activeRows).toBe(1);
	});

	it("第一题禁用「上一步」", () => {
		const c = mount(wizardQuestion);
		const prev = c.container.querySelector(".dialog-prev") as HTMLButtonElement;
		expect(prev.disabled).toBe(true);
	});

	it("最后一题点选项自动提交全部答案（含前几题的选择）", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".question-option"); // Q1 → A
		click(c.container, ".question-option"); // Q2 → X（最后一题 → 自动提交）

		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { type: string; answers: unknown[]; cancelled?: boolean };
		expect(msg.type).toBe("question_answer");
		expect(msg.cancelled ?? false).toBe(false);
		expect(msg.answers).toEqual([
			{ id: "c1", selected: ["A"] },
			{ id: "c2", selected: ["X"] },
		]);
	});

	it("单题问卷点选项即自动提交", () => {
		const c = mount(baseQuestion);
		click(c.container, ".question-option"); // 唯一题的选项 A
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: unknown[] };
		expect(msg.answers).toEqual([{ id: "c1", selected: ["A"] }]);
	});

	it("底部「取消」发送 cancelled 回答", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".dialog-dismiss-inline");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { cancelled?: boolean; answers: unknown[] };
		expect(msg.cancelled).toBe(true);
		expect(msg.answers).toEqual([]);
	});

	it("多选题点选项只切换勾选、不前进；下一步/提交推进", () => {
		const q: Question = {
			id: "q3",
			questions: [
				{
					id: "c1",
					question: "M1",
					multiSelect: true,
					options: [{ label: "A" }, { label: "B" }],
				},
				{ id: "c2", question: "Q2", options: [{ label: "X" }] },
			],
		};
		const c = mount(q);
		const opts = () => Array.from(c.container.querySelectorAll(".question-option")) as HTMLElement[];
		click(c.container, ".question-option"); // 勾选 A
		click(c.container, opts()[1]); // 勾选 B（仍在第一题）
		expect(c.container.textContent).toContain("M1");
		expect(c.container.textContent).not.toContain("Q2");

		// 下一题按钮可用 → 推进
		const nextBtn = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(nextBtn.disabled).toBe(false);
		click(c.container, ".dialog-submit");
		expect(c.container.textContent).not.toContain("M1");
		expect(c.container.textContent).toContain("Q2");

		// 最后一题点选项 → 提交，选中含多选两项
		click(c.container, ".question-option");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: { id: string; selected: string[] }[] };
		expect(msg.answers[0]).toEqual({ id: "c1", selected: ["A", "B"] });
	});

	it("无选项的自定义题：未输入文字也可提交（空提交 = 跳过）", () => {
		const q: Question = {
			id: "q4",
			questions: [{ id: "fill", question: "补充说明（可选）", options: [] }],
		};
		const c = mount(q);
		const submit = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(false); // 无选项 → 空提交允许
		click(c.container, ".dialog-submit");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: unknown[]; cancelled?: boolean };
		expect(msg.cancelled ?? false).toBe(false);
		expect(msg.answers).toEqual([{ id: "fill", selected: [] }]); // 无 custom 键
	});

	it("有选项但未选、也未填字：提交仍禁用（可选题≠可跳过）", () => {
		const c = mount(baseQuestion);
		const submit = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(true); // 有选项仍须作答
	});
});
