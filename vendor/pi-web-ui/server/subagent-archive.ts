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

	/** Bound list output; older records remain directly retrievable by runId. */
	list(limit = 100): SubagentSnapshot[] {
		let names: string[];
		try {
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
				const record = this.read(name.slice(0, -5));
				return record ? [record.snapshot] : [];
			});
	}
}
