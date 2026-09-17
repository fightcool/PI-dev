/**
 * 用量历史「失败标记」回填（一次性迁移）。
 *
 * 为什么需要它：`stopReason`/`failureReason` 是后加的字段，**旧记录里没有**，
 * 所以「按渠道用量」里的失败数与白烧 token 只会从部署之后开始统计——
 * 部署前那十几 M 的损失在界面上永远不会出现。会话文件里其实留着证据
 * （assistant 消息的 stopReason + errorMessage + responseId），而用量记录 id 就是
 * `r:<responseId>`，据此可以把旧记录补回来。
 *
 * 用法：
 *   node scripts/maintenance/backfill-usage-failures.mjs            # 预演（默认，不写盘）
 *   node scripts/maintenance/backfill-usage-failures.mjs --apply    # 落盘（先备份、再原子替换）
 *   环境变量：PI_DEV_AGENT_DIR 覆盖 agentDir。
 *
 * @COUPLED vendor/pi-web-ui/lib/usage/token-usage.mjs（stopReason/failureReason 的写入口径，
 *   异常与中止的区分靠 isFailedStopReason）、server/dev-con/usage-history.ts（聚合读这两个字段）
 *
 * 只补两类事实，不做任何推断：stopReason=error 与它的错误文案（截断 120 字）。
 * 不改 token/费用/归属，不删除任何行；认不出来的记录原样保留。
 *
 * @GOTCHA 本脚本会重写整个文件，而在线的 pi 进程随时在往同一个文件 append——
 *   在服务运行时回填会丢掉期间新写的记录。脚本会比对读入前后的 size/mtime，
 *   发现变化就中止（提示先停服务）；但这只是乱局中的一道护栏，不是替代品。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// 失败口径与截断长度都从库里取：脚本不许维护第二份判断（两处漂移会回填出界面不认的记录）。
import { FAILURE_REASON_MAX_CHARS, isFailedStopReason } from "../../vendor/pi-web-ui/lib/usage/token-usage.mjs";

const agentDir = process.env.PI_DEV_AGENT_DIR ?? join(homedir(), ".local/share/pi-dev/agent");
const historyPath = join(agentDir, "dev-con/usage-history.jsonl");
const previousPath = `${historyPath}.1`;
const sessionsDir = join(agentDir, "sessions");
const apply = process.argv.includes("--apply");

/** 会话目录：<agentDir>/sessions/<项目目录>/*.jsonl。 */
function sessionFiles(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) sessionFiles(full, out);
		else if (entry.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

/** responseId → 失败事实（只收 stopReason=error 的 assistant 消息）。 */
const failures = new Map();
let scannedMessages = 0;
for (const file of sessionFiles(sessionsDir)) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry?.message;
		if (message?.role !== "assistant" || !isFailedStopReason(message.stopReason)) continue;
		scannedMessages += 1;
		const id = typeof message.responseId === "string" && message.responseId ? message.responseId : null;
		if (!id) continue;
		const reason = typeof message.errorMessage === "string" ? message.errorMessage.trim().slice(0, FAILURE_REASON_MAX_CHARS) : "";
		failures.set(id, { stopReason: "error", ...(reason ? { failureReason: reason } : {}) });
	}
}

console.log(`会话里 stopReason=error 的 assistant 消息：${scannedMessages} 条，其中可回填（有 responseId）：${failures.size} 条`);

/** 逐行处理历史：返回新行 + 统计。认不出来的行原样输出。 */
function backfill(text) {
	const out = [];
	let total = 0;
	let already = 0;
	let patched = 0;
	let wastedInput = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) {
			out.push(line);
			continue;
		}
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			out.push(line);
			continue;
		}
		total += 1;
		if (record?.stopReason) {
			already += 1;
			out.push(line);
			continue;
		}
		const id = typeof record?.id === "string" && record.id.startsWith("r:") ? record.id.slice(2) : null;
		const fact = id ? failures.get(id) : undefined;
		if (!fact) {
			out.push(line);
			continue;
		}
		patched += 1;
		wastedInput += (record.input ?? 0) + (record.cacheRead ?? 0) + (record.cacheWrite ?? 0);
		out.push(JSON.stringify({ ...record, ...fact }));
	}
	return { out, total, already, patched, wastedInput };
}

if (!existsSync(historyPath)) {
	console.error(`历史文件不存在：${historyPath}`);
	process.exit(1);
}

const current = backfill(readFileSync(historyPath, "utf8"));
const previous = existsSync(previousPath) ? backfill(readFileSync(previousPath, "utf8")) : null;

console.log(`\n当前文件：共 ${current.total} 条，已带 stopReason ${current.already} 条，可回填 ${current.patched} 条`);
console.log(`  这些记录白烧的输入 token：${current.wastedInput}`);
if (previous) console.log(`上一代（.1）：共 ${previous.total} 条，已带 stopReason ${previous.already} 条，可回填 ${previous.patched} 条，白烧 ${previous.wastedInput} token`);

if (!apply) {
	console.log("\n预演结束（未写入）。确认无误后用 --apply 落盘。");
	process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// 写入前重新确认文件没被在线的 pi 进程追加过，否则重写会静默丢掉那些新记录。
const before = statSync(historyPath);
for (const path of [historyPath, ...(previous ? [previousPath] : [])]) {
	const now = statSync(path);
	if (path === historyPath && (now.size !== before.size || now.mtimeMs !== before.mtimeMs)) {
		console.error(`${path} 在本次读取后被修改过（size/mtime 变了）。`);
		console.error("在线进程正在 append，现在重写会丢掉新记录——请先停掉服务再回填。未写入任何内容。");
		process.exit(1);
	}
}

for (const [path, result] of [
	[historyPath, current],
	...(previous ? [[previousPath, previous]] : []),
]) {
	const backup = `${path}.bak-${stamp}`;
	copyFileSync(path, backup);
	const tmp = `${path}.${process.pid}.backfill`;
	writeFileSync(tmp, result.out.join("\n"), { mode: 0o600 });
	renameSync(tmp, path);
	console.log(`已回填 ${result.patched} 条：${path}（备份 ${backup}，${statSync(path).size} 字节）`);
}
console.log(`\n完成。备份目录：${dirname(historyPath)}`);
