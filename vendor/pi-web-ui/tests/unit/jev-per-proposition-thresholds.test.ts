/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-model.ts（resolvePropositionThresholds / decideOutcome）
 *            ../../server/dev-con/jev-settings.ts（mergeThresholds 的两层合并）
 *            ../../scripts/jev-gate.ts（config --proposition / --unset-proposition 的实际入口）
 * 📖 docs/JEV-DECISION-GATE.md §4.3（逐命题阈值的实测依据）
 * @WHY 这份测试钉的是「逐命题阈值」这个特性的**契约**：
 *   1. 没配独立阈值 → 行为与加本特性之前**逐字节一致**（老配置不会因为升级而变）；
 *   2. 配了 → 只有那个判定项用独立阈值，其它项仍走全局（不能一改全改）；
 *   3. 磁盘上的独立配置自相矛盾（blockAt >= approveAt）→ 回落全局（宁可退回已验证行为）；
 *   4. 保存路径只改一个判定项时**不能**把其它判定项的阈值抹掉。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type JevThresholds,
	JEV_MAX_PROPOSITION_THRESHOLDS,
	decideOutcome,
	resolvePropositionThresholds,
	validateJevGateConfig,
} from "../../server/dev-con/jev-model.js";
import {
	jevSettingsPath,
	loadJevSettings,
	mergeThresholds,
	saveJevSettings,
} from "../../server/dev-con/jev-settings.js";
import { JevGate } from "../../server/dev-con/jev-gate.js";
import { defaultJevGateConfig } from "../../server/dev-con/jev-model.js";

const dirs: string[] = [];
function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jev-per-prop-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GLOBAL: JevThresholds = { approveAt: 0.9, blockAt: 0.1 };

describe("resolvePropositionThresholds", () => {
	it("没有 perProposition 配置时返回全局值且标记 scoped=false", () => {
		expect(resolvePropositionThresholds("test_asserts_behavior", GLOBAL)).toEqual({
			approveAt: 0.9,
			blockAt: 0.1,
			scoped: false,
		});
	});

	it("只配 approveAt 时 blockAt 回落全局", () => {
		const t: JevThresholds = { ...GLOBAL, perProposition: { change_within_task_scope: { approveAt: 0.5 } } };
		expect(resolvePropositionThresholds("change_within_task_scope", t)).toEqual({
			approveAt: 0.5,
			blockAt: 0.1,
			scoped: true,
		});
	});

	it("只配 blockAt 时 approveAt 回落全局（实测 scope 的拦截侧就是 0.1）", () => {
		const t: JevThresholds = { ...GLOBAL, perProposition: { test_asserts_behavior: { blockAt: 0.15 } } };
		expect(resolvePropositionThresholds("test_asserts_behavior", t)).toEqual({
			approveAt: 0.9,
			blockAt: 0.15,
			scoped: true,
		});
	});

	it("未配置的判定项不受影响", () => {
		const t: JevThresholds = { ...GLOBAL, perProposition: { change_within_task_scope: { approveAt: 0.5 } } };
		expect(resolvePropositionThresholds("test_asserts_behavior", t).scoped).toBe(false);
	});

	it("独立配置自相矛盾（blockAt >= approveAt）时回落全局，不拿未验证的阈值放行", () => {
		const t: JevThresholds = {
			...GLOBAL,
			perProposition: { change_within_task_scope: { approveAt: 0.5, blockAt: 0.6 } },
		};
		expect(resolvePropositionThresholds("change_within_task_scope", t)).toEqual({
			approveAt: 0.9,
			blockAt: 0.1,
			scoped: false,
		});
	});
});

describe("decideOutcome（逐命题阈值）", () => {
	it("无 perProposition 时逐字节保持历史行为", () => {
		const d = decideOutcome({ test_asserts_behavior: 0.94 }, GLOBAL);
		expect(d.outcome).toBe("approve");
		expect(d.reason).toBe("全部判定项达到放行阈值（test_asserts_behavior=0.94；放行阈值 0.9）");
		const r = decideOutcome({ test_asserts_behavior: 0.5 }, GLOBAL);
		expect(r.reason).toBe("判定项未全部达到放行阈值（未达标：test_asserts_behavior=0.5；放行阈值 0.9）");
		const b = decideOutcome({ test_asserts_behavior: 0.1 }, GLOBAL);
		expect(b.reason).toBe("判定项触及拦截阈值（test_asserts_behavior=0.1；拦截阈值 0.1）");
	});

	it("实测取值：scope 0.50 就放行（全局 0.9 下这条会转人工）", () => {
		const t: JevThresholds = { ...GLOBAL, perProposition: { change_within_task_scope: { approveAt: 0.5 } } };
		expect(decideOutcome({ change_within_task_scope: 0.5 }, t).outcome).toBe("approve");
		expect(decideOutcome({ change_within_task_scope: 0.49 }, t).outcome).toBe("review");
	});

	it("混合调用：只有配了独立阈值的项用它，其余项仍按全局判", () => {
		const t: JevThresholds = { ...GLOBAL, perProposition: { change_within_task_scope: { approveAt: 0.5 } } };
		// scope 达标（0.55 >= 0.5），但 test 项没配独立阈值 → 0.8 < 全局 0.9 → 整体转人工。
		const d = decideOutcome({ change_within_task_scope: 0.55, test_asserts_behavior: 0.8 }, t);
		expect(d.outcome).toBe("review");
		expect(d.failed).toEqual(["test_asserts_behavior"]);
	});

	it("独立拦截阈值生效：0.12 在 scope 的 0.15 下被拦（全局 0.1 下只是转人工）", () => {
		const t: JevThresholds = { ...GLOBAL, perProposition: { change_within_task_scope: { blockAt: 0.15 } } };
		expect(decideOutcome({ change_within_task_scope: 0.12 }, GLOBAL).outcome).toBe("review");
		const d = decideOutcome({ change_within_task_scope: 0.12 }, t);
		expect(d.outcome).toBe("block");
		expect(d.reason).toContain("独立阈值 0.9/0.15");
	});

	it("理由里写出生效阈值（不能是黑盒）：逐项标注 + 全局值作参照", () => {
		const t: JevThresholds = { ...GLOBAL, perProposition: { change_within_task_scope: { approveAt: 0.5 } } };
		const d = decideOutcome({ change_within_task_scope: 0.4 }, t);
		expect(d.reason).toContain("change_within_task_scope=0.4（独立阈值 0.5/0.1）");
		expect(d.reason).toContain("放行阈值 0.9（全局）");
		expect(d.reasonEn).toContain("independent threshold");
	});

	it("NaN 仍然拦截（独立阈值不改变「拿不到分数不放行」）", () => {
		const t: JevThresholds = { ...GLOBAL, perProposition: { change_within_task_scope: { approveAt: 0.5 } } };
		expect(decideOutcome({ change_within_task_scope: Number.NaN }, t).outcome).toBe("block");
	});
});

describe("validateJevGateConfig（perProposition 校验）", () => {
	const base = { endpoint: "https://example.com/decide", model: "typesafe/jev-1.13" };

	it("接受合法配置并规范化：空条目被丢掉、只有 approveAt 的项保留单字段", () => {
		const r = validateJevGateConfig({
			...base,
			thresholds: {
				approveAt: 0.9,
				blockAt: 0.1,
				perProposition: { change_within_task_scope: { approveAt: 0.5 }, test_asserts_behavior: {} },
			},
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.config.thresholds.perProposition).toEqual({ change_within_task_scope: { approveAt: 0.5 } });
	});

	it("空 map 归一成 undefined（磁盘上不留『配了但什么都没配』的噪声）", () => {
		const r = validateJevGateConfig({ ...base, thresholds: { perProposition: {} } });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.config.thresholds.perProposition).toBeUndefined();
		expect("perProposition" in r.config.thresholds).toBe(false);
	});

	it("拒绝拼错的判定项名，并列出可用项", () => {
		const r = validateJevGateConfig({
			...base,
			thresholds: { perProposition: { change_within_scope: { approveAt: 0.5 } } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain("change_within_scope");
		expect(r.error).toContain("change_within_task_scope");
	});

	it("拒绝越界数值与非数字", () => {
		for (const bad of [{ approveAt: 1.5 }, { blockAt: -0.1 }, { approveAt: "0.5" }]) {
			const r = validateJevGateConfig({ ...base, thresholds: { perProposition: { change_within_task_scope: bad } } });
			expect(r.ok).toBe(false);
		}
	});

	it("拒绝生效后 blockAt >= approveAt 的组合（缺失侧按全局补齐）", () => {
		// blockAt 0.95 > 全局 approveAt 0.9 → 非法
		const r = validateJevGateConfig({
			...base,
			thresholds: { perProposition: { change_within_task_scope: { blockAt: 0.95 } } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain("change_within_task_scope");
	});

	it("拒绝过多条目（防止被塞成事实上的配置文件）", () => {
		const many: Record<string, unknown> = {};
		for (let i = 0; i <= JEV_MAX_PROPOSITION_THRESHOLDS; i++) many[`p${i}`] = { approveAt: 0.5 };
		const r = validateJevGateConfig({ ...base, thresholds: { perProposition: many } });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain("条目过多");
	});
});

describe("mergeThresholds（保存时的两层合并）", () => {
	const base = {
		approveAt: 0.9,
		blockAt: 0.1,
		perProposition: { change_within_task_scope: { approveAt: 0.5 }, test_asserts_behavior: { approveAt: 0.95 } },
	};

	it("只改一个判定项时其它项原样保留", () => {
		const merged = mergeThresholds(base, { perProposition: { change_within_task_scope: { approveAt: 0.55 } } });
		expect(merged.perProposition).toEqual({
			change_within_task_scope: { approveAt: 0.55 },
			test_asserts_behavior: { approveAt: 0.95 },
		});
	});

	it("只改某个项的 blockAt 时该项的 approveAt 不被丢掉", () => {
		const merged = mergeThresholds(base, { perProposition: { change_within_task_scope: { blockAt: 0.2 } } });
		expect(merged.perProposition).toEqual({
			change_within_task_scope: { approveAt: 0.5, blockAt: 0.2 },
			test_asserts_behavior: { approveAt: 0.95 },
		});
	});

	it("null 删除单个判定项；整块 null 清空", () => {
		expect(mergeThresholds(base, { perProposition: { test_asserts_behavior: null } }).perProposition).toEqual({
			change_within_task_scope: { approveAt: 0.5 },
		});
		expect("perProposition" in mergeThresholds(base, { perProposition: null })).toBe(false);
	});

	it("删到空时不留空 map", () => {
		const only = { approveAt: 0.9, blockAt: 0.1, perProposition: { change_within_task_scope: { approveAt: 0.5 } } };
		expect("perProposition" in mergeThresholds(only, { perProposition: { change_within_task_scope: null } })).toBe(
			false,
		);
	});

	it("没提到 perProposition 时保留磁盘上的值（缺省 ≠ 删除）", () => {
		expect(mergeThresholds(base, { approveAt: 0.8 }).perProposition).toEqual(base.perProposition);
	});
});

describe("磁盘往返（config --proposition 走的真实路径）", () => {
	it("保存一个判定项的阈值不影响另一个；再删掉它另一项仍在", () => {
		const dir = agentDir();
		const first = saveJevSettings(dir, {
			thresholds: {
				perProposition: {
					change_within_task_scope: { approveAt: 0.5 },
					test_asserts_behavior: { approveAt: 0.95 },
				},
			},
		});
		expect(first.ok).toBe(true);
		const second = saveJevSettings(dir, {
			thresholds: { perProposition: { change_within_task_scope: { approveAt: 0.55 } } },
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.config.thresholds.perProposition).toEqual({
			change_within_task_scope: { approveAt: 0.55 },
			test_asserts_behavior: { approveAt: 0.95 },
		});
		const third = saveJevSettings(dir, { thresholds: { perProposition: { change_within_task_scope: null } } });
		expect(third.ok).toBe(true);
		if (!third.ok) return;
		expect(third.config.thresholds.perProposition).toEqual({ test_asserts_behavior: { approveAt: 0.95 } });
		expect(loadJevSettings(dir).config.thresholds.perProposition).toEqual({
			test_asserts_behavior: { approveAt: 0.95 },
		});
	});

	it("落盘的 JSON 里真的有 perProposition（不是只在内存里）", () => {
		const dir = agentDir();
		saveJevSettings(dir, { thresholds: { perProposition: { change_within_task_scope: { approveAt: 0.5 } } } });
		const raw = JSON.parse(readFileSync(jevSettingsPath(dir), "utf8"));
		expect(raw.thresholds.perProposition).toEqual({ change_within_task_scope: { approveAt: 0.5 } });
	});
});

describe("JevGate.config() 的深副本契约", () => {
	it("外部改返回值的 perProposition 不会渗透进内部状态（嵌套对象不能浅拷）", () => {
		const gate = new JevGate({
			config: {
				...defaultJevGateConfig(),
				thresholds: { ...GLOBAL, perProposition: { change_within_task_scope: { approveAt: 0.5 } } },
			},
		});
		const first = gate.config();
		first.thresholds.perProposition!.change_within_task_scope.approveAt = 0.05;
		first.thresholds.perProposition!.injected = { approveAt: 0.01 };
		expect(gate.config().thresholds.perProposition).toEqual({ change_within_task_scope: { approveAt: 0.5 } });
	});
});

describe("CLI config --proposition（真实进程，无网络）", () => {
	// 每次 spawn 要冷启动 tsx（~2-4s），默认 5s 超时不够。
	const CLI_TIMEOUT = 30_000;
	const run = (dir: string, args: string[]): string =>
		execFileSync(process.execPath, ["--import", "tsx", "scripts/jev-gate.ts", "config", "--agent-dir", dir, ...args], {
			encoding: "utf8",
			cwd: join(__dirname, "..", ".."),
		});

	it(
		"设置 → 显示 → 删除，且不碰全局阈值与其它项",
		() => {
			const dir = agentDir();
			run(dir, ["--proposition", "change_within_task_scope", "--approve", "0.5", "--block", "0.1"]);
			const shown = run(dir, []);
			expect(shown).toContain("change_within_task_scope: 通过 >= 0.5  阻断 <= 0.1");
			expect(shown).toContain("阈值: 通过 >= 0.9  阻断 <= 0.1");
			run(dir, ["--unset-proposition", "change_within_task_scope"]);
			expect(loadJevSettings(dir).config.thresholds.perProposition).toBeUndefined();
		},
		CLI_TIMEOUT,
	);

	it(
		"互斥/缺参的用法错误直接失败，不静默写盘",
		() => {
			const dir = agentDir();
			expect(() =>
				run(dir, ["--proposition", "change_within_task_scope", "--unset-proposition", "x", "--approve", "0.5"]),
			).toThrow();
			expect(() => run(dir, ["--proposition", "change_within_task_scope"])).toThrow();
			expect(loadJevSettings(dir).config.thresholds.perProposition).toBeUndefined();
		},
		CLI_TIMEOUT,
	);
});
