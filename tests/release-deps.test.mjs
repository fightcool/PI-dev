/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/release-deps.mjs, scripts/maintenance/prepare-release.mjs
 * @CONTRACT 用临时目录验证依赖硬链接复用与「只读依赖仓」的安全性质：
 *           同 inode 共享、目录仍可写、冻结后原地写会 EACCES、构建后就地改写会被守卫拦住；
 *           不触碰真实部署根，不调用 npm。
 * @WHY 保留这一组「共享 inode 安全性」用例，是为了让「依赖树在构建与运行期只被读」这个前提
 *      在有人破坏时立刻可见（node-pty 的 prepare/tsc 就会在构建后原地重写 lib/*.js）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";import { tmpdir } from "node:os";
import {
	HARD_LINKED_TREES,
	assertDependencyTreeUnmodified,
	changedSinceSnapshot,
	depsStoreId,
	ensureDepsStore,
	freezeTree,
	linkTree,
	listFiles,
	planObsoleteStores,
	populateFromStore,
	pruneObsoleteStores,
	snapshotTrees,
} from "../scripts/lifecycle/release-deps.mjs";

function tempDir(t, prefix = "pi-deps-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** 造一个「最小可用 release」：两个硬链接树 + 锁文件。 */
function makeRelease(t, root, id, { locks = { root: "lock-a", vendor: "lock-a" } } = {}) {
	const dir = join(root, id);
	for (const tree of HARD_LINKED_TREES) {
		mkdirSync(join(dir, tree, "pkg"), { recursive: true });
		writeFileSync(join(dir, tree, "pkg/index.js"), "module.exports = 1;\n");
		writeFileSync(join(dir, tree, "pkg/package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
	}
	writeFileSync(join(dir, "package-lock.json"), locks.root);
	mkdirSync(join(dir, "vendor/pi-web-ui"), { recursive: true });
	writeFileSync(join(dir, "vendor/pi-web-ui/package-lock.json"), locks.vendor);
	return dir;
}


test("依赖仓 id 只由锁文件字节决定：内容相同即同仓，任一锁变化即换仓", (t) => {
	const root = tempDir(t);
	const a = makeRelease(t, root, "rel-a");
	const b = makeRelease(t, root, "rel-b");
	const c = makeRelease(t, root, "rel-c", { locks: { root: "lock-a", vendor: "lock-b" } });
	assert.equal(depsStoreId(a), depsStoreId(b));
	assert.notEqual(depsStoreId(a), depsStoreId(c));
});

test("linkTree 默认硬链接（同 inode、内容共享），link:false 退化为独立拷贝", (t) => {
	const root = tempDir(t);
	const src = join(root, "src");
	mkdirSync(join(src, "pkg"), { recursive: true });
	writeFileSync(join(src, "pkg/index.js"), "x");
	const linked = join(root, "linked");
	assert.equal(linkTree(src, linked).mode, "hardlink");
	assert.equal(statSync(join(src, "pkg/index.js")).ino, statSync(join(linked, "pkg/index.js")).ino);

	const copied = join(root, "copied");
	assert.equal(linkTree(src, copied, { link: false }).mode, "copy");
	assert.notEqual(statSync(join(src, "pkg/index.js")).ino, statSync(join(copied, "pkg/index.js")).ino);
});

test("freezeTree 把文件冻结为只读，但目录仍可写（能新建文件、能回收）", (t) => {
	const root = tempDir(t);
	const tree = join(root, "node_modules");
	mkdirSync(join(tree, "pkg"), { recursive: true });
	writeFileSync(join(tree, "pkg/index.js"), "x");
	assert.equal(freezeTree(tree), 1);
	assert.equal(statSync(join(tree, "pkg/index.js")).mode & 0o777, 0o444);
	// 目录保持可写：构建仍能在依赖树里新建缓存文件，之后也能 rm -rf。
	assert.doesNotThrow(() => writeFileSync(join(tree, "pkg/.cache-new"), "y"));
	assert.doesNotThrow(() => rmSync(join(tree, "pkg/index.js")));
});

test("冻结的文件被就地改写时抛 EACCES —— 只读是安全机制而非优化", (t) => {
	const root = tempDir(t);
	const tree = join(root, "node_modules");
	mkdirSync(join(tree, "node-pty/lib"), { recursive: true });
	const file = join(tree, "node-pty/lib/windowsPtyAgent.js");
	writeFileSync(file, "compiled");
	freezeTree(tree);
	assert.throws(() => writeFileSync(file, "rewritten"), /EACCES|EPERM/);
	assert.equal(readFileSync(file, "utf8"), "compiled");
	chmodSync(file, 0o644);
});

test("快照只记录既有文件：新增文件不算异常，就地改写会被发现", async (t) => {
	const root = tempDir(t);
	const rel = makeRelease(t, root, "rel-a");
	const before = snapshotTrees(rel);
	writeFileSync(join(rel, "node_modules/pkg/added.js"), "new");
	assert.deepEqual(changedSinceSnapshot(rel, before), []);
	// 同长度改写靠 mtime 区分；文件系统时间戳粒度是毫秒级，需跨过一个 tick 才能观测到。
	await new Promise((resolve) => setTimeout(resolve, 60));
	writeFileSync(join(rel, "node_modules/pkg/index.js"), "module.exports = 2;\n");
	assert.deepEqual(changedSinceSnapshot(rel, before), ["node_modules/pkg/index.js"]);
});

test("回归：构建后原地重写依赖（node-pty 的 prepare/tsc）会被守卫拦住并指认文件", async (t) => {
	const root = tempDir(t);
	const source = makeRelease(t, root, "rel-source");
	const staging = join(root, "staging");
	mkdirSync(join(staging, "vendor/pi-web-ui"), { recursive: true });
	// 硬链接复用（构建前的正常状态）
	for (const tree of HARD_LINKED_TREES) linkTree(join(source, tree), join(staging, tree));
	const guard = snapshotTrees(staging);

	// 模拟 node-pty 的 prepare：tsc 在构建后几十秒就地重写 lib/*.js
	await new Promise((resolve) => setTimeout(resolve, 60));
	const patched = join(staging, "vendor/pi-web-ui/node_modules/pkg/index.js");
	writeFileSync(patched, "compiled-and-rewritten");

	assert.throws(
		() => assertDependencyTreeUnmodified(staging, guard),
		(err) => err.message.includes("vendor/pi-web-ui/node_modules/pkg/index.js") && err.message.includes("PI_DEV_RELEASE_LINK_DEPS=0"),
	);
});

test("只读依赖仓：幂等创建、冻结、从仓里硬链接进 staging", (t) => {
	const root = tempDir(t);
	const shared = join(root, "shared");
	const source = makeRelease(t, root, "rel-source");
	

	const first = ensureDepsStore({ sharedDir: shared, source });
	assert.equal(first.created, true);
	assert.ok(existsSync(join(first.path, ".ready")));
	assert.equal(statSync(join(first.path, "node_modules/pkg/index.js")).mode & 0o777, 0o444);
	assert.equal(statSync(join(first.path, "node_modules/pkg/index.js")).ino, statSync(join(source, "node_modules/pkg/index.js")).ino);

	const second = ensureDepsStore({ sharedDir: shared, source });
	assert.equal(second.created, false);
	assert.equal(second.path, first.path);

	const staging = join(root, "staging");
	mkdirSync(join(staging, "vendor/pi-web-ui"), { recursive: true });
	const used = populateFromStore(first.path, staging);
	assert.deepEqual(used, { node_modules: "hardlink", "vendor/pi-web-ui/node_modules": "hardlink" });
	assert.equal(statSync(join(staging, "node_modules/pkg/index.js")).ino, statSync(join(first.path, "node_modules/pkg/index.js")).ino);
	assert.ok(listFiles(staging).length > 0);
});

test("只回收无人引用的依赖仓，被保留版本引用的仓必须留下", (t) => {
	const root = tempDir(t);
	const shared = join(root, "shared");
	const releases = join(root, "releases");
	const kept = makeRelease(t, releases, "rel-kept");
	const dropped = makeRelease(t, releases, "rel-dropped", { locks: { root: "lock-b", vendor: "lock-a" } });
	mkdirSync(shared, { recursive: true });
	const keptStore = ensureDepsStore({ sharedDir: shared, source: kept });
	const droppedStore = ensureDepsStore({ sharedDir: shared, source: dropped });
	assert.notEqual(keptStore.id, droppedStore.id);

	assert.deepEqual(planObsoleteStores(shared, ["rel-kept"], releases), [droppedStore.id]);
	assert.deepEqual(pruneObsoleteStores(shared, ["rel-kept"], releases, { apply: false }), [droppedStore.id]);
	assert.ok(existsSync(droppedStore.path), "dry-run 不得删除任何依赖仓");

	assert.deepEqual(pruneObsoleteStores(shared, ["rel-kept"], releases, { apply: true }), [droppedStore.id]);
	assert.equal(existsSync(droppedStore.path), false);
	assert.ok(existsSync(keptStore.path), "被引用的依赖仓必须保留");
});

test("找不到锁文件的 release 不被当成引用来源（不会误保护依赖仓）", (t) => {
	const root = tempDir(t);
	const shared = join(root, "shared");
	const releases = join(root, "releases");
	const source = makeRelease(t, releases, "rel-source");
	mkdirSync(shared, { recursive: true });
	const store = ensureDepsStore({ sharedDir: shared, source });
	// 新增一个没有锁文件的版本（例如被截断的候选）——它引用不了任何仓。
	mkdirSync(join(releases, "rel-nolocks"), { recursive: true });
	assert.deepEqual(planObsoleteStores(shared, ["rel-nolocks"], releases), [store.id]);
});
