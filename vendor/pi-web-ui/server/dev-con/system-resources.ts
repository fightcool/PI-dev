/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED ../protocol.ts（list_resources / resources 载荷）, ../index.ts（dispatch）,
 *            web/src/components/SystemResources.tsx（界面）, use-chat.ts（状态与查询）
 *   📖 docs/DEV-CON-PROPOSAL.md §8 P4 候选「资源展示」
 *   @CONTRACT 只读采集，不写任何文件、不改配置；读不到的字段返回 null 并在 warnings/sources
 *             里说明来源，界面不得把估算值当精确值展示（§7 同样的诚实性要求）。
 *   @WHY 采集逻辑与解析逻辑分离：解析函数是纯函数（可用固定 /proc 文本做单测），
 *        采集函数把 io 作为参数注入（测试不依赖宿主机的真实负载）。
 *   @GOTCHA CPU 使用率需要两次采样：模块内保留上一次的 /proc/stat 聚合值，**首次调用返回 null**
 *           （界面显示「采样中」而不是伪造一个数字）。
 *   @ASSUME 目标平台是 Linux（/proc、/sys/fs/cgroup、statfs 可用）；非 Linux 上降级为
 *           os.* 能提供的信息并写 warning。
 *   @MAGIC DISK_WARN_PERCENT=85：仅用于界面高亮，不影响采集。
 * ──────────────────────────────────────────────────
 */
import { readFileSync, statfsSync } from "node:fs";
import type { UiResourceDisk, UiResourceSnapshot } from "../protocol.js";
import { cpus, hostname, loadavg, platform, totalmem, freemem, uptime } from "node:os";

/** 用于界面高亮的阈值（不影响采集口径）。 */
export const DISK_WARN_PERCENT = 85;

export interface CpuSample {
	/** /proc/stat 首行（cpu 汇总）的累计 jiffies。 */
	idle: number;
	total: number;
}

/** 磁盘行（形状由协议定义，避免双端漂移）。 */
export type DiskUsage = UiResourceDisk;

/** 快照形状由 protocol.ts 定义（UiResourceSnapshot），本模块只负责采集。 */
export type ResourceSnapshot = UiResourceSnapshot;

/** /proc/stat 的 cpu 汇总行 → 累计 idle / total jiffies。 */
export function parseProcStat(text: string): CpuSample | null {
	const line = text.split("\n").find((l) => l.startsWith("cpu "));
	if (!line) return null;
	const values = line.trim().split(/\s+/).slice(1).map(Number);
	if (values.length < 5 || values.some((v) => !Number.isFinite(v))) return null;
	// user nice system idle iowait irq softirq steal guest guest_nice
	const [user, nice, system, idle, iowait, irq = 0, softirq = 0, steal = 0] = values;
	const idleAll = idle + iowait;
	const total = user + nice + system + idleAll + irq + softirq + steal;
	return { idle: idleAll, total };
}

/** 两次采样的使用率（0–100，保留一位小数）；无增量时返回 null。 */
export function cpuPercentBetween(prev: CpuSample | null, next: CpuSample | null): number | null {
	if (!prev || !next) return null;
	const totalDelta = next.total - prev.total;
	const idleDelta = next.idle - prev.idle;
	if (totalDelta <= 0) return null;
	const percent = (1 - idleDelta / totalDelta) * 100;
	return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

/** /proc/meminfo → 字节数。 */
export function parseMeminfo(text: string): {
	totalBytes: number;
	availableBytes: number;
	swapTotalBytes: number;
	swapFreeBytes: number;
} | null {
	const pick = (key: string): number | null => {
		const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB$`, "m"));
		return match ? Number(match[1]) * 1024 : null;
	};
	const total = pick("MemTotal");
	if (total === null) return null;
	return {
		totalBytes: total,
		availableBytes: pick("MemAvailable") ?? pick("MemFree") ?? 0,
		swapTotalBytes: pick("SwapTotal") ?? 0,
		swapFreeBytes: pick("SwapFree") ?? 0,
	};
}

/** cgroup v2 memory 文件 → 字节；`max` 表示无上限（返回 null，不是 0）。 */
export function parseCgroupLimit(value: string | null): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "max") return null;
	const n = Number(trimmed);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

interface CollectIo {
	readText: (path: string) => string | null;
	statfs: (path: string) => { blocks: number; bsize: number; bavail: number } | null;
	now: () => number;
	pid: number;
	node: string;
	processUptimeSec: number;
	memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
}

function defaultIo(): CollectIo {
	return {
		readText: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		statfs: (path) => {
			try {
				const s = statfsSync(path);
				return { blocks: Number(s.blocks), bsize: Number(s.bsize), bavail: Number(s.bavail) };
			} catch {
				return null;
			}
		},
		now: () => Date.now(),
		pid: process.pid,
		node: process.version,
		processUptimeSec: Math.round(process.uptime()),
		memory: (() => {
			const m = process.memoryUsage();
			return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
		})(),
	};
}

let lastCpuSample: CpuSample | null = null;

/**
 * 采集一次资源快照。磁盘路径由调用方给出（本模块不认识项目的目录约定）。
 * 测试可注入 io（不依赖宿主机真实负载与文件系统）。
 */
export function collectResources(
	options: { disks: { path: string; label: string }[]; io?: Partial<CollectIo> },
): ResourceSnapshot {
	const io: CollectIo = { ...defaultIo(), ...options.io };
	const warnings: string[] = [];

	const statSample = (() => {
		const text = io.readText("/proc/stat");
		return text ? parseProcStat(text) : null;
	})();
	const cpuPercent = cpuPercentBetween(lastCpuSample, statSample);
	if (statSample) lastCpuSample = statSample;
	const cpuSource = statSample ? "proc-stat" : "loadavg-only";
	if (!statSample && platform() === "linux") warnings.push("/proc/stat 不可读，CPU 使用率不可用（仅负载）");

	const meminfo = (() => {
		const text = io.readText("/proc/meminfo");
		return text ? parseMeminfo(text) : null;
	})();
	const totalBytes = totalmem();
	const mem = meminfo
		? {
				totalBytes: meminfo.totalBytes,
				availableBytes: meminfo.availableBytes,
				usedBytes: Math.max(0, meminfo.totalBytes - meminfo.availableBytes),
				swapTotalBytes: meminfo.swapTotalBytes,
				swapUsedBytes: Math.max(0, meminfo.swapTotalBytes - meminfo.swapFreeBytes),
			}
		: {
				totalBytes,
				availableBytes: freemem(),
				usedBytes: Math.max(0, totalBytes - freemem()),
				swapTotalBytes: 0,
				swapUsedBytes: 0,
			};
	const memSource = meminfo ? "proc-meminfo" : "os";
	if (!meminfo) warnings.push("/proc/meminfo 不可读，内存改用 os.freemem（无 swap 信息）");

	// cgroup v2：读 /proc/self/cgroup 的路径，再读该路径下的 memory.*（systemd unit 限制）。
	const cgroupFiles = (() => {
		const group = io.readText("/proc/self/cgroup");
		const path = group?.split("\n").find((l) => l.startsWith("0::"))?.slice(3).trim();
		if (!path) return null;
		const dir = `/sys/fs/cgroup${path}`;
		return {
			current: parseCgroupLimit(io.readText(`${dir}/memory.current`)),
			max: parseCgroupLimit(io.readText(`${dir}/memory.max`)),
			high: parseCgroupLimit(io.readText(`${dir}/memory.high`)),
		};
	})();
	const cgroup = {
		currentBytes: cgroupFiles?.current ?? null,
		maxBytes: cgroupFiles?.max ?? null,
		highBytes: cgroupFiles?.high ?? null,
	};
	if (!cgroupFiles) warnings.push("cgroup v2 内存限制不可读（当前进程可能不在 systemd unit 下）");

	const disks: DiskUsage[] = [];
	for (const entry of options.disks) {
		const fs = io.statfs(entry.path);
		if (!fs || !fs.blocks || !fs.bsize) {
			warnings.push(`磁盘 ${entry.path} 不可读`);
			continue;
		}
		const total = fs.blocks * fs.bsize;
		// bavail = 非特权用户可用块；used 用「总量 - 可用」估算（不含保留块，界面上标注为估算）。
		const free = fs.bavail * fs.bsize;
		const used = Math.max(0, total - free);
		disks.push({
			path: entry.path,
			label: entry.label,
			totalBytes: total,
			freeBytes: free,
			usedBytes: used,
			usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
		});
	}

	return {
		at: io.now(),
		host: {
			hostname: hostname(),
			platform: platform(),
			uptimeSec: Math.round(uptime()),
			cpuCount: cpus().length,
			loadAvg: loadavg() as [number, number, number],
			cpuPercent,
			mem,
		},
		app: {
			pid: io.pid,
			node: io.node,
			uptimeSec: io.processUptimeSec,
			rssBytes: io.memory.rss,
			heapUsedBytes: io.memory.heapUsed,
			heapTotalBytes: io.memory.heapTotal,
			externalBytes: io.memory.external,
			cgroup,
		},
		disks,
		sources: { cpu: cpuSource, mem: memSource, disk: "statfs", cgroup: cgroupFiles ? "cgroup-v2" : "unavailable" },
		warnings,
	};
}
