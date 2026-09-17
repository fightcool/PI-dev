# UI 服务与 agent 运行时共用事件循环：风险与拆分提案

<!-- 🍞 AI Breadcrumb — @COUPLED docs/PERF-SESSION-LOAD.md §7, docs/STRUCTURE.md（多进程边界）, docs/PM2-PRODUCTION.md（排空与回滚） -->

> 状态：**提案（第一版，未实施）**。本文只规划「把 UI 服务与 agent 运行时拆开」这条结构性改造的路线与验收口径；功能范围仍以 [DEV-CON-PROPOSAL.md](DEV-CON-PROPOSAL.md) 为准，目录与工程边界以 [STRUCTURE.md](STRUCTURE.md) 为准。
> 触发事实：2026-09-16 性能复核（[PERF-SESSION-LOAD.md](PERF-SESSION-LOAD.md) §7）确认线上实例是**一个 Node 进程同时承担** WS/HTTP 服务、agent 运行、工具执行、会话 jsonl 读写与插件宿主。

---

## 1. 问题陈述

单进程单事件循环意味着：**任何一处同步工作，都会同时卡住所有客户端**（WS 增量推送、HTTP 响应、其他标签页与后台对话）。当前已实测到的同步热点：

| 热点 | 量级 | 位置 |
| --- | --- | --- |
| `SessionManager.list(cwd)` / `listAll()` 逐行 `JSON.parse` 每个 transcript | 540 ms / 960 ms（25 文件 / 75 MB） | SDK `core/session-manager.js:442-571`，经 `server/agent-service.ts:4827/4836` |
| 会话快照序列化 `JSON.stringify` | 随会话长度增长（多标签页用 WeakMap 去重，仍是主线程） | `server/index.ts:1067-1074` |
| 子代理归档列表（同步 `readdirSync` + 逐文件 `readFileSync`+`parse`） | 未测，同源 | `server/subagent-archive.ts:76-95` |
| 存储占用遍历 / 系统资源采集 | 有上限（2000 ms / 50000 文件） | `server/dev-con/storage-usage.ts:16,21`、`system-resources.ts:20` |
| `execFileSync("systemctl", …)`（60 s 定时器） | timeout 3000 ms | `server/agent-service.ts:2356` |
| 插件依赖补装 `spawnSync` | 视包体 | `server/plugin-facilities.ts:255-257` |
| **插件代码本身同进程动态 import** | 插件可任意阻塞同一循环 | `server/plugins.ts:1256`（`handleMessage` 只隔离抛错，不隔离 CPU） |

**已核实**：全仓无 `worker_threads` / `new Worker(`；`scripts/start.mjs` 单入口；`deploy/ecosystem.config.cjs` 为 PM2 单实例 fork；systemd unit 共享 cgroup（`MemoryHigh=3G` / `MemoryMax=4G` / `TasksMax=512`）；`server/index.ts:1781` 的 `shutdown()` 是 `process.exit(0)`。

**为什么不能直接上 PM2 cluster**：会话、PTY、WS 状态不是多进程共享的（[STRUCTURE.md](STRUCTURE.md)）；排空判定 `activeConversations`/`pendingMessages` 是单进程聚合（`server/agent-service.ts:6155`），而部署脚本把它当作切版前提（`scripts/maintenance/switch-production-release.mjs:174-184`）。

---

## 2. 现有可用边界（可复用，不必自造）

| 边界 | 位置 | 复用程度 |
| --- | --- | --- |
| **DSH 引擎：UI 进程 + runtime 子进程 + stdio JSON-RPC** | `server/dsh/dsh-client.ts:102-250`（`spawn` + 行分隔 JSON-RPC + `pending` 表 + `kill`/`close`）、`server/dsh/runtime/launcher.mjs` | ★★★★★ 本仓库已有的「runtime 子进程」模板。局限：无 per-session close、无 prompt 取消（中止 = kill 进程树、换模型 = 重启运行时） |
| **SDK 官方 RPC 模式** | `node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js`、`dist/modes/rpc/rpc-client.js`（`RpcClient` 从包根导出）、`docs/rpc.md` | ★★★★★ 协议面无需自造。**限制**：`new_session`/`switch_session` 表明**单活跃会话** → N 个并发对话需要 N 个 RPC 子进程 |
| 控制 socket（已在部署链路里使用） | `server/control-socket.ts:57`，调用方 `switch-production-release.mjs:84-85`、`lifecycle/cutover.mjs:29-37` | ★★★★☆ 跨进程控制面雏形 |
| MCP bridge（外部进程 + 工具桥） | `server/mcp-bridge.ts:77` | ★★★★☆ 证明该模式在本项目可行 |
| 合作式让出（长循环 `await setImmediate()`） | `server/session-search.ts:9,74` | ★★★☆☆ 用于搬不走的循环 |
| node-pty | `server/terminals.ts:894` | ★★☆☆☆ PTY **进程**已隔离，桥接状态仍在内存 |

---

## 3. 三条路线

### A. worker_threads 搬走大块同步工作（最小侵入，推荐第一阶段）

| 切片 | 搬什么 | 落点 |
| --- | --- | --- |
| A1 | **会话扫描**（`list` / `listAll`） | `server/agent-service.ts:4827/4836` 的 loader 注入点已在 `SessionHistoryCache` 里现成可换 |
| A2 | 子代理归档列表 | `server/subagent-archive.ts:76-95` |
| A3 | 快照序列化 | `server/index.ts:1067-1074` —— **先测再决定**：把多 MB 对象 structured-clone 进 worker 的成本可能吃掉收益 |

- 不改协议、不改 WS、不改部署/排空语义 → 回滚 = 切回原 loader（保留 `PI_WEB_SESSION_SCAN=inline` 之类的降级开关）。
- 约束：worker 有独立 isolate，必须显式 `resourceLimits`（主进程的 `--max-old-space-size=2048` 不约束 worker），且 cgroup 仍是共享的 4G / 512 tasks。
- 必须保住 `SessionHistoryCache` 已有的单飞 / supersede 语义（"被更新的扫描取代则重取"，`server/session-history-cache.ts`），跨 worker 后等价重实现并补单测。

### C1. 会话列表后台索引（收益最大，与现有缓存天然合流）

维护**可丢弃**的旁路索引（sidecar jsonl 或 sqlite）：key = transcript 路径，value = `{size, mtimeMs, name, firstMessage, messageCount, modified, searchText}`；失效判据 `(mtimeMs, size)`（与 `Conversation.diskSig` 同一约定）。列表刷新退化为「readdir + stat + 只解析变更文件」。

- 约束：索引**不得成为第二事实源**（[STRUCTURE.md](STRUCTURE.md) 与 DEV-CON「不新增第二份可写事实源」原则）；损坏必须 fail-open 回退全量扫描。
- 2026-09-16 已落地的「签名 gate + 运行中会话豁免」是这条路线的最小版本（不落盘、只在内存里复用）；完整版仅在有侧车索引需求时再做。

### B. agent runtime 拆到独立子进程（最大改动，不建议作为第一阶段）

- 协议面可复用 SDK 官方 `--mode rpc`；但需要**进程池**（每并发对话一个）或上游支持多会话 RPC。
- 必须显式决定归属的状态：runtime/session、WS sinks 与广播、PTY（终端接管 bash）、插件宿主、`WebUIContext`、子代理归档、jsonl 写入（唯一写者）、quiesce/status 聚合。
- 硬前提：排空要覆盖所有进程；`systemctl stop`（`KillMode=control-group`）要收干净；`TasksMax=512` 不被击穿；`shutdown()` 要改成先优雅停子进程。
- 代价：每个 RPC 子进程 = 独立堆 + 独立加载 SDK/扩展（扩展冷转译已在 §2 记录为 1569 ms/次），内存与冷启动都放大；`tasks/`、唤醒订阅、`displaceActive` 保留规则等「同进程才便宜」的约束会被打破。

---

## 4. 推荐顺序与验收

1. **A1（先做）**：把会话扫描搬 worker，带降级开关。
2. **C1（按需）**：若 A1 之后「流式对话打开面板仍卡」，再加侧车索引。
3. **B（另立里程碑）**：只有在「多进程隔离」本身成为需求（例如隔离插件崩溃域、按对话分核）时才启动；启动前先把排空/状态聚合的多进程语义写成新设计。

### 验收指标（A1）

| # | 指标 | 方法 | 通过线 |
| --- | --- | --- | --- |
| 1 | 事件循环阻塞 | 隔离实例 + 心跳客户端，触发 `list_sessions`/`list_projects`，`perf_hooks.monitorEventLoopDelay` 或心跳抖动 | 扫描期间最大 delay 从「≈扫描耗时」降到 **< 50 ms** |
| 2 | 服务端分段 | `tests/performance/server-timing.mjs` | attach / switch 分段不劣化；`list_projects` 冷/热均不劣于基线 |
| 3 | 功能契约 | `node tests/run-smoke.mjs snapshot-delta-test switch-session-background-test multi-device-session-sync-test quiesce-test` | 全绿；`npm run check:protocol` 不变（`PROTOCOL_VERSION` 不动） |
| 4 | 资源 | PM2 RSS / cgroup 上限 / `TasksMax` | 不越界；worker 显式 `resourceLimits` |
| 5 | 失效正确性 | 新增单测：worker 扫描途中被 `invalidate` 覆盖 → 旧结果不得发布 | 通过 |
| 6 | 回退 | 关掉开关走 inline 路径 | smoke 全绿，行为与改前逐字一致 |

---

## 5. 回归面清单（动工时逐项过）

- **单测**：`session-history-cache` / `session-search` / `pi-sessions-root` / `history-window` / `initial-snapshot`（A1/C1）；B 另加 `control-socket-ownership` / `conversation-maintenance` / `subagents` / `plugin-*`。
- **e2e（默认清单内）**：`snapshot-delta-test`、`switch-session-background-test`、`multi-device-session-sync-test`、`quiesce-test`、`conversation-lifecycle-test`、`plugin-test` 系列、`terminal-smoke-test`、`global-search-test`、`left-panel-delete-test`。
- **易漏跑**：`ws-session-test`、`multi-tab-test`、`title-jsonl-test`、`projects-test`、浏览器系列（需本机 Chromium）。
- **文档**：本文件、[PERF-SESSION-LOAD.md](PERF-SESSION-LOAD.md)、[STRUCTURE.md](STRUCTURE.md)（「不能 cluster」的结论在 A 下仍成立、在 B 下必须重写）、[PM2-PRODUCTION.md](PM2-PRODUCTION.md)（排空与逐次升级记录）。
- **部署语义**：quiesce → 等归零 → 切换 → 验收（新 PID / 健康 / build-info 与 release-source 一致 / 公网前端为本版 / 匿名 WS 401）→ unquiesce。

---

## 6. 开放问题（实施前需核实）

1. `RpcClient` / `--mode rpc` 是否支持**多并发会话**（决定 B 是「进程池」还是「1:1」）。
2. worker 首次 `import` SDK 的冷启动耗时（决定是否必须池化/预热）。
3. A3（快照序列化搬 worker）的 structured-clone 成本是否小于收益 —— 必须先测量。
4. 线上进程的真实 loop delay 基线（需要新探针；当前只有 `PI_WEB_TIMING=1` 的分段日志）。
5. `plugin-facilities.ts` 的 `spawnSync` 与 `agent-service.ts:2356` 的 `execFileSync` 在同机上的实际耗时（可能是第二个秒级阻塞点）。
