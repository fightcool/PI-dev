/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/channel-accounts.ts
 * 📖 ../../../docs/DEV-CON-PROPOSAL.md §7（余额/配额、限频、失败/过期状态）、§9（账户查询）、§10 A08/A09
 * 用本地 HTTP 替身验证：不支持/成功/失败/超时/超长响应/重定向/限频/缓存与旧值保留。
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AccountRegistry, deepSeekAdapter } from "../../server/dev-con/channel-accounts.js";
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

	it("parses an OpenAI-compatible gateway balance with the configured scale and unit", async () => {
		const base = await stub((url, res) => {
			expect(url.pathname).toBe("/api/user/self");
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
		expect(await registry().query(channel(bad), () => "sk")).toMatchObject({ status: "failed", error: "账户接口返回 HTTP 500" });

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

		expect(await registry().query({ ...channel(bad), credentialRef: null }, () => "sk")).toMatchObject({
			status: "failed",
			error: "该渠道未绑定命名凭据，无法查询账户",
		});
		expect((await registry().query(channel(bad), () => null)).error).toBe("命名凭据已不存在");
	});

	it("gives up after the bounded timeout instead of hanging the request path", async () => {
		const slow = await stub(() => {
			/* never respond */
		});
		const started = Date.now();
		const result = await registry({ timeoutMs: 150 }).query(channel(slow), () => "sk");
		expect(result.status).toBe("failed");
		expect(result.error).toBe("查询超时");
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
		const second = await r.query(channel(base), () => "sk");
		expect(calls).toBe(1);
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
