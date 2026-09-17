/**
 * session-signature.ts — 会话目录的廉价签名（`${mtimeMs}:${size}`）。
 *
 * 为什么需要：`SessionManager.list(cwd)` / `listAll()` 会**逐行 JSON.parse 每一个
 * transcript**（实测 25 个文件 / 75MB → `listAll` 960ms、`list` 540ms，全在服务端
 * 主线程上；SDK 内部并发度固定 10，且没有单文件 API）。而会话列表在 agent 运行
 * 期间会被反复刷新（每条消息结束都会失效缓存 + 800ms 防抖推送）——没有签名就只能
 * 反复付这份全量解析。
 *
 * 有了签名，`SessionHistoryCache` 可以在「磁盘没变」时直接复用缓存列表，一次刷新
 * 的代价从 540ms 降到 readdir+stat 的亚毫秒级。
 *
 * 签名格式与 `agent-service.ts` 的 `diskSig`（`${st.mtimeMs}:${st.size}`）一致。
 * 目录布局与 SDK 保持一致（两种都覆盖）：
 *  - 默认：`<agentDir>/sessions/--<cwd>--/*.jsonl`（每个 cwd 一个子目录）
 *  - 设置 `PI_CODING_AGENT_SESSION_DIR` 时：该目录下扁平铺放 `*.jsonl`
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** 会话目录根：默认 `<agentDir>/sessions`；env 覆盖时为扁平目录。 */
export function sessionsRootDir(agentDir: string): string {
	return process.env.PI_CODING_AGENT_SESSION_DIR || join(agentDir, "sessions");
}

/** 扫描根下全部 `*.jsonl` 的 `path → ${mtimeMs}:${size}`；目录不存在时返回空表。 */
export async function scanSessionStamps(root: string): Promise<Map<string, string>> {
	const stamps = new Map<string, string>();
	const add = async (path: string): Promise<void> => {
		try {
			const st = await stat(path);
			stamps.set(path, `${st.mtimeMs}:${st.size}`);
		} catch {
			// 竞态删除：当作不存在（下一次扫描的差异会让缓存重扫）。
		}
	};
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return stamps;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			let files: string[] = [];
			try {
				files = await readdir(join(root, entry.name));
			} catch {
				continue;
			}
			for (const file of files) if (file.endsWith(".jsonl")) await add(join(root, entry.name, file));
		} else if (entry.name.endsWith(".jsonl")) {
			await add(join(root, entry.name));
		}
	}
	return stamps;
}
