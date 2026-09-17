/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/DirectoryPicker.tsx（唯一消费方）,
 *            tests/unit/new-project-entry.test.ts（这些纯函数在这里被单测钉住）,
 *            server/files-service.ts（MACHINE_ROOT 的 wire 字面量必须同值）
 *   @WHY 从 DirectoryPicker.tsx 抽出来的纯路径逻辑：组件那时已 387 行（超 300 行拆分红线），
 *        而这些函数与 React 无关、可单测，本就是最该独立的一块。
 *   @CONTRACT 纯函数，无 React、无 IO；分隔符一律按 "/" 处理（wire 格式），
 *        原生反斜杠在入口处归一（见 normalizePath）。
 * ──────────────────────────────────────────────────
 */

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
export const MACHINE_ROOT = "@root";

/** 目录候选（协议 path_completions 的条目）。 */
export interface PathCompletion {
	name: string;
	path: string;
	type: "dir" | "file";
}

/** 路径比较用的规范化：统一分隔符 + 去掉尾部 "/"（"/a/b/" 与 "/a/b" 是同一目录）。 */
export function normalizePath(p: string): string {
	const s = p.replace(/\\/g, "/");
	return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

/** 带尾分隔符的查询：让服务端列**整个**目录而不是做前缀匹配。 */
export function browseQuery(p: string): string {
	return p.endsWith("/") ? p : p + "/";
}

/** 绝对路径的父级；文件系统根返回 null。Windows 盘符根（"C:"）的父级是机器根。 */
export function parentOf(p: string): string | null {
	const s = p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
	if (s === MACHINE_ROOT || s === "/") return null;
	const i = s.lastIndexOf("/");
	if (i < 0) return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null; // "/"、盘符根 "C:" 或裸名
	if (i === 0) return "/"; // posix "/foo" → "/"
	const parent = s.slice(0, i);
	// Windows drive root resolves weirdly without the trailing slash.
	return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
}

/**
 * 「新建文件夹后自动打开」用：在刷新后的候选列表里找刚建好的目录。
 * 找不到返回 null（还没刷新到 / 创建失败），调用方继续等待。
 */
export function findCreatedDir(completions: PathCompletion[], parentPath: string, name: string): string | null {
	const wanted = normalizePath(`${normalizePath(parentPath)}/${name.trim()}`);
	const hit = completions.find((c) => c.type === "dir" && normalizePath(c.path) === wanted);
	return hit ? hit.path : null;
}

/**
 * 该名字在当前列表里已经是目录（= 存在，创建会变成"直接打开它"）。
 * @WHY makeDir 走 `fs.mkdir(recursive:true)`，已存在也返回成功 —— 客户端不自己判就会
 *      把"打开了一个本来就在的目录"说成"创建成功"（误导）。
 */
export function isExistingDir(completions: PathCompletion[], parentPath: string, name: string): boolean {
	return findCreatedDir(completions, parentPath, name.trim()) !== null;
}

/**
 * 新建时真正落在哪个父目录：路径框里改了父目录但还没按 Enter/点「进入」时，
 * 输入框里的绝对路径才是用户意图（按 browsePath 建会默默建到旧目录里）。
 */
export function createParent(typedPath: string, browsePath: string): string {
	const typed = typedPath.trim();
	const absolute = typed && typed !== MACHINE_ROOT && (typed.startsWith("/") || /^[A-Za-z]:/.test(typed));
	return absolute ? typed : browsePath;
}
