/**
 * PR 门禁的**判定映射**（纯函数）：把门禁 CLI 的输出翻成 job 该说什么、该用什么退出码。
 *
 * 背景（2026-09-20）：门禁接进编码路径后，跑了几小时真实调用 0 次 —— 因为没有触发点。
 * 补 CI 卡口时，最容易出错的地方就是**这层翻译**：把 block 说成通过、把「没跑成」说成绿色，
 * 都会让卡口变成装饰。所以这层被单独拆出来，用 tests/jev-gate-verdict.test.mjs 钉死。
 *
 * @COUPLED scripts/ci/jev-gate-pr.mjs（唯一调用方）, config/jev-settings.ci.json（阈值来源）,
 *   vendor/pi-web-ui/scripts/jev-gate.ts（退出码约定：check 0 通过 / 1 阻断 / 2 转人工 / 3 出错）
 * @CONTRACT 退出码：0 = 无 block（approve 或 review）；1 = block；3 = 没跑成（出错/解析失败）。
 *   **block 优先于一切**：即使 CLI 退出码说 0、只要 decision.outcome 是 block，也算 1。
 */

/** 门槛（用户 2026-09-20 定）：只有 block 拦。review（灰区）只提醒。 */
export const BLOCK_ONLY = true;

/**
 * 判定项生效阈值：优先取 perProposition 的独立阈值，缺一侧回落全局。
 * 只用于**展示**（判定的唯一事实源是门禁自己），所以这里不重算三态。
 */
export function thresholdOf(config, proposition) {
  const scoped = config?.thresholds?.perProposition?.[proposition];
  const approveAt =
    typeof scoped?.approveAt === "number"
      ? scoped.approveAt
      : config?.thresholds?.approveAt;
  const blockAt =
    typeof scoped?.blockAt === "number"
      ? scoped.blockAt
      : config?.thresholds?.blockAt;
  return { approveAt, blockAt, scoped: Boolean(scoped) };
}

/** 分数表（markdown 行）：每个判定项的分数与生效阈值。 */
export function describeChecks(decision, config) {
  const checks = decision?.checks ?? {};
  return Object.entries(checks).map(([name, score]) => {
    const t = thresholdOf(config, name);
    const scope = t.scoped ? "（独立阈值）" : "（全局）";
    return `- \`${name}\` = **${score}** — 放行 ≥ ${t.approveAt} / 阻断 ≤ ${t.blockAt}${scope}`;
  });
}

/**
 * 该不该跳过（以及为什么）。
 * @CONTRACT 跳过**不是通过**：调用方必须把它说成「没跑」，不能写成绿。
 *   没凭据（含 fork PR 拿不到 secret）与空 diff 是仅有的两种跳过。
 */
export function skipReason({ hasCredential, diffChars }) {
  if (!hasCredential) return "no-credential";
  if (!Number.isFinite(diffChars) || diffChars <= 0) return "empty-diff";
  return null;
}

export const SKIP_TEXT = {
  "no-credential": "SKIPPED: 没配凭据 —— 门禁这次没有运行（这不是通过）。",
  "empty-diff": "SKIPPED: 相对 base 没有 diff（空改动），没有可判的内容。",
};

/**
 * 把一次门禁调用的结果翻成结论。
 * @param {{decision?: object|null, status?: number|null}} input
 *   decision = CLI 的 `--json` 输出（JevDecision）；status = CLI 退出码（null = 超时/被杀）。
 * @returns {{kind: "approve"|"review"|"block"|"error", exitCode: number, error?: string}}
 */
export function verdictOf({ decision, status }) {
  if (!decision || typeof decision !== "object") {
    // 没有 JSON = 没跑成。CLI 退出码 3 也落在这里。
    return {
      kind: "error",
      exitCode: 3,
      error: `门禁没有给出可解析的判定（CLI 退出码 ${status ?? "null"}）`,
    };
  }
  if (decision.error) {
    return { kind: "error", exitCode: 3, error: String(decision.error) };
  }
  const outcome = decision.outcome;
  if (outcome === "block" || status === 1)
    return { kind: "block", exitCode: 1 };
  if (outcome === "review") return { kind: "review", exitCode: 0 };
  if (outcome === "approve") return { kind: "approve", exitCode: 0 };
  // 未知结论（协议新增了第四种？）→ 当出错，别当通过。
  return { kind: "error", exitCode: 3, error: `未知结论：${String(outcome)}` };
}
