/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../protocol.ts（list_storage / storage 载荷）, ../index.ts（dispatch）,
 *            ../agent-service.ts（磁盘区域清单）, usage-history.ts（历史文件大小/保留）,
 *            web/src/components/SystemResources.tsx（界面）
 *   📖 docs/DEV-CON-PROPOSAL.md §8 P4 候选「必要运维」
 *   @CONTRACT 只读遍历：不删除、不改写任何数据。遍历必须有界（文件数/时间/深度上限），
 *             触到上限就把该区域标 truncated 并在界面说明，绝不假装数字完整。
 *   @PERF 递归 stat 是本模块唯一的重活：默认上限 @MAGIC MAX_FILES=50_000 / MAX_MS=2_000，
 *         超限即停。不要在 5 秒轮询里调用它（界面只在手动刷新/打开时查一次）。
 *   @GOTCHA 不跟随符号链接（release 目录、node_modules 链接都会造成重复计数或死循环）。
 * ──────────────────────────────────────────────────
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** @MAGIC 有界遍历上限（见头部说明）。 */
export const MAX_FILES = 50_000;
export const MAX_MS = 2_000;

export interface StorageAreaInput {
	path: string;
	label: string;
	/** 界面用的一句话说明（例如「会话记录（用户数据，不建议清理）」）。 */
	note?: string;
}

export interface StorageAreaResult {
	path: string;
	label: string;
	note?: string;
	bytes: number;
	files: number;
	/** true = 触到文件数/时间上限，数字不完整。 */
	truncated: boolean;
	/** 目录不存在时为 true（不是错误）。 */
	missing: boolean;
}

interface WalkIo {
	/** 目录项（不可读返回 null）。 */
	readdir: (path: string) => { name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }[] | null;
	/** 路径类型与大小：文件给 size，目录给 kind="dir"，不存在给 "missing"。 */
	kindOf: (path: string) => { kind: "file" | "dir" | "missing"; size: number };
	now: () => number;
}

function defaultWalkIo(): WalkIo {
	return {
		readdir: (path) => {
			try {
				return readdirSync(path, { withFileTypes: true }).map((entry) => ({
					name: entry.name,
					isDirectory: entry.isDirectory(),
					isFile: entry.isFile(),
					isSymbolicLink: entry.isSymbolicLink(),
				}));
			} catch {
				return null;
			}
		},
		kindOf: (path) => {
			try {
				const info = statSync(path);
				return info.isFile() ? { kind: "file", size: info.size } : { kind: "dir", size: info.size };
			} catch {
				return { kind: "missing", size: 0 };
			}
		},
		now: () => Date.now(),
	};
}

/**
 * 统计一个路径的占用（文件大小之和）。目录递归、符号链接不跟随；
 * 触到上限立即停止并标记 truncated。路径不存在 → missing（不是错误）。
 */
export function measurePath(area: StorageAreaInput, io: Partial<WalkIo> = {}): StorageAreaResult {
	const walk: WalkIo = { ...defaultWalkIo(), ...io };
	const root = walk.kindOf(area.path);
	if (root.kind === "missing") return { ...area, bytes: 0, files: 0, truncated: false, missing: true };
	// 单文件区域（例如 usage-history.jsonl）：直接返回自身大小。
	if (root.kind === "file") return { ...area, bytes: root.size, files: 1, truncated: false, missing: false };

	const started = walk.now();
	let files = 0;
	let bytes = 0;
	let truncated = false;

	const visit = (path: string): void => {
		const entries = walk.readdir(path);
		if (entries === null) return;
		for (const entry of entries) {
			if (entry.isSymbolicLink) continue; // @GOTCHA 不跟随链接（release 链接/依赖链接会重复计数）
			const child = join(path, entry.name);
			if (entry.isDirectory) {
				visit(child);
				continue;
			}
			if (!entry.isFile) continue;
			const info = walk.kindOf(child);
			if (info.kind === "file") {
				files += 1;
				bytes += info.size;
			}
			if (files >= MAX_FILES || walk.now() - started > MAX_MS) {
				truncated = true;
				return;
			}
		}
	};

	visit(area.path);
	return { ...area, bytes, files, truncated, missing: false };
}

/** 批量统计并按占用降序（同大小按标签稳定排序）。 */
export function measureAreas(areas: StorageAreaInput[], io: Partial<WalkIo> = {}): StorageAreaResult[] {
	return areas
		.map((area) => measurePath(area, io))
		.sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
}
