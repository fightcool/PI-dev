/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED gateway-usage.ts（网关账单查询）, jev-gate.ts（Decisions 接口，复用同一套有界传输）
 *   @CONTRACT 单一有界 JSON 传输实现：超时由**调用方**的 AbortController 提供，本模块只发一次请求、
 *             绝不重试；禁止跟随重定向；响应体上限 64KiB；非 2xx / 非 JSON 如实返回失败种类。
 *             安全/体积规则的修复只需改这一处。
 *   @WHY 原先住在 channel-accounts.ts（渠道账户查询适配器）里；渠道能力移除后仍有真实消费方，
 *        因此抽成独立模块保留。
 * ──────────────────────────────────────────────────
 */

/** @MAGIC 单次响应体上限：这两个接口的正文都只有几十字节，超过就是打错了地址。 */
export const MAX_BODY_BYTES = 64 * 1024;

export type FetchJsonFailureKind = "timeout" | "network" | "redirect" | "http" | "no-body" | "too-large" | "not-json";

/**
 * 有界读取响应体（超时 / 体积上限与 ok 路径完全同一套规则）。
 * @CONTRACT 返回 `{ok:false}` 时 `kind`/`message` 就是失败种类与中文文案，状态码由调用方补。
 */
async function readBoundedBody(
	res: Response,
): Promise<{ ok: true; text: string } | { ok: false; kind: FetchJsonFailureKind; message: string }> {
	const reader = res.body?.getReader();
	if (!reader) return { ok: false, kind: "no-body", message: "接口无响应体" };
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.byteLength;
				if (total > MAX_BODY_BYTES) {
					await reader.cancel();
					return { ok: false, kind: "too-large", message: "接口响应体超出上限" };
				}
				chunks.push(value);
			}
		}
	} catch (err) {
		const aborted = (err as Error).name === "AbortError";
		return {
			ok: false,
			kind: aborted ? "timeout" : "network",
			message: aborted ? "查询超时" : (err as Error).message,
		};
	}
	return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
}

/** 有界 JSON 读取：体积上限、禁止重定向、非 2xx 即失败（超时由调用方的 AbortController 提供）。
 *  @CONTRACT 调用方自己持有 AbortController 与超时定时器；这里只发一次请求、**绝不重试**。
 *  `opts.captureErrorDetail` = 额外读取**错误响应体**（同样是 64KiB 上限）放到 `detail`，供
 *  调用方拼自己的错误文案：只靠状态码无法排障（实测：形状错时正文才是答案）。默认关闭。
 */
export async function fetchJson(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	opts?: { captureErrorDetail?: boolean },
): Promise<{
	ok: boolean;
	status: number;
	body?: unknown;
	error?: string;
	kind?: FetchJsonFailureKind;
	detail?: string;
}> {
	let res: Response;
	try {
		res = await fetchImpl(url, { ...init, redirect: "manual", signal });
	} catch (err) {
		const aborted = (err as Error).name === "AbortError";
		return {
			ok: false,
			status: 0,
			kind: aborted ? "timeout" : "network",
			error: aborted ? "查询超时" : (err as Error).message,
		};
	}
	if (res.status >= 300 && res.status < 400)
		return { ok: false, status: res.status, kind: "redirect", error: "接口返回重定向，已按策略拒绝" };
	if (!res.ok) {
		const failed = { ok: false, status: res.status, kind: "http" as const, error: `接口返回 HTTP ${res.status}` };
		if (!opts?.captureErrorDetail) return failed;
		const raw = await readBoundedBody(res);
		// 错误体本身读失败（无正文/超限/断流）时不覆盖状态码错误：detail 只是附加信息。
		return raw.ok ? { ...failed, detail: raw.text } : failed;
	}
	const raw = await readBoundedBody(res);
	if (!raw.ok) return { ok: false, status: res.status, kind: raw.kind, error: raw.message };
	try {
		return { ok: true, status: res.status, body: JSON.parse(raw.text) };
	} catch {
		return { ok: false, status: res.status, kind: "not-json", error: "接口返回非 JSON" };
	}
}
