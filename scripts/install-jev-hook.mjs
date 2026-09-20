/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-gate/index.ts（被**复制**到宿主，不是引用路径）
 * 📖 docs/JEV-HOOK.md — official global extensions/*.ts discovery, without settings edits.
 * @WHY 为什么是复制而不是「写一个 re-export 指向仓库路径」：第一版就是这么写的，结果全局入口指向了
 *   一个**临时 worktree**（/home/dev/jev-hook）—— 那个 worktree 一删，所有 pi 会话加载扩展都会报错。
 *   宿主目录必须**自包含**：装完就与仓库路径无关，更新靠重跑 install。
 * @WHY 为什么入口文件名带**内容哈希**（`jev-gate-<hash>.ts`）：宿主进程按**扩展路径**缓存已加载的
 *   factory（SDK 的 extensionCache + 进程内模块缓存）。同名覆盖时，新会话仍会拿到**旧代码** ——
 *   实测：重装后在一个 cwd=/tmp 的新会话里提交，钩子仍然找不到 CLI 而静默放行（新版才有 app.json 兜底）。
 *   内容寻址 = 代码一变路径就变 → 缓存自然失效，不必重启宿主。
 * @CONTRACT 只动两处：`<agentDir>/extensions/jev-gate-<hash>.ts`（入口 shim）与
 *   `<agentDir>/hooks/jev-gate-<hash>/`（扩展本体 + `.managed-by` 标记 + `app.json`）。
 *   **不是我们装的东西一律拒绝覆盖/删除**（内容不匹配就抛错），绝不静默接管别人的扩展。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = fileURLToPath(
  new URL("../extensions/jev-gate/", import.meta.url),
);
/** 安装来源 checkout 根（用于把「CLI 在哪」写进 app.json 当兜底）。 */
const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const agentDir =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const extensionsDir = resolve(agentDir, "extensions");
const hooksDir = resolve(agentDir, "hooks");
const LEGACY_SHIM = join(extensionsDir, "jev-gate.ts");
const LEGACY_BODY = join(hooksDir, "jev-gate");
/** 本安装器写过的入口都带这行标记 —— 用它把「自己人的旧版本」和「别人的扩展」分开。 */
const MANAGED_PREFIX = "// Managed by PI-dev scripts/install-jev-hook.mjs";
const MARKER =
  "pi-dev jev-gate hook（安装：scripts/install-jev-hook.mjs install；卸载：… uninstall）\n";
const SHIM_RE = /^jev-gate(?:-[0-9a-f]{8,})?\.ts$/;
const BODY_RE = /^jev-gate(?:-[0-9a-f]{8,})?$/;

const action = process.argv[2] ?? "install";
if (!["install", "uninstall"].includes(action))
  throw new Error("Use install or uninstall");

const bodyFiles = readdirSync(SOURCE_DIR)
  .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs"))
  .sort();
if (bodyFiles.length === 0)
  throw new Error(`源目录里没有可安装的文件：${SOURCE_DIR}`);
/** 内容哈希：本体一变，入口名与本体目录名都变（缓存失效的关键，见 @WHY）。 */
const bodyHash = createHash("sha256");
for (const name of bodyFiles)
  bodyHash
    .update(name)
    .update("\0")
    .update(readFileSync(join(SOURCE_DIR, name)))
    .update("\0");
const hash = bodyHash.digest("hex").slice(0, 8);
const shimPath = join(extensionsDir, `jev-gate-${hash}.ts`);
const bodyDir = join(hooksDir, `jev-gate-${hash}`);
const appRecordPath = join(bodyDir, "app.json");
const shimText = `${MANAGED_PREFIX}\nexport { default } from "../hooks/jev-gate-${hash}/index.ts";\n`;

/** 我们装过的东西：入口 shim（带管理标记）与本体目录（带 .managed-by）。别人的一律不碰。 */
function ourShims() {
  if (!existsSync(extensionsDir)) return [];
  return readdirSync(extensionsDir)
    .filter((name) => SHIM_RE.test(name))
    .map((name) => join(extensionsDir, name))
    .filter((path) => readFileSync(path, "utf8").startsWith(MANAGED_PREFIX));
}
function ourBodyDirs() {
  if (!existsSync(hooksDir)) return [];
  return readdirSync(hooksDir)
    .filter((name) => BODY_RE.test(name))
    .map((name) => join(hooksDir, name))
    .filter((path) => existsSync(join(path, ".managed-by")));
}
function foreignNames() {
  const foreign = [];
  if (!existsSync(extensionsDir)) return foreign;
  for (const name of readdirSync(extensionsDir)) {
    if (name === ".managed-by") continue;
    if (!SHIM_RE.test(name)) continue;
    if (
      !readFileSync(join(extensionsDir, name), "utf8").startsWith(
        MANAGED_PREFIX,
      )
    )
      foreign.push(join(extensionsDir, name));
  }
  if (existsSync(hooksDir)) {
    for (const name of readdirSync(hooksDir)) {
      if (!BODY_RE.test(name)) continue;
      if (!existsSync(join(hooksDir, name, ".managed-by")))
        foreign.push(join(hooksDir, name));
    }
  }
  return foreign;
}

const foreign = foreignNames();
if (foreign.length > 0) {
  throw new Error(
    `以下路径不是本安装器管理的（拒绝覆盖或删除）：${foreign.join("、")}`,
  );
}

if (action === "uninstall") {
  const removed = [...ourShims(), ...ourBodyDirs()];
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  // 历史遗留的固定名（第一版）一并清理：它们要么是旧的自己人（有标记），要么已被 foreignNames 拦下。
  for (const path of [LEGACY_SHIM, LEGACY_BODY]) {
    const ours =
      path === LEGACY_SHIM
        ? existsSync(path) &&
          readFileSync(path, "utf8").startsWith(MANAGED_PREFIX)
        : existsSync(join(path, ".managed-by"));
    if (ours) {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  console.log(
    removed.length
      ? `已卸载：${removed.join("、")}；现有会话需 /reload 或重新创建。`
      : "没有找到本安装器安装的入口，未做改动。",
  );
} else {
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(bodyDir, { recursive: true });
  for (const name of bodyFiles)
    copyFileSync(join(SOURCE_DIR, name), join(bodyDir, name));
  writeFileSync(join(bodyDir, ".managed-by"), MARKER, { mode: 0o600 });
  /**
   * 记下「门禁 CLI 在本机哪个 checkout」—— 会话在**别的项目**里提交时（cwd 不含 `vendor/pi-web-ui`），
   * gate.mjs 靠这份记录兜底；否则它就找不到 CLI 而静默放行。装完与源目录无关（只是兜底路径）。
   * 想换兜底 checkout：在目标 checkout 里重跑 install。
   */
  writeFileSync(
    appRecordPath,
    `${JSON.stringify({ app: resolve(SOURCE_ROOT, "vendor", "pi-web-ui"), installedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(shimPath, shimText, { mode: 0o600 });
  // 清掉旧版本（内容哈希变了就换名）：同名的陈货会让宿主继续跑旧代码，也避免一次加载两个钩子。
  let cleaned = 0;
  for (const path of [...ourShims(), ...ourBodyDirs()]) {
    if (path === shimPath || path === bodyDir) continue;
    rmSync(path, { recursive: true, force: true });
    cleaned += 1;
  }
  for (const path of [LEGACY_SHIM, LEGACY_BODY]) {
    const ours =
      path === LEGACY_SHIM
        ? existsSync(path) &&
          readFileSync(path, "utf8").startsWith(MANAGED_PREFIX)
        : existsSync(join(path, ".managed-by"));
    if (ours) {
      rmSync(path, { recursive: true, force: true });
      cleaned += 1;
    }
  }
  console.log(
    `已安装 ${shimPath}（本体 ${bodyFiles.length} 个文件在 ${bodyDir}/，内容哈希 ${hash}，自包含、不依赖仓库路径）`,
  );
  console.log(
    `兜底 CLI 路径已记入 ${appRecordPath}（会话在别的项目里提交时用它；换 checkout 重跑 install 即可）`,
  );
  if (cleaned)
    console.log(
      `已清理 ${cleaned} 个旧版本（入口名带内容哈希，宿主缓存随之失效，不必重启）`,
    );
  console.log(
    "新会话自动加载；现有会话执行 /reload，或在宿主中重新创建会话运行时。",
  );
}
