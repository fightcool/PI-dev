/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/system-resources.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §8 P4 候选「资源展示」
 * 覆盖：/proc 解析、CPU 增量、cgroup 语义（max=无上限）、磁盘估算、读不到时的诚实降级。
 */
import { describe, expect, it } from "vitest";
import {
	cpuPercentBetween,
	parseCgroupLimit,
	parseMeminfo,
	parseProcStat,
	collectResources,
} from "../../server/dev-con/system-resources.js";

const PROC_STAT = `cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
`;
const MEMINFO = `MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    2000000 kB
SwapTotal:       1000000 kB
SwapFree:         750000 kB
`;

describe("system resource parsing", () => {
	it("aggregates the /proc/stat cpu line and computes usage between samples", () => {
		const first = parseProcStat(PROC_STAT);
		expect(first).toEqual({ idle: 850, total: 1000 });
		// 第二次：总 jiffies 涨 100（1000 → 1100），idle+iowait 只涨 10（850 → 860）→ 使用率 90%
		const second = parseProcStat("cpu  170 0 70 810 50 0 0 0 0 0\n");
		expect(second).toEqual({ idle: 860, total: 1100 });
		expect(cpuPercentBetween(first, second)).toBeCloseTo(90, 1);
		// 再取一个「忙 100 / 总 160」的样本：使用率 62.5%（算式写出来，避免断言与实现一起错）
		const third = parseProcStat("cpu  180 0 70 860 50 0 0 0 0 0\n");
		expect(third).toEqual({ idle: 910, total: 1160 });
		expect(cpuPercentBetween(first, third)).toBeCloseTo(62.5, 1);
		expect(cpuPercentBetween(null, second)).toBeNull();
		expect(cpuPercentBetween(first, first)).toBeNull();
		expect(parseProcStat("garbage")).toBeNull();
	});

	it("reads meminfo in bytes and falls back to MemFree when MemAvailable is missing", () => {
		expect(parseMeminfo(MEMINFO)).toEqual({
			totalBytes: 8_000_000 * 1024,
			availableBytes: 2_000_000 * 1024,
			swapTotalBytes: 1_000_000 * 1024,
			swapFreeBytes: 750_000 * 1024,
		});
		expect(parseMeminfo("MemTotal: 1000 kB\nMemFree: 400 kB\n")?.availableBytes).toBe(400 * 1024);
		expect(parseMeminfo("nope")).toBeNull();
	});

	it("treats cgroup 'max' as no limit (null, never 0)", () => {
		expect(parseCgroupLimit("max")).toBeNull();
		expect(parseCgroupLimit("")).toBeNull();
		expect(parseCgroupLimit(null)).toBeNull();
		expect(parseCgroupLimit("4294967296")).toBe(4294967296);
		expect(parseCgroupLimit("garbage")).toBeNull();
	});

	it("collects a snapshot from injected io without touching the host", () => {
		const files: Record<string, string> = {
			"/proc/stat": "cpu  100 0 50 800 50 0 0 0 0 0\n",
			"/proc/meminfo": MEMINFO,
			"/proc/self/cgroup": "0::/user.slice/user-1000.slice/pi-dev-pm2.service\n",
			"/sys/fs/cgroup/user.slice/user-1000.slice/pi-dev-pm2.service/memory.current": "123456789",
			"/sys/fs/cgroup/user.slice/user-1000.slice/pi-dev-pm2.service/memory.max": "max",
			"/sys/fs/cgroup/user.slice/user-1000.slice/pi-dev-pm2.service/memory.high": "2147483648",
		};
		const snapshot = collectResources({
			disks: [{ path: "/data", label: "data" }, { path: "/missing", label: "missing" }],
			io: {
				readText: (p: string) => files[p] ?? null,
				statfs: (p: string) => (p === "/data" ? { blocks: 1000, bsize: 4096, bavail: 250 } : null),
				now: () => 1700000000000,
				pid: 4242,
				node: "v22.19.0",
				processUptimeSec: 3600,
				memory: { rss: 100 * 1024 ** 2, heapUsed: 50 * 1024 ** 2, heapTotal: 60 * 1024 ** 2, external: 5 * 1024 ** 2 },
			},
		});
		expect(snapshot.at).toBe(1700000000000);
		expect(snapshot.app).toMatchObject({ pid: 4242, rssBytes: 100 * 1024 ** 2, cgroup: { currentBytes: 123456789, maxBytes: null, highBytes: 2147483648 } });
		expect(snapshot.host.mem).toMatchObject({ totalBytes: 8_000_000 * 1024, usedBytes: 6_000_000 * 1024, swapUsedBytes: 250_000 * 1024 });
		expect(snapshot.disks).toHaveLength(1);
		expect(snapshot.disks[0]).toMatchObject({ label: "data", totalBytes: 1000 * 4096, freeBytes: 250 * 4096, usedPercent: 75 });
		expect(snapshot.sources).toMatchObject({ cpu: "proc-stat", mem: "proc-meminfo", cgroup: "cgroup-v2", disk: "statfs" });
		expect(snapshot.warnings.join(" ")).toContain("/missing");
	});

	it("degrades honestly when /proc is unavailable", () => {
		const snapshot = collectResources({
			disks: [],
			io: { readText: () => null, statfs: () => null, now: () => 1, pid: 1, node: "v0", processUptimeSec: 0, memory: { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 } },
		});
		expect(snapshot.host.cpuPercent).toBeNull();
		expect(snapshot.sources).toMatchObject({ cpu: "loadavg-only", mem: "os", cgroup: "unavailable" });
		expect(snapshot.app.cgroup).toEqual({ currentBytes: null, maxBytes: null, highBytes: null });
		expect(snapshot.warnings.length).toBeGreaterThan(0);
	});
});
