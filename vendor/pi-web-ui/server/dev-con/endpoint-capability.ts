/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED agent-service.ts（makeConversation → 请求前探测 + warning notice）,
 *            tests/unit/endpoint-capability.test.ts
 *   📖 docs/DEV-CON-PROPOSAL.md §5（切换场景）、§9（P0 技术项）
 *   @CONTRACT 纯逻辑 + 一次有界请求：URL/请求体拼装与响应判读可单测，只有
 *             runCapabilityProbe 触网（fetch 可注入，测试不联网）。
 *   @WHY 存在一类**沉默失败**的渠道：网关接受请求并返回 200，但把 `tools` 字段丢掉
 *        （实测 rightapi.ai 的 /v1/messages 会转成 oai_chat），模型于是声称「没有工具」。
 *        UI 上看不出任何错误，开发任务却退化成纯对话。这里用一个最小的「工具探测」
 *        把它变成可判定的结果，让上层能明确告警而不是静默降级。
 *   @GOTCHA URL 必须**逐字复刻 SDK 的拼法**（anthropic-messages → <baseUrl>/v1/messages、
 *        openai-responses → <baseUrl>/responses、openai-completions → <baseUrl>/chat/completions），
 *        不做任何「顺手规范化」。否则探测走通了、真实请求 404，探测结论就是假的。
 *   @ASSUME 只判「有没有 tool call」，不判工具调用质量；网关丢 tools 与模型不愿调用
 *        在 200 文本响应上无法区分，所以两者都归 unsupported（对开发任务的结论相同）。
 *   @SECURITY 密钥只作为请求头使用，绝不进入返回结构、日志或 evidence 文本。
 * ──────────────────────────────────────────────────
 */

/** 探测用工具名与提示：要求模型必须调用它，避免模型出于礼貌改用文本回答。 */
export const CAPABILITY_PROBE_TOOL = "pi_capability_probe";
export const CAPABILITY_PROBE_PROMPT = `Call the ${CAPABILITY_PROBE_TOOL} tool now, with no arguments. Do not answer with text.`;

/** 单次探测的有界参数（小输出、短超时、限长读取）。 */
export const CAPABILITY_PROBE_TIMEOUT_MS = 12_000;
export const CAPABILITY_PROBE_MAX_BYTES = 64 * 1024;
export const CAPABILITY_PROBE_MAX_TOKENS = 64;

export type CapabilityVerdictKind = "supported" | "unsupported" | "unverified";

export interface CapabilityVerdict {
	kind: CapabilityVerdictKind;
	/** 机器可读的短原因（如 "tool_call_seen" / "http_404" / "timeout"）。 */
	reason: string;
	/** 人类可读证据（已截断；绝不含密钥）。 */
	evidence: string;
}

export interface CapabilityProbeInput {
	api: string;
	baseUrl: string;
	model: string;
	apiKey?: string | null;
	headers?: Record<string, string> | undefined;
	/** 是否要求流式（pi 真实调用总是流式）；默认非流式，便于探测端直接读到完整 JSON。 */
	stream?: boolean;
}

const TOOL_SCHEMA = { type: "object", properties: {}, required: [] } as const;

/** 探测请求的 URL：与 SDK 的拼法逐字一致（见文件头 @GOTCHA）。 */
export function capabilityProbeUrl(api: string, baseUrl: string): string {
	const base = baseUrl.trim().replace(/\/+$/, "");
	switch (api) {
		case "anthropic-messages":
			return `${base}/v1/messages`;
		case "openai-responses":
			return `${base}/responses`;
		default:
			// openai-completions 及其兼容家族（含未知 api，按最通用的形态探测）。
			return `${base}/chat/completions`;
	}
}

/**
 * 把凭据写进探测请求头，口径与真实调用一致：
 * - 服务商已声明某个认证头（authorization / x-api-key / api-key，大小写不敏感）→ 只**改写它的值**，不新增第二个头；
 * - 都没声明 → anthropic-messages 用 x-api-key，其余（OpenAI 兼容家族）用 Authorization: Bearer。
 * @WHY 探测必须拖对话绑定的那把命名密钥（与真实请求同一把），否则可能拿错 key 得到 401
 *   （结论变 unverified → 恰好把要防的故障漏报），还会把配额计到别的密钥上。
 */
export function applyProbeCredential(
	headers: Record<string, string> | undefined,
	api: string,
	apiKey: string,
): Record<string, string> {
	const out: Record<string, string> = { ...(headers ?? {}) };
	const found = Object.keys(out).find((k) => ["authorization", "x-api-key", "api-key"].includes(k.toLowerCase()));
	if (found) {
		out[found] = found.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey;
		return out;
	}
	if (api === "anthropic-messages") out["x-api-key"] = apiKey;
	else out.authorization = `Bearer ${apiKey}`;
	return out;
}

/** 拼装带单个工具的探测请求；三种 api 家族的工具声明形状不同。 */
export function buildCapabilityProbeRequest(input: CapabilityProbeInput): {
	url: string;
	headers: Record<string, string>;
	body: unknown;
} {
	const { api, baseUrl, model, apiKey } = input;
	const headers: Record<string, string> = { "content-type": "application/json", ...(input.headers ?? {}) };
	if (apiKey) Object.assign(headers, applyProbeCredential(headers, api, apiKey));
	const url = capabilityProbeUrl(api, baseUrl);
	if (api === "anthropic-messages") {
		headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
		return {
			url,
			headers,
			body: {
				model,
				max_tokens: CAPABILITY_PROBE_MAX_TOKENS,
				stream: input.stream ?? false,
				messages: [{ role: "user", content: CAPABILITY_PROBE_PROMPT }],
				tools: [{ name: CAPABILITY_PROBE_TOOL, description: "Capability probe.", input_schema: TOOL_SCHEMA }],
			},
		};
	}
	if (api === "openai-responses") {
		return {
			url,
			headers,
			body: {
				model,
				max_output_tokens: CAPABILITY_PROBE_MAX_TOKENS,
				stream: input.stream ?? false,
				store: false,
				input: [{ role: "user", content: [{ type: "input_text", text: CAPABILITY_PROBE_PROMPT }] }],
				tools: [{ type: "function", name: CAPABILITY_PROBE_TOOL, description: "Capability probe.", parameters: TOOL_SCHEMA }],
			},
		};
	}
	return {
		url,
		headers,
		body: {
			model,
			max_tokens: CAPABILITY_PROBE_MAX_TOKENS,
			stream: input.stream ?? false,
			messages: [{ role: "user", content: CAPABILITY_PROBE_PROMPT }],
			tools: [
				{
					type: "function",
					function: { name: CAPABILITY_PROBE_TOOL, description: "Capability probe.", parameters: TOOL_SCHEMA },
				},
			],
		},
	};
}

/** 响应里是否出现工具调用（流式 SSE 与非流式 JSON 都是同样的 JSON 片段，故用文本匹配）。 */
function hasToolCall(api: string, body: string): boolean {
	if (api === "anthropic-messages") return /"type"\s*:\s*"tool_use"/.test(body) || /"stop_reason"\s*:\s*"tool_use"/.test(body);
	if (api === "openai-responses") return /"type"\s*:\s*"function_call"/.test(body);
	return /"tool_calls"\s*:/.test(body) || /"finish_reason"\s*:\s*"tool_calls"/.test(body);
}

/** 响应是否是一个「正常完成、只是没有工具调用」的答复（而非错误/空响应）。 */
function looksLikePlainReply(body: string): boolean {
	const trimmed = body.trim();
	if (!trimmed) return false;
	if (/"(error|failed|refusal)"\s*:/.test(trimmed) && !/"(text|content|output_text)"\s*:/.test(trimmed)) return false;
	if (/"type"\s*:\s*"(message|response)"/.test(trimmed)) return true;
	if (/"object"\s*:\s*"chat\.completion"/.test(trimmed)) return true;
	if (/"choices"\s*:/.test(trimmed)) return true;
	if (/"content"\s*:/.test(trimmed)) return true;
	return /"type"\s*:\s*"message_delta"/.test(trimmed) || /"type"\s*:\s*"message_stop"/.test(trimmed);
}

function clip(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 判读一次探测响应：只区分「有工具调用」「正常但没有工具调用」「无法判定」。 */
export function interpretCapabilityProbe(input: { api: string; status: number; body: string }): CapabilityVerdict {
	const { api, status, body } = input;
	if (status >= 400) {
		return {
			kind: "unverified",
			reason: `http_${status}`,
			evidence: clip(body) || `HTTP ${status}`,
		};
	}
	// 200 但返回 HTML：请求根本没到达 API（baseUrl 指到了网站）——属于配置问题，不是「网关丢工具」。
	if (/^\s*<(!doctype|html)/i.test(body.trim())) {
		return { kind: "unverified", reason: "html_response", evidence: clip(body, 120) };
	}
	if (hasToolCall(api, body)) {
		return { kind: "supported", reason: "tool_call_seen", evidence: clip(body, 120) };
	}
	if (looksLikePlainReply(body)) {
		return {
			kind: "unsupported",
			reason: "no_tool_call_in_reply",
			evidence: clip(body, 160),
		};
	}
	return { kind: "unverified", reason: "unrecognized_response", evidence: clip(body) };
}

/** 配置层面的可执行建议：openai-* 系列要求 baseUrl 带 /v1，anthropic 不带（SDK 自己补）。 */
export function capabilityFixHint(input: { api: string; baseUrl: string }): string | null {
	const base = input.baseUrl.trim().replace(/\/+$/, "");
	if (input.api === "anthropic-messages") {
		if (/\/v1$/.test(base)) return "anthropic-messages 的 baseUrl 不需要 /v1（SDK 会自己补 /v1/messages），当前值会拼成 /v1/v1/messages";
		return null;
	}
	if (!/\/v1$/.test(base)) return `${input.api} 的 baseUrl 需要带 /v1（当前值会拼出 404 路径）`;
	return null;
}

/**
 * 跑一次探测（唯一触网函数）。任何异常都收敛成 unverified —— 探测失败不等于渠道不可用，
 * 绝不能把网络抖动报成「该渠道不支持工具」。
 * @WHY 非流式被 4xx 拒掉时用流式重试一次：有的网关只接受流式（pi 真实调用也总是流式），
 *   不重试就会得到 unverified → 沉默，恰好把要防的故障漏报掉。
 */
export async function runCapabilityProbe(
	input: CapabilityProbeInput & {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		maxBytes?: number;
	},
): Promise<CapabilityVerdict> {
	const first = await attemptCapabilityProbe(input, false);
	if (first.kind !== "unverified" || !/^http_4\d\d$/.test(first.reason)) return first;
	const retry = await attemptCapabilityProbe(input, true);
	return retry.kind === "unverified" ? first : retry;
}

async function attemptCapabilityProbe(
	input: CapabilityProbeInput & {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		maxBytes?: number;
	},
	stream: boolean,
): Promise<CapabilityVerdict> {
	const plan = buildCapabilityProbeRequest({ ...input, stream });
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	const timeoutMs = input.timeoutMs ?? CAPABILITY_PROBE_TIMEOUT_MS;
	const maxBytes = input.maxBytes ?? CAPABILITY_PROBE_MAX_BYTES;
	if (typeof fetchImpl !== "function") {
		return { kind: "unverified", reason: "no_fetch", evidence: "运行时没有可用的 fetch" };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(plan.url, {
			method: "POST",
			headers: plan.headers,
			body: JSON.stringify(plan.body),
			signal: controller.signal,
		});
		const raw = await res.text();
		const body = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
		return interpretCapabilityProbe({ api: input.api, status: res.status, body });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const aborted = controller.signal.aborted;
		return {
			kind: "unverified",
			reason: aborted ? "timeout" : "request_failed",
			evidence: clip(message),
		};
	} finally {
		clearTimeout(timer);
	}
}
