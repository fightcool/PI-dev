/* 🍞 AI Breadcrumb — @COUPLED config.mjs, ask.mjs, sections.mjs, trim.mjs, stats.mjs, objective.mjs
 * 📖 ../../docs/JEV-HARNESS-PLAN.md §3-P0 —— 这是 P0 的落地点：`tool_result` 钩子。
 * @WHY 为什么挂 `tool_result` 而不是 `context`：**「不改写历史前缀」是硬约束**
 *   （docs/CONTEXT-POLICY.md §7：`pi-context-prune` 就是因为改写历史前缀被移除，前缀缓存一失效，
 *   省下的 token 会以数倍的价格还回去）。`tool_result` 只在结果**追加为消息那一刻**改写，
 *   不进历史前缀 —— 这是唯一安全的省钱位置。工具结果实测占我们 token 的 48.8%。
 * @CONTRACT 四条不许破的规矩：
 *   ① 默认 `off`：不配环境变量就完全不介入（连网络都不碰）；
 *   ② 任何失败/异常一律**原样放行**（返回 undefined），绝不「为了省 token 把内容弄丢」；
 *   ③ 只返回 `{content}`：`details` / `isError` / `usage` 一律不碰（改了会让 UI 与后续逻辑错乱）；
 *   ④ 每次改动都在文本里留可见标记 + 落一条统计（agent 必须能看出「这份结果被过滤过」）。
 * @GOTCHA 宿主按扩展**路径**缓存 factory：改本体必须换内容寻址目录名（安装器负责），否则新会话仍跑旧代码。
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { askKeep } from "./ask.mjs";
import { loadFileConfig, readTrimConfig, type TrimConfig } from "./config.mjs";
import { objectiveFromEntries } from "./objective.mjs";
import { splitSections } from "./sections.mjs";
import { appendTrimStat } from "./stats.mjs";
import { applyTrimmedText, planTrim, textParts } from "./trim.mjs";

/**
 * 每个事件都重新读环境与配置（不做模块级缓存）。
 * @WHY 配置在宿主里不会变，但**模块级捕获**会让测试无法在一个进程里验证多种模式（第二个用例会沿用
 *   第一个的 mode），也会让「改了环境变量要重启」变成隐藏约束。8 次 env 查找的代价可以忽略。
 */
function envAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? "";
}

/** 有效配置 = 环境变量 > 配置文件（`<agentDir>/dev-con/jev-trim-settings.json`）> 默认。 */
function effectiveConfig(): TrimConfig {
  const agentDir = envAgentDir();
  return readTrimConfig(process.env, agentDir ? loadFileConfig(agentDir) : {});
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning",
) {
  try {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
      return;
    }
  } catch {
    /* UI 失败不能影响主流程 */
  }
  console.warn(message);
}

interface TrimDeps {
  askKeep: typeof askKeep;
  now: () => number;
}

export default function jevTrim(
  pi: ExtensionAPI,
  deps: Partial<TrimDeps> = {},
) {
  const ask = deps.askKeep ?? askKeep;
  const now = deps.now ?? (() => Date.now());
  let used = 0;
  let failuresNotified = 0;

  const record = (fields: Record<string, unknown>) => {
    const agentDir = envAgentDir();
    if (!agentDir) return;
    appendTrimStat(agentDir, {
      at: new Date(now()).toISOString(),
      mode: effectiveConfig().mode,
      ...fields,
    });
  };

  pi.on("session_start", (_event, ctx) => {
    const cfg: TrimConfig = effectiveConfig();
    if (cfg.mode === "off") {
      console.warn(
        "[jev-trim] 未启用（设 JEV_TRIM=dry-run 先量收益，再设 on）",
      );
      return;
    }
    notify(
      ctx,
      `Jev 工具结果过滤已启用：mode=${cfg.mode}（≥${cfg.minChars} 字才动手，保留阈值 ${cfg.keepAt}，每会话最多 ${cfg.maxPerSession} 次）`,
      "info",
    );
  });

  pi.on("tool_result", async (event, ctx) => {
    const cfg: TrimConfig = effectiveConfig();
    if (cfg.mode === "off") return undefined;
    try {
      const text = textParts(event.content)
        .filter((part): part is { index: number; kind: string; text: string } =>
          Boolean(part),
        )
        .map((part) => part.text)
        .join("\n");
      const base = {
        tool: event.toolName,
        chars: text.length,
        toolCallId: event.toolCallId,
      };
      if (event.isError) {
        record({ ...base, skipped: "is-error" });
        return undefined;
      }
      if (text.length < cfg.minChars) {
        record({ ...base, skipped: "below-min-chars" });
        return undefined;
      }
      if (text.length > cfg.maxChars) {
        record({ ...base, skipped: "above-max-chars" });
        return undefined;
      }
      if (used >= cfg.maxPerSession) {
        record({ ...base, skipped: "session-cap" });
        return undefined;
      }
      const objective = objectiveFromEntries(ctx.sessionManager.getBranch());
      if (!objective) {
        record({ ...base, skipped: "no-objective" });
        return undefined;
      }
      const { sections, merged } = splitSections(text, cfg);
      if (sections.length < 2) {
        record({
          ...base,
          skipped: "single-section",
          sections: sections.length,
        });
        return undefined;
      }
      used += 1;
      const asked = await ask({
        objective,
        tool: event.toolName,
        sections,
        cwd: ctx.cwd,
        signal: ctx.signal,
        timeoutMs: cfg.cliTimeoutMs,
      });
      if (!asked.ok) {
        record({
          ...base,
          sections: sections.length,
          ok: false,
          reason: asked.reason,
          wallMs: asked.elapsedMs,
        });
        console.error(`[jev-trim] 判定失败，已原样放行：${asked.reason}`);
        if (failuresNotified === 0) {
          failuresNotified += 1;
          notify(
            ctx,
            `Jev 工具结果过滤失败（已原样放行，不影响结果）：${asked.reason}`,
            "warning",
          );
        }
        return undefined;
      }
      const plan = planTrim({
        text,
        sections,
        scores: asked.scores,
        keepAt: cfg.keepAt,
      });
      record({
        ...base,
        sections: sections.length,
        merged,
        ok: true,
        changed: Boolean(plan),
        kept: plan?.kept.length ?? sections.length,
        elided: plan?.elided.length ?? 0,
        unscored: plan?.unscored.length ?? 0,
        charsAfter: plan?.charsAfter ?? text.length,
        savedRatio: plan?.savedRatio ?? 0,
        wallMs: asked.elapsedMs,
        apiMs: asked.audit?.elapsedMs ?? null,
        cost: asked.audit?.cost ?? null,
        requestId: asked.audit?.requestId ?? null,
        cache: asked.audit?.cache ?? null,
      });
      if (!plan) return undefined;
      if (cfg.mode === "dry-run") return undefined;
      notify(
        ctx,
        `Jev 已过滤工具结果（${event.toolName}）：保留 ${plan.kept.length}/${sections.length} 段，` +
          `${plan.charsBefore} → ${plan.charsAfter} 字（省 ${Math.round(plan.savedRatio * 100)}%，${asked.elapsedMs}ms）`,
        "info",
      );
      return { content: applyTrimmedText(event.content, plan.text) };
    } catch (err) {
      // 扩展内部出任何问题都必须放行：不能因为一个「省 token 的优化」把工具结果弄坏。
      record({
        tool: event.toolName,
        toolCallId: event.toolCallId,
        ok: false,
        reason: "internal-error",
      });
      notify(
        ctx,
        `Jev 工具结果过滤内部错误（已原样放行）：${String((err as Error)?.message ?? err).slice(0, 200)}`,
        "warning",
      );
      return undefined;
    }
  });
}
