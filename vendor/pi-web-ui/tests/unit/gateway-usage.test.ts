/* 🍞 AI Breadcrumb — @COUPLED ../../server/dev-con/gateway-usage.ts, ../../server/dev-con/http-json.ts
 * 📖 ../../../docs/NEWAPI-GATEWAY.md（接口事实、单位换算的实测证据）
 * @CONTRACT 本用例钉住「网关自报用量」的换算口径：NewAPI 的 total_usage 是**显示币种的分**
 *   （= USD × 100 × (display_in_currency ? usd_exchange_rate : 1)），换算错就是 7.3 倍或 100 倍的
 *   假数字；同时钉住「不限额度占位值不当余额」「查不到就说查不到」「缓存与 force」。
 * 全部用替身 fetch，不联网。
 */
import { describe, expect, it, vi } from "vitest";
import {
	GatewayUsageService,
	UNLIMITED_LIMIT_MIN,
	parseBillingUsage,
	parseDisplayFactor,
	parseSubscriptionLimit,
	siteRootOf,
	type GatewayUsagePort,
} from "../../server/dev-con/gateway-usage.js";

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);

/** 构造一个只认这三个路径的替身网关（响应形状逐字取自 api.ftai.cc 的实测回包）。 */
function stubGateway(overrides: { usage?: unknown; subscription?: unknown; status?: unknown } = {}) {
	const calls: string[] = [];
	const fetchImpl = (async (url: string) => {
		calls.push(String(url));
		const path = new URL(String(url)).pathname + new URL(String(url)).search;
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (path.startsWith("/v1/dashboard/billing/usage")) {
			if (overrides.usage === undefined) return new Response("nope", { status: 404 });
			return json(overrides.usage);
		}
		if (path.startsWith("/v1/dashboard/billing/subscription")) {
			if (overrides.subscription === undefined) return new Response("nope", { status: 404 });
			return json(overrides.subscription);
		}
		if (path === "/api/status") {
			if (overrides.status === undefined) return new Response("nope", { status: 404 });
			return json({ data: overrides.status });
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function port(over: Partial<GatewayUsagePort> = {}): GatewayUsagePort {
	return {
		providerBaseUrl: () => "https://api.ftai.cc/v1",
		providerName: () => "NewAPI 网关",
		resolveProviderKey: async () => "sk-test",
		providerIds: () => ["newapi"],
		...over,
	};
}

describe("gateway usage: URL normalisation", () => {
	it("strips the OpenAI-compatible suffix and keeps the origin", () => {
		expect(siteRootOf("https://api.ftai.cc/v1")).toBe("https://api.ftai.cc");
		expect(siteRootOf("https://api.ftai.cc/v1/")).toBe("https://api.ftai.cc");
		expect(siteRootOf("https://gw.example.com:8443/api/v1")).toBe("https://gw.example.com:8443");
		expect(siteRootOf("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
	});
});

describe("gateway usage: response parsing", () => {
	it("reads total_usage / limits / the display-currency factor", () => {
		expect(parseBillingUsage({ object: "list", total_usage: 0.72416 })).toBe(0.72416);
		expect(parseBillingUsage({ totalUsage: "1.5" })).toBe(1.5);
		expect(parseBillingUsage({})).toBeUndefined();
		expect(parseSubscriptionLimit({ hard_limit_usd: 100000000, soft_limit_usd: 12 })).toBe(100000000);
		expect(parseSubscriptionLimit({ soft_limit_usd: 12 })).toBe(12);
		expect(parseSubscriptionLimit(undefined)).toBeUndefined();
		expect(parseDisplayFactor({ display_in_currency: true, usd_exchange_rate: 7.3 })).toBe(7.3);
		// 不显示本币 = one-api 原始口径（美分）——这是最关键的一支，不能被汇率放大 7.3 倍。
		expect(parseDisplayFactor({ display_in_currency: false, usd_exchange_rate: 7.3 })).toBe(1);
		expect(parseDisplayFactor(undefined)).toBe(1);
	});
});

describe("gateway usage: query", () => {
	it("converts a CNY-displaying NewAPI deployment back to USD (measured calibration)", async () => {
		// 实测：一次 432 in / 16 out 的 deepseek-flash 请求让 total_usage 增加 0.72416，
		// 而该模型公开的计价表达式 p*2.0 + c*8.0（USD/1M）算出 0.000992 USD。
		const { fetchImpl, calls } = stubGateway({
			usage: { object: "list", total_usage: 0.72416 },
			subscription: { hard_limit_usd: 100000000 },
			status: { display_in_currency: true, usd_exchange_rate: 7.3, quota_per_unit: 500000 },
		});
		const service = new GatewayUsageService(port(), fetchImpl);
		const result = await service.query("newapi", { now: T0 });
		expect(result.ok).toBe(true);
		expect(result.usage?.usedUsd).toBeCloseTo(0.000992, 9);
		expect(result.usage?.unlimited).toBe(true);
		expect(result.usage?.limitUsd).toBeNull();
		expect(result.usage?.remainingUsd).toBeNull();
		expect(result.usage?.providerName).toBe("NewAPI 网关");
		expect(result.usage?.baseUrl).toBe("https://api.ftai.cc");
		expect(result.usage?.checkedAt).toBe(T0);
		expect(calls).toContain("https://api.ftai.cc/v1/dashboard/billing/usage");
	});

	it("keeps the raw one-api cents convention when the deployment does not display a local currency", async () => {
		const { fetchImpl } = stubGateway({
			usage: { total_usage: 10 },
			subscription: { hard_limit_usd: 50 },
		});
		const service = new GatewayUsageService(port(), fetchImpl);
		const result = await service.query("newapi", { now: T0 });
		expect(result.usage?.usedUsd).toBeCloseTo(0.1, 9);
		expect(result.usage?.limitUsd).toBe(50);
		expect(result.usage?.remainingUsd).toBeCloseTo(49.9, 9);
		expect(result.usage?.unlimited).toBe(false);
	});

	it("treats the one-api/new-api unlimited placeholder as 'no balance to report'", async () => {
		const { fetchImpl } = stubGateway({
			usage: { total_usage: 1 },
			subscription: { hard_limit_usd: UNLIMITED_LIMIT_MIN, soft_limit_usd: UNLIMITED_LIMIT_MIN },
		});
		const service = new GatewayUsageService(port(), fetchImpl);
		const result = await service.query("newapi", { now: T0 });
		expect(result.usage?.unlimited).toBe(true);
		expect(result.usage?.limitUsd).toBeNull();
		expect(result.usage?.usedUsd).toBeTruthy();
	});

	it("falls back to the dated window when the plain usage endpoint is unavailable", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			const u = String(url);
			calls.push(u);
			if (u.includes("start_date")) {
				return new Response(JSON.stringify({ object: "list", total_usage: 2 }), { status: 200 });
			}
			if (u.includes("/v1/dashboard/billing/usage")) return new Response("no", { status: 400 });
			return new Response("no", { status: 404 });
		}) as unknown as typeof fetch;
		const service = new GatewayUsageService(port(), fetchImpl);
		const result = await service.query("newapi", { now: T0 });
		expect(result.ok).toBe(true);
		expect(result.usage?.usedUsd).toBeCloseTo(0.02, 9);
		expect(calls.some((c) => c.includes("start_date=") && c.includes("end_date="))).toBe(true);
	});

	it("reports failures honestly instead of guessing numbers", async () => {
		// 1) 没有可用密钥
		const noKey = new GatewayUsageService(port({ resolveProviderKey: async () => null }), stubGateway({}).fetchImpl);
		expect(await noKey.query("newapi", { now: T0 })).toMatchObject({ ok: false });
		// 2) 服务商没有注册地址
		const noUrl = new GatewayUsageService(port({ providerBaseUrl: () => undefined }), stubGateway({}).fetchImpl);
		expect((await noUrl.query("newapi", { now: T0 })).error).toContain("未注册地址");
		// 3) 网关没有账单接口
		const noBilling = new GatewayUsageService(port(), stubGateway({}).fetchImpl);
		expect((await noBilling.query("newapi", { now: T0 })).error).toContain("未提供用量接口");
		// 4) 非 http(s) 地址
		const bad = new GatewayUsageService(port({ providerBaseUrl: () => "ftp://gw" }), stubGateway({}).fetchImpl);
		expect((await bad.query("newapi", { now: T0 })).error).toContain("http(s)");
	});

	it("caches a successful result for the TTL and bypasses it on force", async () => {
		const { fetchImpl, calls } = stubGateway({ usage: { total_usage: 4 } });
		const service = new GatewayUsageService(port(), fetchImpl);
		await service.query("newapi", { now: T0 });
		const afterFirst = calls.length;
		await service.query("newapi", { now: T0 + 1_000 });
		expect(calls.length).toBe(afterFirst);
		await service.query("newapi", { now: T0 + 1_000, force: true });
		expect(calls.length).toBeGreaterThan(afterFirst);
	});

	it("只在带窗口那次成功时才报 windowDays（该部署忽略窗口 → 累计口径）", async () => {
		// 实测 api.ftai.cc：start_date/end_date 被完全忽略，2020 年的窗口与不带窗口同值。
		// 所以不带窗口成功时 windowDays 必须缺省 —— 界面据此说「累计」而不是「近 30 天」。
		const plain = await new GatewayUsageService(port(), stubGateway({ usage: { total_usage: 730 } }).fetchImpl).query(
			"newapi",
			{ now: T0 },
		);
		expect(plain.ok).toBe(true);
		expect(plain.usage?.windowDays).toBeUndefined();

		// 只有「不带窗口失败 → 带窗口成功」这条回落路径才敢报窗口。
		const dated = (async (url: string) => {
			const u = String(url);
			if (u.includes("start_date"))
				return new Response(JSON.stringify({ object: "list", total_usage: 730 }), { status: 200 });
			return new Response("no", { status: 400 });
		}) as unknown as typeof fetch;
		const fallback = await new GatewayUsageService(port(), dated).query("newapi", { now: T0 });
		expect(fallback.ok).toBe(true);
		expect(fallback.usage?.windowDays).toBe(30);
	});

	it("把「这台网关没有账单接口」与「网关连不上」分开报（unsupported）", async () => {
		// ① 端点不存在（404）→ 永久事实：界面应停止重试，也不该在状态栏常驻报错。
		const noBilling = await new GatewayUsageService(port(), stubGateway({}).fetchImpl).query("newapi", { now: T0 });
		expect(noBilling).toMatchObject({ ok: false, unsupported: true });

		// ② 网络层失败 → 暂时故障：值得重试。
		const failing = (async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const transport = await new GatewayUsageService(port(), failing).query("newapi", { now: T0 });
		expect(transport.ok).toBe(false);
		expect(transport.unsupported).toBeFalsy();
	});

	it("never throws on a hung/failing gateway (bounded, single attempt)", async () => {
		const failing = (async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const service = new GatewayUsageService(port(), failing);
		const result = await service.query("newapi", { now: T0 });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("ECONNRESET");
		// 重定向按策略拒绝（不做跟随）→ 如实报「没有用量接口」而不是跟着跳走。
		const redirecting = (async () =>
			new Response("", { status: 301, headers: { location: "https://evil.example" } })) as unknown as typeof fetch;
		const redirected = await new GatewayUsageService(port(), redirecting).query("newapi", { now: T0 });
		expect(redirected.ok).toBe(false);
		const spy = vi.fn();
		expect(spy).not.toHaveBeenCalled();
	});
});
