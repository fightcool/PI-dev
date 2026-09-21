/* 🍞 AI Breadcrumb — @COUPLED index.ts, ask.mjs, trim.mjs, ../../docs/JEV-HARNESS-PLAN.md §3-P0
 * @WHY 配置全部走环境变量（宿主进程）：这个扩展在 **pi-web-ui 服务**里生效，服务不会读扩展自己的
 *   配置文件；环境变量是唯一「一处设、所有会话生效」的入口。
 * @CONTRACT 默认 `off`：不配就是零开销（只在 tool_result 里做一次字符串长度检查）。
 *   没量到收益之前不许默认开——省 token 的前提是别先弄坏行为。
 * @GOTCHA 这是 `.mjs`，宿主**直接执行、不转译**：不能写 TS 类型语法（写了运行时报错）。
 *   类型约束写在 JSDoc / `index.ts` 里。
 */

import { readFileSync, statSync } from "node:fs";

/** @typedef {"off" | "dry-run" | "on"} TrimMode */
/**
 * @typedef {object} TrimConfig
 * @property {TrimMode} mode
 * @property {number} minChars 小于这个字符数的工具结果不动手（别为小输出付一次网络往返）
 * @property {number} maxChars 大于这个字符数的结果放弃判定（state 太大会把成本与延迟一起推高）
 * @property {number} sectionChars 每个片段的目标字符数（片段是判断与保留的最小单位）
 * @property {number} maxSections 最多判多少片段（再多就均匀取样；未判到的片段原样保留）
 * @property {number} maxStateChars 进 state 的片段总字符上限（上游按 token 限流：state + 最长问题 ≤ 32k token）
 * @property {number} keepAt 保留阈值：片段得分 ≥ 它的才留下
 * @property {number} maxPerSession 一个会话最多裁几次（连续大输出时别把每轮都拖成秒级）
 * @property {number} cliTimeoutMs 单次 ask 的墙钟上限（含 CLI 冷启动）
 */

/**
 * 配置文件路径（**宿主进程的环境变量改不了**：pi-web-ui 服务一启动 env 就定了，改它要重启服务）。
 * 所以模式与参数也能从文件读：装好后改文件即可生效，不必重启、不必动服务配置。
 */
export function trimSettingsPath(agentDir) {
  return `${agentDir}/dev-con/jev-trim-settings.json`;
}

/** 文件配置缓存：按 mtime 失效（每次事件一次 statSync，比重复读文件便宜）。 */
let fileCache = { path: null, mtimeMs: -1, value: {} };

/**
 * 读配置文件；缺失/损坏/字段类型不对一律当空（**绝不抛**：配错不能让扩展崩，更不能影响工具结果）。
 * @param {string} agentDir
 * @returns {Partial<TrimConfig>}
 */
export function loadFileConfig(agentDir) {
  if (!agentDir) return {};
  const path = trimSettingsPath(agentDir);
  try {
    const stat = statSync(path);
    if (fileCache.path === path && fileCache.mtimeMs === stat.mtimeMs)
      return fileCache.value;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    /** @type {Partial<TrimConfig>} */
    const value = {};
    if (typeof parsed?.mode === "string") value.mode = parsed.mode;
    for (const key of [
      "minChars",
      "maxChars",
      "sectionChars",
      "maxSections",
      "maxStateChars",
      "keepAt",
      "maxPerSession",
      "cliTimeoutMs",
    ]) {
      if (typeof parsed?.[key] === "number" && Number.isFinite(parsed[key]))
        value[key] = parsed[key];
    }
    fileCache = { path, mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    fileCache = { path, mtimeMs: -1, value: {} };
    return {};
  }
}

/** @type {TrimConfig} */
const DEFAULTS = {
  mode: "off",
  minChars: 12_000,
  maxChars: 400_000,
  sectionChars: 1_500,
  maxSections: 24,
  maxStateChars: 20_000,
  keepAt: 0.5,
  maxPerSession: 3,
  cliTimeoutMs: 20_000,
};

const int = (raw, fallback, min, max) => {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

const float = (raw, fallback, min, max) => {
  const value = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

/**
 * 解析有效配置：**环境变量 > 配置文件 > 默认**。非法值一律回退下一级（绝不因为配错就让扩展崩掉）。
 * @WHY 环境变量优先是刻意的：它是「这一次进程」的显式覆盖（调试、CI），文件是「长期开关」。
 * @param {Record<string, string | undefined>} [env]
 * @param {Partial<TrimConfig>} [file] 来自 loadFileConfig()
 * @returns {TrimConfig}
 */
export function readTrimConfig(env = process.env, file = {}) {
  const rawMode = (env.JEV_TRIM ?? "").trim().toLowerCase();
  const fileMode =
    typeof file.mode === "string" ? file.mode.trim().toLowerCase() : "";
  const pickMode = rawMode || fileMode;
  /** @type {TrimMode} */
  const mode = pickMode === "on" || pickMode === "dry-run" ? pickMode : "off";
  const num = (envRaw, fileValue, fallback, min, max, kind = "int") =>
    kind === "float"
      ? float(envRaw ?? String(fileValue ?? ""), fallback, min, max)
      : int(envRaw ?? String(fileValue ?? ""), fallback, min, max);
  return {
    mode,
    minChars: num(
      env.JEV_TRIM_MIN_CHARS,
      file.minChars,
      DEFAULTS.minChars,
      1_000,
      500_000,
    ),
    maxChars: num(
      env.JEV_TRIM_MAX_CHARS,
      file.maxChars,
      DEFAULTS.maxChars,
      10_000,
      2_000_000,
    ),
    sectionChars: num(
      env.JEV_TRIM_SECTION_CHARS,
      file.sectionChars,
      DEFAULTS.sectionChars,
      200,
      8_000,
    ),
    maxSections: num(
      env.JEV_TRIM_MAX_SECTIONS,
      file.maxSections,
      DEFAULTS.maxSections,
      1,
      48,
    ),
    maxStateChars: num(
      env.JEV_TRIM_MAX_STATE_CHARS,
      file.maxStateChars,
      DEFAULTS.maxStateChars,
      4_000,
      40_000,
    ),
    keepAt: num(
      env.JEV_TRIM_KEEP_AT,
      file.keepAt,
      DEFAULTS.keepAt,
      0,
      1,
      "float",
    ),
    maxPerSession: num(
      env.JEV_TRIM_MAX_PER_SESSION,
      file.maxPerSession,
      DEFAULTS.maxPerSession,
      1,
      100,
    ),
    cliTimeoutMs: num(
      env.JEV_TRIM_CLI_TIMEOUT_MS,
      file.cliTimeoutMs,
      DEFAULTS.cliTimeoutMs,
      1_000,
      60_000,
    ),
  };
}
