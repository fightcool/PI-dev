// @vitest-environment jsdom
/* 🍞 AI Breadcrumb — @COUPLED ../../web/src/components/DirectoryPicker.tsx（被测件）,
 *   ../../web/src/components/LeftPanelProjects.tsx（左栏「＋ 新建项目」入口）,
 *   ../../web/src/components/FooterBar.tsx（底栏共用同一个选择器）
 * 📖 ../../../docs/STRUCTURE.md（项目=工作目录）
 * @CONTRACT 「新建项目」必须满足（用户投诉「系统没有新建项目功能」的直接原因）：
 *   ① 左栏「最近项目」区块在 0 个项目时**仍然渲染**，并有新建入口（原来整块不渲染）；
 *   ② 入口在标题行里，空列表也看得见，空态里再给一个按钮；
 *   ③ 新建 = make_dir + set_cwd，且 set_cwd 只在**服务端列表确认目录已存在**后才发
 *      （make_dir 是 void，抢跑会让 set_cwd 的 fs.stat 失败）；
 *   ④ 已存在的目录仍能直接「选择」；选中当前 cwd 不重复发 set_cwd；
 *   ⑤ 在路径框里改了父目录（未按 Enter）后新建，目录必须建在**输入的那个父目录**下
 *      （浏览器 E2E 先抛出来的真 bug：默默建到了旧目录）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { DirectoryPicker, findCreatedDir, parentOf, MACHINE_ROOT } from "../../web/src/components/DirectoryPicker.js";
import { LeftPanelProjects, projectName } from "../../web/src/components/LeftPanelProjects.js";
import { LanguageProvider } from "../../web/src/i18n.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// @GOTCHA LanguageProvider 在英文词典未就绪时只渲染 boot-wait 占位（jsdom 里取不到服务端）。
localStorage.setItem("pi-web-ui:lang", "zh");

let root: Root | null = null;

function render(node: ReactNode): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, node));
	});
	return container;
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	vi.useRealTimers();
});

const buttons = (c: HTMLElement) => [...c.querySelectorAll("button")];
const byText = (c: HTMLElement, text: string) => buttons(c).find((b) => (b.textContent ?? "").trim() === text);
const click = (el: Element | undefined) => {
	expect(el, "target button exists").toBeTruthy();
	act(() => {
		el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};
/** 受控 input 赋值：必须走原生 setter，否则 React 的 value tracker 认为没变、onChange 不触发。 */
const type = (input: HTMLInputElement, value: string) => {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
};

describe("路径工具（纯函数）", () => {
	it("parentOf：posix / 盘符根 / 机器根", () => {
		expect(parentOf("/home/dev/proj")).toBe("/home/dev");
		expect(parentOf("/home/dev/proj/")).toBe("/home/dev");
		expect(parentOf("/home")).toBe("/");
		expect(parentOf("/")).toBeNull();
		expect(parentOf(MACHINE_ROOT)).toBeNull();
		expect(parentOf("C:")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/proj")).toBe("C:/");
	});

	it("findCreatedDir：只认目录，忽略尾部分隔符差异，找不到返回 null", () => {
		const listing = [
			{ name: "alpha", path: "/home/dev/alpha", type: "dir" as const },
			{ name: "beta.txt", path: "/home/dev/beta.txt", type: "file" as const },
		];
		expect(findCreatedDir(listing, "/home/dev/", "alpha")).toBe("/home/dev/alpha");
		expect(findCreatedDir(listing, "/home/dev", " alpha ")).toBe("/home/dev/alpha");
		expect(findCreatedDir(listing, "/home/dev", "beta.txt")).toBeNull();
		expect(findCreatedDir(listing, "/home/dev", "gamma")).toBeNull();
	});

	it("projectName：目录名即项目名（协议里没有独立名字字段）", () => {
		expect(projectName("/home/dev/PI-dev")).toBe("PI-dev");
		expect(projectName("C:\\work\\app")).toBe("app");
	});
});

describe("左栏「最近项目」区块", () => {
	const header = createElement("button", { type: "button", className: "lp-section-title" }, "最近项目");

	it("0 个项目时区块仍渲染，且有两处新建入口（标题行 + 空态）", () => {
		const onNewProject = vi.fn();
		const c = render(
			createElement(LeftPanelProjects, {
				projects: [],
				cwd: "/home/dev",
				collapsed: false,
				header,
				send: () => true,
				onNewProject,
				renderRemoveButton: () => null,
				formatModified: () => "",
				onRowLeave: () => {},
			}),
		);
		expect(c.textContent).toContain("还没有项目");
		const headRowBtn = c.querySelector(".lp-section-head-row .lp-projects-new");
		expect(headRowBtn, "标题行的 ＋ 入口").toBeTruthy();
		click(headRowBtn!);
		click(byText(c, "＋ 新建项目"));
		expect(onNewProject).toHaveBeenCalledTimes(2);
	});

	it("折叠时列表不渲染，但标题行的新建入口仍在", () => {
		const c = render(
			createElement(LeftPanelProjects, {
				projects: [{ path: "/home/dev/proj", lastUsed: 1 }],
				cwd: "/home/dev",
				collapsed: true,
				header,
				send: () => true,
				onNewProject: () => {},
				renderRemoveButton: () => null,
				formatModified: () => "12:00",
				onRowLeave: () => {},
			}),
		);
		expect(c.querySelector(".projects-scroll")).toBeNull();
		expect(c.querySelector(".lp-projects-new")).toBeTruthy();
	});

	it("点项目行发 set_cwd；点当前项目不重复发", () => {
		const sent: unknown[] = [];
		const c = render(
			createElement(LeftPanelProjects, {
				projects: [
					{ path: "/home/dev/a", lastUsed: 2 },
					{ path: "/home/dev/b", lastUsed: 1 },
				],
				cwd: "/home/dev/a",
				collapsed: false,
				header,
				send: (m: unknown) => {
					sent.push(m);
					return true;
				},
				onNewProject: () => {},
				renderRemoveButton: () => null,
				formatModified: () => "12:00",
				onRowLeave: () => {},
			}),
		);
		const items = [...c.querySelectorAll<HTMLButtonElement>(".project-item")];
		expect(items).toHaveLength(2);
		expect(items[0].className).toContain("active");
		click(items[0]); // 当前项目
		expect(sent).toEqual([]);
		click(items[1]);
		expect(sent).toEqual([{ type: "set_cwd", path: "/home/dev/b" }]);
	});
});

describe("目录选择器（新建项目形态）", () => {
	/** 选择器渲染 + 受控的 completions（模拟服务端 path_completions 回推）。 */
	function mountPicker(opts: { completions?: { name: string; path: string; type: "dir" | "file" }[] } = {}) {
		const sent: { type: string; path: string }[] = [];
		const onClose = vi.fn();
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const draw = (completions: { name: string; path: string; type: "dir" | "file" }[]) => {
			act(() => {
				root!.render(
					createElement(
						LanguageProvider,
						null,
						createElement(DirectoryPicker, {
							initialPath: "/home/dev",
							cwd: "/home/dev",
							completions,
							send: (m) => {
								sent.push(m as { type: string; path: string });
								return true;
							},
							onClose,
							placement: "modal" as const,
							title: "新建项目",
							hint: "项目就是一个工作目录",
							openAfterCreate: true,
							newFolderOpen: true,
						}),
					),
				);
			});
		};
		draw(opts.completions ?? []);
		return { container, sent, onClose, draw };
	}

	it("弹窗形态：role=dialog + aria-modal，ESC 与点遮罩都关", () => {
		const { container, onClose } = mountPicker();
		const dialog = container.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog!.getAttribute("aria-modal")).toBe("true");
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(onClose).toHaveBeenCalledTimes(1);
		click(dialog!); // 内部点击不关
		expect(onClose).toHaveBeenCalledTimes(1);
		click(container.querySelector(".cwd-picker-backdrop")!);
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("newFolderOpen：打开即展开文件夹名输入行，按钮是「创建并打开」", () => {
		const { container } = mountPicker();
		expect(container.querySelector(".cwd-newrow input")).toBeTruthy();
		expect(byText(container, "创建并打开")).toBeTruthy();
	});

	it("新建 = make_dir，然后**等列表确认**才 set_cwd（不抢跑）", async () => {
		vi.useFakeTimers();
		const { container, sent, onClose, draw } = mountPicker();
		const input = container.querySelector<HTMLInputElement>(".cwd-newrow input")!;
		type(input, "new-proj");
		click(byText(container, "创建并打开"));
		expect(sent.filter((m) => m.type === "make_dir")).toEqual([{ type: "make_dir", path: "/home/dev/new-proj" }]);
		// 列表还没确认 → 绝不能已经发 set_cwd（make_dir 是 void，抢跑会 fs.stat 失败）
		expect(sent.some((m) => m.type === "set_cwd")).toBe(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
		expect(sent.some((m) => m.type === "set_cwd")).toBe(false);
		// 服务端刷新后的列表里出现该目录 = 创建成功的证据 → 这时才打开
		draw([{ name: "new-proj", path: "/home/dev/new-proj", type: "dir" }]);
		expect(sent.filter((m) => m.type === "set_cwd")).toEqual([{ type: "set_cwd", path: "/home/dev/new-proj" }]);
		expect(onClose).toHaveBeenCalled();
	});

	it("创建失败（列表里始终没有该目录）不会误发 set_cwd", async () => {
		vi.useFakeTimers();
		const { container, sent } = mountPicker();
		const input = container.querySelector<HTMLInputElement>(".cwd-newrow input")!;
		type(input, "denied");
		click(byText(container, "创建并打开"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(6000);
		});
		expect(sent.some((m) => m.type === "set_cwd")).toBe(false);
	});

	it("已有目录可直接「选择」；选中当前 cwd 不发 set_cwd", () => {
		const { container, sent, onClose } = mountPicker({
			completions: [
				{ name: "existing", path: "/home/dev/existing", type: "dir" },
				{ name: "note.md", path: "/home/dev/note.md", type: "file" },
			],
		});
		// 文件不进列表（目录选择器只列目录）
		expect(container.querySelectorAll(".cwd-item")).toHaveLength(1);
		click(container.querySelector(".cwd-item .cwd-choose-btn")!);
		expect(sent.filter((m) => m.type === "set_cwd")).toEqual([{ type: "set_cwd", path: "/home/dev/existing" }]);
		expect(onClose).toHaveBeenCalled();

		// 「选择当前目录」在 initialPath === cwd 时只关闭，不重复切
		sent.length = 0;
		click(byText(container, "选择当前目录"));
		expect(sent.some((m) => m.type === "set_cwd")).toBe(false);
	});

	it("在路径框里改了父目录（未按 Enter）后新建，目录建在输入的父目录下", () => {
		const { container, sent } = mountPicker();
		// 只改路径框（真实用户行为）：不点「进入」、不按 Enter
		type(container.querySelector<HTMLInputElement>(".cwd-picker-input")!, "/srv/workspaces");
		type(container.querySelector<HTMLInputElement>(".cwd-newrow input")!, "proj");
		click(byText(container, "创建并打开"));
		expect(sent.filter((m) => m.type === "make_dir")).toEqual([{ type: "make_dir", path: "/srv/workspaces/proj" }]);
	});

	it("弹窗里 Enter = 定位到该目录，不切工作目录", async () => {
		const { container, sent, onClose } = mountPicker();
		const input = container.querySelector<HTMLInputElement>(".cwd-picker-input")!;
		type(input, "/srv/workspaces");
		act(() => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(sent.some((m) => m.type === "set_cwd")).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
		// 定位生效：面包屑标题换成新目录
		expect(container.querySelector(".cwd-picker-title")?.textContent).toContain("/srv/workspaces");
	});
});
