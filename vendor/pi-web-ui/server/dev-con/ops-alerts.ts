/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED system-resources.ts（输入快照）, ../agent-service.ts（周期检查 + notice）, ../protocol.ts
 *   📖 docs/DEV-CON-PROPOSAL.md §8 P4 候选「更多监控」
 *   @CONTRACT 纯判定函数：输入一次资源快照 + 阈值 + 上次触发时间 → 该触发的告警列表；
 *             读不到的指标（cgroup 上限为 null、磁盘缺失）**不产生告警**，也不当成 0。
 *   @WHY 告警只给「已经越线」的事实 + 冷却窗口，不预测、不聚合历史；跨阈值只在冷却结束后
 *        重新提醒，避免把通知刷成噪声（运维通知一旦变吵就没人看了）。
 *   @MAGIC 默认阈值：磁盘/内存使用率 85% 警告、90% 严重；cgroup 用量/上限 85% 警告；
 *          冷却 60 分钟（可用 settings 覆盖冷却）。
 * ──────────────────────────────────────────────────
 */
import type { UiResourceSnapshot } from "../protocol.js";

export const ALERT_WARN_PERCENT = 85;
export const ALERT_CRITICAL_PERCENT = 90;
export const ALERT_COOLDOWN_MS = 60 * 60_000;

export type AlertId = "disk" | "memory" | "cgroup";

export interface OpsAlert {
	id: AlertId;
	level: "warn" | "critical";
	/** 稳定键：同一资源重复触发时用它做冷却去重。 */
	key: string;
	/** 触发时的实测值（百分比）与阈值，便于通知里直接说明。 */
	value: number;
	threshold: number;
}

export interface AlertInputs {
	resources: UiResourceSnapshot;
	/** 上次触发时间（ms），键为 OpsAlert.key；缺省视为从未触发。 */
	lastFired?: Record<string, number>;
	now?: number;
	cooldownMs?: number;
	warnPercent?: number;
	criticalPercent?: number;
}

function levelFor(value: number, warn: number, critical: number): OpsAlert["level"] | null {
	if (value >= critical) return "critical";
	if (value >= warn) return "warn";
	return null;
}

/** 判定本次应触发的告警（不修改输入）。 */
export function evaluateAlerts(input: AlertInputs): OpsAlert[] {
	const now = input.now ?? Date.now();
	const cooldown = input.cooldownMs ?? ALERT_COOLDOWN_MS;
	const warn = input.warnPercent ?? ALERT_WARN_PERCENT;
	const critical = input.criticalPercent ?? ALERT_CRITICAL_PERCENT;
	const lastFired = input.lastFired ?? {};
	const alerts: OpsAlert[] = [];

	const push = (alert: OpsAlert): void => {
		const last = lastFired[alert.key];
		if (typeof last === "number" && now - last < cooldown) return;
		alerts.push(alert);
	};

	for (const disk of input.resources.disks) {
		// 读不到的磁盘（missing）不告警：没有数据不等于满了。
		if (disk.totalBytes <= 0) continue;
		const level = levelFor(disk.usedPercent, warn, critical);
		if (level) push({ id: "disk", level, key: `disk:${disk.path}`, value: disk.usedPercent, threshold: level === "critical" ? critical : warn });
	}

	const mem = input.resources.host.mem;
	if (mem.totalBytes > 0) {
		const usedPercent = Math.round(((mem.totalBytes - mem.availableBytes) / mem.totalBytes) * 1000) / 10;
		const level = levelFor(usedPercent, warn, critical);
		if (level) push({ id: "memory", level, key: "memory", value: usedPercent, threshold: level === "critical" ? critical : warn });
	}

	// cgroup 上限为 null = 无上限：不做比例告警（分母未知，不能拿 0 当分母）。
	const cgroup = input.resources.app.cgroup;
	if (cgroup.currentBytes !== null && cgroup.maxBytes !== null && cgroup.maxBytes > 0) {
		const usedPercent = Math.round((cgroup.currentBytes / cgroup.maxBytes) * 1000) / 10;
		const level = levelFor(usedPercent, warn, critical);
		if (level) push({ id: "cgroup", level, key: "cgroup", value: usedPercent, threshold: level === "critical" ? critical : warn });
	}

	return alerts;
}

/** 记录本次触发时间（调用方在发出通知后调用）。 */
export function markFired(lastFired: Record<string, number>, alerts: OpsAlert[], now = Date.now()): Record<string, number> {
	const next = { ...lastFired };
	for (const alert of alerts) next[alert.key] = now;
	return next;
}
