# 会话加载与切换性能：基线与优化记录

<!-- 🍞 AI Breadcrumb — @COUPLED docs/README.md, vendor/pi-web-ui/server/timing.ts,
vendor/pi-web-ui/web/src/perf-trace.ts, tests/performance/README.md -->

本文记录「打开会话页面慢 / 切换会话卡」两条路径的**实测基线、归因、优化分层与验收口径**。它不是新的需求基准；功能范围仍以 [DEV-CON-PROPOSAL.md](DEV-CON-PROPOSAL.md) 为准，目录与工程边界以 [STRUCTURE.md](STRUCTURE.md) 为准。运行数据、日志和原始性能产物不进入本目录。

## 1. 现象与两条独立路径

用户报告：新打开页面时偶发卡 4~5 秒；切换会话过程有明显停顿。实测归因是**两条成因不同的路径**，必须分开验收。

| 路径 | 主要成因 |
| --- | --- |
| A 新加载页面 | 首份 snapshot 被插件激活门控；首屏 JS 水位串行（WS 握手要等 App + markdown chunk 下载执行） |
| B 切换会话 | 目标会话 runtime 重建（扩展缓存被清）；整份大 snapshot 传输与解析；客户端整列表卸载重挂载 + 同步 markdown |

另有一个纯体验缺陷放大以上数字：切换期间界面停留在**旧会话**且无任何提示，新快照到达后整树重新挂载，用户感知为「点击无反应，然后整页跳一下」。

## 2. 实测基线（本机，warm page cache）

测量环境：开发服务器 `C202609091757997`，线上实例 PM2 `pi-dev-web`（release 构建，SDK 0.85.1）。会话数据 8 个 jsonl / 14.3 MiB，最大 4.06 MB / 1460 条消息。测量期间同机有并发测试负载，数值偏保守。

| 环节 | 实测 | 说明 |
| --- | --- | --- |
| `SessionManager.list(cwd)` | 212–242 ms | 会话列表：逐行全文 `JSON.parse`，主线程 |
| `SessionManager.listAll()` | 225–292 ms | 项目列表：**无任何缓存** |
| `SessionManager.open(3.57MB)` | 62 ms | 切历史会话：同步全文读 + 建索引 |
| 冷序列化 + `JSON.stringify`（1460 条） | 35–45 ms → 2.76 MB | 每份全量 snapshot |
| 冷 jiti 转译已装扩展 | 1569 ms | 每次新建 runtime 触发（`resourceLoader.reload` 清扩展缓存） |
| `rehype-highlight` `detect:true`，无语言代码块 | 79.2 ms/块 | 同内容带 \`\`\`js 仅 11.9 ms |
| 首屏 JS | 1010 KB raw / 313 KB gz | entry 137 + react 143 + App 222 + **markdown 507**；CSS 150/26 |
| 首屏关键路径 RTT | HTML → entry → App(+markdown) → WS → hello → snapshot | markdown chunk 是 App 的静态依赖，被串进 WS 握手之前 |

服务端**单个**步骤都到不了 4~5 秒，但各段串行叠加 + 客户端解析渲染 2.76 MB，合计即为用户可感知的 4~5 秒。唯一能在单跳内吃掉数秒的服务端调用是项目密钥/模型恢复里的 `refresh({ allowNetwork: true })`（远端目录 4 s/次，最多 3 次）。

## 3. 度量口径（怎么读数字）

两端使用同一套阶段名，便于对齐：

- **服务端**：`PI_WEB_TIMING=1` 时，`server/timing.ts` 在 attach / 建会话 / 切会话 / snapshot 各阶段输出一行 `[timing] …`，包含每段毫秒数、`total`、snapshot 构建耗时与 wire 字节数。关闭时零成本（调用点全为可选链）。
- **浏览器**：`web/src/perf-trace.ts` 记录 `boot → ws:open → ws:ready → ws:snapshot → paint`，切换额外记录 `switch:click → paint` 差值。控制台执行 `__piPerf()` 打印瀑布；`localStorage.setItem("pi-perf","1")` 可在控制台实时打印单点。
- **客户端渲染回归**：`npm run test:performance`（`tests/performance/browser.mjs`，模拟 WS + 长任务/DOM 预算）。口径见 [tests/performance/README.md](../tests/performance/README.md)。
- 打点只留在内存（上限 200 条环形缓冲），不发送、不落盘、不含消息正文。

## 4. 优化分层

按「收益/风险」排序，P0 不动协议与产品行为，P1 引入协议变更。

### P0（服务端关键路径 + 客户端渲染热点 + 乐观切换）

| # | 目标 | 落点 |
| --- | --- | --- |
| 1 | 首份 snapshot 不再等插件激活，兜底超时 5 s → 亚秒 | `server/index.ts` hello 链、`server/initial-snapshot-gate.ts` |
| 2 | 项目密钥/模型恢复的**网络刷新**移出关键路径 | `server/agent-service.ts` attach / switchConversation / switchSession |
| 3 | attach / 切会话内部 await 并行化、按 cwd 去重 | 同上 |
| 4 | 高亮语言集收敛 + 高亮/解析结果缓存（保留自动嗅探观感） | `web/src/components/Markdown.tsx` |
| 5 | 工具输出默认折叠 + 消除 memo 失效的新对象 | `web/src/components/ToolCallBlock.tsx`、`Message.tsx`、服务端默认设置 |
| 6 | 去掉切会话的整树重挂载，保住行高测量缓存 | `web/src/app/chat-view.tsx`、`message-list/useRowWindow.ts` |
| 7 | 滚动/流式热点：无依赖 layout effect、每帧逐行测量、滚动期子树查询 | `message-list/useBottomScroll.ts`、`useRowWindow.ts` |
| 8 | 切换「先给帧」：立即进入目标会话并显示骨架/本地缓存 | `web/src/use-chat.ts`、`chat-view.tsx` |

### P1（协议与数据面）

| # | 目标 | 落点 |
| --- | --- | --- |
| 9 | 尾部优先 + 向上分页加载（大历史不再一次全量） | `server/protocol.ts`、`agent-service.ts`、客户端 reducer |
| 10 | 本地会话缓存（stale-while-revalidate），切回近 0 延迟 | 新增客户端缓存模块 |
| 11 | hover/列表打开时预取 | `web/src/components/LeftPanel.tsx` |
| 12 | runtime LRU 复用，避免切历史会话重付扩展转译 | `server/agent-service.ts` |
| 13 | 会话/项目列表扫描加缓存与精确失效 | `server/session-history-cache.ts`、`agent-service.ts` |
| 14 | 首屏 bundle：markdown chunk 真正懒加载 + 关键 chunk 预加载 + i18n 分语言 | `web/vite.config.ts`、`index.html`、`web/src/i18n.tsx` |

## 5. 验收口径

| 指标 | 基线（本机） | 目标 |
| --- | --- | --- |
| 冷启动至会话内容可见 | 约 3–5 s | P0 < 1.5 s；P1 < 1 s |
| 切到运行中的会话：首帧反馈 | 无反馈，1–2 s 后整树跳变 | < 100 ms 有反馈 |
| 切到磁盘历史会话：可读内容 | 约 2–5 s | P0 < 800 ms；P1 < 300 ms |
| 客户端长任务（>50 ms）累计 | `test:performance` 记录 | 不劣化，P1 显著下降 |

数值以同机、同网、同 browser 配置的 before/after 对比为准；绝对时间受宿主负载影响，不写入硬门限。最终验收在 `dev.ftai.cc` 实例上进行（需走构建/发布/切换版本流程，单独授权）。

## 6. 进度

- [x] P0-0 度量基线：服务端分段打点（`server/timing.ts`）+ 浏览器时间线（`web/src/perf-trace.ts`）。
- [ ] P0-1 … P0-8。
- [ ] P1-9 … P1-14。
