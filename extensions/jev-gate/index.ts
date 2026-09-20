/* 🍞 AI Breadcrumb — @COUPLED gate.mjs, ../../docs/JEV-HOOK.md
 * @CONTRACT tool_call errors in Pi block by default, so this hook catches all failures.
 * Notifications are non-blocking; no confirm dialog and no requirement for review approval.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGate } from "./gate.mjs";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning") {
  try {
    if (ctx.hasUI) { ctx.ui.notify(message, level); return; }
  } catch { /* UI failure must not turn a fail-open gate into a block. */ }
  console.warn(message);
}

export default function jevCommitGate(pi: ExtensionAPI) {
  const gate = createGate();
  pi.on("session_start", (_event, ctx) => {
    notify(ctx, process.env.JEV_GATE_HOOK === "off"
      ? "Jev 提交钩子已关闭（JEV_GATE_HOOK=off）"
      : "Jev 提交钩子已启用：仅 block 拦截；review 与故障告警放行。", "info");
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      return await gate(event, ctx, (message: string, level: "info" | "warning") => notify(ctx, message, level));
    } catch {
      notify(ctx, "Jev 提交钩子内部失败，未完成判定；本次放行（原始错误已隐藏）。", "warning");
      return undefined;
    }
  });
}
