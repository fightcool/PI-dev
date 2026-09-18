/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED server/agent-service.ts（ClientSession.ensureFreshModelCatalog 用它决定是否 refresh）,
 *            server/model-admin.ts（models.json 的唯一写入者，写后 refresh + pushModels）
 *   📖 docs/DEV-CON-PROPOSAL.md §4（渠道 = 服务商 + 端点 + 凭据 + 模型白名单）
 *   @WHY SDK 的 ModelRuntime 只在**构造时**读一次 models.json，之后仅显式 refresh() 才重读；
 *        而服务进程长期在线，配置可能被别处改写（另一个标签页保存服务商 / 手工编辑 / 脚本）。
 *        没有这个判据时，旧会话的模型目录会永久停在旧版本，用户看到的是只有它一个渠道
 *        「暂无可用的模型」——而且刷新页面也没用（同 clientId 复用同一 ClientSession）。
 *   @CONTRACT 判据只有 mtime+size：写入永远是整体重写（writeFileSync 全量 JSON），所以够准；
 *        不读文件内容、不解析 JSON，所以每次 list_models 都能便宜地检一次。
 *   @GOTCHA 任一侧取不到（文件不存在 / statSync 抛错）时**不算变过**：把「读不到」当成
 *        「变了」会让 list_models 每次都白 refresh 一次，甚至形成重试死循环。
 * ──────────────────────────────────────────────────
 */
import { statSync } from "node:fs";
import { join } from "node:path";

/** agentDir 下的模型配置文件（服务商 / 模型目录的唯一事实源）。 */
export function modelsConfigPathOf(agentDir: string): string {
	return join(agentDir, "models.json");
}

/** statSync 里我们真正用到的两个字段（刻意收窄，便于纯函数测试）。 */
export interface FileStamp {
	mtimeMs: number;
	size: number;
}

/** 一次文件身份（mtime+size）；缺字段 → 空串（= 没有可用判据）。 */
export function stampOf(stat: FileStamp | null | undefined): string {
	if (!stat || !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.size)) return "";
	return `${stat.mtimeMs}:${stat.size}`;
}

/** models.json 当前的身份戳；不存在 / 读不到 → 空串。 */
export function modelConfigStamp(path: string): string {
	try {
		return stampOf(statSync(path));
	} catch {
		return "";
	}
}

/** 目录是否需要重新加载：任一侧为空串 → false（见头部 @GOTCHA）。 */
export function modelCatalogStale(prev: string, next: string): boolean {
	return prev !== "" && next !== "" && prev !== next;
}
