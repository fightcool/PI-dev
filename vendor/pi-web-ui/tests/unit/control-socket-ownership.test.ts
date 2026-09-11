/* 🍞 AI Breadcrumb — @COUPLED ../../server/control-socket.ts
 * @GOTCHA Node 关闭 Unix socket 服务时会自行 unlink 路径，因此「退出时所有权判断」无法保护替换文件；
 *   防线在启动侧：活套接字绝不抢占/删除，只有确认无人监听（ECONNREFUSED）才清理重试。
 * 📖 docs/PM2-PRODUCTION.md（部署脚本依赖控制套接字做排空与验收）
 * @BUGFIX 2026-09-11: 旧进程退出时无条件删除套接字文件，会删掉新进程刚创建的那一个，
 *   导致进程仍在服务但本地控制通道失效。这里用真实套接字验证「只删自己创建的」。
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { controlPath, sendControlCommand, startControlServer } from "../../server/control-socket.js";

const service = {
	serviceStatus: () => ({
		pid: process.pid,
		version: "test",
		cwd: "/test",
		quiesced: false,
		connectedClients: 0,
		activeConversations: 0,
		pendingMessages: 0,
	}),
	quiesce: () => true,
	unquiesce: () => true,
};

describe("control socket ownership", () => {
	it("never steals a live socket, yet cleans a stale file and retries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dev-sock-live-"));
		const path = controlPath(dir, 8982);
		const stopLive = startControlServer({ service, dataDir: dir, port: 8982 });
		await new Promise((r) => setTimeout(r, 250));
		const liveInode = statSync(path).ino;

		// 第二个实例（例如因端口冲突而启动失败的进程）不得抢占或删除活套接字。
		startControlServer({ service, dataDir: dir, port: 8982 });
		await new Promise((r) => setTimeout(r, 500));
		expect(existsSync(path)).toBe(true);
		expect(statSync(path).ino).toBe(liveInode);
		expect((await sendControlCommand(dir, 8982, "status"))?.ok).toBe(true);
		stopLive();

		// 陈旧文件（无人监听）应被清理并重新监听。
		const staleDir = mkdtempSync(join(tmpdir(), "pi-dev-sock-stale-"));
		const stalePath = controlPath(staleDir, 8983);
		writeFileSync(stalePath, "", { mode: 0o600 });
		const stopFresh = startControlServer({ service, dataDir: staleDir, port: 8983 });
		await new Promise((r) => setTimeout(r, 600));
		expect((await sendControlCommand(staleDir, 8983, "status"))?.ok).toBe(true);
		stopFresh();
	});
});
