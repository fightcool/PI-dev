/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED sync needed: scripts/maintenance/prepare-release.mjs, scripts/lifecycle/release-prune.mjs,
 *            tests/release-deps.test.mjs; 📖 see: docs/PM2-PRODUCTION.md「依赖复用」
 *   @WHY 一个 release 自包含 ~1.6 GiB 依赖（node_modules + vendor/pi-web-ui/node_modules），
 *        上线 12 次即 19 GiB；而依赖树在构建完成后至今没有被写过（实测三版均为 0 个文件）。
 *        因此把依赖放进只读依赖仓，release 只硬链接共享 inode，单版开销从 GiB 级降到几十 MiB。
 *   @CONTRACT 只读依赖仓（shared/deps/<lockhash>/）：文件 0444、目录保持可写。
 *        文件只读是**安全机制而不是优化**——构建脚本若试图就地改写包文件会当场 EACCES 失败，
 *        而不是静默污染所有共享该 inode 的 release（包括正在跑的线上版本）。
 *        目录保持可写，保证仍能新建文件（如 __pycache__/缓存）与之后 rm -rf 回收。
 *   @ASSUME .venv 不进依赖仓：Python 会就地重写陈旧 .pyc，只读会让运行时炸掉；.venv 仅 39 MiB，
 *        继续按原样物理拷贝。
 *   @GOTCHA cp -al 只在同一文件系统内成立；跨设备会 EXDEV，必须回退物理拷贝而不是让发布失败。
 *   @GOTCHA 硬链接复用的前提是「构建不就地改依赖」；buildDependencyGuard 在构建后复核，
 *        一旦发现既有文件被改写就抛错，宁可发布失败也不要污染线上版本。
 *   @SECURITY 只处理依赖目录与锁文件字节，不读取、不复制任何凭据。
 * ──────────────────────────────────────────────────
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** 走依赖仓（硬链接 + 冻结）的依赖根；.venv 刻意不在其中（见 @ASSUME）。 */
export const HARD_LINKED_TREES = ["node_modules", "vendor/pi-web-ui/node_modules"];
/** 仍然物理拷贝的依赖根。 */
export const COPIED_TREES = [".venv"];
/** 依赖仓根目录名（相对部署根的 shared/）。 */
export const DEPS_DIRNAME = "deps";
/** 参与依赖解析的锁文件（相对 release 根），顺序固定以保证仓 id 可复现。 */
export const LOCK_FILES = ["package-lock.json", "vendor/pi-web-ui/package-lock.json"];
/** @MAGIC 只读文件权限：阻止就地改写，同时不妨碍硬链接目标被 unlink。 */
const READONLY_FILE_MODE = 0o444;
/** @GOTCHA 可执行位必须保留：node_modules/.bin/* 与各种二进制靠 exec 位工作，
 *  统一改成 0444 会让构建直接 `vite: Permission denied`（实测踩过）。 */
const READONLY_EXEC_MODE = 0o555;
const readonlyModeFor = (mode) => ((mode & 0o111) === 0 ? READONLY_FILE_MODE : READONLY_EXEC_MODE);

/**
 * 依赖仓 id：只由**锁文件内容**决定（按固定相对路径顺序），绝不含绝对路径——
 * 含路径会让每个 release 得到各自的仓，硬链接复用直接失效。
 */
export function depsStoreId(releaseRoot) {
	const hash = createHash("sha256");
	for (const rel of LOCK_FILES) {
		hash.update(rel).update("\0");
		try {
			hash.update(readFileSync(join(releaseRoot, rel)));
		} catch {
			hash.update("<missing>");
		}
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 12);
}

export function depsStorePath(sharedDir, id) {
	if (!/^[a-f0-9]{6,64}$/.test(id)) throw new Error("Invalid dependency store id.");
	return join(sharedDir, DEPS_DIRNAME, id);
}

/** 递归列出目录下所有普通文件（相对路径）；目录不存在返回空数组。 */
export function listFiles(root) {
	if (!existsSync(root)) return [];
	const out = [];
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(join(dir, entry.name), rel);
			else if (entry.isFile()) out.push(rel);
		}
	};
	walk(root, "");
	out.sort();
	return out;
}

/**
 * 硬链接整棵树；同文件系统外或链接失败时回退物理拷贝。
 * @returns {{ mode: "hardlink" | "copy", files: number }}
 */
export function linkTree(from, to, { link = true } = {}) {
	if (!existsSync(from)) return { mode: link ? "hardlink" : "copy", files: 0 };
	mkdirSync(join(to, ".."), { recursive: true });
	if (link) {
		try {
			execFileSync("cp", ["-al", from, to], { stdio: ["ignore", "ignore", "pipe"] });
			return { mode: "hardlink", files: listFiles(to).length };
		} catch {
			rmSync(to, { recursive: true, force: true });
		}
	}
	cpSync(from, to, { recursive: true, dereference: false });
	return { mode: "copy", files: listFiles(to).length };
}

/** 把树内既有文件改成只读（目录保持可写）。 */
export function freezeTree(root) {
	let frozen = 0;
	for (const rel of listFiles(root)) {
		const path = join(root, rel);
		const target = readonlyModeFor(statSync(path).mode);
		if ((statSync(path).mode & 0o777) !== target) chmodSync(path, target);
		frozen += 1;
	}
	return frozen;
}

/**
 * 确保「与给定 release 的锁文件对应」的只读依赖仓存在。
 * 缺失时从 source 硬链接建仓并冻结；已存在则直接复用（不再扫描，保持幂等与快速）。
 */
export function ensureDepsStore({ sharedDir, source, echo = () => {}, trees = HARD_LINKED_TREES }) {
	const id = depsStoreId(source);
	const store = depsStorePath(sharedDir, id);
	if (existsSync(join(store, ".ready"))) return { id, path: store, created: false };
	mkdirSync(store, { recursive: true });
	for (const rel of trees) {
		if (!existsSync(join(source, rel))) continue;
		const { mode } = linkTree(join(source, rel), join(store, rel));
		if (mode === "copy") {
			// 拷贝出来的仓同样可用，只是不省空间；仍冻结，保证语义一致。
			echo(`依赖仓 ${id}/${rel} 无法硬链接（可能跨文件系统），已退化为拷贝`);
		}
	}
	const frozen = trees.reduce((sum, rel) => sum + freezeTree(join(store, rel)), 0);
	execFileSync("touch", [join(store, ".ready")]);
	echo(`依赖仓就绪：shared/${DEPS_DIRNAME}/${id}（${frozen} 个文件已冻结为只读）`);
	return { id, path: store, created: true, frozen };
}

/** 用只读依赖仓填充 staging；返回每个依赖根实际使用的方式。 */
export function populateFromStore(storePath, staging, { link = true, echo = () => {}, trees = HARD_LINKED_TREES } = {}) {
	const used = {};
	for (const rel of trees) {
		if (!existsSync(join(storePath, rel))) continue;
		const { mode, files } = linkTree(join(storePath, rel), join(staging, rel), { link });
		used[rel] = mode;
		echo(`  ${rel}: ${mode}（${files} 个文件）`);
	}
	return used;
}

/** 依赖树快照：相对路径 → { size, mtimeNs }。用纳秒精度，否则「同毫秒内等长就地改写」会漏检。 */
export function snapshotTrees(root, trees = HARD_LINKED_TREES) {
	const snap = new Map();
	for (const tree of trees) {
		for (const rel of listFiles(join(root, tree))) {
			const stat = statSync(join(root, tree, rel), { bigint: true });
			snap.set(`${tree}/${rel}`, `${stat.size}:${stat.mtimeNs}`);
		}
	}
	return snap;
}

/**
 * 比对快照，返回「既有文件被就地改写」的相对路径列表。
 * 新增文件不算问题——`cp -al` 把目录建成真实目录，新文件只落在本 release 内，不会波及共享 inode。
 */
export function changedSinceSnapshot(root, snapshot) {
	const changed = [];
	for (const [rel, before] of snapshot) {
		const path = join(root, rel);
		try {
			const stat = statSync(path, { bigint: true });
			if (`${stat.size}:${stat.mtimeNs}` !== before) changed.push(rel);
		} catch {
			changed.push(rel);
		}
	}
	return changed;
}

/** 构建后守卫：硬链接复用的 release 若改写了既有依赖文件，必须立即失败。 */
export function assertDependencyTreeUnmodified(root, snapshot, { trees = HARD_LINKED_TREES } = {}) {
	const changed = changedSinceSnapshot(root, snapshot);
	if (changed.length) {
		throw new Error(
			`构建过程中改写了 ${changed.length} 个既有依赖文件（首个：${changed[0]}）——` +
				`硬链接复用的依赖是只读共享的，就地改写会同时污染其他 release。` +
				`请用 PI_DEV_RELEASE_LINK_DEPS=0 重新准备候选并排查写入方（构建步骤不应写进依赖树）。`,
		);
	}
	return true;
}

/** 保留集里用到的依赖仓 id（用于判断哪些仓已无人引用）。 */
export function referencedStoreIds(releasesDir, releaseIds) {
	const ids = new Set();
	for (const id of releaseIds) {
		const root = join(releasesDir, id);
		if (!LOCK_FILES.every(rel => existsSync(join(root, rel)))) continue;
		ids.add(depsStoreId(root));
	}
	return ids;
}

/** 未被任何保留版本引用的依赖仓；纯规划，不落盘（锁文件变化后会留下旧仓，需显式回收）。 */
export function planObsoleteStores(sharedDir, releaseIds, releasesDir) {
	const dir = join(sharedDir, DEPS_DIRNAME);
	if (!existsSync(dir)) return [];
	const referenced = referencedStoreIds(releasesDir, releaseIds);
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.filter((id) => !referenced.has(id))
		.sort();
}

/** 回收无人引用的依赖仓；只删 shared/deps 下的普通目录，不碰其他任何东西。 */
export function pruneObsoleteStores(sharedDir, releaseIds, releasesDir, { apply = false } = {}) {
	const obsolete = planObsoleteStores(sharedDir, releaseIds, releasesDir);
	if (apply) {
		for (const id of obsolete) rmSync(join(sharedDir, DEPS_DIRNAME, id), { recursive: true, force: true });
	}
	return obsolete;
}
