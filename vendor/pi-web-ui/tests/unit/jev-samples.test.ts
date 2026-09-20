/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/jev-samples.ts
 * 📖 docs/JEV-DECISION-GATE.md §8（可观测性）/ §4.4（复盘回路）
 * @WHY 这块是**唯一会落盘被审内容**的地方，所以它的测试重点不是“能存”，而是三条约束：
 *   ① 超长截断但如实记录原文长度；② 密钥**形状**的 token 被抹掉（且不会因为 diff 里
 *   出现 `token` 这种键名就整条不落盘 —— 那正是我第一版的 bug）；③ 轮转/清空/损坏行都不抛。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	JEV_SAMPLES_MAX_BYTES,
	JEV_SAMPLE_STATE_MAX_CHARS,
	appendJevSample,
	captureJevSample,
	clearJevSamples,
	jevSamplesPath,
	jevSamplesPreviousPath,
	jevSamplesStats,
	loadJevReviewAck,
	loadJevSamples,
	normalizeJevSampleEntry,
	redactSecretTokens,
	saveJevReviewAck,
} from "../../server/dev-con/jev-samples.js";

/** 合成密钥（运行时拼接，避免被发布检查当成真实密钥字面量）。 */
const SYNTHETIC_KEY = ["sk", "or", "v1", "TESTONLY0123456789abcdef"].join("-");

const dirs: string[] = [];
function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jev-samples-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = {
	at: 1_700_000_000_000,
	propositions: ["change_within_task_scope"],
	checks: { change_within_task_scope: 0.56 },
	outcome: "approve" as const,
	reason: "全部判定项达到放行阈值",
	reasonEn: "All checks reached the approve threshold",
	source: "tool" as const,
	model: "typesafe/jev-1.13",
	stateHash: "abc123",
};

describe("redactSecretTokens", () => {
	it("抹掉密钥形状的 token，返回命中数", () => {
		const { text, hits } = redactSecretTokens(`apiKey = "${SYNTHETIC_KEY}"`);
		expect(hits).toBe(1);
		expect(text).not.toContain(SYNTHETIC_KEY);
		expect(text).toContain("«redacted»");
	});

	it("抹掉 ≥32 位的不透明串（hex/base64/JWT）", () => {
		const opaque = "a".repeat(48);
		const { text, hits } = redactSecretTokens(`digest=${opaque}`);
		expect(hits).toBe(1);
		expect(text).not.toContain(opaque);
	});

	it("普通文本原样保留（不因为出现 token/secret 这类**键名**就误杀）", () => {
		const src = "-const token = req.headers.authorization;\n+const nextToken = refresh(token);";
		const { text, hits } = redactSecretTokens(src);
		expect(hits).toBe(0);
		expect(text).toBe(src);
	});

	it("占位符不误杀（{apiKey} 是模板，不是密钥）", () => {
		const { hits } = redactSecretTokens('headers: { Authorization: "Bearer {apiKey}" }');
		expect(hits).toBe(0);
	});
});

describe("captureJevSample", () => {
	it("记录被审内容并如实保留原文长度", () => {
		const entry = captureJevSample({ ...BASE, state: "-a\n+b" });
		expect(entry.state).toBe("-a\n+b");
		expect(entry.stateChars).toBe(5);
		expect(entry.stateRedacted).toBeUndefined();
		expect(entry.v).toBe(1);
	});

	it("超长截断，但 stateChars 是截断前的长度（复盘时知道丢了多少）", () => {
		const long = Array.from({ length: 900 }, (_, i) => `+line ${i} of the diff`).join("\n");
		const entry = captureJevSample({ ...BASE, state: long });
		expect(long.length).toBeGreaterThan(JEV_SAMPLE_STATE_MAX_CHARS);
		expect(entry.state.length).toBe(JEV_SAMPLE_STATE_MAX_CHARS);
		expect(entry.stateChars).toBe(long.length);
	});

	it("含密钥形状 token 时抹掉并标记命中数（不整条跳过：diff 仍可复盘）", () => {
		const entry = captureJevSample({ ...BASE, state: `-const k = "${SYNTHETIC_KEY}";\n+const k = env.K;` });
		expect(entry.state).not.toContain(SYNTHETIC_KEY);
		expect(entry.state).toContain("+const k = env.K;");
		expect(entry.stateRedacted).toBe(1);
	});

	it("命题去重排序、分数越界丢弃、失败样本带上错误", () => {
		const entry = captureJevSample({
			...BASE,
			propositions: ["b_prop", "a_prop", "a_prop"],
			checks: { a_prop: 0.5, bad: 1.5 },
			outcome: "review",
			error: { code: "400", error: "上游拒绝", errorEn: "upstream rejected" },
		});
		expect(entry.propositions).toEqual(["a_prop", "b_prop"]);
		expect(entry.checks).toEqual({ a_prop: 0.5 });
		expect(entry.error?.code).toBe("400");
	});

	it("来源白名单之外的取值回落 unknown", () => {
		const entry = captureJevSample({ ...BASE, source: "hacker" as unknown as "tool" });
		expect(entry.source).toBe("unknown");
	});
});

describe("磁盘往返", () => {
	it("append → load 往返（0600、一行一条）", () => {
		const dir = agentDir();
		const path = jevSamplesPath(dir);
		appendJevSample(path, captureJevSample({ ...BASE, state: "-a\n+b" }));
		appendJevSample(path, captureJevSample({ ...BASE, at: BASE.at + 1000, outcome: "block", state: "-c" }));
		const { entries } = loadJevSamples(path);
		expect(entries.map((e) => e.outcome)).toEqual(["approve", "block"]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const stats = jevSamplesStats(path);
		expect(stats.entries).toBe(2);
		expect(stats.byOutcome).toEqual({ approve: 1, block: 1, review: 0 });
		expect(stats.bySource).toEqual({ tool: 2 });
		expect(stats.oldestAt).toBe(BASE.at);
		expect(stats.newestAt).toBe(BASE.at + 1000);
	});

	it("损坏行跳过并计数，不抛", () => {
		const dir = agentDir();
		const path = jevSamplesPath(dir);
		appendJevSample(path, captureJevSample({ ...BASE, state: "-a" }));
		writeFileSync(path, "{ 不是 JSON\n" + readFileSync(path, "utf8"), { mode: 0o600 });
		const { entries, skipped } = loadJevSamples(path);
		expect(entries.length).toBe(1);
		expect(skipped).toBe(1);
		expect(jevSamplesStats(path).skipped).toBe(1);
	});

	it("超过字节上限时轮转到 .1（上一代仍可读）", () => {
		const dir = agentDir();
		const path = jevSamplesPath(dir);
		// 造一个已超过上限的文件，下一次 append 应触发轮转。
		mkdirSync(join(dir, "dev-con"), { recursive: true });
		writeFileSync(path, "x".repeat(JEV_SAMPLES_MAX_BYTES + 1), { mode: 0o600 });
		appendJevSample(path, captureJevSample({ ...BASE, state: "-after-rotate" }));
		expect(existsSync(jevSamplesPreviousPath(path))).toBe(true);
		const { entries } = loadJevSamples(path);
		expect(entries.map((e) => e.state)).toContain("-after-rotate");
	});

	it("clear 删掉当前与上一代，返回字节数", () => {
		const dir = agentDir();
		const path = jevSamplesPath(dir);
		appendJevSample(path, captureJevSample({ ...BASE, state: "-a" }));
		const result = clearJevSamples(path);
		expect(result.removed).toEqual([path]);
		expect(result.bytes).toBeGreaterThan(0);
		expect(existsSync(path)).toBe(false);
		// 再清一次：没有文件也不抛
		expect(clearJevSamples(path).removed).toEqual([]);
	});

	it("normalize 拒绝版本不符/缺时间/非法 outcome", () => {
		expect(normalizeJevSampleEntry({ v: 99, at: 1, outcome: "approve" })).toBeNull();
		expect(normalizeJevSampleEntry({ v: 1, outcome: "approve" })).toBeNull();
		expect(normalizeJevSampleEntry({ v: 1, at: 1, outcome: "maybe" })).toBeNull();
		expect(normalizeJevSampleEntry({ v: 1, at: 1, outcome: "approve" })?.state).toBe("");
	});
});

describe("复盘确认状态（ack）", () => {
	it("写入后可读回；缺失/损坏一律 null", () => {
		const dir = agentDir();
		const path = join(dir, "dev-con", "jev-review.json");
		expect(loadJevReviewAck(path)).toBeNull();
		expect(saveJevReviewAck(path, 1234)).toBe(true);
		expect(loadJevReviewAck(path)).toEqual({ version: 1, lastAckAt: 1234 });
		writeFileSync(path, "not json", { mode: 0o600 });
		expect(loadJevReviewAck(path)).toBeNull();
	});
});
