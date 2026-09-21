/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-trim/{trim,sections,config,objective,ask}.mjs
 * 📖 ../docs/JEV-HARNESS-PLAN.md §3-P0
 * @WHY 这套测试全部**零网络**（`askKeep` 注入假 runner）：判定质量靠真实语料校准（另一条线），
 *   这里钉住的是**安全规则**——失败放行、未判定必留、错误结果不裁、收益不足不改、details/isError 不碰。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildTrimQuestions,
  buildTrimState,
  entryFor,
  firstSuccessful,
  trimQuestion,
} from "../extensions/jev-trim/ask.mjs";
import { resolveAppCandidates } from "../extensions/jev-trim/app.mjs";
import { readTrimConfig } from "../extensions/jev-trim/config.mjs";
import {
  messageText,
  objectiveFromEntries,
} from "../extensions/jev-trim/objective.mjs";
import { splitSections } from "../extensions/jev-trim/sections.mjs";
import {
  applyTrimmedText,
  elisionMarker,
  planTrim,
  textParts,
} from "../extensions/jev-trim/trim.mjs";

const long = (label, chars) => `${label} ${"x".repeat(chars)}`;

test("config：默认 off，非法值回退默认，不因配错崩溃", () => {
  const off = readTrimConfig({});
  assert.equal(off.mode, "off");
  assert.equal(off.minChars, 12_000);
  assert.equal(off.keepAt, 0.5);
  assert.equal(off.maxPerSession, 3);

  assert.equal(readTrimConfig({ JEV_TRIM: "ON" }).mode, "on");
  assert.equal(readTrimConfig({ JEV_TRIM: "dry-run" }).mode, "dry-run");
  assert.equal(readTrimConfig({ JEV_TRIM: "yes" }).mode, "off");
  assert.equal(
    readTrimConfig({ JEV_TRIM: "on", JEV_TRIM_MIN_CHARS: "abc" }).minChars,
    12_000,
  );
  assert.equal(
    readTrimConfig({ JEV_TRIM: "on", JEV_TRIM_KEEP_AT: "9" }).keepAt,
    1,
  );
  assert.equal(
    readTrimConfig({ JEV_TRIM: "on", JEV_TRIM_MAX_PER_SESSION: "0" })
      .maxPerSession,
    1,
  );
});

test("sections：不丢字（拼接回来等于原文）；超上限时合并而不是丢弃", () => {
  const text = Array.from(
    { length: 6 },
    (_, i) => `${long(`para${i}`, 300)}`,
  ).join("\n\n");
  const { sections, merged } = splitSections(text, {
    sectionChars: 700,
    maxSections: 24,
  });
  assert.equal(merged, false);
  assert.ok(sections.length >= 2, "应切成多段");
  assert.equal(
    sections.map((s) => s.text).join("\n\n"),
    text,
    "切片拼回必须等于原文",
  );

  const tiny = splitSections(text, { sectionChars: 400, maxSections: 2 });
  assert.equal(tiny.merged, true);
  assert.ok(tiny.sections.length <= 2);
  assert.equal(
    tiny.sections.map((s) => s.text).join("\n\n"),
    text,
    "合并也不能丢字",
  );
});

test("sections：单个超长段落会被硬切（不允许出现「一段就是全部」）", () => {
  const oneLine = "y".repeat(5_000);
  const { sections } = splitSections(oneLine, {
    sectionChars: 1_000,
    maxSections: 24,
  });
  assert.ok(sections.length >= 5);
  assert.equal(sections.map((s) => s.text).join(""), oneLine);
});

test("objective：取最后一条 user 消息；取不到就没法判（返回 null）", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "最早的请求" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "助手的长篇推理" }],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "当前目标：修缓存测试" }],
      },
    },
  ];
  assert.equal(objectiveFromEntries(entries), "当前目标：修缓存测试");
  assert.equal(objectiveFromEntries([]), null);
  assert.equal(objectiveFromEntries(undefined), null);
  assert.equal(
    objectiveFromEntries([
      { type: "message", message: { role: "assistant", content: "x" } },
    ]),
    null,
  );
  assert.equal(
    messageText([{ type: "image" }, { type: "text", text: "看得见" }]),
    "看得见",
  );
});

test("planTrim：全部保留 = 不改写（别白花一次调用）", () => {
  const sections = splitSections(`${long("a", 800)}\n\n${long("b", 800)}`, {
    sectionChars: 1_000,
  }).sections;
  const scores = { section_0: 0.9, section_1: 0.8 };
  assert.equal(planTrim({ text: "x", sections, scores, keepAt: 0.5 }), null);
});

test("planTrim：模型没回答的片段一律保留（未判定 ≠ 不重要）", () => {
  const sections = splitSections(
    [long("keep", 900), long("unjudged", 900), long("drop", 900)].join("\n\n"),
    { sectionChars: 950 },
  ).sections;
  assert.equal(sections.length, 3);
  const plan = planTrim({
    text: "x".repeat(2_700),
    sections,
    scores: { section_0: 0.95, section_2: 0.05 },
    keepAt: 0.5,
  });
  assert.ok(plan, "应当裁剪");
  assert.deepEqual(plan.kept, [0, 1]);
  assert.deepEqual(plan.elided, [2]);
  assert.deepEqual(plan.unscored, [1]);
  assert.ok(plan.text.includes("unjudged"));
  assert.ok(!plan.text.includes(long("drop", 900)));
});

test("planTrim：省不到 15% 就不改；全部判无关时至少留一段（风险不对称）", () => {
  const sections = splitSections(
    [long("a", 3_000), long("b", 3_000), long("c", 3_000)].join("\n\n"),
    { sectionChars: 3_100 },
  ).sections;
  const marginal = planTrim({
    text: "x".repeat(9_000),
    sections,
    scores: { section_0: 0.6, section_1: 0.55, section_2: 0.5 },
    keepAt: 0.5,
  });
  assert.equal(marginal, null, "保留比例 >0.8 时不该改写");

  const allIrrelevant = planTrim({
    text: "x".repeat(9_000),
    sections,
    scores: { section_0: 0.01, section_1: 0.02, section_2: 0.03 },
    keepAt: 0.5,
  });
  assert.ok(allIrrelevant);
  assert.equal(allIrrelevant.kept.length, 1, "至少留得分最高的那一段");
  assert.deepEqual(allIrrelevant.kept, [2]);
});

test("省略标记：可见、带首行摘要、给出可执行的补救方式", () => {
  const marker = elisionMarker({
    index: 0,
    text: "x".repeat(1_234),
    firstLine: "npm ERR! 404 Not Found",
  });
  assert.match(marker, /jev-trim 已省略 1234 字/);
  assert.match(marker, /npm ERR! 404 Not Found/);
  assert.match(marker, /重跑/);
});

test("content 改写：只动文本 part，图片/details 结构不碰（多文本 part 合并进第一个）", () => {
  const original = [
    { type: "text", text: "第一段" },
    { type: "image", data: "AAA", mimeType: "image/png" },
    { type: "text", text: "第二段" },
  ];
  const next = applyTrimmedText(original, "裁剪后");
  assert.deepEqual(next[1], {
    type: "image",
    data: "AAA",
    mimeType: "image/png",
  });
  assert.equal(next[0].text, "裁剪后");
  assert.equal(next[2].text, "");
  assert.equal(original[0].text, "第一段", "不得就地修改原对象");
  assert.equal(applyTrimmedText("纯字符串", "新"), "新");
  assert.deepEqual(
    textParts(original).map((p) => p.index),
    [0, 2],
  );
});

test("app 候选：按优先级去重列出全部，entry 选择随 checkout 内容变化", () => {
  // 实测踩过：会话 cwd 里的 checkout 还没有 `ask` 子命令 → 每次判定都「未知命令」。
  // 所以候选要**全部**列出来逐个尝试，而不是只取第一个。
  const cwd = mkdtempSync(join(tmpdir(), "jev-trim-cand-"));
  const app = join(cwd, "vendor", "pi-web-ui");
  mkdirSync(join(app, "scripts"), { recursive: true });
  writeFileSync(join(app, "scripts", "jev-gate.ts"), "// cli stub");
  // ① 老 checkout 只有 jev-gate.ts（没有瘦入口）→ 用 `jev-gate.ts ask` 兜底。
  assert.deepEqual(entryFor(app), {
    entry: join(app, "scripts", "jev-gate.ts"),
    prefix: ["ask"],
  });
  const candidates = resolveAppCandidates(cwd, {}, join(cwd, "app.json"));
  assert.equal(candidates[0], app, "cwd 里的 checkout 优先");
  // 去重（同一目录只出现一次）；最后一项恒为「本体自带的 checkout」兜底（这里就是本仓库）。
  assert.equal(new Set(candidates).size, candidates.length);
  // ② 新 checkout 有瘦入口 → 用瘦入口、不带子命令。
  writeFileSync(join(app, "scripts", "jev-ask.ts"), "// slim stub");
  assert.deepEqual(entryFor(app), {
    entry: join(app, "scripts", "jev-ask.ts"),
    prefix: [],
  });
  // ③ 环境变量指定的 app 排在最前；不存在的目录被忽略。
  const other = join(cwd, "other", "vendor", "pi-web-ui");
  mkdirSync(join(other, "scripts"), { recursive: true });
  writeFileSync(join(other, "scripts", "jev-gate.ts"), "// cli stub");
  const withEnv = resolveAppCandidates(
    cwd,
    { JEV_GATE_APP: other },
    join(cwd, "app.json"),
  );
  assert.deepEqual(
    withEnv.slice(0, 2),
    [other, app],
    "env 指定的 app 排最前，其次 cwd",
  );
  // 有安装记录时它**优先于 cwd**（版本与本体一致，避免拿到别人的旧副本 —— 实测吃过这个亏）。
  const recordPath = join(cwd, "app.json");
  writeFileSync(recordPath, JSON.stringify({ app: other }));
  assert.deepEqual(
    resolveAppCandidates(cwd, {}, recordPath).slice(0, 2),
    [other, app],
  );
  // 记录指向已删除的 checkout → 直接跳过，不付代价。
  writeFileSync(recordPath, JSON.stringify({ app: "/gone" }));
  assert.equal(resolveAppCandidates(cwd, {}, recordPath)[0], app);
  const envMissing = resolveAppCandidates(
    cwd,
    { JEV_GATE_APP: "/nope" },
    join(cwd, "app.json"),
  );
  assert.equal(envMissing[0], app, "不存在的 env 路径被忽略");
  rmSync(cwd, { recursive: true, force: true });
});

test("firstSuccessful：版本偏差自愈；取消/超时不重试", async () => {
  // ① 第一个候选因版本偏差失败 → 试第二个并成功（这正是实测踩到的场景）。
  const tried = [];
  const ok = await firstSuccessful(["/old", "/new"], async (app) => {
    tried.push(app);
    return app === "/old"
      ? { ok: false, reason: "app-version-skew" }
      : { ok: true, scores: { section_0: 0.9 } };
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(tried, ["/old", "/new"]);
  // ② 取消/超时：不换 app 重试（用户中断了，重试只会拖时间）。
  const tried2 = [];
  const aborted = await firstSuccessful(["/a", "/b"], async (app) => {
    tried2.push(app);
    return { ok: false, reason: "aborted" };
  });
  assert.equal(aborted.ok, false);
  assert.deepEqual(tried2, ["/a"]);
  // ③ 记住成功过的 app：下一次先试它（省掉「每次先撞一次坏候选」的 2.4s）。
  const tried3 = [];
  await firstSuccessful(["/slow", "/fast"], async (app) => {
    tried3.push(app);
    return app === "/fast"
      ? { ok: true, scores: {} }
      : { ok: false, reason: "app-version-skew" };
  });
  assert.deepEqual(tried3, ["/slow", "/fast"]);
  const tried4 = [];
  await firstSuccessful(["/slow", "/fast"], async (app) => {
    tried4.push(app);
    return { ok: true, scores: {} };
  });
  // 上次成功的排最前 → 第一次就成功，不会再去碰那个坏候选（这就是省下的 2.4s）。
  assert.deepEqual(tried4, ["/fast"], "上次成功的排最前，且成功即停");

  // ④ 全失败：原因串起来（能看出是哪个 checkout 的问题），不会静默变成 undefined。
  const allFail = await firstSuccessful(["/zz-a"], async () => ({
    ok: false,
    reason: "cli-exit-3:x",
  }));
  assert.match(allFail.reason, /cli-exit-3:x@\/zz-a/);
  assert.equal(
    (await firstSuccessful([], async () => ({ ok: true }))).reason,
    "app-not-found",
  );
});

test("ask 判据：引用 state 路径、英文、两侧给反例、片段正文不复制进问题", () => {
  const question = trimQuestion(7);
  assert.equal(question.type, "noul");
  assert.match(question.instructions.question, /`sections\[7\]\.text`/);
  assert.match(question.instructions.question, /`objective`/);
  assert.match(question.criteria.true.what, /^Yes:/);
  assert.match(question.criteria.false.what, /^No:/);
  assert.ok(
    question.criteria.true.examples.length > 0 &&
      question.criteria.false.examples.length > 0,
  );
  assert.ok(
    !JSON.stringify(question).includes("x".repeat(50)),
    "问题里不该出现片段正文",
  );

  const questions = buildTrimQuestions([{ index: 0 }, { index: 1 }]);
  assert.deepEqual(Object.keys(questions).sort(), ["section_0", "section_1"]);
  const state = buildTrimState({
    objective: "obj",
    tool: "bash",
    sections: [{ index: 3, text: "T" }],
  });
  assert.deepEqual(state, {
    objective: "obj",
    tool: "bash",
    sections: [{ index: 3, text: "T" }],
  });
});
