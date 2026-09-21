/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED components/Message.tsx（红色报错卡）, components/MessageList.tsx（每条算一次，保持 memo 稳定）,
 *            server/protocol.ts（UiMessage.provider/model/errorMessage）
 *   @WHY 上游报错原文是一串 JSON，用户看不到**是哪个服务商/模型失败**。这里把
 *        「服务商 + 模型 + 人话原因」算成一处，并在「详情」里保留原文。
 *   @CONTRACT 只识别明确认得的失败类别（目前只有「网关账户额度不足」）：认不出就 kind=null，
 *        调用方原样显示 errorMessage，绝不改写、绝不编造原因。
 *   @GOTCHA 各 API 的报错前缀不同（"OpenAI API error (403): {...}" / "…API error (400): …"），
 *        所以解析不依赖前缀：从第一个 `{` 起做括号配平扫描，扫不到就用整串兜底。
 * ──────────────────────────────────────────────────
 */

/** 认得的上游失败类别。 */
export type UpstreamErrorKind = "quota";

export interface UpstreamErrorFacts {
	/** 认得出来的类别；null = 认不出（调用方按原文显示）。 */
	kind: UpstreamErrorKind | null;
	/** 前缀里的 HTTP 状态码（"OpenAI API error (403)" → 403）。 */
	status: number | null;
	/** 上游错误码（new-api 的 code / OpenAI 的 code）。 */
	code: string | null;
	/** 网关自己报出的剩余额度文本，如 "¥-0.013362"。 */
	remaining: string | null;
}

export interface UpstreamErrorView extends UpstreamErrorFacts {
	/** 消息自带的服务商 id（原样展示用的兜底）。 */
	providerId: string | null;
	modelId: string | null;
}

/** new-api / one-api 的「用户额度不足」与 OpenAI 的 insufficient_quota。 */
const QUOTA_CODES = new Set(["insufficient_user_quota", "insufficient_quota"]);
/** 文字兜底：上游可能只给 message 不给 code（大小写、中英混排都认）。 */
const QUOTA_TEXT = /额度不足|余额不足|欠费|insufficient[_ ]?(user[_ ])?quota|insufficient credits/i;
/** new-api 把余额写在 message 里：`用户额度不足, 剩余额度: ¥-0.013362 (request id: …)`。 */
const REMAINING_TEXT = /剩余额度[:：]\s*([^\s(（,，;；]+)/;

function asText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * 取出错误正文里的第一段 JSON（从第一个 `{` 起做字符串感知的括号配平）。
 * @WHY 不能直接 `JSON.parse(raw.slice(indexOf("{")))`：多数上游会在 JSON 后面追加
 *    `(request id: …)` 之类的尾巴，严格解析会失败；也不能用「最后一个 }」——嵌套对象会截错。
 */
function jsonBody(raw: string): Record<string, unknown> | null {
	const start = raw.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return asRecord(JSON.parse(raw.slice(start, i + 1)));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/**
 * 上游报错的可用事实。纯函数：同样的输入永远同样的输出（单测覆盖）。
 * @CONTRACT 任何字段都可能为 null；`kind=null` 表示「这不是我认识的失败」，调用方不得据此改写文案。
 */
export function upstreamErrorFacts(raw: string): UpstreamErrorFacts {
	const text = typeof raw === "string" ? raw : String(raw ?? "");
	const head = text.slice(0, Math.max(0, text.indexOf("{")));
	const statusMatch = /(\d{3})/.exec(head);
	const body = jsonBody(text) ?? {};
	const error = asRecord(body.error) ?? body;
	const code = asText(error.code) ?? asText(body.code);
	const message = asText(error.message) ?? asText(body.message) ?? "";
	const remaining = REMAINING_TEXT.exec(message)?.[1] ?? REMAINING_TEXT.exec(text)?.[1] ?? null;
	// 文字兜底：有的上游只给一句可读报错（没有 JSON、没有 code），不能因为解析不到结构就认不出。
	const haystack = `${message} ${code ?? ""} ${text}`;
	const kind: UpstreamErrorKind | null = (code !== null && QUOTA_CODES.has(code)) || QUOTA_TEXT.test(haystack) ? "quota" : null;
	return { kind, status: statusMatch ? Number(statusMatch[1]) : null, code, remaining };
}

/** 报错卡需要的全部信息（服务商 / 模型 / 人话原因）。 */
export function upstreamErrorView(input: {
	errorMessage: string;
	provider?: string | null;
	modelId?: string | null;
}): UpstreamErrorView {
	return {
		...upstreamErrorFacts(input.errorMessage),
		providerId: input.provider?.trim() || null,
		modelId: input.modelId?.trim() || null,
	};
}
