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
- **浏览器**：`web/src/perf-trace.ts` 记录 `boot → ws:open → ws:ready → ws:snapshot → paint`，切换额外记录 `switch:switch_conversation|switch_session → paint` 差值（配对窗口 15 s）。控制台执行 `__piPerf()` 打印瀑布；`localStorage.setItem("pi-perf","1")` 则每次打点都同时 `console.debug`（刷新后生效）。
- **客户端渲染回归**：`npm run test:performance`（`tests/performance/browser.mjs`，模拟 WS + 长任务/DOM 预算）。口径见 [tests/performance/README.md](../tests/performance/README.md)。
- 打点只留在内存（上限 200 条环形缓冲），不发送、不落盘、不含消息正文。

## 4. 优化分层

按「收益/风险」排序，P0 不动协议与产品行为，P1 引入协议变更。

### P0（服务端关键路径 + 客户端渲染热点 + 乐观切换）

| # | 目标 | 落点 | 状态 |
| --- | --- | --- | --- |
| 1 | 首份 snapshot 不再等插件激活，兜底超时 5 s → 已删除（hello 同步开闸） | `server/index.ts` hello 链、`server/initial-snapshot-gate.ts` | ✅ |
| 2 | 项目密钥/模型恢复的**网络刷新**移出关键路径（显式切换密钥仍是同步的） | `server/agent-service.ts`、`server/model-admin.ts` | ✅ |
| 3 | 高亮语言集收敛（保留自动嗅探观感） | `web/src/components/Markdown.tsx` | ✅ |
| 4 | 工具输出默认折叠 + 消除 memo 失效的新对象 | `web/src/components/ToolCallBlock.tsx`、`Message.tsx`、`server/client-state.ts` | ✅ |
| 5 | 去掉切会话的整树重挂载 | `web/src/app/chat-view.tsx`、`message-list/useRowWindow.ts` | ⏸ 暂缓（见下） |
| 6 | 滚动/流式热点：贴底重复写、滚动期子树查询 | `message-list/useBottomScroll.ts`、`useRowWindow.ts` | ✅ |
| 7 | 切换「先给帧」：乐观切换占位 | `web/src/use-chat.ts`、`chat-view.tsx` | ✅（点击→卸载旧内容→新快照到→挂载；与 P0-5 的 key 重挂载次数相同，没有额外代价） |

**P0-5 为何暂缓**：拆开看，`key={conversationId}` 丢掉的三样东西里，`expanded`（展开的折叠行）
和 `position`（滚动位置）本就应该在新会话里重置，只有行高测量缓存是净损失——而它按消息 id 索引，
跨会话本来也不会命中，所以真实代价只是「多一轮测量 + 重渲染」。相对地，滚动/`escape` 语义有
`@BUGFIX 2026-09-10` 的历史回归记录。等到能在真实环境用 `__piPerf()` 拆出“切→首帧”里
markdown 解析、测量重排、布局各占多少，再决定是否动它。

### P1（协议与数据面）

| # | 目标 | 落点 | 状态 |
| --- | --- | --- | --- |
| 8 | 尾部优先 + 向上分页加载（大历史不再一次全量） | `server/protocol.ts`、`agent-service.ts`、客户端 reducer | 待做（需协议 bump） |
| 9 | 本地会话缓存（stale-while-revalidate），切回近 0 延迟 | 新增客户端缓存模块 | 待做 |
| 10 | hover/列表打开时预取 | `web/src/components/LeftPanel.tsx` | 待做 |
| 11 | runtime LRU 复用，避免切历史会话重付扩展转译 | `server/agent-service.ts` | 待做（内存上限需设计） |
| 12 | 会话/项目列表扫描加缓存与精确失效 | `server/session-history-cache.ts`、`agent-service.ts` | ✅ |
| 13 | 首屏 bundle：markdown chunk 真正懒加载 + 关键 chunk 预加载 + i18n 分语言 | `web/vite.config.ts`、`index.html`、`web/src/i18n.tsx` | 待做 |
| 14 | attach 时 `syncActiveFromDiskIfStale` 的整份 runtime 重建与首快照抢跑 | `server/agent-service.ts` | 待做（仅在“离开期间另一端写过”时触发） |

## 5. 验收口径

| 指标 | 基线（本机） | 目标 |
| --- | --- | --- |
| 冷启动至会话内容可见 | 约 3–5 s | P0 < 1.5 s；P1 < 1 s |
| 切到运行中的会话：首帧反馈 | 无反馈，1–2 s 后整树跳变 | 立即进入占位态（P0-7 已做） |
| 切到磁盘历史会话：可读内容 | 约 2–5 s | P0 < 800 ms；P1 < 300 ms |
| 客户端长任务（>50 ms）累计 | `test:performance` 记录 | 不劣化，P1 显著下降 |

数值以同机、同网、同 browser 配置的 before/after 对比为准；绝对时间受宿主负载影响，不写入硬门限。最终验收在 `dev.ftai.cc` 实例上进行（需走构建/发布/切换版本流程，单独授权）。

验收时同时开服务端 `PI_WEB_TIMING=1`（一行分段日志）与浏览器 `__piPerf()`（端到端时间线），两端阶段名一一对应：

```
服务端: [timing] attach <cid> runtime=… bind=… keys=… model=… snap-full[…]=… snapshot-sent=… | total=…
浏览器: boot → ws:open → ws:ready → ws:snapshot → paint    （切换额外：switch:… → paint）
```

## 6. 进度与实测

| 项 | 状态 |
| --- | --- |
| P0-0 度量基线（服务端分段打点 + 浏览器时间线 + 隔离探针） | ✅ |
| P0-1 首份快照与插件门控解耦（删掉 5 秒兜底） | ✅ |
| P0-2 项目凭据/模型恢复的网络刷新后台化 | ✅ |
| P0-3 高亮语言集收敛 | ✅ |
| P0-4 工具输出默认折叠 + ToolView 引用稳定 | ✅ |
| P0-5 去掉整树重挂载 | ⏸ 暂缓（理由见上） |
| P0-6 滚动路径减负 | ✅ |
| P0-7 乐观切换占位 | ✅ |
| P1-12 列表扫描缓存 | ✅ |
| P1-8/9/10/11/13/14 | 待做 |

### 服务端（隔离实例探针，`node tests/performance/server-timing.mjs`）

| 场景 | 基线 | 当前 |
| --- | --- | --- |
| 冷 attach → 首份 snapshot（200 条会话） | 149–151 ms，但插件激活排在快照之前（插件慢时靠 5 s 兜底） | 166–172 ms（同机抖动 ±20 ms，差异不可比）；关键是顺序：`snapshot-sent` 稳定排在 `plugins` 之前，白屏上限从「5 s 兜底」变为「一次 snapshot」 |
| switch_session → 1460 条会话 | 85–96 ms | 96 ms（含 `open=29 runtime=32 snap-full=11`） |
| switch_session 重复目标（no-op） | 仍答一份快照（探针守住此契约） | 4 ms |
| list_projects | 每次 26 ms（小 fixture；线上 14 MiB 数据约 250 ms） | 首次同前，同交互内二次 2 ms |

隔离实例没有线上的扩展与插件，绝对值远低于线上；这里用于确认改动没有把服务端改慢，及缓存/顺序确实生效。

### 客户端

- `lowlight.highlightAuto`（无标注围栏的语言嗅探，本机实测）：40 行块 37 种语法 53.0 ms → 限定 20 种 16.7 ms；短块 6.2 ms → 1.6 ms。
- 浏览器 harness（`npm run test:performance`，基线 dist vs 当前 dist 各跑一遍）：4 个场景全过、DOM 预算未劣化；1000 条会话 `searchOld` 长任务 451 ms → 292 ms、`jumpOld` 426 ms → 317 ms。注意：harness 的合成消息没有代码围栏、且显式传 `toolsWrap: true`，所以 P0-3/P0-4 的收益不体现在它里。
- 验收用 `__piPerf()`：在真实实例控制台可以看到 `ws:ready → ws:snapshot → paint` 与 `switch:… → paint` 两段墙钟。
