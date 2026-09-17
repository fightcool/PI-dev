/**
 * 渠道端点「工具调用能力」探测的纯逻辑单测。
 *
 * 回归锚点来自 2026-09-13 的真实故障：rightapi.ai 的 /v1/messages 以 200 返回
 * 纯文本（网关把 tools 转成 oai_chat 后丢弃），模型于是声称「没有工具」；
 * 同一个模型在 /v1/responses 上会正常返回 function_call。
 */
import { describe, expect, it, vi } from "vitest";
import {
	CAPABILITY_PROBE_TOOL,
	buildCapabilityProbeRequest,
	capabilityFixHint,
	applyProbeCredential,
	capabilityProbeUrl,
	interpretCapabilityProbe,
	runCapabilityProbe,
} from "../../server/dev-con/endpoint-capability.js";

/** 实测抓到的真实响应体（截断），作为「网关丢 tools」的回归样本。 */
const REAL_RIGHTCODE_PLAIN_REPLY =
	'{"id":"resp_096f35f01a90a2fc016aa656adaf6087d09c9cf5e73889dfe5","type":"message","role":"assistant",' +
	'"content":[{"type":"text","text":"I’m unable to call `get_current_time` because that tool isn’t available in this chat."}],' +
	'"stop_reason":"end_turn","model":"gpt-6-astra","usage":{"input_tokens":38,"output_tokens":138}}';

const REAL_RESPONSES_TOOL_CALL =
	'{"id":"resp_x","type":"response.output_item.done","item":{"id":"fc_0495","type":"function_call","status":"completed",' +
	'"arguments":"{}","call_id":"call_IO4aUu60lzO25s6lrjke347U"}}';

describe("capabilityProbeUrl：URL 必须与 SDK 拼法逐字一致", () => {
	it("anthropic-messages 自己补 /v1/messages", () => {
		expect(capabilityProbeUrl("anthropic-messages", "https://www.rightapi.ai")).toBe("https://www.rightapi.ai/v1/messages");
	});

	it("openai-responses 拼 /responses（baseUrl 需带 /v1）", () => {
		expect(capabilityProbeUrl("openai-responses", "https://www.rightapi.ai/v1")).toBe("https://www.rightapi.ai/v1/responses");
	});

	it("openai-completions 拼 /chat/completions", () => {
		expect(capabilityProbeUrl("openai-completions", "https://api.deepseek.com")).toBe("https://api.deepseek.com/chat/completions");
	});

	it("去掉尾部斜杠，但不做任何「顺手规范化」（否则探测走通、真实请求 404）", () => {
		expect(capabilityProbeUrl("openai-responses", "https://h/v1/")).toBe("https://h/v1/responses");
		expect(capabilityProbeUrl("anthropic-messages", "https://h/v1")).toBe("https://h/v1/v1/messages");
	});
});

describe("buildCapabilityProbeRequest：三种 api 家族的工具声明形状", () => {
	it("anthropic-messages 用 input_schema 且带 anthropic-version", () => {
		const plan = buildCapabilityProbeRequest({ api: "anthropic-messages", baseUrl: "https://h", model: "m", apiKey: "k" });
		const body = plan.body as { tools: { name: string; input_schema: unknown }[] };
		expect(body.tools[0].name).toBe(CAPABILITY_PROBE_TOOL);
		expect(body.tools[0].input_schema).toBeTruthy();
		expect(plan.headers["anthropic-version"]).toBe("2023-06-01");
		// anthropic 家族默认用 x-api-key（官方 SDK 口吻），不是 Authorization。
		expect(plan.headers["x-api-key"]).toBe("k");
		expect(plan.headers.authorization).toBeUndefined();
	});

	it("openai-responses 用扁平的 function 工具", () => {
		const plan = buildCapabilityProbeRequest({ api: "openai-responses", baseUrl: "https://h/v1", model: "m" });
		const body = plan.body as { tools: { type: string; name: string }[] };
		expect(body.tools[0]).toMatchObject({ type: "function", name: CAPABILITY_PROBE_TOOL });
		expect(plan.headers.authorization).toBeUndefined();
	});

	it("openai-completions 用嵌套的 function 工具", () => {
		const plan = buildCapabilityProbeRequest({ api: "openai-completions", baseUrl: "https://h", model: "m" });
		const body = plan.body as { tools: { type: string; function: { name: string } }[] };
		expect(body.tools[0]).toMatchObject({ type: "function", function: { name: CAPABILITY_PROBE_TOOL } });
	});
});

describe("applyProbeCredential：认证口径与对话级凭据隔离", () => {
	it("服务商已声明的 authorization 只改值，不新增第二个认证头", () => {
		const out = applyProbeCredential({ authorization: "Bearer provider-active-key" }, "openai-completions", "conversation-bound-key");
		expect(out.authorization).toBe("Bearer conversation-bound-key");
		expect(Object.keys(out)).toEqual(["authorization"]);
	});

	it("服务商声明的 x-api-key 用裸值改写（大小写不敏感）", () => {
		expect(applyProbeCredential({ "X-Api-Key": "old" }, "anthropic-messages", "new")).toEqual({ "X-Api-Key": "new" });
	});

	it("没有任何认证头时按 api 家族补默认口吻", () => {
		expect(applyProbeCredential(undefined, "openai-responses", "k").authorization).toBe("Bearer k");
		expect(applyProbeCredential(undefined, "anthropic-messages", "k")["x-api-key"]).toBe("k");
	});

	it("探测请求带的是调用方给的那把密钥（对话绑定优先，否则会拿错 key 得到 401 而漏报）", () => {
		const plan = buildCapabilityProbeRequest({
			api: "openai-completions",
			baseUrl: "https://h/v1",
			model: "m",
			apiKey: "conversation-bound-key",
			headers: { authorization: "Bearer provider-active-key", "x-trace": "1" },
		});
		expect(plan.headers.authorization).toBe("Bearer conversation-bound-key");
		expect(plan.headers["x-trace"]).toBe("1");
	});
});

describe("interpretCapabilityProbe：判读结论", () => {
	it("anthropic 的 tool_use → supported", () => {
		const v = interpretCapabilityProbe({
			api: "anthropic-messages",
			status: 200,
			body: '{"type":"message","content":[{"type":"tool_use","name":"pi_capability_probe","input":{}}],"stop_reason":"tool_use"}',
		});
		expect(v.kind).toBe("supported");
		expect(v.reason).toBe("tool_call_seen");
	});

	it("openai-responses 的 function_call → supported", () => {
		expect(interpretCapabilityProbe({ api: "openai-responses", status: 200, body: REAL_RESPONSES_TOOL_CALL }).kind).toBe("supported");
	});

	it("openai-completions 的 tool_calls → supported", () => {
		const body = '{"choices":[{"message":{"tool_calls":[{"id":"c1","function":{"name":"pi_capability_probe","arguments":"{}"}}]}}]}';
		expect(interpretCapabilityProbe({ api: "openai-completions", status: 200, body }).kind).toBe("supported");
	});

	it("实测的 RightCode 200 纯文本答复 → unsupported（这就是「没有工具」的真身）", () => {
		const v = interpretCapabilityProbe({ api: "anthropic-messages", status: 200, body: REAL_RIGHTCODE_PLAIN_REPLY });
		expect(v.kind).toBe("unsupported");
		expect(v.reason).toBe("no_tool_call_in_reply");
		expect(v.evidence).toContain("unable to call");
	});

	it("HTTP 错误 → unverified（探测失败不等于渠道不可用）", () => {
		expect(interpretCapabilityProbe({ api: "openai-responses", status: 404, body: '404 "Not Found"' })).toMatchObject({
			kind: "unverified",
			reason: "http_404",
		});
		expect(interpretCapabilityProbe({ api: "openai-responses", status: 403, body: "quota" }).kind).toBe("unverified");
	});

	it("200 但返回 HTML → unverified/html_response（baseUrl 指到了网站，不是网关丢工具）", () => {
		const v = interpretCapabilityProbe({ api: "anthropic-messages", status: 200, body: "<!doctype html><html>…" });
		expect(v).toMatchObject({ kind: "unverified", reason: "html_response" });
	});

	it("空响应/无法识别 → unverified", () => {
		expect(interpretCapabilityProbe({ api: "anthropic-messages", status: 200, body: "" }).reason).toBe("unrecognized_response");
		expect(interpretCapabilityProbe({ api: "anthropic-messages", status: 200, body: '{"weird":true}' }).kind).toBe("unverified");
	});
});

describe("capabilityFixHint：可执行建议", () => {
	it("openai-* 缺 /v1 时给出提示", () => {
		expect(capabilityFixHint({ api: "openai-responses", baseUrl: "https://www.rightapi.ai" })).toContain("/v1");
		expect(capabilityFixHint({ api: "openai-responses", baseUrl: "https://www.rightapi.ai/v1" })).toBeNull();
		expect(capabilityFixHint({ api: "openai-completions", baseUrl: "https://api.deepseek.com" })).toContain("/v1");
	});

	it("anthropic-messages 带了 /v1 反而要提示（会拼成 /v1/v1/messages）", () => {
		expect(capabilityFixHint({ api: "anthropic-messages", baseUrl: "https://h/v1" })).toContain("/v1/v1/messages");
		expect(capabilityFixHint({ api: "anthropic-messages", baseUrl: "https://www.cctq.ai" })).toBeNull();
	});
});

describe("runCapabilityProbe：有界请求与失败收敛", () => {
	it("把请求打到与 SDK 相同的 URL，并读回 supported", async () => {
		const calls: { url: string; body: unknown }[] = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response(REAL_RESPONSES_TOOL_CALL, { status: 200 });
		}) as unknown as typeof fetch;

		const verdict = await runCapabilityProbe({
			api: "openai-responses",
			baseUrl: "https://www.rightapi.ai/v1",
			model: "gpt-6-astra",
			apiKey: "secret",
			fetchImpl,
		});

		expect(verdict.kind).toBe("supported");
		expect(calls[0].url).toBe("https://www.rightapi.ai/v1/responses");
		expect((calls[0].body as { tools: unknown[] }).tools).toHaveLength(1);
	});

	it("请求失败/超时 → unverified，绝不报成「不支持」", async () => {
		const boom = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect((await runCapabilityProbe({ api: "openai-responses", baseUrl: "https://h/v1", model: "m", fetchImpl: boom })).reason).toBe(
			"request_failed",
		);

		const hang = vi.fn(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		) as unknown as typeof fetch;
		const verdict = await runCapabilityProbe({
			api: "openai-responses",
			baseUrl: "https://h/v1",
			model: "m",
			fetchImpl: hang,
			timeoutMs: 10,
		});
		expect(verdict).toMatchObject({ kind: "unverified", reason: "timeout" });
	});

	it("超长响应按 maxBytes 截断（不把整段对话读进内存）", async () => {
		const huge = `{"choices":[{"message":{"content":"${"x".repeat(5000)}"}}]}`;
		const fetchImpl = (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch;
		const verdict = await runCapabilityProbe({
			api: "openai-completions",
			baseUrl: "https://h",
			model: "m",
			fetchImpl,
			maxBytes: 64,
		});
		expect(verdict.kind).toBe("unsupported");
		expect(verdict.evidence.length).toBeLessThanOrEqual(200);
	});

	it("非流式被 4xx 拒掉时用流式重试一次（有的网关只接受流式）", async () => {
		const streams: boolean[] = [];
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const stream = (JSON.parse(String(init?.body)) as { stream?: boolean }).stream === true;
			streams.push(stream);
			if (!stream) return new Response("stream required", { status: 400 });
			// 流式 SSE：内容与真实函数调用同名片段，测试文本匹配在 SSE 上也能命中。
			const sse =
				'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"pi_capability_probe","input":{}}}\n\n' +
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n';
			return new Response(sse, { status: 200 });
		}) as unknown as typeof fetch;

		const verdict = await runCapabilityProbe({ api: "anthropic-messages", baseUrl: "https://h", model: "m", fetchImpl });
		expect(verdict.kind).toBe("supported");
		expect(streams).toEqual([false, true]);
	});

	it("两次都失败时返回首次结论（不把重试的失败当新事实）", async () => {
		const fetchImpl = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
		const verdict = await runCapabilityProbe({ api: "openai-responses", baseUrl: "https://h/v1", model: "m", fetchImpl });
		expect(verdict).toMatchObject({ kind: "unverified", reason: "http_400" });
	});
});
