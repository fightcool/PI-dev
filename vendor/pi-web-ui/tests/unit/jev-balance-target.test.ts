/* 🍞 AI Breadcrumb — @COUPLED ../../scripts/jev-gate.ts（`balance` 的实际入口）,
 *   ../../server/dev-con/gateway-usage.ts（被复用的查询实现）,
 *   ../../server/dev-con/gateway-config.ts（谁是网关的解析）
 * 📖 ../../../docs/NEWAPI-GATEWAY.md §4–§5（两条口径、CLI 复用同一份读数）
 * @WHY 这条用例是一次**上线当天踩到的真实缺陷**的回归锁：`balance` 原来拿 Jev 的
 *   `credentialRef.providerId` 去查账单，而那是「谁跑门禁判定」的服务商（可以是 OpenRouter
 *   这类直连上游）。结果是 `查询失败: 服务商 openrouter 未注册地址` —— 一个与用户意图
 *   完全无关的报错。单网关接入后 `balance` 问的是「我们的模型调用花了多少」，
 *   目标必须是**网关**（gatewayProviderId）。
 * @CONTRACT 用例用**替身网关**观察真实请求：只有指向替身的网关会被打到账单接口，
 *   Jev 凭据那个服务商（故意不给 baseUrl）一次都不该被查。
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const s of servers.splice(0)) s.close();
});

/** 替身网关：只认三个账单路径，记录被打到的 URL（响应形状取自 api.ftai.cc 实测回包）。 */
async function stubGateway(): Promise<{ origin: string; hits: string[] }> {
	const hits: string[] = [];
	const server = createServer((req, res) => {
		const url = String(req.url ?? "");
		hits.push(url);
		const json = (body: unknown) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (url.startsWith("/v1/dashboard/billing/usage")) return json({ object: "list", total_usage: 0.73 });
		if (url.startsWith("/v1/dashboard/billing/subscription")) return json({ hard_limit_usd: 100000000 });
		if (url.startsWith("/api/status")) return json({ data: { display_in_currency: false } });
		res.writeHead(404).end("nope");
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return { origin: `http://127.0.0.1:${port}`, hits };
}

function agentDirWith(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "jev-balance-"));
	dirs.push(dir);
	mkdirSync(join(dir, "dev-con"), { recursive: true });
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
	return dir;
}

/**
 * 跑 CLI（冷启动 tsx 约 2–4s，给足超时）。
 * @GOTCHA 必须用**异步** execFile：替身网关跑在本进程里，`execFileSync` 会把事件循环卡死，
 *   替身无法应答，子进程只能等到 8s 超时（实测表现就是「查询超时」）。
 */
function runBalance(dir: string, extra: string[] = []): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			["--import", "tsx", "scripts/jev-gate.ts", "balance", "--agent-dir", dir, ...extra],
			{ encoding: "utf8", timeout: 30_000 },
			(err, stdout, stderr) => {
				const code = err ? ((err as { code?: number }).code ?? 1) : 0;
				resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
			},
		);
	});
}

describe("CLI balance：查的是网关，不是 Jev 凭据的服务商", () => {
	it("Jev 凭据指向直连上游时，仍然只查网关（拿它去查账单会得到「未注册地址」）", async () => {
		const gw = await stubGateway();
		const dir = agentDirWith({
			"provider-keys.json": { newapi: { activeKeyName: "默认", keys: [{ name: "默认", apiKey: "sk-stub" }] } },
			"models.json": {
				providers: {
					newapi: {
						name: "NewAPI 网关",
						api: "openai-completions",
						baseUrl: `${gw.origin}/v1`,
						models: [{ id: "deepseek-flash" }],
					},
				},
			},
			// Jev 的门禁判定跑在直连上游上（没有 baseUrl，本来就不该被查）。
			"dev-con/jev-settings.json": {
				enabled: true,
				endpoint: "https://openrouter.ai/api/alpha/decisions",
				model: "typesafe/jev-1.13",
				credentialRef: { providerId: "openrouter", keyName: "1" },
			},
		});
		const { code, out } = await runBalance(dir);
		expect(out, out).toContain("网关: ");
		expect(out).toContain("已用: $0.0073"); // 0.73 分（不显示本币 → one-api 美分口径）= 0.0073 USD
		expect(out).toContain("累计");
		expect(out).toContain("Jev 门禁用的是 openrouter");
		expect(out).not.toContain("openrouter 未注册地址");
		expect(code).toBe(0);
		// 真正被打到的只有替身网关（而且只打账单接口，不打模型接口）。
		expect(gw.hits.some((h) => h.startsWith("/v1/dashboard/billing/usage"))).toBe(true);
		expect(gw.hits.every((h) => h.startsWith("/v1/dashboard/billing/") || h.startsWith("/api/status"))).toBe(true);
	});

	it("一个服务商都没配时说清楚要配什么，不自作主张", async () => {
		const dir = agentDirWith({
			"dev-con/jev-settings.json": { credentialRef: { providerId: "openrouter", keyName: "1" } },
		});
		const { code, out } = await runBalance(dir);
		expect(code).toBe(3);
		expect(out).toContain("没有可查询的网关");
		expect(out).not.toContain("openrouter");
	});
});
