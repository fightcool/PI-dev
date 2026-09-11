/* 🍞 AI Breadcrumb — @COUPLED web/src/use-chat.ts（listResources / state.resources）,
 *   web/src/components/SettingsModal.tsx（系统分组内嵌本组件）, server/dev-con/system-resources.ts（采集口径）
 * 📖 docs/DEV-CON-PROPOSAL.md §8 P4 候选「资源展示」
 * @CONTRACT 只读展示快照：读不到的字段显示「—」（不是 0），并显示来源标签与告警；
 *   应用 RSS（本进程）与 cgroup（systemd unit，含 supervisor）分开标注，不混成一个数字。
 */
import { memo, useEffect, useState } from "react";
import { useT } from "../i18n";
import type { UiResourceSnapshot } from "../types";

const DISK_WARN_PERCENT = 85;

const bytes = (n: number | null | undefined): string => {
	if (n === null || n === undefined || !Number.isFinite(n)) return "—";
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
	if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
	return `${n} B`;
};
const percent = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : `${n.toFixed(1)}%`);
const duration = (sec: number): string => {
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const SystemResources = memo(function SystemResources({
	snapshot,
	onRefresh,
}: {
	snapshot: UiResourceSnapshot | null;
	onRefresh: () => void;
}) {
	const t = useT();
	const [tick, setTick] = useState(0);
	// 面板打开期间每 5 秒刷新一次（服务端无后台采样，刷新即一次只读采集）。
	useEffect(() => {
		const timer = setInterval(() => setTick((v) => v + 1), 5000);
		return () => clearInterval(timer);
	}, []);
	useEffect(() => {
		onRefresh();
	}, [tick, onRefresh]);

	if (!snapshot) return <p className="set-hint">{t("resourcesLoading")}</p>;
	const { host, app, disks } = snapshot;
	const memUsedPercent = host.mem.totalBytes > 0 ? Math.round((host.mem.usedBytes / host.mem.totalBytes) * 1000) / 10 : 0;

	return (
		<div className="resources">
			<div className="resources-cards">
				<div className="resource-card">
					<div className="resource-title">{t("resourcesCpu")}</div>
					<div className="resource-value">
						{host.cpuPercent === null ? t("resourcesSampling") : percent(host.cpuPercent)}
					</div>
					<div className="resource-meta">
						{t("resourcesCores", { n: host.cpuCount })} · load {host.loadAvg.map((v) => v.toFixed(2)).join(" / ")}
					</div>
					<div className="resource-source">{t("resourcesSourceCpu", { src: snapshot.sources.cpu })}</div>
				</div>
				<div className="resource-card">
					<div className="resource-title">{t("resourcesMem")}</div>
					<div className="resource-value">{percent(memUsedPercent)}</div>
					<div className="resource-bar">
						<span style={{ width: `${Math.min(100, memUsedPercent)}%` }} />
					</div>
					<div className="resource-meta">
						{bytes(host.mem.usedBytes)} / {bytes(host.mem.totalBytes)} · {t("resourcesAvailable", { v: bytes(host.mem.availableBytes) })}
						{host.mem.swapTotalBytes > 0 && ` · swap ${bytes(host.mem.swapUsedBytes)} / ${bytes(host.mem.swapTotalBytes)}`}
					</div>
					<div className="resource-source">{t("resourcesSourceMem", { src: snapshot.sources.mem })}</div>
				</div>
				<div className="resource-card">
					<div className="resource-title">{t("resourcesApp")}</div>
					<div className="resource-value">{bytes(app.rssBytes)}</div>
					<div className="resource-meta">
						PID {app.pid} · {app.node} · {t("resourcesUptime", { v: duration(app.uptimeSec) })}
					</div>
					<div className="resource-meta">
						{t("resourcesHeap", { used: bytes(app.heapUsedBytes), total: bytes(app.heapTotalBytes) })}
					</div>
					<div className="resource-meta">
						{/* cgroup 是 systemd unit（含 PM2 supervisor 与子进程），与上面的进程 RSS 不是同一口径。 */}
						{app.cgroup.currentBytes === null
							? t("resourcesCgroupUnavailable")
							: t("resourcesCgroup", { current: bytes(app.cgroup.currentBytes), max: app.cgroup.maxBytes === null ? t("resourcesNoLimit") : bytes(app.cgroup.maxBytes) })}
					</div>
					<div className="resource-source">{t("resourcesSourceCgroup", { src: snapshot.sources.cgroup })}</div>
				</div>
				<div className="resource-card">
					<div className="resource-title">{t("resourcesHost")}</div>
					<div className="resource-value">{host.hostname}</div>
					<div className="resource-meta">
						{host.platform} · {t("resourcesUptime", { v: duration(host.uptimeSec) })}
					</div>
					<div className="resource-source">{t("resourcesSampledAt", { at: new Date(snapshot.at).toLocaleTimeString() })}</div>
				</div>
			</div>

			<div className="resources-disks">
				<div className="resource-title">{t("resourcesDisks")}</div>
				{disks.length === 0 && <p className="set-hint">{t("resourcesNoDisks")}</p>}
				{disks.map((disk) => (
					<div key={disk.path} className="resource-disk">
						<div className="resource-disk-head">
							<span className="resource-disk-label">{disk.label}</span>
							<span className={`resource-disk-percent${disk.usedPercent >= DISK_WARN_PERCENT ? " warn" : ""}`}>{percent(disk.usedPercent)}</span>
						</div>
						<div className="resource-bar">
							<span className={disk.usedPercent >= DISK_WARN_PERCENT ? "warn" : ""} style={{ width: `${Math.min(100, disk.usedPercent)}%` }} />
						</div>
						<div className="resource-meta" title={disk.path}>
							{bytes(disk.usedBytes)} / {bytes(disk.totalBytes)} · {t("resourcesFree", { v: bytes(disk.freeBytes) })}
						</div>
					</div>
				))}
				<div className="resource-source">{t("resourcesDiskNote", { src: snapshot.sources.disk })}</div>
			</div>

			{snapshot.warnings.length > 0 && (
				<div className="resources-warnings">
					{snapshot.warnings.map((w) => (
						<div key={w} className="chan-warn">
							{w}
						</div>
					))}
				</div>
			)}
			<div className="resources-actions">
				<button type="button" className="chan-btn" onClick={onRefresh}>
					{t("channelRefresh")}
				</button>
			</div>
		</div>
	);
});
