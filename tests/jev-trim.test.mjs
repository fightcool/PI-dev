/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-trim/{trim,sections,config,objective,ask}.mjs
 * 📖 ../docs/JEV-HARNESS-PLAN.md §3-P0
 * @WHY 这套测试全部**零网络**（`askKeep` 注入假 runner）：判定质量靠真实语料校准（另一条线），
 *   这里钉住的是**安全规则**——失败放行、未判定必留、错误结果不裁、收益不足不改、details/isError 不碰。
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildTrimQuestions,
  buildTrimState,
  classifyCliFailure,
  entryFor,
  trimQuestion,
} from "../extensions/jev-trim/ask.mjs";
import { resolveApp } from "../extensions/jev-trim/app.mjs";
import { readTrimConfig } from "../extensions/jev-trim/config.mjs";
import {
  messageText,
  objectiveFromEntries,
} from "../extensions/jev-trim/objective.mjs";
import { askKeep, budgetSections } from "../extensions/jev-trim/ask.mjs";
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

test("sections：不丢字（拼接回来等于原文）；超上限时取样，绝不允许把片段合大", () => {
  const text = Array.from(
    { length: 6 },
    (_, i) => `${long(`para${i}`, 300)}`,
  ).join("\n\n");
  const { sections, sampled } = splitSections(text, {
    sectionChars: 700,
    maxSections: 24,
  });
  assert.equal(sampled, false);
  assert.ok(sections.length >= 2, "应切成多段");
  assert.equal(
    sections.map((s) => s.text).join("\n\n"),
    text,
    "切片拼回必须等于原文",
  );

  const tiny = splitSections(text, { sectionChars: 400, maxSections: 2 });
  assert.equal(tiny.sampled, true);
  assert.ok(tiny.sections.length <= 2);
});

/**
 * @BUGFIX 回归：片段数超上限时**不允许合并**。
 * 第一版合并相邻片段 → 每段变成 `总长/上限`，90k 字的结果变成 22 段 × 4.1k 字，
 * 等于整份结果全进 state；上游按 token 限流（state + 最长问题 ≤ 32k token）→ 每次 HTTP 400，
 * 功能静默失效（看起来装了、其实每次都在失败放行）。
 */
test("sections：大结果 + 段数上限时，每段仍只有 ~sectionChars（不再合并成大段）", () => {
  const text = Array.from(
    { length: 400 },
    (_, i) => `第 ${i} 段：${long(`line${i}`, 400)}`,
  ).join("\n\n");
  const { sections, sampled } = splitSections(text, {
    sectionChars: 1_500,
    maxSections: 24,
  });
  assert.equal(sampled, true);
  assert.ok(
    sections.length <= 24,
    `段数必须收敛到上限内，实际 ${sections.length}`,
  );
  const longest = Math.max(...sections.map((s) => s.text.length));
  assert.ok(
    longest <= 3_000,
    `最大段 ${longest} 字 —— 合并成大段会让 state 爆掉（上限实测约 32k 字）`,
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

test("app 解析：pm_exec_path → argv[1]，绝不用 cwd 兜底", () => {
  // @WHY 部署语义：`deploy/current` 指向的 release 才是唯一在跑的代码，解析必须跟随它。
  // @GOTCHA pm2 会用自己的 process container 重新 fork，`process.argv[1]` 是 pm2 的包装器，
  //   真实入口在 `pm_exec_path` —— 实测就是这里翻车，还被 cwd 兜底掩盖成「版本错位」。
  const tmp = mkdtempSync(join(tmpdir(), "jev-trim-app-"));
  const release = join(tmp, "deploy/current");
  mkdirSync(join(release, "vendor/pi-web-ui/scripts"), { recursive: true });
  writeFileSync(
    join(release, "vendor/pi-web-ui/scripts/jev-gate.ts"),
    "// cli stub",
  );
  const other = join(tmp, "someone-else");
  mkdirSync(join(other, "vendor/pi-web-ui/scripts"), { recursive: true });
  writeFileSync(
    join(other, "vendor/pi-web-ui/scripts/jev-gate.ts"),
    "// cli stub",
  );
  const pm2Wrapper = join(
    tmp,
    "deploy/tools/pm2/node_modules/pm2/lib/ProcessContainerFork.js",
  );

  // ① pm_exec_path 胜出（pm2 现场）。
  assert.equal(
    resolveApp(
      { pm_exec_path: join(release, "scripts/start.mjs") },
      pm2Wrapper,
    ),
    join(release, "vendor/pi-web-ui"),
  );
  // ② 解析结果保留 `current` 字面量 → 换发布自动跟随。
  assert.match(
    resolveApp(
      { pm_exec_path: join(release, "scripts/start.mjs") },
      pm2Wrapper,
    ),
    /deploy\/current/,
  );
  // ③ 无 pm2 时用 argv[1]（直接 node 启动）。
  assert.equal(
    resolveApp({}, join(release, "scripts/start.mjs")),
    join(release, "vendor/pi-web-ui"),
  );
  // ④ cwd 里有别的 checkout 也**不能**当答案（cwd 不是「正在跑的代码」）。
  assert.equal(resolveApp({}, other), null);
  // ⑤ 显式覆盖优先；配错就是 null（不猜别处）。
  const otherApp = join(other, "vendor/pi-web-ui");
  assert.equal(
    resolveApp(
      {
        JEV_GATE_APP: otherApp,
        pm_exec_path: join(release, "scripts/start.mjs"),
      },
      pm2Wrapper,
    ),
    otherApp,
  );
  assert.equal(resolveApp({ JEV_GATE_APP: "/nope" }, pm2Wrapper), null);
  rmSync(tmp, { recursive: true, force: true });
});

test("entry 选择 + CLI 失败分类：版本旧就明确要求「部署新版本」", () => {
  const tmp = mkdtempSync(join(tmpdir(), "jev-trim-entry-"));
  const app = join(tmp, "vendor/pi-web-ui");
  mkdirSync(join(app, "scripts"), { recursive: true });
  writeFileSync(join(app, "scripts/jev-gate.ts"), "// cli stub");
  // 旧代码：只有 jev-gate.ts → 用 `ask` 子命令兜底。
  assert.deepEqual(entryFor(app), {
    entry: join(app, "scripts/jev-gate.ts"),
    prefix: ["ask"],
  });
  // 新代码：有瘦入口 → 直接用它。
  writeFileSync(join(app, "scripts/jev-ask.ts"), "// slim stub");
  assert.deepEqual(entryFor(app), {
    entry: join(app, "scripts/jev-ask.ts"),
    prefix: [],
  });
  // 「未知命令」不是重试能解决的问题：报成 deploy-outdated（动作 = 部署新版本）。
  assert.match(classifyCliFailure(3, "未知命令: ask"), /^deploy-outdated:/);
  assert.match(classifyCliFailure(3, "未知命令: ask"), /部署新版本/);
  // 其它失败保留退出码与输出，便于定位。
  assert.equal(classifyCliFailure(7, "boom\n"), "cli-exit-7:boom");
  rmSync(tmp, { recursive: true, force: true });
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

/**
 * state 预算闸门：上游按 token 限流（state + 最长问题 ≤ 32k token），这里只能按字符保守收口。
 * @BUGFIX 回归：没有这道闸门时，大结果的 state 直接是整份输出 → 每次 HTTP 400 → 功能静默失效。
 */
test("state 预算：只把预算内的片段放进 state，超出的不判（不判=原样保留）", () => {
  const sections = Array.from({ length: 30 }, (_, i) => ({
    index: i,
    text: `片段 ${i} ` + "z".repeat(1_000),
    firstLine: `片段 ${i}`,
  }));
  const judged = budgetSections(sections, 5_000);
  assert.equal(judged.length, 4, "4 × ~1007 字进预算，第 5 段就越界了");
  assert.ok(
    judged.reduce((a, s) => a + s.text.length, 0) <= 5_000,
    "进 state 的总量不许超预算",
  );
  // 单个片段本身就超预算：跳过它（不截断后判，截断判整段是误删）
  const oneHuge = [{ index: 0, text: "h".repeat(9_000), firstLine: "h" }];
  assert.deepEqual(budgetSections(oneHuge, 5_000), []);
});

test("askKeep：超预算的片段不进 questions，返回 judged/dropped 供留痕", async () => {
  let seen = null;
  const runner = async ({ questions, state }) => {
    seen = { questions, state };
    return {
      ok: true,
      scores: Object.fromEntries(Object.keys(questions).map((id) => [id, 0.9])),
      audit: {},
    };
  };
  const sections = Array.from({ length: 10 }, (_, i) => ({
    index: i,
    text: `片段 ${i} ` + "z".repeat(2_000),
    firstLine: `片段 ${i}`,
  }));
  const res = await askKeep({
    objective: "只看配置读取",
    tool: "bash",
    sections,
    maxStateChars: 6_000,
    runner,
  });
  assert.equal(res.ok, true);
  assert.equal(res.judged.length, 2);
  assert.equal(res.dropped, 8);
  assert.equal(Object.keys(seen.questions).length, 2, "只问判得到的片段");
  assert.ok(
    JSON.stringify(seen.state).length <= 7_000,
    `state 必须留在预算内，实际 ${JSON.stringify(seen.state).length}`,
  );
  // 未判到的片段没有分数 → planTrim 必须整体保留它们
  const plan = planTrim({
    text: sections.map((s) => s.text).join("\n\n"),
    sections,
    scores: res.scores,
    keepAt: 0.5,
  });
  assert.equal(plan, null, "全判保留时不该改写");
});

test("askKeep：连一个片段都放不进预算时不发请求（宁可没省，不可白花一次）", async () => {
  let called = 0;
  const res = await askKeep({
    objective: "x",
    tool: "bash",
    sections: [{ index: 0, text: "y".repeat(50_000), firstLine: "y" }],
    maxStateChars: 20_000,
    runner: async () => {
      called += 1;
      return { ok: true, scores: {}, audit: {} };
    },
  });
  assert.equal(res.ok, false);
  assert.match(String(res.reason), /state-budget/);
  assert.equal(called, 0);
});
