/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-gate/index.ts（被**复制**到宿主，不是引用路径）
 * 📖 docs/JEV-HOOK.md — official global extensions/*.ts discovery, without settings edits.
 * @WHY 为什么是复制而不是「写一个 re-export 指向仓库路径」：第一版就是这么写的，结果全局入口指向了
 *   一个**临时 worktree**（/home/dev/jev-hook）—— 那个 worktree 一删，所有 pi 会话加载扩展都会报错。
 *   宿主目录必须**自包含**：装完就与仓库路径无关，更新靠重跑 install。
 * @CONTRACT 只动两处：`<agentDir>/extensions/jev-gate.ts`（入口 shim，固定内容）与
 *   `<agentDir>/extensions/jev-gate/`（扩展本体 + `.managed-by` 标记）。
 *   **不是我们装的东西一律拒绝覆盖/删除**（内容不匹配就抛错），绝不静默接管别人的扩展。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = fileURLToPath(new URL("../extensions/jev-gate/", import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const extensionsDir = resolve(agentDir, "extensions");
const shimPath = join(extensionsDir, "jev-gate.ts");
/**
 * 扩展本体放在 `extensions/` **外面**。
 * @GOTCHA pi 的全局发现规则有两条：`extensions/<文件名>.ts` 与 `extensions/<目录名>/index.ts`。
 *   第一版把本体放进 `extensions/jev-gate/`，于是本体自己也被发现 → **同一个钩子加载两次**
 *   （实测：SDK 报 extensions.length=2，钩子会重复触发）。所以本体挪到宿主目录下的 `hooks/`，
 *   `extensions/` 里只留一个入口 shim。
 */
const hooksDir = resolve(agentDir, "hooks");
const bodyDir = join(hooksDir, "jev-gate");
const markerPath = join(bodyDir, ".managed-by");
/** 入口 shim 用**相对**路径 —— 这样它对仓库/ worktree 的位置零依赖（见 @WHY）。 */
const SHIM = '// Managed by PI-dev scripts/install-jev-hook.mjs\nexport { default } from "../hooks/jev-gate/index.ts";\n';
const MARKER = "pi-dev jev-gate hook（安装：scripts/install-jev-hook.mjs install；卸载：… uninstall）\n";

const action = process.argv[2] ?? "install";
if (!["install", "uninstall"].includes(action)) throw new Error("Use install or uninstall");

/** 本安装器写过的入口都带这行标记 —— 用它把「自己人的旧版本」和「别人的扩展」分开。 */
const MANAGED_PREFIX = "// Managed by PI-dev scripts/install-jev-hook.mjs";
const currentShim = existsSync(shimPath) ? readFileSync(shimPath, "utf8") : null;
const shimIsOurs = currentShim === null || currentShim.startsWith(MANAGED_PREFIX);
if (!shimIsOurs) {
  throw new Error("已有不同的 jev-gate.ts；请先确认其来源并用原安装目录卸载，拒绝覆盖。");
}
const bodyIsOurs = !existsSync(bodyDir) || existsSync(markerPath);
if (!bodyIsOurs) throw new Error(`${bodyDir} 不是本安装器管理的目录，拒绝覆盖或删除。`);

if (action === "uninstall") {
  if (currentShim !== null) unlinkSync(shimPath);
  if (existsSync(bodyDir)) rmSync(bodyDir, { recursive: true, force: true });
  console.log(`已卸载 ${shimPath} 与 ${bodyDir}/；现有会话需 /reload 或重新创建。`);
} else {
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(bodyDir, { recursive: true });
  const files = readdirSync(SOURCE_DIR).filter((name) => name.endsWith(".ts") || name.endsWith(".mjs"));
  if (files.length === 0) throw new Error(`源目录里没有可安装的文件：${SOURCE_DIR}`);
  for (const name of files) copyFileSync(join(SOURCE_DIR, name), join(bodyDir, name));
  writeFileSync(markerPath, MARKER, { mode: 0o600 });
  // 旧版本入口也覆盖（升级路径）：第一版指向 worktree 的 shim 就是这么换成自包含入口的。
  writeFileSync(shimPath, SHIM, { mode: 0o600 });
  console.log(`已安装 ${shimPath}（本体 ${files.length} 个文件在 ${bodyDir}/，自包含、不依赖仓库路径）`);
  console.log("新会话自动加载；现有会话执行 /reload，或在宿主中重新创建会话运行时。");
  console.log("更新：改了扩展源码后重跑 install（会覆盖本体文件）。");
}
