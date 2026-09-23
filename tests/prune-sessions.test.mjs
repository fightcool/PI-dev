/* 🍞 AI Breadcrumb — @COUPLED scripts/maintenance/prune-sessions.mjs, docs/OPERATIONS.md「会话留存」
 * @CONTRACT 规格锁：
 *   ① 分类只看 mtime：超期归档/删除，24 小时内修改过的一律不动（活跃会话天然安全）；
 *   ② 默认 dry-run（CLI 冒烟钉住）；--apply 后归档文件可 gunzip 恢复原位；
 *   ③ 2GiB 安全上限：超量计划必须标记 overCap（CLI 拒绝执行需 --force）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, collectPlan, formatReport, applyPlan } from "../scripts/maintenance/prune-sessions.mjs";

const DAY = 86_400_000;
const file = (path, daysAgo, sizeBytes = 1024) => ({ path, mtimeMs: Date.now() - daysAgo * DAY, sizeBytes });

test("collectPlan：超期会话归档、过期归档/subagent 删除、bak 只留最新一份", () => {
	const plan = collectPlan({
		nowMs: Date.now(),
		sessionFiles: [file("old.jsonl", 100), file("new.jsonl", 10)],
		archiveFiles: [file("old.jsonl.gz", 200), file("recent.jsonl.gz", 100)],
		subagentFiles: [file("c1/run1.json", 40), file("c1/run2.json", 3)],
		usageBakFiles: [
			// mtime 与文件名时间戳一致：09-18 的更旧（9 天前）、09-20 的更新（5 天前）
			file("usage-history.jsonl.bak-2026-09-18T03-10-52-427Z", 9),
			file("usage-history.jsonl.bak-2026-09-20T09-21-31-627Z", 5),
		],
	});
	assert.deepEqual(plan.archive.map((f) => f.path), ["old.jsonl"]);
	assert.deepEqual(plan.deleteArchives.map((f) => f.path), ["old.jsonl.gz"]);
	assert.deepEqual(plan.deleteSubagent.map((f) => f.path), ["c1/run1.json"]);
	// 保留最新一份 bak（09-18 的更早，被删；09-20 的保留）
	assert.deepEqual(plan.deleteBaks.map((f) => f.path), ["usage-history.jsonl.bak-2026-09-18T03-10-52-427Z"]);
});

test("collectPlan：24 小时内修改过的文件一律不动（即使天数阈值已到）", () => {
	const plan = collectPlan({
		nowMs: Date.now(),
		opts: { sessionDays: 0, subagentDays: 0 },
		sessionFiles: [file("active.jsonl", 0.5)],
		subagentFiles: [file("c1/run-now.json", 0.1)],
	});
	assert.equal(plan.archive.length, 0);
	assert.equal(plan.deleteSubagent.length, 0);
});

test("collectPlan：影响总量超 2GiB 时标记 overCap", () => {
	const plan = collectPlan({
		nowMs: Date.now(),
		opts: { sessionDays: 1 },
		sessionFiles: [file("huge.jsonl", 30, 3 * 1024 ** 3)],
	});
	assert.equal(plan.overCap, true);
	assert.equal(plan.totalBytes, 3 * 1024 ** 3);
});

test("applyPlan：gzip 归档保留相对路径、原文件删除、可 gunzip 还原；重复执行幂等", async () => {
	const dir = mkdtempSync(join(tmpdir(), "prune-sessions-"));
	const sessionsDir = join(dir, "sessions", "--home-dev-PI-dev--");
	mkdirSync(sessionsDir, { recursive: true });
	const sessionPath = join(sessionsDir, "2026-01-01T00-00-00Z_abc.jsonl");
	const original = JSON.stringify({ v: 1, messages: ["hello", "world"] }) + "\n";
	writeFileSync(sessionPath, original);
	utimesSync(sessionPath, new Date(Date.now() - 100 * DAY), new Date(Date.now() - 100 * DAY));
	mkdirSync(join(dir, "web", "subagent-archive", "c1"), { recursive: true });
	writeFileSync(join(dir, "web", "subagent-archive", "c1", "run1.json"), "{}");
	utimesSync(join(dir, "web", "subagent-archive", "c1", "run1.json"), new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY));

	const plan = collectPlan({
		nowMs: Date.now(),
		sessionFiles: [{ path: "--home-dev-PI-dev--/2026-01-01T00-00-00Z_abc.jsonl", mtimeMs: Date.now() - 100 * DAY, sizeBytes: 40 }],
		subagentFiles: [{ path: "c1/run1.json", mtimeMs: Date.now() - 40 * DAY, sizeBytes: 2 }],
	});
	const first = await applyPlan(dir, plan);
	assert.equal(first.archived, 1);
	assert.equal(first.deleted, 1);
	assert.equal(existsSync(sessionPath), false);
	const gz = join(dir, "sessions-archive", "--home-dev-PI-dev--", "2026-01-01T00-00-00Z_abc.jsonl.gz");
	assert.equal(existsSync(gz), true);
	// 恢复口径：gunzip 后逐字节等于原文件（文档承诺「恢复 = gunzip 回原位」）
	assert.equal(gunzipSync(readFileSync(gz)).toString(), original);
	assert.equal(existsSync(join(dir, "web", "subagent-archive", "c1", "run1.json")), false);

	// 幂等：同一计划重跑不再动任何文件（归档源已不在、删除目标已不在 → 各跳过一次）
	const second = await applyPlan(dir, plan);
	assert.equal(second.archived, 0);
	assert.equal(second.deleted, 0);
	assert.equal(second.skipped, 2);
	// 归档已存在但源文件又出现（例如手工恢复一半）：跳过而不是覆盖已有归档
	writeFileSync(sessionPath, original);
	const third = await applyPlan(dir, plan);
	assert.equal(third.archived, 0);
	assert.equal(third.skipped, 2); // 归档不覆盖 + 已删的 subagent 目标
	assert.equal(gunzipSync(readFileSync(gz)).toString(), original, "已有归档未被覆盖");
	rmSync(sessionPath);
});

test("CLI 冒烟：默认 dry-run 只打印计划、不动盘", () => {
	const dir = mkdtempSync(join(tmpdir(), "prune-sessions-cli-"));
	rmSync(dir, { recursive: true, force: true }); // 用完即删放 finally 语义：测试体短，直接收尾清理
	const sessionsDir = join(dir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(join(sessionsDir, "old.jsonl"), "{}");
	utimesSync(join(sessionsDir, "old.jsonl"), new Date(Date.now() - 100 * DAY), new Date(Date.now() - 100 * DAY));
	try {
		const out = spawnSync(
			process.execPath,
			[join(process.cwd(), "scripts/maintenance/prune-sessions.mjs"), `--agent-dir=${dir}`],
			{ encoding: "utf8" },
		);
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stdout, /dry-run：未动任何文件/);
		assert.match(out.stdout, /归档会话.*1 个/);
		assert.equal(existsSync(join(sessionsDir, "old.jsonl")), true, "dry-run 不得动盘");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
