/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED channel-model.ts (数据结构 + 纯逻辑), channel-service.ts (唯一调用方)
 *   📖 docs/DEV-CON-PROPOSAL.md §4「配置变更采用校验/预览 → revision复核 → 应用 → 验证和回执」
 *   @CONTRACT 渠道元数据落盘于 <agentDir>/dev-con/channels.json，只存引用不存密钥；
 *             写入前用 findSecretMaterial 拒绝任何密钥字段，避免出现第二份凭据事实源。
 *   @WHY revision 复核用「内容哈希」而不是 mtime：外部编辑器/别的进程改写后，
 *        旧客户端提交必须得到 conflict 而不是静默覆盖（§4 已知外部修改不能被静默覆盖）。
 *   @GOTCHA 原子写必须同目录 tmp + rename；跨设备 rename 会失败（见 client-state.ts 同款）。
 * ──────────────────────────────────────────────────
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	defaultCatalog,
	findSecretMaterial,
	normalizeChannelRecord,
	pruneBindings,
	type ChannelCatalog,
	type ChannelBinding,
} from "./channel-model.js";

/** 落盘版本号：结构不兼容变更时 +1 并给出迁移路径。 */
export const CHANNEL_STORE_VERSION = 1;

const STORE_DIR = "dev-con";
const STORE_FILE = "channels.json";

export interface LoadedCatalog {
	catalog: ChannelCatalog;
	/** 文件内容哈希；文件不存在为 null。写入时用于冲突复核。 */
	hash: string | null;
	exists: boolean;
	/** 文件存在但无法解析（调用方不得用空目录覆盖内存态）。 */
	parseError?: boolean;
}

export type SaveResult =
	| { ok: true; hash: string; configRevision: number }
	| { ok: false; kind: "conflict" | "invalid"; hash?: string; errors?: string[] };

export function channelStorePath(agentDir: string): string {
	return join(agentDir, STORE_DIR, STORE_FILE);
}

function hashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** 读取渠道目录；缺失/损坏时返回空目录而不是抛错（服务必须能启动）。 */
export function loadCatalog(agentDir: string): LoadedCatalog {
	const path = channelStorePath(agentDir);
	if (!existsSync(path)) return { catalog: defaultCatalog(), hash: null, exists: false };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { catalog: defaultCatalog(), hash: null, exists: false };
	}
	const hash = hashOf(text);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		// 损坏文件不静默覆盖：标记 parseError 让上层保留内存态并暴露问题。
		return { catalog: defaultCatalog(), hash, exists: true, parseError: true };
	}
	return { catalog: normalizeCatalog(raw), hash, exists: true };
}

/** 归一化外部 JSON：未知顶层字段保留在 extra（无损往返）。 */
export function normalizeCatalog(raw: unknown): ChannelCatalog {
	if (!raw || typeof raw !== "object") return defaultCatalog();
	const r = raw as Record<string, unknown>;
	const known = new Set(["version", "configRevision", "channels", "instanceDefault", "projectDefaults", "bindings", "extra"]);
	const extra: Record<string, unknown> = { ...((r.extra as Record<string, unknown>) ?? {}) };
	for (const [k, v] of Object.entries(r)) if (!known.has(k)) extra[k] = v;
	const channels = Array.isArray(r.channels)
		? (r.channels.map(normalizeChannelRecord).filter((c) => c !== null) as ChannelCatalog["channels"])
		: [];
	const bindings: Record<string, ChannelBinding> = {};
	if (r.bindings && typeof r.bindings === "object") {
		for (const [id, value] of Object.entries(r.bindings as Record<string, ChannelBinding>)) {
			if (value && typeof value === "object" && typeof value.channelId === "string" && typeof value.modelId === "string") {
				bindings[id] = {
					conversationId: id,
					channelId: value.channelId,
					endpointId: typeof value.endpointId === "string" ? value.endpointId : "default",
					credentialRef: value.credentialRef ?? null,
					modelId: value.modelId,
					bindingRevision: Number.isInteger(value.bindingRevision) ? value.bindingRevision : 0,
					configRevision: Number.isInteger(value.configRevision) ? value.configRevision : 0,
					lastUsedAt: Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : 0,
				};
			}
		}
	}
	const projectDefaults: ChannelCatalog["projectDefaults"] = {};
	if (r.projectDefaults && typeof r.projectDefaults === "object") {
		for (const [cwd, sel] of Object.entries(r.projectDefaults as ChannelCatalog["projectDefaults"])) {
			projectDefaults[cwd] = sel && typeof sel === "object" && typeof sel.channelId === "string" ? sel : null;
		}
	}
	return {
		configRevision: Number.isInteger(r.configRevision) ? (r.configRevision as number) : 0,
		channels,
		instanceDefault:
			r.instanceDefault && typeof r.instanceDefault === "object" && typeof (r.instanceDefault as ChannelCatalog["instanceDefault"])?.channelId === "string"
				? (r.instanceDefault as ChannelCatalog["instanceDefault"])
				: null,
		projectDefaults,
		bindings: pruneBindings(bindings),
		extra,
	};
}

/** 序列化（含 version 与未知字段；密钥字段一律拒绝）。 */
export function serializeCatalog(catalog: ChannelCatalog): string {
	const secrets = findSecretMaterial({ channels: catalog.channels, extra: catalog.extra });
	if (secrets.length > 0) {
		throw new Error(`渠道元数据不得包含密钥字段：${secrets.join(", ")}`);
	}
	const payload: Record<string, unknown> = {
		...catalog.extra,
		version: CHANNEL_STORE_VERSION,
		configRevision: catalog.configRevision,
		channels: catalog.channels,
		instanceDefault: catalog.instanceDefault,
		projectDefaults: catalog.projectDefaults,
		bindings: pruneBindings(catalog.bindings),
	};
	return JSON.stringify(payload, null, 2) + "\n";
}

/**
 * 原子写入 + revision 复核。expectedHash 为 null 表示「启动时文件不存在」，
 * 此时若文件已被他人创建则同样判为 conflict。
 */
export function saveCatalog(agentDir: string, catalog: ChannelCatalog, expectedHash: string | null): SaveResult {
	const path = channelStorePath(agentDir);
	const current = existsSync(path) ? hashOf(readFileSync(path, "utf8")) : null;
	if (current !== expectedHash) return { ok: false, kind: "conflict", hash: current ?? undefined };
	let text: string;
	try {
		text = serializeCatalog(catalog);
	} catch (err) {
		return { ok: false, kind: "invalid", errors: [(err as Error).message] };
	}
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, text, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		return { ok: false, kind: "invalid", errors: [`写入渠道元数据失败：${(err as Error).message}`] };
	}
	return { ok: true, hash: hashOf(text), configRevision: catalog.configRevision };
}

/** 文件当前哈希（不解析），供服务层在冲突后重新取基准。 */
export function catalogHash(agentDir: string): string | null {
	const path = channelStorePath(agentDir);
	if (!existsSync(path)) return null;
	try {
		return hashOf(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
