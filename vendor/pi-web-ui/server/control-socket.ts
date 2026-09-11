/**
 * Local control socket for the pi-web-ui server.
 *
 * Lets the CLI (and humans) query status and quiesce/unquiesce the server
 * WITHOUT opening a network port or exposing an unauthenticated HTTP
 * endpoint. Only the local OS user can reach it:
 *   - POSIX: a mode-0600 Unix domain socket at <dataDir>/pi-web-ui.sock
 *   - Windows: a named pipe  \\.\pipe\pi-web-ui-<port>
 *
 * Protocol: one JSON object per line.
 *   → {"cmd":"status"}        ← {"ok":true, ...serviceStatus}
 *   → {"cmd":"quiesce"}       ← {"ok":true}
 *   → {"cmd":"unquiesce"}     ← {"ok":true}
 *   → anything else           ← {"ok":false,"error":"..."}
 *
 * Idle connections are closed after a short timeout so a stuck CLI never
 * holds the socket.
 */
import { createServer, createConnection, type Server, type Socket, connect } from "node:net";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentService } from "./agent-service.js";

/** 控制 socket 只需服务状态与 quiesce 控制（pi/dsh 引擎都满足）。 */
type ControlService = Pick<AgentService, "serviceStatus" | "quiesce" | "unquiesce">;

/** How long a control connection may sit idle before the server closes it. */
const CONTROL_IDLE_TIMEOUT_MS = 5_000;

/** How long the CLI waits for a reply before giving up. */
const CONTROL_CLIENT_TIMEOUT_MS = 3_000;

/** Socket path (POSIX) or pipe name (Windows). */
export function controlPath(dataDir: string, port: number): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\pi-web-ui-${port}` : join(dataDir, "pi-web-ui.sock");
}

export interface ControlCommand {
	cmd: "status" | "quiesce" | "unquiesce";
}

export interface ControlStatus {
	ok: boolean;
	error?: string;
	/** serviceStatus fields, present on "status". */
	pid?: number;
	version?: string;
	cwd?: string;
	quiesced?: boolean;
	quiescedSince?: number;
	connectedClients?: number;
	activeConversations?: number;
	pendingMessages?: number;
}

/** Start the control socket; returns a stop function. */
export function startControlServer(opts: { service: ControlService; dataDir: string; port: number }): () => void {
	const { service, dataDir, port } = opts;
	const path = controlPath(dataDir, port);
	let server: Server;

	if (process.platform === "win32") {
		server = createServer(handleConnection);
	} else {
		server = createServer(handleConnection);
	}
	// A second instance on the same data dir / port would fail to bind — don't
	// crash the server over it, just log and run without a control socket.
	let retried = false;
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code !== "EADDRINUSE") {
			console.warn(`[control] socket error: ${err.message}`);
			return;
		}
		// @BUGFIX 2026-09-11: 旧实现启动时无条件 rmSync(path)，任何第二个实例（哪怕它随后
		// 因端口冲突退出）都会删掉**正在服务**的实例的套接字文件 —— 进程仍在监听，但本地控制
		// 通道变成 ECONNREFUSED（部署脚本无法排空/验收）。现在先探测：有人在服务就不抢、不删。
		probeSocketAlive(path).then((alive) => {
			if (alive) {
				console.warn(`[control] socket ${path} is served by another instance — control socket disabled`);
				return;
			}
			if (retried) return;
			retried = true;
			try {
				rmSync(path);
			} catch {
				/* best-effort */
			}
			console.warn(`[control] removed a stale socket file and will retry: ${path}`);
			server.listen(path, onListening);
		});
	});

	const onListening = (): void => {
		try {
			chmodSync(path, 0o600);
		} catch {
			/* best-effort */
		}
		console.log(`  control    : ${path}`);
	};

	/**
	 * 探测套接字后面是否真的有服务在跑：能连上 = 有活实例（绝不删除、绝不抢占）；
	 * ECONNREFUSED/ENOENT = 陈旧文件（可安全清理后重试）。
	 */
	const probeSocketAlive = (target: string, timeoutMs = 300): Promise<boolean> =>
		new Promise((resolve) => {
			const socket = connect(target);
			const done = (alive: boolean): void => {
				socket.destroy();
				resolve(alive);
			};
			socket.setTimeout(timeoutMs);
			socket.once("connect", () => done(true));
			socket.once("timeout", () => done(false));
			socket.once("error", () => done(false));
		});

	function handleConnection(sock: Socket): void {
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
		}, CONTROL_IDLE_TIMEOUT_MS);
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				timer.refresh();
				let req: ControlCommand;
				try {
					req = JSON.parse(line) as ControlCommand;
				} catch {
					sock.write(JSON.stringify({ ok: false, error: "bad json" }) + "\n");
					continue;
				}
				let resp: ControlStatus;
				switch (req.cmd) {
					case "status":
						resp = { ok: true, ...service.serviceStatus() };
						break;
					case "quiesce":
						service.quiesce();
						resp = { ok: true };
						break;
					case "unquiesce":
						service.unquiesce();
						resp = { ok: true };
						break;
					default:
						resp = { ok: false, error: `unknown cmd: ${String((req as { cmd?: unknown }).cmd)}` };
						break;
				}
				sock.write(JSON.stringify(resp) + "\n");
			}
		});
		sock.on("error", () => {
			/* client vanished */
		});
		sock.on("close", () => clearTimeout(timer));
	}

	if (process.platform === "win32") {
		// net.Server on a named pipe: listen on the pipe name directly.
		server.listen(path, () => {
			console.log(`  control    : ${path}`);
		});
	} else {
		server.listen(path, onListening);
	}
	return () => {
		// @GOTCHA Node 关闭 Unix socket 服务时**自己**会 unlink 该路径（实测：连别人新建的
		// 替换文件也会被删）。因此「谁拥有这个文件」无法靠退出时判断来保护 —— 防线必须在
		// **启动侧**：见上面的 EADDRINUSE 处理，绝不抢占仍在服务的套接字。
		server.close();
	};
}

/**
 * CLI-side client: send one command and return the parsed reply (or null if
 * the server is unreachable / timed out).
 */
export function sendControlCommand(
	dataDir: string,
	port: number,
	cmd: ControlCommand["cmd"],
): Promise<ControlStatus | null> {
	const path = controlPath(dataDir, port);
	return new Promise((resolve) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v: ControlStatus | null): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => finish(null), CONTROL_CLIENT_TIMEOUT_MS);
		let buf = "";
		sock.on("connect", () => {
			sock.write(JSON.stringify({ cmd }) + "\n");
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)) as ControlStatus);
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}
