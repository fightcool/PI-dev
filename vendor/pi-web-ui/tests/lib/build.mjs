/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED run-smoke.mjs（聚合跑器：跑批前统一构建一次并置 PI_SMOKE_DIST_READY=1）,
 *            tests/*-test.mjs（自起 server 的用例原先各自 `npm run build`）,
 *            ../../../scripts/protocol-smoke.mjs（根入口的受限环境白名单）
 *   @WHY 2026-09-17：原先每个自起 server 的用例各跑一次 `npm run build`（共 6 个在冒烟清单里）。
 *        并发 3 时最多 3 份 vite/tsc 同时写同一个 dist/ —— CI 上复现过
 *        「✗ conv-cwd-test — build failed」6 秒即挂（同一次 run 里另一个用例构建成功、
 *        本地同样环境通过），是资源竞争型 flake，不是代码问题。
 *        现在跑批前只构建一次，用例复用同一份产物。
 *   @BUGFIX 同时修掉一个诊断黑洞：原先构建失败时 `stdio:"ignore"` 把 tsc/vite 的输出全丢了，
 *        冒烟跑器只能打印一句「build failed」，无法定位。现在保留输出尾部。
 * ──────────────────────────────────────────────────
 */
import { execFileSync } from "node:child_process";

/** 跑器已完成构建的信号（由 run-smoke.mjs 设置）；单独跑用例时不存在，用例会自建。 */
const DIST_READY_ENV = "PI_SMOKE_DIST_READY";

/**
 * 保证 `dist/` 是最新构建——跑批前已构建则直接返回。
 *
 * 单独跑（`node tests/xxx-test.mjs`）时行为与原来一致：自己构建。
 * 失败时打印构建输出尾部并以非零码退出，不再只留一句无法定位的 "build failed"。
 *
 * @param {{ cwd: string, label?: string }} opts cwd = 仓库根（npm run build 的工作目录）
 */
export function ensureBuild({ cwd, label = "build" }) {
	if (process.env[DIST_READY_ENV] === "1") return;
	const started = Date.now();
	try {
		execFileSync("npm", ["run", "build"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			// 构建输出可能上万行（mermaid vendor 提示等）；默认 1MB 会 ENOBUFS。
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		console.error(`${label}: 构建失败（${((Date.now() - started) / 1000).toFixed(1)}s）`);
		console.error("--- npm run build 输出尾部 ---");
		console.error(`${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n"));
		console.error(`--- ${error.message ?? "unknown error"} ---`);
		process.exit(1);
	}
	console.log(`${label}: 构建完成 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
