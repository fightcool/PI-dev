/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-<name>/index.ts（被**复制**到宿主，不是引用路径）
 * 📖 docs/JEV-HOOK.md — official global extensions/*.ts discovery, without settings edits.
 * @WHY 为什么是复制而不是「写一个 re-export 指向仓库路径」：第一版就是这么写的，结果全局入口指向了
 *   一个**临时 worktree**（/home/dev/jev-hook）—— 那个 worktree 一删，所有 pi 会话加载扩展都会报错。
 *   宿主目录必须**自包含**：装完就与仓库路径无关，更新靠重跑 install。
 * @WHY 为什么入口文件名带**内容哈希**（`jev-gate-<hash>.ts`）：宿主进程按**扩展路径**缓存已加载的
 *   factory（SDK 的 extensionCache + 进程内模块缓存）。同名覆盖时，新会话仍会拿到**旧代码** ——
 *   实测：重装后在一个 cwd=/tmp 的新会话里提交，钩子仍然找不到 CLI 而静默放行。
 *   内容寻址 = 代码一变路径就变 → 缓存自然失效，不必重启宿主。
 * @WHY 为什么一次装**所有** `extensions/jev-*`（2026-09-21 起）：一个扩展一个内容寻址目录会漏装，
 *   「装好了却没生效」是我们踩过最多次的坑。安装器只认 `extensions/jev-*` 前缀 —— 名字就是契约。
 * @CONTRACT 只动两处：`<agentDir>/extensions/<name>-<hash>.ts`（入口 shim）与
 *   `<agentDir>/hooks/<name>-<hash>/`（扩展本体 + `.managed-by` 标记）。
 * @WHY 不再写 `app.json`（记录「CLI 在哪个 checkout」）：扩展改为**只认运行中宿主自己那份代码**
 *   （`process.argv[1]` 所在树里的 `vendor/pi-web-ui`，部署时即 `deploy/current` 指向的 release）。
 *   记录的路径只会让人误以为「可以退到别的 checkout」——部署切换后旧 release 会被回收，
 *   会话 cwd 里的副本又可能是别人正在改的工作副本。新装的本体不再依赖它；旧副本里的 app.json
 *   会随内容哈希变更被当作旧版本清掉。
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

const EXT_ROOT = fileURLToPath(new URL("../extensions/", import.meta.url));
const agentDir =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const extensionsDir = resolve(agentDir, "extensions");
const hooksDir = resolve(agentDir, "hooks");
/** 本安装器写过的入口都带这行标记 —— 用它把「自己人的旧版本」和「别人的扩展」分开。 */
const MANAGED_PREFIX = "// Managed by PI-dev scripts/install-jev-hook.mjs";
/** 扩展名规则：`jev-<小写字母数字连字符>`（安装器只认这个前缀，别放进别的东西）。 */
const KEY_RE = /^jev-[a-z0-9-]+$/;
/** 入口/本体的名字：`<name>` 或 `<name>-<hash>`（第一代是固定名，要能认出并升级）。 */
const shimRe = (key) => new RegExp(`^${key}(?:-[0-9a-f]{8,})?\\.ts$`);
const bodyRe = (key) => new RegExp(`^${key}(?:-[0-9a-f]{8,})?$`);
const ANY_SHIM_RE = /^jev-[a-z0-9-]+(?:-[0-9a-f]{8,})?\.ts$/;
const ANY_BODY_RE = /^jev-[a-z0-9-]+(?:-[0-9a-f]{8,})?$/;

const action = process.argv[2] ?? "install";
if (!["install", "uninstall"].includes(action))
  throw new Error("Use install or uninstall");

/** 一份扩展的安装计划：源文件、内容哈希、入口路径、本体目录。 */
function planFor(key) {
  const sourceDir = join(EXT_ROOT, key);
  const files = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs"))
    .sort();
  if (files.length === 0)
    throw new Error(`源目录里没有可安装的文件：${sourceDir}`);
  const bodyHash = createHash("sha256");
  for (const name of files)
    bodyHash
      .update(name)
      .update("\0")
      .update(readFileSync(join(sourceDir, name)))
      .update("\0");
  const hash = bodyHash.digest("hex").slice(0, 8);
  return {
    key,
    sourceDir,
    files,
    hash,
    shimPath: join(extensionsDir, `${key}-${hash}.ts`),
    bodyDir: join(hooksDir, `${key}-${hash}`),
    shimText: `${MANAGED_PREFIX}\nexport { default } from "../hooks/${key}-${hash}/index.ts";\n`,
    marker: `pi-dev ${key}（安装：scripts/install-jev-hook.mjs install；卸载：… uninstall）\n`,
  };
}

const keys = readdirSync(EXT_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && KEY_RE.test(entry.name))
  .map((entry) => entry.name)
  .sort();
if (keys.length === 0)
  throw new Error(`没有找到任何 extensions/jev-* 源目录：${EXT_ROOT}`);
const plans = keys.map(planFor);

const readdir = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
const isOurShim = (path) =>
  existsSync(path) && readFileSync(path, "utf8").startsWith(MANAGED_PREFIX);
const isOurBody = (path) => existsSync(join(path, ".managed-by"));

/** 本安装器装过的入口 shim（全部扩展）。 */
function ourShims() {
  return readdir(extensionsDir)
    .filter((name) => ANY_SHIM_RE.test(name))
    .map((name) => join(extensionsDir, name))
    .filter(isOurShim);
}
/** 本安装器装过的本体目录（全部扩展）。 */
function ourBodyDirs() {
  return readdir(hooksDir)
    .filter((name) => ANY_BODY_RE.test(name))
    .map((name) => join(hooksDir, name))
    .filter(isOurBody);
}
/** 名字像我们的、内容/标记不是我们的 → 拒绝动。 */
function foreignNames() {
  const foreign = [];
  for (const name of readdir(extensionsDir)) {
    if (name === ".managed-by") continue;
    if (!ANY_SHIM_RE.test(name)) continue;
    if (!isOurShim(join(extensionsDir, name)))
      foreign.push(join(extensionsDir, name));
  }
  for (const name of readdir(hooksDir)) {
    if (!ANY_BODY_RE.test(name)) continue;
    if (!isOurBody(join(hooksDir, name))) foreign.push(join(hooksDir, name));
  }
  return foreign;
}

/** 某个扩展自己的旧版本（同名或旧哈希），不含当前要写的路径。 */
function staleFor(plan) {
  const stale = [];
  for (const name of readdir(extensionsDir)) {
    const path = join(extensionsDir, name);
    if (path === plan.shimPath) continue;
    if (shimRe(plan.key).test(name) && isOurShim(path)) stale.push(path);
  }
  for (const name of readdir(hooksDir)) {
    const path = join(hooksDir, name);
    if (path === plan.bodyDir) continue;
    if (bodyRe(plan.key).test(name) && isOurBody(path)) stale.push(path);
  }
  return stale;
}

const foreign = foreignNames();
if (foreign.length > 0)
  throw new Error(
    `以下路径不是本安装器管理的（拒绝覆盖或删除）：${foreign.join("、")}`,
  );

if (action === "uninstall") {
  const removed = [...ourShims(), ...ourBodyDirs()];
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  console.log(
    removed.length
      ? `已卸载 ${removed.length} 项：${removed.join("、")}；现有会话需 /reload 或重新创建。`
      : "没有找到本安装器安装的入口，未做改动。",
  );
} else {
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  let cleaned = 0;
  for (const plan of plans) {
    mkdirSync(plan.bodyDir, { recursive: true });
    for (const name of plan.files)
      copyFileSync(join(plan.sourceDir, name), join(plan.bodyDir, name));
    writeFileSync(join(plan.bodyDir, ".managed-by"), plan.marker, {
      mode: 0o600,
    });
    writeFileSync(plan.shimPath, plan.shimText, { mode: 0o600 });
    for (const path of staleFor(plan)) {
      rmSync(path, { recursive: true, force: true });
      cleaned += 1;
    }
    console.log(
      `已安装 ${plan.shimPath}（本体 ${plan.files.length} 个文件在 ${plan.bodyDir}/，内容哈希 ${plan.hash}，自包含、不依赖仓库路径）`,
    );
  }
  if (cleaned)
    console.log(
      `已清理 ${cleaned} 个旧版本（入口名带内容哈希，宿主缓存随之失效，不必重启）`,
    );
  console.log(
    "新会话自动加载；现有会话执行 /reload，或在宿主中重新创建会话运行时。",
  );
}
