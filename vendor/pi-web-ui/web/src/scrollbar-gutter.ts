/**
 * 实测当前平台滚动条占用的布局宽度（单侧），写入 CSS 变量 `--msgs-gutter`。
 *
 * 背景：.messages 是滚动容器，内容盒被 scrollbar-gutter: stable both-edges
 * 在左右各扣掉一个 gutter（宽度 == 滚动条宽：Chromium 自绘 6px、Firefox
 * thin 约 6-8px；macOS / Windows 自动隐藏等叠加层滚动条为 0）。gutter 宽度
 * 无法用 CSS 读取，只能 JS 实测，供宽屏定距列（margin 260px）把滚动容器内
 * 外的列精确对齐：容器内 margin 需减 --msgs-gutter，容器外不减。
 *
 * 必须在首帧前调用（main.tsx 在 createRoot().render 之前），避免初始布局
 * 用占位值造成一次性闪动。CSS px 不随页面 zoom 变化，无需重复测量。
 */
export function installScrollbarGutterVar(): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	// 探针必须挂在 body 里才能继承全局 * { scrollbar-width/color } 与
	// ::-webkit-scrollbar 6px 的自绘样式 —— 测得的就是应用真实滚动条宽度。
	const probe = document.createElement("div");
	probe.style.cssText =
		"position:fixed;top:-9999px;left:0;width:100px;height:100px;overflow-y:scroll;visibility:hidden;pointer-events:none;";
	document.body.appendChild(probe);
	const gutter = probe.offsetWidth - probe.clientWidth; // 叠加层滚动条 = 0
	document.body.removeChild(probe);
	root.style.setProperty("--msgs-gutter", `${gutter}px`);
}
