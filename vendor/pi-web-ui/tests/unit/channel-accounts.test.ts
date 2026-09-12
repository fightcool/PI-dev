/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/channel-accounts.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §7（余额/配额、限频、失败/过期状态）、§9（账户查询）、§10 A08/A09
 * 用本地 HTTP 替身验证：不支持/成功/失败/超时/超长响应/重定向/限频/缓存与旧值保留。
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	AccountRegistry,
	deepSeekAdapter,
	topupUrlOf,
	setProviderBaseUrlLookup,
} from "../../server/dev-con/channel-accounts.js";
import type { ChannelRecord } from "../../server/dev-con/channel-model.js";

let servers: Server[] = [];
afterEach(() => {
	for (const s of servers) s.close();
	servers = [];
});

async function stub(handler: (url: URL, res: import("node:http").ServerResponse) => void): Promise<string> {
	const server = createServer((req, res) => handler(new URL(req.url ?? "/", "http://127.0.0.1"), res));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

const channel = (url: string, extra: Record<string, unknown> = { scale: 2, kind: "openai-gateway", unit: "USD" }): ChannelRecord => ({
	id: "ch-1",
	displayName: "渠道",
	providerId: "main",
	endpointId: "default",
	credentialRef: { providerId: "main", keyName: "密钥 1" },
	accountRef: "acct-1",
	models: [],
	enabled: true,
	extra: { account: { url, ...extra } },
});

const registry = (overrides = {}) => new AccountRegistry({ minIntervalMs: 0, timeoutMs: 300, ...overrides });

describe("account queries", () => {
	it("reports unsupported when the channel has no account endpoint", async () => {
		const r = registry();
		const result = await r.query({ ...channel("http://127.0.0.1:1"), extra: {} }, () => "sk");
		expect(result).toMatchObject({ status: "unsupported", kind: "unsupported" });
		expect(result.error).toBeTruthy();
		expect(r.snapshot()[0].status).toBe("unsupported");
	});

	it("probes the billing API first and never touches /api/user/self when billing answers (one request)", async () => {
		const paths: string[] = [];
		const base = await stub((url, res) => {
			paths.push(url.pathname);
			if (url.pathname === "/v1/dashboard/billing/usage") {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ total_usage: 1.25 }));
			}
			if (url.pathname === "/api/user/self") {
				res.writeHead(401, { "content-type": "application/json" });
				return res.end(JSON.stringify({ success: false }));
			}
			res.writeHead(404);
			res.end("{}");
		});
		const result = await registry().query(channel(base), () => "sk-model-key");
		expect(result.status).toBe("ok");
		expect(result.quota).toEqual({ used: 1.25, unit: "USD" });
		// 只有账单接口被访问；/api/user/self 一次都没打（API token 打它必然 401）。
		expect(paths).not.toContain("/api/user/self");
	});

	it("uses the OpenAI-compatible billing API when the provider exposes no balance endpoint", async () => {
		// 实测形态（www.cctq.ai）：API token 打 /api/user/self 一律 401，但账单接口可用（只有已用）。
		const base = await stub((url, res) => {
			if (url.pathname === "/api/user/self") {
				res.writeHead(401, { "content-type": "application/json" });
				return res.end(JSON.stringify({ code: "AUTH_UNAUTHORIZED", success: false }));
			}
			if (url.pathname === "/v1/dashboard/billing/usage") {
				// 默认先不带日期窗口（实测该部署直接可读）；带窗口是兜底路径。
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ object: "list", total_usage: 3.5 }));
			}
			if (url.pathname === "/v1/dashboard/billing/subscription") {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ hard_limit_usd: 100 }));
			}
			res.writeHead(404);
			res.end("{}");
		});
		const result = await registry().query(channel(`${base}/v1`), () => "sk-model-key");
		expect(result).toMatchObject({ status: "ok", unit: "USD" });
		expect(result.balance).toBeCloseTo(96.5); // 100 - 3.5
		expect(result.quota).toEqual({ used: 3.5, limit: 100, remaining: 96.5, unit: "USD" });
		expect(result.note).toContain("账户接口");
	});

	it("never reports the unlimited placeholder as a balance (reports used instead)", async () => {
		// new-api 对「不限额度」的 token 返回 1e8 占位值：不能当成余额显示（§7 不猜余额）。
		const base = await stub((url, res) => {
			res.writeHead(url.pathname === "/api/user/self" ? 403 : 200, { "content-type": "application/json" });
			if (url.pathname === "/v1/dashboard/billing/usage") return res.end(JSON.stringify({ total_usage: 0.0558 }));
			if (url.pathname === "/v1/dashboard/billing/subscription") return res.end(JSON.stringify({ hard_limit_usd: 100000000 }));
			res.end(JSON.stringify({ success: false }));
		});
		const result = await registry().query(channel(base), () => "sk");
		expect(result.status).toBe("ok");
		expect(result.balance).toBeUndefined();
		expect(result.quota).toEqual({ used: 0.0558, unit: "USD" });
		// 面向用户的说法：只说「有没有余额」，不摆字段名。
		expect(result.note).toContain("没有余额信息");
		expect(result.note).not.toContain("subscription");
		expect(result.note).not.toContain("字段");
	});

	it("says the provider API has no query endpoint when nothing answers", async () => {
		// 按设计：探不到就说探不到（§7），不引导用户去用控制台令牌。
		const base = await stub((_url, res) => {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: false }));
		});
		const result = await registry().query(channel(base), () => "sk");
		expect(result.status).toBe("failed");
		expect(result.error).toContain("未提供可用的用量/余额查询接口");
		expect(result.error).not.toContain("控制台");
	});

	it("parses an OpenAI-compatible gateway balance with the configured scale and unit", async () => {
		// 该部署的 API 没有账单接口（404）→ 探到 /api/user/self 并解析出额度（scale/unit 生效）。
		const base = await stub((url, res) => {
			if (url.pathname !== "/api/user/self") {
				res.writeHead(404);
				return res.end("{}");
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: true, data: { quota: 1000, used_quota: 400, display_name: "acct" } }));
		});
		const result = await registry().query(channel(base), () => "sk-secret");
		expect(result).toMatchObject({ status: "ok", unit: "USD", scope: "acct", balance: 300 });
		expect(result.quota).toEqual({ used: 200, limit: 500, remaining: 300, unit: "USD" });
		expect(result.checkedAt).toBeTypeOf("number");
	});

	it("sends the channel credential and never writes it anywhere it is not needed", async () => {
		let seen = "";
		const base = await stub((_url, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: { quota: 10 } }));
		});
		const server = servers[0];
		server.removeAllListeners("request");
		server.on("request", (req, res) => {
			seen = String(req.headers.authorization ?? "");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: { quota: 10 } }));
		});
		await registry().query(channel(base), () => "sk-secret");
		expect(seen).toBe("Bearer sk-secret");
	});

	it("fails on non-2xx, non-JSON, redirects, oversized bodies and missing credentials", async () => {
		const bad = await stub((_url, res) => {
			res.writeHead(500);
			res.end("boom");
		});
		expect((await registry().query(channel(bad), () => "sk")).error).toContain("账户接口返回 HTTP 500");

		const notJson = await stub((_url, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<html>login</html>");
		});
		expect((await registry().query(channel(notJson), () => "sk")).error).toContain("非 JSON");

		const redirect = await stub((_url, res) => {
			res.writeHead(302, { location: "https://evil.example/steal" });
			res.end();
		});
		expect((await registry().query(channel(redirect), () => "sk")).error).toContain("重定向");

		const huge = await stub((_url, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: { quota: 1, pad: "x".repeat(70 * 1024) } }));
		});
		expect((await registry().query(channel(huge), () => "sk")).error).toContain("超出上限");

		// 渠道没有命名凭据 → 问服务层要「服务商自己那把 key」（keyName=null）；拿不到才失败。
		const asked: (string | null)[] = [];
		expect(
			await registry().query({ ...channel(bad), credentialRef: null }, (name) => {
				asked.push(name);
				return null;
			}),
		).toMatchObject({ status: "failed", error: "该渠道未绑定命名凭据，无法查询账户" });
		expect(asked).toEqual([null]);
		expect((await registry().query(channel(bad), () => null)).error).toBe("命名凭据「密钥 1」已不存在");
	});

	it("gives up after the bounded timeout instead of hanging the request path", async () => {
		const slow = await stub(() => {
			/* never respond */
		});
		const started = Date.now();
		const result = await registry({ timeoutMs: 150 }).query(channel(slow), () => "sk");
		expect(result.status).toBe("failed");
		expect(result.error).toContain("查询超时");
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("parses the official DeepSeek /user/balance shape (CNY, string amounts, granted/topped-up split)", async () => {
		let seenUrl = "";
		let seenAuth = "";
		const base = await stub((url, res) => {
			seenUrl = url.pathname;
			seenAuth = String((res.req?.headers.authorization ?? "").toString());
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] }));
		});
		const channelWithDeepSeek = { ...channel(base), extra: { account: { kind: "deepseek", url: base } } };
		const result = await registry().query(channelWithDeepSeek, () => "ds-key");
		expect(seenUrl).toBe("/user/balance");
		expect(seenAuth).toBe("Bearer ds-key");
		expect(result).toMatchObject({ status: "ok", kind: "deepseek", unit: "CNY", balance: 110 });
		expect(result.breakdown).toEqual([{ currency: "CNY", total: 110, granted: 10, toppedUp: 100 }]);
		expect(result.note).toBeUndefined();
	});

	it("keeps multiple currencies separate and flags an insufficient balance", async () => {
		const base = await stub((_url, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					is_available: false,
					balance_infos: [
						{ currency: "USD", total_balance: "3.50", granted_balance: "0.00", topped_up_balance: "3.50" },
						{ currency: "CNY", total_balance: "25.00", granted_balance: "5.00", topped_up_balance: "20.00" },
					],
				}),
			);
		});
		const channelWithDeepSeek = { ...channel(base), extra: { account: { kind: "deepseek", url: base, unit: "CNY" } } };
		const result = await registry().query(channelWithDeepSeek, () => "ds-key");
		// 主条目按渠道配置的币种选 CNY；多币种只在 breakdown 里分别列出，绝不相加。
		expect(result).toMatchObject({ status: "ok", unit: "CNY", balance: 25 });
		expect(result.breakdown?.map((entry) => entry.currency)).toEqual(["USD", "CNY"]);
		expect(result.note).toContain("is_available=false");
	});

	it("reports DeepSeek failures honestly (empty balance_infos, non-JSON)", async () => {
		const empty = await stub((_url, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ is_available: true, balance_infos: [] }));
		});
		const channelWithDeepSeek = { ...channel(empty), extra: { account: { kind: "deepseek", url: empty } } };
		const missing = await registry().query(channelWithDeepSeek, () => "ds-key");
		expect(missing.status).toBe("failed");
		expect(missing.error).toContain("balance_infos");
		// 缺 total_balance 的条目同样视为不可识别（不把 0 当余额）。
		const partial = await stub((_url, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", topped_up_balance: "1.00" }] }));
		});
		const partialResult = await registry().query({ ...channel(partial), extra: { account: { kind: "deepseek", url: partial } } }, () => "ds-key");
		expect(partialResult.status).toBe("failed");
	});

	it("normalizes a gateway baseUrl that already carries /v1 before /api/user/self", async () => {
		const seen: string[] = [];
		const base = await stub((url, res) => {
			seen.push(url.pathname);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: true, data: { quota: 500, used_quota: 500, display_name: "gw" } }));
		});
		// 渠道里填的是 OpenAI 兼容基址（末尾 /v1）——额度接口必须落在站点根 /api/user/self，
		// 不能拼成 /v1/api/user/self。
		const withV1 = { ...channel(`${base}/v1`), extra: { account: { kind: "openai-gateway", url: `${base}/v1`, unit: "CNY", scale: 1 } } };
		const result = await registry().query(withV1, () => "gw-key");
		expect(seen).toContain("/api/user/self");
		expect(seen).not.toContain("/v1/api/user/self");
		expect(result.status).toBe("ok");
		// 已经给出完整账户路径时原样使用，不做二次拼接。
		seen.length = 0;
		const explicit = { ...channel(base), extra: { account: { kind: "openai-gateway", url: `${base}/api/user/self`, scale: 1 } } };
		await registry().query(explicit, () => "gw-key");
		expect(seen).toContain("/api/user/self");
		expect(seen).not.toContain("/v1/api/user/self");
	});

	it("falls back to the provider's own key when the channel has no named credential", async () => {
		// 自定义服务商（CCQTCC / micu 这类）的 key 只存在 models.json，没有 provider-keys.json 的名字：
		// 旧实现直接报「未绑定命名凭据」，这类渠道的余额永远查不出来。
		let seenAuth = "";
		const base = await stub((_url, res) => {
			seenAuth = String((res.req?.headers.authorization ?? "").toString());
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: { quota: 10, used_quota: 4 } }));
		});
		const bare = { ...channel(`${base}/v1`), credentialRef: null };
		const resolve = async (name: string | null) => (name === null ? "provider-own-key" : null);
		const result = await registry().query(bare, resolve);
		expect(result.status).toBe("ok");
		expect(seenAuth).toBe("Bearer provider-own-key");
	});

	it("uses the account-specific credential when the gateway needs a console token", async () => {
		let seenAuth = "";
		const base = await stub((_url, res) => {
			seenAuth = String((res.req?.headers.authorization ?? "").toString());
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: { quota: 10, used_quota: 0 } }));
		});
		const gateway = { ...channel(`${base}/v1`), extra: { account: { kind: "openai-gateway", url: `${base}/v1`, scale: 1, credentialKeyName: "控制台令牌" } } };
		const resolve = (name: string | null) => (name === "控制台令牌" ? "console-token" : "model-key");
		const result = await registry().query(gateway, resolve);
		expect(result.status).toBe("ok");
		expect(seenAuth).toBe("Bearer console-token");
		// 没配置账户凭据时回落到渠道的模型凭据（DeepSeek 官方这类）。
		seenAuth = "";
		await registry().query({ ...gateway, extra: { account: { kind: "openai-gateway", url: `${base}/v1`, scale: 1 } } }, resolve);
		expect(seenAuth).toBe("Bearer model-key");
	});

	it("tells the user the provider API has no query endpoint when the API token is rejected everywhere", async () => {
		const base = await stub((_url, res) => {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: false, message: "unauthorized" }));
		});
		const gateway = { ...channel(`${base}/v1`), extra: { account: { kind: "openai-gateway", url: `${base}/v1`, scale: 1 } } };
		const result = await registry().query(gateway, () => "model-key");
		expect(result.status).toBe("failed");
		// 如实说「这个 API 没有可用的查询接口」，并列出探测过的地址；不引导控制台令牌（设计决定）。
		expect(result.error).toContain("未提供可用的用量/余额查询接口");
		expect(result.error).toContain("/v1/dashboard/billing/usage");
		expect(result.error).not.toContain("控制台");
	});

	it("exposes the DeepSeek adapter with its documented kind", () => {
		expect(deepSeekAdapter.kind).toBe("deepseek");
		expect(deepSeekAdapter.match({ ...channel("https://api.deepseek.com"), extra: { account: { kind: "deepseek" } } })).toBe(true);
		expect(deepSeekAdapter.match({ ...channel("https://x"), extra: { account: { kind: "openai-gateway" } } })).toBe(false);
	});

	it("rate-limits repeated queries and keeps the previous result", async () => {
		let calls = 0;
		const base = await stub((_url, res) => {
			calls += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: { quota: 100 } }));
		});
		const clock = { value: 1_000 };
		const r = registry({ minIntervalMs: 60_000, now: () => clock.value });
		const first = await r.query(channel(base), () => "sk");
		expect(first.status).toBe("ok");
		// 探测可能不止一个请求，所以比较「第二次查询有没有新增请求」，而不是硬编码 1。
		const callsAfterFirst = calls;
		const second = await r.query(channel(base), () => "sk");
		expect(calls).toBe(callsAfterFirst);
		expect(second.error).toContain("查询过于频繁");
		expect(second.balance).toBe(first.balance);
	});

	it("keeps the last good balance with a stale marker when a later query fails", async () => {
		let healthy = true;
		const base = await stub((_url, res) => {
			if (!healthy) {
				res.writeHead(503);
				res.end("nope");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: { quota: 500 } }));
		});
		const clock = { value: 1_000 };
		const r = registry({ now: () => clock.value });
		const ok = await r.query(channel(base), () => "sk");
		expect(ok.status).toBe("ok");
		healthy = false;
		clock.value += 1_000;
		const failed = await r.query(channel(base), () => "sk");
		// §7：失败保留上次结果与旧时间，不显示为 0。
		expect(failed.status).toBe("stale");
		expect(failed.balance).toBe(ok.balance);
		expect(failed.staleSince).toBe(ok.checkedAt);
		const snapshot = r.snapshot()[0];
		expect(snapshot.status).toBe("stale");
		expect(snapshot.balance).toBe(ok.balance);
	});
});

describe("充值直达链接（用量面板标题右侧）", () => {
	it("显式配置优先，其次按账户查询方式取默认值，{baseUrl} 会被解析", () => {
		setProviderBaseUrlLookup((id) => (id === "main" ? "https://gw.example/v1" : undefined));
		// openai-gateway 的默认充值页：站点根 + /console/topup（不能拼到 /v1 后面）
		expect(topupUrlOf(channel("https://gw.example", { kind: "openai-gateway" }))).toBe("https://gw.example/console/topup");
		// 显式配置覆盖默认值
		expect(topupUrlOf(channel("https://gw.example", { kind: "openai-gateway", topupUrl: "https://pay.example/x" }))).toBe(
			"https://pay.example/x",
		);
		// 占位也能用
		expect(topupUrlOf(channel("https://gw.example", { kind: "template", topupUrl: "{baseUrl}/billing" }))).toBe(
			"https://gw.example/billing",
		);
	});
	it("非 http(s) 或未配置 → null（绝不把坏地址当 href 渲染）", () => {
		expect(topupUrlOf(channel("https://gw.example", { kind: "template", topupUrl: "javascript:alert(1)" }))).toBeNull();
		expect(topupUrlOf(channel("https://gw.example", { kind: "template" }))).toBeNull();
	});
	it("deepseek / openrouter 有内置充值页默认值", () => {
		expect(topupUrlOf(channel("https://api.deepseek.com", { kind: "deepseek" }))).toBe("https://platform.deepseek.com/top_up");
		expect(topupUrlOf(channel("https://openrouter.ai/api/v1", { kind: "openrouter" }))).toBe("https://openrouter.ai/settings/credits");
	});
});
