// 模型目录自愈 + 目录变更广播（零 token，本地替身服务商）。
//
// 复现的真实故障（2026-09-18）：服务在跑 → 用户新加了一个服务商（models.json 被改写）→
// 旧会话的模型选择器里该渠道显示「该渠道暂无可用的模型」，刷新页面也没用（同 clientId 会复用
// 同一个 ClientSession / ModelRuntime）。根因：SDK 的 ModelRuntime 只在构造时读一次 models.json，
// 而当时唯一的再读入口是「通过 UI 保存服务商」——只对发起那次保存的会话生效。
//
// 断言（每条都对应一处代码承诺，见 server/model-catalog-freshness.ts 与
// ClientSession.ensureFreshModelCatalog / onModelCatalogChanged）：
//   1. 基线：list_models 只给 main/mock-a
//   2. 自愈：服务在跑时改写 models.json 加 extra 服务商 → **同一个**会话再 list_models 就能看到
//      （用户症状的直接回归测试；无自愈时这里会永久看不到）
//   3. 无变更时不自愈：文件没动 → 不会每次 list_models 都白 refresh（用同一份戳断言行为等价）
//   4. 广播：A 会话保存服务商 → **B 会话**（自己的 runtime 快照）不等请求就收到含新服务商的 models
//   5. 删除服务商同样广播（目录变小的方向也要跟得上）
//
// Usage: npm run build && node tests/model-catalog-freshness-test.mjs [port]
// 注：裸跑时要剥掉宿主环境（隔离实例要求鉴权），冒烟跑器已处理：
//   env -u PI_WEB_TOKEN -u PI_WEB_MANAGED node tests/model-catalog-freshness-test.mjs
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const PORT = Number(process.argv[2] || 8900 + (process.pid % 100) * 2);
const base = mkdtempSync(join(tmpdir(), "pi-web-catfresh-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const modelsPath = join(agentDir, "models.json");
/** 写一份 models.json（服务在跑时也能安全改写：这正是被测场景）。 */
function writeModels(providers) {
	writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2));
}
// 替身服务商：baseUrl 指向必然连不上的端口（本测试不发模型请求，只看目录）。
const mockProvider = (id, models) => ({
	[id]: { api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: `${id}-key`, models },
});
writeModels({ ...mockProvider("main", [{ id: "mock-a" }]) });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({}));

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

class Client {
	constructor(ws, label) {
		this.ws = ws;
		this.label = label;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** 取一条匹配的消息（消费掉，避免反复命中同一条）。 */
	async waitFor(type, timeout = 15000, pred) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type !== type) continue;
				if (pred && !pred(m)) continue;
				this.received.splice(i, 1);
				return m;
			}
			await sleep(50);
		}
		throw new Error(`${this.label}: timeout waiting for ${type}`);
	}
	/** 「再等一会儿，确认不会再来了」——用于断言没有多余推送。 */
	async expectNo(type, ms) {
		await sleep(ms);
		const hit = this.received.find((m) => m.type === type);
		return !hit;
	}
	clear() {
		this.received = [];
	}
}

async function connect(label) {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			const c = new Client(ws, label);
			c.send({ type: "hello", clientId: label });
			await c.waitFor("ready", 10000);
			return c;
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

/** 一次 list_models 请求 → 返回 id 列表（"provider/model"）。 */
async function listModels(c) {
	c.clear();
	c.send({ type: "list_models" });
	const msg = await c.waitFor("models", 10000);
	return msg.models.map((m) => m.id);
}

let clean = false;
async function cleanup() {
	if (clean) return;
	clean = true;
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {
		/* gone */
	}
}
process.on("exit", () => void cleanup());
process.on("SIGINT", async () => {
	await cleanup();
	process.exit(1);
});

try {
	await sleep(1200);
	const a = await connect("catfresh-a");
	const b = await connect("catfresh-b");

	console.log("① 基线：目录里只有 main/mock-a");
	const first = await listModels(a);
	check("基线含 main/mock-a", first.includes("main/mock-a"));
	check("基线不含 extra/mock-b", !first.includes("extra/mock-b"));

	console.log("② 服务在跑时改写 models.json（用户新加服务商）→ 同一会话应自愈");
	writeModels({ ...mockProvider("main", [{ id: "mock-a" }]), ...mockProvider("extra", [{ id: "mock-b" }]) });
	const healed = await listModels(a);
	check("自愈后能看到 extra/mock-b", healed.includes("extra/mock-b"));
	check("原有 main/mock-a 仍在", healed.includes("main/mock-a"));

	console.log("③ 文件没变时不自愈（等价性：再列一次结果一致）");
	const again = await listModels(a);
	check("目录稳定（两次一致）", JSON.stringify([...again].sort()) === JSON.stringify([...healed].sort()));

	console.log("④ A 保存服务商 → B 会话不等请求就收到新目录（广播）");
	b.clear();
	// save_model_config 会走 models.json 写入 + runtime 热加载 + 推送所有会话。
	// 缺 baseUrl 的自定义服务商会被拒，所以带上一个必然连不上的地址（本测试不发模型请求）。
	a.send({
		type: "save_model_config",
		providerId: "pushed",
		config: {
			providerId: "pushed",
			name: "pushed",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:9",
			apiKey: "pushed-key",
			models: [{ id: "mock-c" }],
		},
	});
	const pushed = await b.waitFor("models", 15000, (m) => m.models.some((x) => x.id === "pushed/mock-c"));
	check(
		"B 收到含 pushed/mock-c 的目录（无需自己请求）",
		pushed.models.some((m) => m.id === "pushed/mock-c"),
	);
	check("写入后 models.json 确实落盘", readFileSync(modelsPath, "utf8").includes("pushed"));

	console.log("⑤ 删除服务商 → 同样广播（目录变小也跟得上）");
	b.clear();
	a.send({ type: "delete_model_config", providerId: "pushed" });
	const shrunk = await b.waitFor("models", 15000, (m) => !m.models.some((x) => x.id === "pushed/mock-c"));
	check("B 收到不含 pushed 的目录", !shrunk.models.some((m) => m.id === "pushed/mock-c"));
	check(
		"extra/mock-b 不受影响",
		shrunk.models.some((m) => m.id === "extra/mock-b"),
	);

	console.log(`\n${process.exitCode ? "FAILED" : "ALL PASS"} — ${passed} checks`);
} catch (err) {
	console.log(`  ✗ ERROR: ${err.message}`);
	process.exitCode = 1;
} finally {
	await cleanup();
	await sleep(200);
}
