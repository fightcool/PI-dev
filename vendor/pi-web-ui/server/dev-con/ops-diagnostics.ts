/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED system-resources.ts / storage-usage.ts（复用其快照）, ../protocol.ts
 *            （list_diagnostics / diagnostics 载荷）, ../agent-service.ts（组装并下发）
 *   📖 docs/DEV-CON-PROPOSAL.md §8 P4 候选「必要运维」
 *   @CONTRACT 诊断包只含**元数据**：版本/提交/路径/单位状态/资源与存储汇总量/渠道计数/用量汇总。
 *             绝不含密钥值、会话内容、提示词、日志正文或环境变量值 —— 由 buildDiagnostics 组装，
 *             并由单测用「合成密钥字符串不得出现在结果里」强约束。
 *   @WHY 运维排查最常见的问题是「你需要哪条信息」；把固定的一小撮元数据一次性给出，
 *        比让操作人去翻 systemctl / pm2 / 文件系统更快，也不会顺手泄露凭据。
 * ──────────────────────────────────────────────────
 */
import type { UiDiagnostics, UiResourceSnapshot, UiStorageSnapshot } from "../protocol.js";

/** 诊断包形状由 protocol.ts 定义（UiDiagnostics），本模块只负责组装。
 *  app.* = 当前运行进程；release.* = 磁盘上的 build-info（开发 checkout 可能过期，见字段注释）。 */
export type OpsDiagnostics = UiDiagnostics;

export interface DiagnosticsInput {
	now: number;
	app: OpsDiagnostics["app"];
	release: OpsDiagnostics["release"];
	instance: OpsDiagnostics["instance"];
	units: OpsDiagnostics["units"];
	resources: UiResourceSnapshot;
	storage: UiStorageSnapshot;
	channels: OpsDiagnostics["channels"];
	usage: OpsDiagnostics["usage"];
	environment: OpsDiagnostics["environment"];
	warnings?: string[];
}

/** 组装诊断包（纯函数；调用方负责提供各部分数据）。 */
export function buildDiagnostics(input: DiagnosticsInput): OpsDiagnostics {
	return {
		generatedAt: input.now,
		app: { ...input.app },
		release: { ...input.release },
		instance: { ...input.instance },
		units: input.units.map((u) => ({ ...u })),
		resources: input.resources,
		storage: input.storage,
		channels: { ...input.channels },
		usage: { ...input.usage, bySource: { ...input.usage.bySource }, byChannel: { ...input.usage.byChannel } },
		environment: { ...input.environment },
		warnings: [...(input.warnings ?? [])],
	};
}

/** 从用量聚合结果映射出诊断用的汇总（复用 §7 的聚合，不另算一套）。 */
export function usageSummaryOf(result: {
	totals: { requests: number; total: number; cost: number; unpricedRequests: number };
	rows: { key: string; requests: number }[];
	groupBy: string;
}): OpsDiagnostics["usage"] {
	const bySource: Record<string, number> = {};
	const byChannel: Record<string, number> = {};
	for (const row of result.rows) {
		if (result.groupBy === "source") bySource[row.key] = row.requests;
		if (result.groupBy === "channel") byChannel[row.key] = row.requests;
	}
	return {
		windowDays: 0,
		requests: result.totals.requests,
		totalTokens: result.totals.total,
		cost: result.totals.cost,
		unpricedRequests: result.totals.unpricedRequests,
		bySource,
		byChannel,
	};
}
