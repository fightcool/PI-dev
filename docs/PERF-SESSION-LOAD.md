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

**P0-5 为何暂缓（并建议直接关闭这一项）**：P0-7 上线后它的前提已经不成立。

1. 现在的切换路径是「点击 → `chat.switching=true` → 渲染占位（`chat-view.tsx:146` 的
   `chat.state && !chat.switching`）→ 目标快照到达 → 挂载新会话」——**MessageList 在切换时
   本来就会卸载一次**，这正是 P0-7 想要的效果。即便删掉 `key`，占位分支依然会卸载它，
   删 key 的收益是 0；除非把旧会话内容继续挂着（那就退回「点了没反应」的观感）。
2. 会丢掉的东西本来就不该保：`useRowWindow` 的行高缓存按消息 id 索引，新会话的消息 id 完全不同，
   复用也不会命中；滚动位置、展开的折叠行、搜索状态**本来就该重置**，重挂载是免费且正确地做到这点。
3. 改成手写重置的成本与风险更高：要在 `MessageList`/`useRowWindow`/`useBottomScroll` 各写一段
   `useEffect(reset, [conversationId])`，而滚动语义有明确的回归历史
   （`useBottomScroll.ts:4` 的 `@BUGFIX 2026-09-10`：escape 意图要在窗口切换与流式定稿之间保持）。
   为省下一轮「测量 + 重渲染」（≤80 行，且这些行的 markdown 由 `memo(Markdown)` 按 text 缓存、
   不会重解析）去动这段代码不划算。

如果日后真实数据显示「挂载那一轮」确实是切换延迟的大头（用 `__piPerf()` 读 `switch:… → paint`
与长任务），正确的方向不是删 key，而是让服务端在切换时先只发尾部若干条（即 P1-8），
让首屏挂载的行数下降。

**P1-11 为何复核后不做**：该项的前提是「每切一次历史会话都要重付扩展的 jiti 转译 1.5s」。
复核发现 1569ms 是 jiti **磁盘转译缓存冷启动**时的一次性成本（同目录第二次是 1–2ms），
不是每次切换都付；隔离探针里 `runtime` 段为 27–42ms，线上有 1 个扩展时的量级也是百毫秒级。
也就是说：为了省 ~50–150ms 去保留多个 runtime（内存、扩展宿主生命周期、唤醒订阅等一批
`displaceActive` 已明确保护的约束）风险明显大于收益。留待有真实分段数据证明它是大头时再做。

### P1（协议与数据面）

| # | 目标 | 落点 | 状态 |
| --- | --- | --- | --- |
| 8 | 尾部优先 + 向上分页加载（大历史不再一次全量） | `server/protocol.ts`、`agent-service.ts`、客户端 reducer | 待做（需协议 bump） |
| 9 | 本地会话缓存（stale-while-revalidate），切回近 0 延迟 | 新增客户端缓存模块 | 待做 |
| 10 | hover/列表打开时预取 | `web/src/components/LeftPanel.tsx` | 待做 |
| 11 | runtime LRU 复用 | `server/agent-service.ts` | ❌ 复核后不做（见下：1.5s 是 jiti 磁盘缓存的**首次**成本，不是每次切换的成本） |
| 12 | 会话/项目列表扫描加缓存与精确失效 | `server/session-history-cache.ts`、`agent-service.ts` | ✅ |
| 13 | 首屏 bundle：对话区（含 markdown 渲染器）改为并行预取的动态 chunk | `web/src/app/chat-view.tsx` | ✅（i18n 分语言仍待做） |
| 14 | 磁盘接力重载与首快照抢跑（双份全量 + 旧→新跳变） | `server/agent-service.ts`、`server/index.ts` | ✅（仅在「离开期间另一端写过」时触发） |

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

## 5.5 部署记录

| 时间 | 版本 | 结果 |
| --- | --- | --- |
| 2026-09-11 09:09 | `969ef2a76d18` → **`79525237ee6c`**（PR #21 合并提交） | 成功。排空 → 停 PM2 → 原子换 current → 启动 → 验收（新 PID / 健康 / build-info 与 release-source 一致 / 公网入口发新前端 / 匿名 WS 仍 401）→ unquiesce；中断约 4 秒；失败回滚目标 `969ef2a76d18` 保留 |

### P1-8 的必要性（实测）

真实形态的高熵会话快照（1460 条、含代码块与工具调用）压缩后仍然很大：

| 样本 | raw | deflate level 1 | level 6 |
| --- | --- | --- | --- |
| 合成高熵会话 1460 条 | 1.60 MB | **385 KB**（4.3x） | 298 KB（5.5x） |
| 线上最大会话的 snapshot | 2.76 MB | 估 ~460–640 KB | — |

也就是说大历史每次切换都要在 wire 上传数百 KB；尾部优先（先发最近 ~30 条）能把它降到几十 KB。
代价是要配套解决「客户端 search / 问题导航依赖完整 messages」——两种做法：
①打开搜索或跳到最早已读位置时先补全历史（实现简单，但那一刻要等一次全量传输）；
②服务端提供会话内搜索接口（体验最好，但要新增协议端点与实现）。
这是 P1-8 落地前需要定的产品选择。

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
| P1-13 首屏 bundle（对话区动态 chunk + 并行预取） | ✅ |
| P1-14 接力重载与首快照抢跑 | ✅ |
| P1-8 尾部优先分页 / P1-9 本地缓存 / P1-10 预取 / P1-13 的 i18n 分语言 | 待做 |
| P1-11 runtime LRU | ❌ 复核后不做（理由见上） |

### 服务端（隔离实例探针，`node tests/performance/server-timing.mjs`）

| 场景 | 基线 | 当前 |
| --- | --- | --- |
| 冷 attach → 首份 snapshot（200 条会话） | 149–151 ms，但插件激活排在快照之前（插件慢时靠 5 s 兜底） | 166–172 ms（同机抖动 ±20 ms，差异不可比）；关键是顺序：`snapshot-sent` 稳定排在 `plugins` 之前，白屏上限从「5 s 兜底」变为「一次 snapshot」 |
| switch_session → 1460 条会话 | 85–96 ms | 96 ms（含 `open=29 runtime=32 snap-full=11`） |
| switch_session 重复目标（no-op） | 仍答一份快照（探针守住此契约） | 4 ms |
| list_projects | 每次 26 ms（小 fixture；线上 14 MiB 数据约 250 ms） | 首次同前，同交互内二次 2 ms |

隔离实例没有线上的扩展与插件，绝对值远低于线上；这里用于确认改动没有把服务端改慢，及缓存/顺序确实生效。

### 客户端（P1-13 后）

| 项 | 改前 | 改后 |
| --- | --- | --- |
| App chunk | 222,420 raw | **174,679 raw**，静态依赖只剩 entry + react |
| 「能开 WebSocket」前的 JS 水位 | index+react+App+**markdown** = 312 KB gz | index+react+App = **145 KB gz**（-167 KB） |
| markdown 渲染器 | 阻塞 WS 握手 | 与 hello→首份 snapshot **并行**下载（挂载后立刻预取） |

### 客户端

- `lowlight.highlightAuto`（无标注围栏的语言嗅探，本机实测）：40 行块 37 种语法 53.0 ms → 限定 20 种 16.7 ms；短块 6.2 ms → 1.6 ms。
- 浏览器 harness（`npm run test:performance`，基线 dist vs 当前 dist 各跑一遍）：4 个场景全过、DOM 预算未劣化；1000 条会话 `searchOld` 长任务 451 ms → 292 ms、`jumpOld` 426 ms → 317 ms。注意：harness 的合成消息没有代码围栏、且显式传 `toolsWrap: true`，所以 P0-3/P0-4 的收益不体现在它里。
- 验收用 `__piPerf()`：在真实实例控制台可以看到 `ws:ready → ws:snapshot → paint` 与 `switch:… → paint` 两段墙钟。
