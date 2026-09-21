/* 🍞 AI Breadcrumb — @COUPLED ../../server/protocol.ts（set_settings 的字段清单）,
 *   ../../server/index.ts（逐字段转发到 ClientSession.setSettings）
 * 📖 docs/NEWAPI-GATEWAY.md §5（设置项的落位）
 * @WHY 这道守卫来自一次真实事故（2026-09-21）：新增 `hiddenModels` 时改了协议、客户端设置类型、
 *   设置服务与界面，**唯独漏了 index.ts 里那张逐字段转发表** —— 于是界面上的开关点了没反应：
 *   消息在分发层被静默丢掉，而 `as Record<string, unknown>` 的类型断言把 tsc 也蒙过去了。
 * @CONTRACT 「协议里出现的 set_settings 字段」必须在 index.ts 的转发里出现。这条不可能靠类型
 *   检查（那张表是动态形状），只能靠文本比对 —— 所以它是个可执行的约束，而不是靠人记得。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

/** protocol.ts 里 set_settings 消息的字段名（含注释掉的除外）。 */
function protocolFields(): string[] {
	const src = readFileSync(join(root, "server", "protocol.ts"), "utf8");
	const start = src.indexOf('type: "set_settings";');
	expect(start, "protocol.ts 里找不到 set_settings 消息").toBeGreaterThan(-1);
	const rest = src.slice(start);
	// 该消息对象以「一个 Tab + 缩进 + }」收尾（仓库里是 `\t  }`，历史缩进习惯）。
	const end = rest.split("\n").findIndex((l, i) => i > 0 && /^\t\s*\}$/.test(l));
	const block = rest
		.split("\n")
		.slice(0, end < 0 ? undefined : end)
		.join("\n");
	return [...block.matchAll(/^\t{3}([a-zA-Z][a-zA-Z0-9_]*)\??:/gm)].map((m) => m[1]);
}

/** index.ts 里 set_settings 分支实际转发给 setSettings 的字段名。 */
function forwardedFields(): Set<string> {
	const src = readFileSync(join(root, "server", "index.ts"), "utf8");
	const start = src.indexOf('case "set_settings"');
	expect(start, "index.ts 里找不到 set_settings 分支").toBeGreaterThan(-1);
	const block = src.slice(start, src.indexOf("\n\t\t\tcase ", start + 10));
	return new Set([...block.matchAll(/^\t{5}([a-zA-Z][a-zA-Z0-9_]*):\s*(?:msg|\(msg as)/gm)].map((m) => m[1]));
}

describe("set_settings 的字段必须转发到服务端", () => {
	it("协议里声明的每个字段都在 index.ts 的转发表里", () => {
		const fields = protocolFields();
		expect(fields.length, "解析到的字段太少，说明解析逻辑坏了").toBeGreaterThan(10);
		const forwarded = forwardedFields();
		const missing = fields.filter((f) => !forwarded.has(f));
		expect(missing, "这些字段在协议里有、却没被转发 → 界面上改了没反应（消息在分发层被静默丢掉）").toEqual([]);
	});

	it("转发表里没有协议里不存在的字段（防拼写错误/残留）", () => {
		const fields = new Set(protocolFields());
		const extra = [...forwardedFields()].filter((f) => !fields.has(f));
		expect(extra, "转发表里的字段在协议里找不到，可能是拼错了或已删除").toEqual([]);
	});
});
