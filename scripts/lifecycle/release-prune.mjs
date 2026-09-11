/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED sync needed: scripts/lifecycle/release.mjs, scripts/release.mjs, tests/release-prune.test.mjs
 *   📖 see: docs/PM2-SHADOW.md「命令」
 *   @WHY 保留集由系统已经记录的指针（current 链接、shared/previous.json）决定，不用目录 mtime 猜回滚目标。
 *        mtime 只用来在「没有指针保护的多余版本」之间排序，挑出额外保留的备用版本。
 *   @CONTRACT 只删除 releases/ 下带版本标记的完整版本与超龄 .build-* 暂存；不删除 current、
 *        previous.json 记录的版本、.release-lock、符号链接或未知条目。默认 dry-run，apply 才落盘。
 *   @GOTCHA 调用方若已经持有 .release-lock，必须传 lockHeld:true，否则会被自己的锁拒绝。
 * ──────────────────────────────────────────────────
 */
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readJson } from "../lib.mjs";
import { contained, releaseId } from "./release-options.mjs";

/** @GOTCHA shadow 流程（buildRelease）写 .release.json；生产流程只写 release-source.json。
 *  只用其中一个会把另一种流程的版本误判为未知条目，此处必须两者都接受。 */
const MANIFESTS = [".release.json", "release-source.json"];
/** @MAGIC buildRelease 用 randomBytes(8) 生成暂存名，因此固定为 16 位小写十六进制。 */
const STAGING = /^\.build-[0-9a-f]{16}(\.tar)?$/;
export const DEFAULT_KEEP = 1;
/** @MAGIC 6 小时：超过此年龄且无人持锁的 .build-* 视为硬中断残留，可回收。 */
export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_WARN_COUNT = 5;

/** current 链接指向的版本；非受管链接一律拒绝，避免误删真实目录。 */
function currentId(options) {
  const entry = lstatSync(options.current, { throwIfNoEntry: false });
  if (!entry) return null;
  if (!entry.isSymbolicLink()) throw new Error("current must be a managed release symlink.");
  const target = realpathSync(options.current);
  if (!contained(options.releases, target)) throw new Error("current points outside managed releases.");
  return basename(target);
}

/** shadow 流程记录的上一个成功版本；文件损坏时拒绝清理，而不是放弃保护。 */
function previousId(options) {
  const file = join(options.shared, "previous.json");
  if (!existsSync(file)) return null;
  try { return releaseId(readJson(file).id); }
  catch { throw new Error("shared/previous.json is unreadable; refusing to prune without its protection."); }
}

/** 必须保留的版本：current 与 previous.json 记录的版本。 */
export function protectedIds(options) {
  const ids = new Set();
  for (const id of [currentId(options), previousId(options)]) if (id !== null) ids.add(id);
  return ids;
}

function scanReleases(options) {
  let entries;
  try { entries = readdirSync(options.releases, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { releases: [], staging: [], skipped: [] }; throw error; }
  const releases = [], staging = [], skipped = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) { skipped.push({ name: entry.name, reason: "symlink" }); continue; }
    const path = join(options.releases, entry.name);
    const mtimeMs = statSync(path).mtimeMs;
    if (STAGING.test(entry.name)) {
      if (entry.isDirectory() || entry.isFile()) staging.push({ name: entry.name, mtimeMs });
      else skipped.push({ name: entry.name, reason: "unexpected-type" });
      continue;
    }
    if (!entry.isDirectory()) { skipped.push({ name: entry.name, reason: "not-a-directory" }); continue; }
    if (!MANIFESTS.some(name => existsSync(join(path, name)))) { skipped.push({ name: entry.name, reason: "missing-release-manifest" }); continue; }
    releases.push({ id: entry.name, mtimeMs });
  }
  // 仅用于在无保护条目之间排序；不参与挑选回滚目标。
  releases.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? 1 : -1));
  // readdir 顺序由文件系统决定，排序后输出才能被工具与测试稳定复现。
  staging.sort((a, b) => (a.name < b.name ? -1 : 1));
  skipped.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { releases, staging, skipped };
}

/** 已完成的版本，从新到旧；用于堆积告警与人工核对。 */
export function releaseInventory(options) {
  return scanReleases(options).releases.map(entry => entry.id);
}

/** 纯规划，不写磁盘。返回将保留、将删除、将回收暂存与跳过的条目。 */
export function planPrune(options, { keep = DEFAULT_KEEP, staleMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error("keep must be a non-negative integer.");
  if (!Number.isFinite(staleMs) || staleMs < 0) throw new Error("staleMs must be a non-negative number.");
  const { releases, staging, skipped } = scanReleases(options);
  const guarded = protectedIds(options);
  const candidates = releases.filter(entry => !guarded.has(entry.id));
  const drop = candidates.slice(keep);
  const dropIds = new Set(drop.map(entry => entry.id));
  return {
    protected: [...guarded].sort(),
    retained: releases.filter(entry => !dropIds.has(entry.id)).map(entry => entry.id),
    remove: drop.map(entry => entry.id),
    stale: staging.filter(entry => now - entry.mtimeMs > staleMs).map(entry => entry.name),
    skipped,
  };
}

export function pruneReleases(options, opts = {}) {
  const { apply = false, lockHeld = false, ...plan } = opts;
  if (!lockHeld && existsSync(join(options.base, ".release-lock")))
    throw new Error("Deployment is locked; inspect the previous operation before pruning.");
  const result = planPrune(options, plan);
  const removed = [];
  if (apply) {
    for (const name of [...result.remove, ...result.stale]) {
      rmSync(join(options.releases, name), { recursive: true });
      removed.push(name);
    }
  }
  return { applied: apply, removed, ...result };
}

/** 非破坏性堆积告警；超过阈值时提示操作者显式回收。 */
export function retentionWarning(options, warnAt = DEFAULT_WARN_COUNT) {
  if (!Number.isSafeInteger(warnAt) || warnAt < 0) throw new Error("warnAt must be a non-negative integer.");
  const ids = releaseInventory(options);
  if (ids.length <= warnAt) return null;
  return `${ids.length} releases are retained (threshold ${warnAt}); run \`node scripts/release.mjs prune --apply\` to reclaim disk.`;
}
