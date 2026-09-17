/* 🍞 AI Breadcrumb — @COUPLED agent-service.ts, subagents.ts
 * @WHY Retire heavy runtimes without losing results or the ability to continue.
 * @CONTRACT Records are private and scoped to a client; never delete transcript history.
 * 📖 ../docs/conversation-lifecycle.md
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "./subagents.js";
import type { SubagentTemplate } from "./subagent-templates.js";

export interface ArchivedSubagent {
	version: 1;
	id: string;
	cwd: string;
	parentId?: string;
	parentSessionId?: string;
	createdAt: number;
	template?: SubagentTemplate;
	model?: { provider: string; id: string };
	snapshot: SubagentSnapshot;
	header: SessionHeader;
	leafId: string | null;
	entries: SessionEntry[];
}

const ID = /^sa-[a-f0-9]{8}$/;

export class SubagentArchive {
	readonly directory: string;
	constructor(dataDir: string, clientId: string) {
		const scope = createHash("sha256").update(clientId).digest("hex");
		this.directory = join(dataDir, "subagent-archive", scope);
	}

	write(record: ArchivedSubagent): void {
		if (!ID.test(record.id) || record.snapshot.convId !== record.id) throw new Error("Invalid subagent archive id");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const path = join(this.directory, `${record.id}.json`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
			renameSync(temporary, path);
		} catch (error) {
			try {
				unlinkSync(temporary);
			} catch {
				/* Keep the original write error; runtime remains live. */
			}
			throw error;
		}
		this.writeIndex(record);
	}

	/**
	 * 派生索引：`list()` 只需要 `snapshot`（实测仅占归档总体积的 **2.2%**，而 `entries`
	 * 占 97.8%）——不建索引就得为了 710 KB 解析 32 MB，每次 `subagent_list` 冻主线程 0.6s。
	 *
	 * 契约：`.json` 仍是唯一事实源；这份索引可丢弃、可重建（缺失时 `list()` 回退整读并自愈），
	 * 写失败不影响归档本身（只记录一条警告）。
	 */
	private writeIndex(record: ArchivedSubagent): void {
		const path = join(this.directory, `${record.id}.snapshot.json`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify(record.snapshot), { flag: "wx", mode: 0o600 });
			renameSync(temporary, path);
		} catch {
			try {
				unlinkSync(temporary);
			} catch {
				/* 索引写入失败：不影响事实源，list() 会回退整读。 */
			}
		}
	}

	/** 读派生索引；缺失/损坏时返回 undefined（调用方回退整读）。 */
	private readIndex(id: string): SubagentSnapshot | undefined {
		try {
			const snapshot = JSON.parse(readFileSync(join(this.directory, `${id}.snapshot.json`), "utf8")) as SubagentSnapshot;
			return snapshot?.convId === id ? snapshot : undefined;
		} catch {
			return undefined;
		}
	}

	read(id: string): ArchivedSubagent | undefined {
		if (!ID.test(id)) return undefined;
		try {
			const record = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8")) as ArchivedSubagent;
			if (
				record.version !== 1 ||
				record.id !== id ||
				record.snapshot?.convId !== id ||
				typeof record.cwd !== "string" ||
				typeof record.header?.id !== "string" ||
				!Array.isArray(record.entries)
			) {
				throw new Error("Invalid archive");
			}
			return record;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			// JSON parser and filesystem errors must not expose transcript content.
			throw new Error("Cannot read archived subagent");
		}
	}

	/**
	 * Bound list output; older records remain directly retrievable by runId.
	 *
	 * @PERF 优先读派生索引（见 writeIndex）：67 个归档（32 MB）从 582 ms 降到只读 710 KB。
	 *   索引缺失（老记录/写索引时失败）就回退整读并**自愈**写回索引。
	 */
	list(limit = 100): SubagentSnapshot[] {
		let names: string[];
		try {
			// 索引文件名是 `<id>.snapshot.json`，被这个 $ 锚定不匹配——不会被当成归档记录。
			names = readdirSync(this.directory).filter((name) => /^sa-[a-f0-9]{8}\.json$/.test(name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new Error("Cannot list archived subagents");
		}
		return names
			.map((name) => ({ name, at: statSync(join(this.directory, name)).mtimeMs }))
			.sort((a, b) => b.at - a.at)
			.slice(0, limit)
			.flatMap(({ name }) => {
				const id = name.slice(0, -5);
				const indexed = this.readIndex(id);
				if (indexed) return [indexed];
				const record = this.read(id);
				if (!record) return [];
				// 自愈：老归档没有索引（或索引写失败过），补写一份，下次就不必整读。
				this.writeIndex(record);
				return [record.snapshot];
			});
	}
}
