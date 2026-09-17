#!/usr/bin/env node
/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED web/public/sw.js（BUILD_ID 占位符的唯一来源；那里的 @CONTRACT 规定了行形状）,
 *            package.json（build:web 之后必须跑本脚本，否则占位符会原样发布）,
 *            tests/sw-build-id-test.mjs（钉住「产物里没有占位符且两次构建号不同」）
 *   @WHY sw.js 放在 web/public/ 下，Vite 只做原样拷贝、不做变量替换，所以缓存名无法用
 *        import.meta.env 注入 —— 只能在构建后就地改写产物。
 *   @CONTRACT 只改 dist 里的产物，**绝不回写 web/public/sw.js**（那是模板，占位符要留着）。
 *   @GOTCHA 必须校验「确实替换掉了」：静默失败会让 sw.js 带着字面量 __PI_WEB_BUILD_ID__ 上线，
 *        那样缓存名又变成常量，等于 bug 原样复活（这正是本脚本存在的理由）。
 * ──────────────────────────────────────────────────
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TARGET = join(ROOT, "web/dist/sw.js");
const PLACEHOLDER = "__PI_WEB_BUILD_ID__";

if (!existsSync(TARGET)) {
	console.error(`stamp-sw: 找不到 ${TARGET}（先跑 build:web）`);
	process.exit(1);
}

/** 构建号 = 短 commit + 构建时刻。commit 让同一次提交可追溯，时间戳保证脏工作区
 *  的两次构建也会得到不同的缓存名（否则本地反复构建时旧资源仍会被钉住）。
 *  @GOTCHA 发布构建跑在从 git 归档展开的 staging 目录里，**那不是 git 工作区**，
 *    直接 git rev-parse 只会得到 nogit（实测过两次）。
 *  @CONTRACT 取值优先级与 ../../scripts/build.mjs 写 build-info.json 时完全一致：
 *    仓库根的 release-source.json（两条发布路径都会写它：prepare-release.mjs
 *    与 release-build.mjs）→ PI_DEV_BUILD_COMMIT → git。不只依赖环境变量：
 *    prepare-release.mjs 并不传它。 */
const commit = (() => {
	const short = (v) => (/^[a-f0-9]{7,40}$/.test(v ?? "") ? v.slice(0, 12) : null);
	// release-source.json 在仓库根（本文件在 vendor/pi-web-ui/scripts/ 下，往上三层）。
	for (const p of [join(ROOT, "../../release-source.json"), join(ROOT, "release-source.json")]) {
		try {
			const hit = short(JSON.parse(readFileSync(p, "utf8")).commit);
			if (hit) return hit;
		} catch {
			/* 不存在或不可读：继续往下一个源找 */
		}
	}
	const fromEnv = short(process.env.PI_DEV_BUILD_COMMIT);
	if (fromEnv) return fromEnv;
	try {
		return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	} catch {
		return "nogit";
	}
})();
const buildId = `${commit}-${Date.now().toString(36)}`;

const source = readFileSync(TARGET, "utf8");
if (!source.includes(PLACEHOLDER)) {
	console.error(`stamp-sw: 产物里没有 ${PLACEHOLDER} —— web/public/sw.js 的 BUILD_ID 行被改坏了？`);
	process.exit(1);
}
const stamped = source.split(PLACEHOLDER).join(buildId);
writeFileSync(TARGET, stamped);
// 二次确认：替换后不允许还残留占位符（见 @GOTCHA）。
if (readFileSync(TARGET, "utf8").includes(PLACEHOLDER)) {
	console.error("stamp-sw: 替换后仍残留占位符，拒绝当作成功");
	process.exit(1);
}
console.log(`stamp-sw: BUILD_ID=${buildId}`);
