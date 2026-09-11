/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/release-prune.mjs, scripts/lifecycle/release.mjs
 * @COUPLED scripts/release.mjs, tests/helpers/release-fixture.mjs; 📖 docs/PM2-SHADOW.md「命令」
 * @CONTRACT 用临时部署根验证保留集由 current/shared/previous.json 指针决定，mtime 只给无保护条目排序；
 *           不接触真实 releases 目录，不调用 PM2。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync,
  utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseOptions } from "../scripts/lifecycle/release-options.mjs";
import { planPrune, pruneReleases, releaseInventory, retentionWarning } from "../scripts/lifecycle/release-prune.mjs";
import { runRelease } from "../scripts/lifecycle/release.mjs";
import { fixture } from "./helpers/release-fixture.mjs";

const COMMIT = "a".repeat(40);
const hoursAgo = hours => { const at = new Date(Date.now() - hours * 3_600_000); return at; };
const age = (path, hours) => { const at = hoursAgo(hours); utimesSync(path, at, at); };
const buildStaging = suffix => `.build-${String(suffix).repeat(16)}`;

/** 最小可用的已发布版本。生产流程只写 release-source.json，shadow 流程额外写 .release.json。 */
function release(t, base, id, ageHours, manifest = "release-source.json") {
  const dir = join(base, "releases", id);
  mkdirSync(join(dir, "vendor/pi-web-ui/dist/server"), { recursive: true });
  writeFileSync(join(dir, "vendor/pi-web-ui/dist/server/index.js"), "");
  writeFileSync(join(dir, manifest), JSON.stringify(manifest === ".release.json"
    ? { id, commit: COMMIT, builtAt: "2026-01-01T00:00:00.000Z" } : { commit: COMMIT }));
  writeFileSync(join(dir, "vendor/pi-web-ui/dist/build-info.json"),
    JSON.stringify({ commit: COMMIT, appVersion: "fixture", builtAt: "2026-01-01T00:00:00.000Z" }));
  age(dir, ageHours);
  return dir;
}

function deployment(t, { current = null, previous = null, releases = [], staging = [], extra = [], manifest = "release-source.json" } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "pi-prune-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const base = join(temp, "deploy with spaces");
  mkdirSync(join(base, "releases"), { recursive: true });
  mkdirSync(join(base, "shared/config"), { recursive: true });
  mkdirSync(join(base, "shared/pm2"), { recursive: true });
  const env = { ...process.env, HOME: temp, PI_DEV_DEPLOY_ROOT: base,
    PI_DEV_CONFIG_DIR: join(base, "shared/config"), PM2_HOME: join(base, "shared/pm2"),
    PI_DEV_SHADOW_PORT: "8790" };
  const options = releaseOptions(env);
  for (const [id, ageHours] of releases) release(t, base, id, ageHours, manifest);
  for (const [name, ageHours] of staging) {
    const path = join(base, "releases", name);
    if (name.endsWith(".tar")) writeFileSync(path, "partial archive");
    else { mkdirSync(path); writeFileSync(join(path, "partial"), "x"); }
    age(path, ageHours);
  }
  for (const [name, contents] of extra) writeFileSync(join(base, "releases", name), contents);
  if (previous !== null) writeFileSync(join(base, "shared/previous.json"), JSON.stringify({ id: previous }));
  if (current !== null) symlinkSync(join(base, "releases", current), join(base, "current"));
  return { temp, base, options, env };
}

/** 四代版本 a(最旧) → d(最新)，current=d、previous=c。 */
const lineage = { releases: [["a", 4], ["b", 3], ["c", 2], ["d", 1]], current: "d", previous: "c" };

test("两种发布流程的版本标记都被识别为完整版本", async t => {
  const production = deployment(t, { ...lineage, manifest: "release-source.json" });
  assert.deepEqual(planPrune(production.options, { keep: 0 }).remove, ["b", "a"]);
  assert.deepEqual(planPrune(production.options).skipped, []);

  const shadow = deployment(t, { ...lineage, manifest: ".release.json" });
  assert.deepEqual(planPrune(shadow.options, { keep: 0 }).remove, ["b", "a"]);
  assert.deepEqual(planPrune(shadow.options).skipped, []);
});

test("保留集由 current 与 previous 指针决定，mtime 只给无保护条目排序", async t => {
  const d = deployment(t, lineage);
  const plan = planPrune(d.options);
  assert.deepEqual(plan.protected, ["c", "d"]);
  assert.deepEqual(plan.remove, ["a"]);
  assert.deepEqual(plan.retained, ["d", "c", "b"]);
});

test("keep 只决定在受保护版本之外额外保留几个较新的备用版本", async t => {
  const d = deployment(t, lineage);
  assert.deepEqual(planPrune(d.options, { keep: 0 }).remove, ["b", "a"]);
  assert.deepEqual(planPrune(d.options, { keep: 1 }).remove, ["a"]);
  assert.deepEqual(planPrune(d.options, { keep: 5 }).remove, []);
});

test("没有 previous 指针时，按 mtime 保留最新的 keep 个版本作为回滚备用", async t => {
  const d = deployment(t, { ...lineage, previous: null });
  assert.deepEqual(planPrune(d.options, { keep: 1 }).protected, ["d"]);
  assert.deepEqual(planPrune(d.options, { keep: 1 }).remove, ["b", "a"]);
  assert.deepEqual(planPrune(d.options, { keep: 0 }).remove, ["c", "b", "a"]);
});

test("dry-run 只规划不落盘，apply 只删除未受保护的版本", async t => {
  const d = deployment(t, lineage);
  const planned = pruneReleases(d.options, { keep: 0 });
  assert.equal(planned.applied, false);
  assert.deepEqual(planned.removed, []);
  assert.ok(existsSync(join(d.base, "releases/a")));

  const applied = pruneReleases(d.options, { keep: 0, apply: true });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.removed, ["b", "a"]);
  assert.ok(!existsSync(join(d.base, "releases/a")));
  assert.ok(!existsSync(join(d.base, "releases/b")));
  assert.ok(existsSync(join(d.base, "releases/c")));
  assert.ok(existsSync(join(d.base, "releases/d")));
  assert.equal(readdirSync(join(d.base, "releases")).length, 2);
});

test("当前部署锁被持有时拒绝清理，持有锁的调用方可以显式放行", async t => {
  const d = deployment(t, lineage);
  mkdirSync(join(d.base, ".release-lock"));
  assert.throws(() => pruneReleases(d.options, { keep: 0, apply: true }), /locked/);
  assert.ok(existsSync(join(d.base, "releases/a")));
  assert.deepEqual(pruneReleases(d.options, { keep: 0, lockHeld: true }).remove, ["b", "a"]);
});

test("previous.json 损坏时拒绝清理，而不是丢掉它的保护", async t => {
  const d = deployment(t, lineage);
  writeFileSync(join(d.base, "shared/previous.json"), "{ not json");
  assert.throws(() => pruneReleases(d.options, { keep: 0, apply: true }), /previous\.json is unreadable/);
  assert.ok(existsSync(join(d.base, "releases/a")));
});

test("切换脚本显式传入的回滚点必须存活，即使它是最旧、mtime 最靠前的版本", async t => {
  const d = deployment(t, lineage);
  // 生产流程不写 previous.json，回滚点只能由 switch 脚本用 protect 传进来。
  const plan = planPrune(d.options, { keep: 0, protect: ["a"] });
  assert.deepEqual(plan.protected, ["a", "c", "d"]);
  assert.deepEqual(plan.remove, ["b"]);
  assert.deepEqual(plan.unknownProtected, []);
  const applied = pruneReleases(d.options, { keep: 0, protect: ["a"], apply: true });
  assert.ok(existsSync(join(d.base, "releases/a")), "回滚点不得被删除");
  assert.ok(existsSync(join(d.base, "releases/c")));
  assert.ok(!existsSync(join(d.base, "releases/b")));
});

test("protect 里的陌生 id 不报错但会回报，非法类型直接拒绝", async t => {
  const d = deployment(t, lineage);
  assert.deepEqual(planPrune(d.options, { keep: 0, protect: ["ghost"] }).unknownProtected, ["ghost"]);
  assert.throws(() => planPrune(d.options, { keep: 0, protect: [""] }), /non-empty release ids/);
  assert.throws(() => planPrune(d.options, { keep: 0, protect: "a" }), /must be an array/);
});

test("符号链接、未知文件与缺少 manifest 的目录一律跳过", async t => {
  const d = deployment(t, { ...lineage, extra: [["notes.txt", "keep me"]] });
  mkdirSync(join(d.base, "releases/mystery"));
  symlinkSync(join(d.base, "releases/d"), join(d.base, "releases/linked"));
  const plan = planPrune(d.options, { keep: 0 });
  assert.deepEqual(plan.remove, ["b", "a"]);
  assert.deepEqual(plan.skipped.map(entry => [entry.name, entry.reason]), [
    ["linked", "symlink"], ["mystery", "missing-release-manifest"], ["notes.txt", "not-a-directory"],
  ]);
  pruneReleases(d.options, { keep: 0, apply: true });
  assert.ok(existsSync(join(d.base, "releases/mystery")));
  assert.ok(existsSync(join(d.base, "releases/notes.txt")));
  assert.ok(existsSync(join(d.base, "releases/linked")));
});

test("只有超龄的 .build-* 暂存与残留 .tar 被回收", async t => {
  const d = deployment(t, { ...lineage, staging: [[buildStaging("a"), 7], [`${buildStaging("b")}.tar`, 7],
    [buildStaging("c"), 1]] });
  const plan = planPrune(d.options, { keep: 0 });
  assert.deepEqual(plan.stale, [buildStaging("a"), `${buildStaging("b")}.tar`]);
  const applied = pruneReleases(d.options, { keep: 0, apply: true });
  assert.ok(applied.removed.includes(buildStaging("a")));
  assert.ok(!existsSync(join(d.base, "releases", buildStaging("a"))));
  assert.ok(!existsSync(join(d.base, "releases", `${buildStaging("b")}.tar`)));
  assert.ok(existsSync(join(d.base, "releases", buildStaging("c"))));
});

test("非法的 keep 取值在任何写操作前拒绝", async t => {
  const d = deployment(t, lineage);
  for (const keep of [-1, 1.5, "2", NaN, Infinity])
    assert.throws(() => pruneReleases(d.options, { keep, apply: true }), /keep must be a non-negative integer/);
  assert.ok(existsSync(join(d.base, "releases/a")));
});

test("current 非受管链接时拒绝清理", async t => {
  const directory = deployment(t, { ...lineage, current: null });
  mkdirSync(join(directory.base, "current"));
  assert.throws(() => planPrune(directory.options), /current must be a managed release symlink/);

  const escaped = deployment(t, lineage);
  rmSync(join(escaped.base, "current"));
  symlinkSync(escaped.temp, join(escaped.base, "current"));
  assert.throws(() => planPrune(escaped.options), /current points outside managed releases/);
  assert.deepEqual(releaseInventory(escaped.options), ["d", "c", "b", "a"]);
});

test("prune 经 runRelease 执行，并拒绝版本 id 与 --commit", async t => {
  const d = deployment(t, lineage);
  const applied = await runRelease({ action: "prune", keep: 0, apply: true, env: d.env });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.removed, ["b", "a"]);
  assert.ok(!existsSync(join(d.base, ".release-lock")));

  await assert.rejects(runRelease({ action: "prune", id: "d", env: d.env }));
  await assert.rejects(runRelease({ action: "prune", commit: COMMIT, env: d.env }));
  await assert.rejects(runRelease({ action: "prune", warnAt: -1, env: d.env }), /warnAt/);
});

test("生产编排的 8 位暂存名按暂存处理，不得被当成完整版本", async t => {
  const inFlight = deployment(t, { ...lineage, staging: [[".build-47e59670", 1], [".build-47e59670.tar", 1]] });
  const plan = planPrune(inFlight.options, { keep: 0 });
  assert.deepEqual(plan.stale, [], "在飞的构建不得被回收");
  assert.ok(!plan.remove.includes(".build-47e59670"));
  assert.ok(!plan.retained.includes(".build-47e59670"));
  assert.deepEqual(releaseInventory(inFlight.options), ["d", "c", "b", "a"]);

  const abandoned = deployment(t, { ...lineage, staging: [[".build-47e59670", 7]] });
  assert.deepEqual(planPrune(abandoned.options, { keep: 0 }).stale, [".build-47e59670"]);
});

test("堆积告警是阈值驱动的非破坏提示", async t => {
  const d = deployment(t, lineage);
  assert.match(retentionWarning(d.options, 3), /4 releases are retained \(threshold 3\)/);
  assert.match(retentionWarning(d.options, 3), /prune --apply/);
  assert.equal(retentionWarning(d.options, 4), null);
});

test("release 成功后告警堆积，且不会自动删除历史版本", async t => {
  const f = await fixture(t);
  const first = await f.release("release", "first", { warnAt: 0 });
  assert.match(first.warning, /prune --apply/);
  await f.release("release", "second");
  assert.equal(f.current(), join(f.base, "releases/second"));
  assert.ok(existsSync(join(f.base, "releases/first")), "历史版本必须由操作者显式回收");
  assert.ok(existsSync(join(f.base, "releases/second")));
  assert.equal(f.json("shared/previous.json").id, "first");
});
