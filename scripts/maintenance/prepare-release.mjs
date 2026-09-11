/*
 * 🍞 AI Breadcrumb Navigation
 * @COUPLED docs/PM2-PRODUCTION.md（候选准备）, scripts/maintenance/switch-production-release.mjs（切换）,
 *          scripts/lifecycle/release-deps.mjs（依赖复用/只读依赖仓）
 * @CONTRACT 准备一个「未运行的独立 candidate」：git archive → 依赖（锁文件未变时复用现值）→ 构建 →
 *           写入 release-source.json。只读 runtime 配置，不碰 current、不重启服务。
 * @WHY 手工流程每次都要 npm ci 两个依赖根（~3 分钟）；而绝大多数发布的 package-lock.json 没变，
 *      直接复用当前 release 的 node_modules/.venv 既省时间又保证与线上同源（锁文件一致才复用）。
 * @GOTCHA 复用依赖前必须逐字节比对 package-lock.json（根 + vendor）：不一致就老老实实安装。
 * @GOTCHA 依赖复用默认是「物理拷贝」（每版约 1.6 GiB）。硬链接共享只读依赖仓能把它降到几十 MiB，
 *         但前提是「依赖树在构建与运行期只被读」；实测 node-pty 的 prepare/tsc 会在构建后原地重写
 *         lib/*.js，所以硬链接默认关闭，必须显式 PI_DEV_RELEASE_LINK_DEPS=1 开启（见 release-deps.mjs）。
 * 用法：node scripts/maintenance/prepare-release.mjs <commit> [releaseId]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	COPIED_TREES,
	HARD_LINKED_TREES,
	assertDependencyTreeUnmodified,
	ensureDepsStore,
	populateFromStore,
	snapshotTrees,
} from "../lifecycle/release-deps.mjs";

const HOME = process.env.HOME;
const DEV_ROOT = "/home/dev/PI-dev";
const BASE = join(HOME, ".local/share/pi-dev/deploy");
const RELEASES = join(BASE, "releases");
const CURRENT = join(BASE, "current");
const SHARED = join(BASE, "shared");
const DEPENDENCY_TREES = [...HARD_LINKED_TREES, ...COPIED_TREES];

const commit = process.argv[2];
if (!commit) throw new Error("用法：prepare-release.mjs <commit|ref> [releaseId]");
// 允许 HEAD / 分支名等 ref：先解析再使用（解析失败即报错退出）。
const resolved = execFileSync("git", ["rev-parse", `${commit}^{commit}`], { cwd: DEV_ROOT, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(resolved)) throw new Error(`无法解析为提交：${commit}`);
const id = process.argv[3] ?? resolved.slice(0, 12);
const target = join(RELEASES, id);
if (existsSync(target)) throw new Error(`release 已存在：${id}（先确认是否就是要用的版本）`);

const log = (...a) => console.log(new Date().toISOString(), "prepare:", ...a);
const staging = join(RELEASES, `.build-${Math.random().toString(16).slice(2, 10)}`);
mkdirSync(staging, { recursive: true, mode: 0o700 });
const tar = `/tmp/prepare-${id}.tar`;
try {
	log(`git archive ${resolved.slice(0, 12)} → ${staging}`);
	execFileSync("git", ["archive", "--format=tar", `--output=${tar}`, resolved], { cwd: DEV_ROOT, stdio: "inherit" });
	execFileSync("tar", ["-xf", tar, "-C", staging], { stdio: "inherit" });
	writeFileSync(join(staging, "release-source.json"), JSON.stringify({ commit: resolved }) + "\n");

	// 依赖：锁文件与当前 release 一致时直接复用（同源且省 ~3 分钟），否则按锁文件安装。
	const LOCK_FILES = ["package-lock.json", "vendor/pi-web-ui/package-lock.json"];
	const sameLock = (rel) => {
		try {
			return readFileSync(join(CURRENT, rel)).equals(readFileSync(join(staging, rel)));
		} catch {
			return false;
		}
	};
	const reuse = existsSync(CURRENT) && LOCK_FILES.every(sameLock);
	/** 硬链接共享只读依赖仓：默认关闭（见文件头 @GOTCHA），开启后单版依赖开销从 GiB 级降到几十 MiB。 */
	const linkDeps = process.env.PI_DEV_RELEASE_LINK_DEPS === "1";
	let depGuard = null;
	if (reuse) {
		if (linkDeps) {
			const store = ensureDepsStore({
				sharedDir: SHARED,
				source: CURRENT,
				echo: (...a) => log(...a),
			});
			log(`锁文件未变 → 从只读依赖仓 shared/deps/${store.id} 硬链接复用依赖`);
			log("注意：依赖文件已冻结为只读；构建若试图原地改写依赖会 EACCES 失败（这是设计上的保护，不是缺陷）");
			populateFromStore(store.path, staging, { echo: (...a) => log(...a) });
		} else {
			log("锁文件未变 → 拷贝复用当前 release 的 node_modules 与 .venv");
			for (const rel of HARD_LINKED_TREES) {
				if (existsSync(join(CURRENT, rel))) cpSync(join(CURRENT, rel), join(staging, rel), { recursive: true, dereference: false });
			}
		}
		for (const rel of COPIED_TREES) {
			if (existsSync(join(CURRENT, rel))) cpSync(join(CURRENT, rel), join(staging, rel), { recursive: true, dereference: false });
		}
		if (linkDeps) depGuard = snapshotTrees(staging);
	} else {
		log("锁文件有变化 → 按锁文件安装依赖");
		execFileSync("npm", ["run", "setup:dependencies"], { cwd: staging, stdio: "inherit" });
		if (existsSync(join(CURRENT, ".venv")) && !existsSync(join(staging, ".venv"))) {
			cpSync(join(CURRENT, ".venv"), join(staging, ".venv"), { recursive: true, dereference: false });
		}
	}

	log("构建");
	execFileSync("npm", ["run", "build"], { cwd: staging, stdio: "inherit" });
	// 硬链接复用的依赖是与其它 release 共享的同一批 inode：构建若就地改写，污染的是共享方，
	// 必须在这里立刻失败，而不是把被污染的候选切上线。
	if (depGuard) assertDependencyTreeUnmodified(staging, depGuard);
	const info = JSON.parse(readFileSync(join(staging, "vendor/pi-web-ui/dist/build-info.json"), "utf8"));
	if (info.commit !== resolved) throw new Error(`build-info 提交不一致：${info.commit} ≠ ${resolved}`);
	renameSync(staging, target);
	log(`就绪：releases/${id}（${info.appVersion}，协议 v${info.protocolVersion}，构建于 ${info.builtAt}）`);
	log(`下一步：产物级验证（冒烟 + 渠道 e2e）→ switch-production-release.mjs ${id}`);
} finally {
	rmSync(tar, { force: true });
	rmSync(staging, { recursive: true, force: true });
}
