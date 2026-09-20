/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED jev-model.ts（配置结构 + 校验 + 明文密钥闸）, jev-gate.ts（applyConfig 的输入）,
 *            ../agent-service.ts（ClientSession 的 load/save 调用方）
 *   @CONTRACT 唯一可写事实源：<agentDir>/dev-con/jev-settings.json（mode 0600，tmp + rename 原子写）。
 *             只存**密钥名引用**（credentialRef）；密钥正文属于 provider-keys.json（model-admin.ts 拥有），
 *             本模块绝不新建第二份密钥/渠道文件。
 *   @WHY 写入是「读 → 合并 → 校验 → 写」而不是**整份覆盖**：
 *         同目录的 ops-settings.json 就是整份覆盖写（setOpsAlerts 只写 {alertsEnabled}，
 *         未知字段一律丢失）——那是既有的缺陷，不照抄（见 @GOTCHA）。
 *   @GOTCHA 磁盘文件缺失/损坏时返回默认值 + parseError 标记，**绝不静默清空**：
 *         调用方看到 parseError 应当保留内存态并暴露问题（对标 channel-store.loadCatalog）。
 *   @MAGIC 落盘版本号 JEV_SETTINGS_VERSION=1（结构不兼容变更时 +1）。
 * ──────────────────────────────────────────────────
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { looksLikeLiteralSecret } from "./account-template.js";
import { findSecretMaterial } from "./channel-model.js";
import { defaultJevGateConfig, validateJevGateConfig, type JevGateConfig } from "./jev-model.js";

/** 落盘版本号：结构不兼容变更时 +1 并给出迁移路径。 */
export const JEV_SETTINGS_VERSION = 1;

const STORE_DIR = "dev-con";
const STORE_FILE = "jev-settings.json";

/** 已知顶层字段（其余字段按 extra 无损保留，见 @WHY）。 */
const KNOWN_KEYS = new Set([
	"version",
	"enabled",
	"endpoint",
	"model",
	"credentialRef",
	"thresholds",
	"timeoutMs",
	"cacheTtlMs",
	"minIntervalMs",
	"recordSamples",
]);

export interface LoadedJevSettings {
	config: JevGateConfig;
	exists: boolean;
	/** 文件存在但无法解析为对象（调用方不得用默认值覆盖磁盘）。 */
	parseError?: boolean;
}

/**
 * thresholds 的两层合并（保存路径专用）：
 * - 第一层同旧行为：只给 approveAt 时不会把 blockAt 丢掉。
 * - 第二层 perProposition **逐项**合并：只改一个判定项时不会把其它项的独立阈值抹掉，
 *   这是必要的——如果整块替换，UI 里改一个题就会静默删掉其余题的阈值。
 * - 删除语义：`perProposition: null` = 全清；`perProposition.<id>: null` = 删这一项。
 *   @WHY 用 null 而不是「缺省即删」：缺省必须继续表示「这一层没提到，保留磁盘上的值」。
 * - 非法形状（数组/字符串）原样透传，交给 validateJevGateConfig 报错，不在这里静默丢弃。
 */
export function mergeThresholds(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...((base ?? {}) as Record<string, unknown>), ...patch };
	if (!("perProposition" in patch)) return merged;
	const incoming = patch.perProposition;
	if (incoming === null) {
		delete merged.perProposition;
		return merged;
	}
	if (typeof incoming !== "object" || Array.isArray(incoming)) return merged;
	const baseMap = ((base ?? {}) as Record<string, unknown>).perProposition;
	const next: Record<string, unknown> = { ...((baseMap ?? {}) as Record<string, unknown>) };
	if (!(typeof baseMap === "object" && baseMap !== null && !Array.isArray(baseMap))) {
		for (const k of Object.keys(next)) delete next[k];
	}
	for (const [id, entry] of Object.entries(incoming as Record<string, unknown>)) {
		if (entry === null) {
			delete next[id];
			continue;
		}
		if (typeof entry !== "object" || Array.isArray(entry)) {
			next[id] = entry;
			continue;
		}
		const prev = next[id];
		next[id] = {
			...((typeof prev === "object" && prev !== null && !Array.isArray(prev) ? prev : {}) as object),
			...entry,
		};
	}
	if (Object.keys(next).length === 0) delete merged.perProposition;
	else merged.perProposition = next;
	return merged;
}

/** 保存结果：失败给中文 + 英文双语（回执直接透传）。 */
export type SaveJevSettingsResult = { ok: true; config: JevGateConfig } | { ok: false; error: string; errorEn: string };

export function jevSettingsPath(agentDir: string): string {
	return join(agentDir, STORE_DIR, STORE_FILE);
}

/** 读原始 JSON 对象（含未知字段）；不存在/损坏返回 null + 原因。 */
function readRaw(agentDir: string): { raw: Record<string, unknown> | null; exists: boolean; parseError?: boolean } {
	const path = jevSettingsPath(agentDir);
	if (!existsSync(path)) return { raw: null, exists: false };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// 读不到（权限/IO）：当成不存在处理，但 exists=false 让上层知道磁盘上没有可信内容。
		return { raw: null, exists: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { raw: null, exists: true, parseError: true };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return { raw: null, exists: true, parseError: true };
	return { raw: parsed as Record<string, unknown>, exists: true };
}

/**
 * 读取配置；缺失/损坏返回默认值（带标记）。
 * @CONTRACT 磁盘内容仍要过 validateJevGateConfig：手改坏了的文件不能让门禁带着非法阈值跑。
 */
export function loadJevSettings(agentDir: string): LoadedJevSettings {
	const { raw, exists, parseError } = readRaw(agentDir);
	if (parseError) return { config: defaultJevGateConfig(), exists, parseError: true };
	if (!raw) return { config: defaultJevGateConfig(), exists };
	const validated = validateJevGateConfig(raw);
	if (!validated.ok) return { config: defaultJevGateConfig(), exists, parseError: true };
	return { config: validated.config, exists };
}

/** 配置对象里是否混进了明文密钥（键名或值形状）。 */
function secretProblem(payload: Record<string, unknown>): string | null {
	const hits = findSecretMaterial(payload);
	if (hits.length > 0) return `配置不得包含密钥字段：${hits.join(", ")}`;
	for (const [key, value] of Object.entries(payload)) {
		if (typeof value === "string" && looksLikeLiteralSecret(value)) return `配置项「${key}」看起来是明文密钥`;
		if (value && typeof value === "object") {
			for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
				if (typeof innerValue === "string" && looksLikeLiteralSecret(innerValue))
					return `配置项「${key}.${inner}」看起来是明文密钥`;
			}
		}
	}
	return null;
}

/**
 * 保存配置：读-合并-写（partial 里没给的字段保持磁盘现值），写入前过校验 + 明文密钥闸。
 * @CONTRACT 合并只覆盖**已知字段**；磁盘上的未知字段原样写回（无损往返）。
 *   任何一步失败都返回双语错误、不落盘（不让半成品配置生效）。
 */
export function saveJevSettings(agentDir: string, partial: unknown): SaveJevSettingsResult {
	const { raw, parseError } = readRaw(agentDir);
	// 磁盘文件损坏时不拿它当合并基准（会静默丢掉用户配置）：改用默认值，但仍然**不覆盖**：
	// 合并后写盘会把损坏文件替换掉——因此这里明确拒绝，让用户先处理磁盘文件。
	if (parseError) {
		return {
			ok: false,
			error: "Jev 门禁配置文件已损坏，无法安全合并；请先修复或删除该文件",
			errorEn: "The Jev settings file is corrupted and cannot be merged safely; fix or delete it first",
		};
	}
	if (partial !== null && partial !== undefined && (typeof partial !== "object" || Array.isArray(partial))) {
		return { ok: false, error: "配置必须是对象", errorEn: "The config must be an object" };
	}
	const patch = (partial ?? {}) as Record<string, unknown>;
	// 磁盘上能解析但**校验不通过**时：loadJevSettings 已回落默认值，这里以它为基准合并（相当于修复）。
	// @WHY 这不是「静默清空」：那些非法字段**本来就没生效**过（门禁启动时用的就是默认值），
	//   且回执会把修复后的完整配置回给调用方；不可解析（损坏）的文件则直接拒绝（见上方分支）。
	const base = raw
		? (loadJevSettings(agentDir).config as unknown as Record<string, unknown>)
		: (defaultJevGateConfig() as unknown as Record<string, unknown>);
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		// 未知键直接忽略（不写进文件）：配置的字段集合由 jev-model 拥有，不能靠前端扩展。
		if (!KNOWN_KEYS.has(key) || key === "version") continue;
		if (value === undefined) continue;
		// thresholds 深合并：只改 approveAt 时不能把 blockAt 丢掉。
		if (key === "thresholds" && value && typeof value === "object" && !Array.isArray(value)) {
			merged.thresholds = mergeThresholds(base.thresholds, value as Record<string, unknown>);
			continue;
		}
		merged[key] = value;
	}

	const validated = validateJevGateConfig(merged);
	if (!validated.ok) return { ok: false, error: validated.error, errorEn: validated.errorEn };

	const payload: Record<string, unknown> = { ...merged, version: JEV_SETTINGS_VERSION };
	// 未知顶层字段无损保留（未来字段/外部工具写入不被本模块抹掉）。
	for (const [key, value] of Object.entries(raw ?? {})) if (!KNOWN_KEYS.has(key)) payload[key] = value;

	const problem = secretProblem(payload);
	if (problem) {
		return {
			ok: false,
			error: `${problem}；请改用 credentialRef 引用密钥名`,
			errorEn: `${problem}; reference a key name via credentialRef instead`,
		};
	}

	const path = jevSettingsPath(agentDir);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		return {
			ok: false,
			error: `写入 Jev 门禁配置失败：${(err as Error).message}`,
			errorEn: `Failed to write the Jev gate settings: ${(err as Error).message}`,
		};
	}
	return { ok: true, config: validated.config };
}
