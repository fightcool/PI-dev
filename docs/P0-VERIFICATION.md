# P0 技术验证结论（DEV-CON v1.3 §9）

<!-- 🍞 AI Breadcrumb — @COUPLED DEV-CON-PROPOSAL.md §8/§9, CONTEXT.md
     @CONTRACT 本文件只记录 P0 七项的技术结论与可复现证据；产品范围仍以 DEV-CON-PROPOSAL.md 为准。 -->

- 对应基准：[PI-dev 多渠道开发基准（DEV-CON）](DEV-CON-PROPOSAL.md) v1.3 第 8–10 节。
- 状态：**P0 七项已收口**（每一项给出结论 + 代码位置 + 可复现测试）。未验证项在文末单独列出，不计入已验收。
- 验证方式：单测（vitest / node:test）+ 真实 `dist/server` 端到端（本地替身模型端点、合成凭据）。**未使用任何操作人真实凭据或真实模型调用。**

## 结论速览

| P0 项 | 结论 | 证据 |
| --- | --- | --- |
| 凭据隔离 | 用 SDK 现成的请求级取钥钩子 `Agent.getApiKey` 实现**对话级凭据**；渠道切换不写 `auth.json`、不改共享 `ModelRuntime` 的全局 override | `server/agent-service.ts` `makeConversation()`（注入 `getApiKey`）；`server/dev-con/channel-service.ts#credentialFor`；`tests/channel-isolation-test.mjs` |
| 切换时点 | SDK 在**每个 provider 请求前**重新解析模型与密钥（`agent-loop.js:191`、`agent-session.js:304`），因此「本轮结束后应用」是可实现的窄边界：空闲立即应用，忙则待生效并在 `agent_end` 落定 | `server/dev-con/channel-model.ts#planSwitch`；`server/agent-service.ts` `agent_end` → `onConversationSettled` |
| 命令与状态 | 普通渠道选择收敛为单条 `channel_select` 命令（渠道+凭据+模型），服务端串行化 + `configRevision`/`bindingRevision` 复核，回执 `channel_command_result` 带 `phase`（applied/pending/rejected/conflict/superseded）；外部改写文件时冲突可见、刷新后可用新版本重试成功（可恢复） | `server/dev-con/channel-service.ts`（`enqueue` 每条命令先从磁盘对齐、`refresh()`）；`tests/unit/channel-service.test.ts`；`tests/channel-multiclient-test.mjs` |
| 用量身份 | 只有 `message_end`/`turn_end` 的**终结值**累加，并按消息身份（`responseId` 或 role+timestamp）去重；`message_update` 只更新请求级视图；补齐 `totalTokens`/`cacheRead`/`cacheWrite`/`cost` | `lib/usage/token-usage.mjs`；`tests/token-usage.test.mjs` |
| 存储与恢复 | 渠道元数据落在 `<agentDir>/dev-con/channels.json` 旁路文件，**只存引用**（providerId/keyName/modelId），原子写 + 哈希复核；密钥仍在 `provider-keys.json`/`auth.json`，模型目录仍在 `models.json` | `server/dev-con/channel-store.ts`；`tests/unit/channel-store.test.ts` |
| 模块结构 | `server/dev-con/` 分四层：`channel-model`（纯逻辑）/`channel-store`（持久化）/`channel-state`（状态与视图）/`channel-service`+`channel-config`（命令）；各文件功能行数均 < 300 | 见 §8 文件清单 |
| 账户查询 | 首批适配器 = OpenAI 兼容自建网关（`/api/user/self`）+ OpenRouter；**必须由渠道显式配置账户端点**，否则返回 `unsupported`；有界超时/体积上限/禁重定向/限频/缓存/失败保留旧值 | `server/dev-con/channel-accounts.ts`；`tests/unit/channel-accounts.test.ts` |
| 入口安全 | 修复 `models_config` 回传 models.json 明文 apiKey（改为 `hasApiKey` 布尔）；WS 非对象帧不再导致进程退出；新增入口全部走既有 WS 鉴权，未开新面 | `server/model-admin.ts#listModelsConfig/saveModelConfig`；`server/index.ts` message 处理器；`tests/channel-isolation-test.mjs` 末项 |

## 1. 凭据隔离

**问题**：如何在复用模型目录时隔离并行对话授权？

**结论**：SDK 已经支持「按请求取钥」——`Agent.getApiKey(provider)` 在每次 provider 请求前被调用，显式返回值优先于 `auth.json` 与 runtime override（`pi-agent-core/dist/agent-loop.js:191`、`pi-ai/dist/auth/resolve.js:33`）。pi-web-ui 之前从未使用该钩子，所有请求都回落到**共享** `ModelRuntime` 的全局凭据，因此「两把 key 并行」在旧实现下不可能。

实现：`makeConversation()` 为每个对话注入

```ts
runtime.session.agent.getApiKey = (provider) => this.channels.credentialFor(id, provider);
```

`credentialFor` 只认**已生效**绑定（待生效选择不影响本轮在途请求），命中的密钥正文只在该调用内部返回，不进入任何出站消息。未绑定渠道的对话返回 `undefined`，完全保留原有全局解析路径（向后兼容）。

**绑定键的作用域（多端实测修正）**：对话 id 形如 `c1`/`c2`，**只在单个客户端内唯一**（`agent-service.ts#nextConversationId`），而 `channels.json` 是全实例共享的；早期实现直接用 conversationId 当键，两个客户端的「c1」会互相覆盖。现在存储键为 `<clientId>::<conversationId>`，对外（`channel_state`/回执）仍只暴露裸 conversationId。因此：

- **实例级共享**：渠道档案、项目/实例默认、账户状态、`configRevision`——广播给所有客户端（`tests/channel-multiclient-test.mjs` 断言两端 `configRevision` 一致）；
- **客户端隔离**：对话绑定只发布给所属客户端（A05「多端看到相同有效绑定」在实现上等于「同一端的同一对话在任何时刻看到同一服务端确认状态」+「配置与版本一致」）。

**外部修改/多端并发**：每条命令在执行前都从磁盘重读目录（`enqueue` → `refresh()`），因此另一端刚写入的渠道立即可见；写入前用内容哈希复核，冲突时不覆盖外部编辑、并向所有端重推真实状态；绑定写入采用「重载 + 按 bindingRevision 合并」，两端的绑定共存。文件损坏（解析失败）时保留内存态，不因一次读失败把渠道列表清空。

**边界与取舍**：`session.setModel()` 的 `checkAuth` 仍按共享存储判定，所以对话级凭据要求该服务商**至少已有一把全局密钥**（UI 的密钥列表天然满足）。压缩摘要、视觉桥、目标复核等旁路调用仍读取全局 `ModelRuntime`（已记录，见文末未验证项）。

## 2. 切换时点

**问题**：SDK 允许请求间还是 run 结束后切换？

**结论（实测 + SDK 源码）**：模型是**每个 run 快照一次、每个 turn 边界刷新一次**（`agent-session.js:288-310` 的 `prepareNextTurnWithContext` 返回实时 `agent.state.model`；`agent-loop.js:88-96` 消费），单个在途请求在流式期间不会改用新模型。因此：
- SDK 事实上允许「run 内的下一个 turn 换模型」，但那会让同一个 run 的工具链横跨两个渠道；
- 本期选择一个**更窄、可解释**的边界：空闲 → 立即应用；正在生成或有排队 → 记录为待生效，在 `agent_end`（不再自动重试时）应用。在途请求与工具按原绑定跑完，不中止、不重放。

**失败语义**：`setModel` 抛错时绑定保持原值，回执 `phase:"rejected"` 并带原因，UI 明确显示有效绑定未变。

## 3. 命令与状态

- `channel_select` 一次提交 channelId + credentialKeyName + modelId，服务端用 `enqueue` 串行化全部变更，保证版本单调、旧回执不可能晚于新状态。
- `expectedConfigRevision` / `expectedBindingRevision` 不匹配 → `phase:"conflict"`（要求刷新），只改内存不落盘。
- 待生效期间再次选择 → 旧的待生效命令回 `phase:"superseded"`，避免 UI 认为两次都成功。
- 状态推送 `channel_state` 含 `configRevision`、`bindingRevision`、渠道列表（仅密钥**名称**）、默认值、全部绑定与待生效项，并广播给所有客户端（多端一致）。

## 4. 用量身份

旧实现按「每个事件都累加」计账：同一条 assistant 消息会经历 `message_start`(全 0) → N×`message_update` → `message_end` → `turn_end`，被记 **N+2 次**（`tests/token-usage.test.mjs` 第一例即复现该事件序列）。同时 `normalizeUsageEvent` 只取 `input/output`，字段名 `total` 与 SDK 的 `totalTokens` 不符，`cacheRead`/`cacheWrite`/`cost` 被丢弃。

现在：
- 累计只取终结事件（`message_end`/`turn_end`），并按消息身份去重；
- 请求级视图（`current`）覆盖更新，流式期间即可见，但不计入 run/session；
- 计入 `cacheRead`/`cacheWrite`/`cost`/`reasoning`；
- 归属：每次 provider 请求发出时记录当时的绑定快照（渠道/凭据名/模型/绑定版本/配置版本），晚到的用量按该快照归属；来源标注 `user`/`retry`/`subagent`/`compaction`/`vision`/`review`/`wizard`（子代理与复核各自是独立会话，不会并进父会话；未知来源回落 `user`，不伪装成已知来源）。
- **逐请求记录**（§7「记录包含稳定请求/事件标识、对话/运行、渠道/账户引用、模型、绑定/配置版本、用量、时间和计价依据」）：每条终结用量都落一条有界记录（默认最近 100 条，快照下发 50 条），字段为 `id`（provider 响应 id，或 role+timestamp，或 run 内序号）、`at`、`runId`、`conversationId`、`cwd`、`source`、`channelId`、`credentialKeyName`、`providerId`、`modelId`、`bindingRevision`、`configRevision`、token 五元组、`cost`、`costBasis`、`currency`。去重与聚合同源（同一条消息只落一条记录），重试按尝试分别落记录。
- **计价依据**：`costBasis:"sdk-model-pricing"`（SDK 按请求当时的模型价目表算出的 USD，非供应商扣费）+ `currency:"USD"`；事件未带价目时记 `"unknown"` 并且界面显示「未知价格」而不是 0（§7「未知价格为空」）。界面在用量详情里新增「最近请求」表（时间/来源/渠道/模型/total/费用）。
- **历史缺失归属诚实展示**（A07）：会话有用量但没有任何归属记录时，详情面板明确提示「这些历史用量没有渠道归属（记录早于渠道功能或来自无渠道的运行）」，不再显示一张空表。
- 旁路调用（§7 要求「探测分别标注来源」）：视觉桥转写通过 `vision-bridge.ts#onUsage` 上报真实用量并记为 `source=vision`；压缩摘要走 SDK 内部 `completeSimple`、不产生消息事件，改为用 `compaction_start`/`compaction_end` 的**会话统计差值**记为 `source=compaction`（差值非正时不记）。两条路径的归属都取自请求时绑定，`modelId` 统一为裸模型 id，能与普通请求在归属表里合并。

## 5. 存储与恢复

`<agentDir>/dev-con/channels.json`（0600，同目录 tmp+rename 原子写）：

```jsonc
{ "version": 1, "configRevision": 2, "channels": [ … ], "instanceDefault": …, "projectDefaults": {…}, "bindings": {…} }
```

- **只存引用**：`providerId`/`keyName`/`modelId`；写入前用 `findSecretMaterial` 拒绝任何 `apiKey/key/token/secret/headers` 字段，防止出现第二份凭据事实源（`tests/unit/channel-store.test.ts` 有专门断言）。
- **无损失去**：未知顶层字段与未知渠道字段进 `extra` 原样写回。
- **外部修改可见**：写入前复核文件内容哈希，被外部或其他进程改写时返回 `conflict`，不静默覆盖；会话绑定写入采用「重载 + 按 bindingRevision 合并」，避免覆盖另一端刚写的绑定。

## 6. 账户查询

结论：**不做通用余额平台**。适配器契约 + 两个首批实现（OpenAI 兼容自建网关、OpenRouter）；渠道必须在 `extra.account` 显式配置 `{ kind, url, unit, scale }` 才启用，否则状态为 `unsupported`（绝不从 Token 反推余额）。所有查询：5s 超时、64KiB 响应上限、`redirect:"manual"` 且 3xx 视为失败、每账户 10s 限频、5min 缓存；失败时保留上次成功结果与时间并标 `stale`（不显示为 0）。

## 7. 入口安全

- **已修复（高）**：`list_models_config` 之前把 `models.json` 的 `apiKey` 原样下发浏览器（浏览器再回传），违反 §4。现在只回 `hasApiKey: boolean`，保存路径对空值理解为「保留已保存的密钥」，因此不再需要密钥往返，也不会因留空而丢 key。
- **已修复（高）**：WS 收到 `null`/字符串/数组帧时旧实现直接在 `msg.type` 上抛错并终止进程（可达的远程重启）。现在在入口丢弃非对象帧，并把同步异常包成 `notice`，单条畸形命令不再影响进程。
- **未修复但已记录（不在本期入口范围内）**：`/api/auth/recovery` 无限频与锁定、passkey 会话无 CSRF 令牌、`?token=` 查询参数回落、`/api/health` 泄露绝对路径。这些属于既有认证面，按 §4「不扩大成整套认证平台重写」处理，见文末。

## 8. 模块结构与文件规模

`channel-service.ts` 拆分前为 754 行（功能行 609），违反仓库 300 行纪律（self-check 规则 29 / coding-principles 门 3）。现拆为状态层与命令层，行为、公开 API、回执语义与 `channels.json` 格式零变化：

| 文件 | 功能行数 | 职责 |
| --- | --- | --- |
| `server/dev-con/channel-model.ts` | ~243 | 纯类型与纯逻辑（优先级、时点、版本、脱敏、裁剪） |
| `server/dev-con/channel-store.ts` | ~136 | 落盘：原子写、哈希冲突、无损失去、拒绝密钥字段 |
| `server/dev-con/channel-state.ts` | ~254 | 目录内存态、绑定键、选择/凭据解析、视图（`stateMessage`） |
| `server/dev-con/channel-accounts.ts` | ~240 | 账户适配器与限频/缓存/超时 |
| `server/dev-con/channel-service.ts` | ~297 | 命令层：串行化、回执、待生效、校验 |
| `server/dev-con/channel-config.ts` | ~184 | 配置命令：渠道 CRUD、默认值、账户查询 |

## 复现方式与本次实测结果

```bash
# 根工程单测（含用量口径与治理）
npm test                          # 174 passed / 0 failed

# 应用单测：渠道模型/存储/服务/账户 + 既有回归
npm run test:channels:unit        # 46 passed（channel-* 四个文件 + usage-attribution）
env -u NODE_ENV npm --prefix vendor/pi-web-ui exec vitest run   # 620 passed / 75 files
timeout 1200 npm run test:smoke   # 41/41 通过（含新增 channel-isolation / channel-multiclient）

# 浏览器回归（Chromium，合成数据，无真实模型）
npm run test:performance          # login / synthetic-20/200/1000 全部 passed

# 端到端：真实 dist server + 两个对话 + 两把 key + 本地替身模型端点
npm run build && npm run test:channels
npm run test:channels:multi       # 两个客户端：广播一致/外部冲突可见且可恢复/绑定互不覆盖
npm run test:channels:browser     # Chromium（桌面 + 移动视口）：选择器/设置页/账户状态/用量归属+逐请求记录 20 项断言
```

> 注：`vitest` 必须在 `NODE_ENV` 未设为 `production` 的环境下运行，否则 React 会解析到生产构建，既有的 DOM 用例会以 `act(...) is not supported in production builds` 失败（与本次改动无关）。

`npm run test:channels:browser` 在真实 Chromium（合成快照 + 模拟 WS，无真实服务/模型）中断言：有效渠道与待生效渠道同时可见、底部显示有效渠道、选择器按 4 个渠道分组、停用/服务商缺失渠道带原因且没有可点条目、点击「渠道 A + 密钥 2 + 模型」只发出**一条**带 `expectedConfigRevision`/`expectedBindingRevision` 的 `channel_select`、用量详情按来源/渠道展示且无渠道行为「Unattributed」、设置页列出全部渠道并标出服务商缺失、账户状态同时显示 ok/Unsupported/Stale（含 `Balance 12.5 USD` 与「上次成功结果」提示）、查询账户只发 `channel_query_account`、新建渠道发带 revision 的 `channel_save`、移动端视口（390×844）下有效/待生效提示与选择流程同样可用。

`npm run test:channels` 的断言（全部通过）：渠道保存/回执、会话 A 用**非 active** 的「密钥 1」发请求、会话 B 用「密钥 2」、A 的绑定不被 B 的运行改写、选择渠道不改写 `auth.json`、`channel_state` 发布两个绑定、快照暴露当前对话绑定、未知模型被拒绝且原绑定保留、畸形 WS 帧不杀进程。

## 未验证 / 未做（不计入已验收）

1. **DSH 引擎**：明确回 `phase:"rejected"`（换模型=重启运行时），未做任何 DSH 热切换改造。
2. **真实供应商账户查询**：未接入任何真实账号；适配器只对本地替身端点验证。OpenAI 网关的 `quota` 语义（单位/换算）需要真实网关注入后才算验收。
3. **run 内 turn 边界切换**：SDK 支持但本期不启用（见 §2 取舍）。
4. **旁路调用的用量归属**：视觉桥、压缩摘要、目标复核与目标向导均已接入（见 §4 与 `goal-service.ts#reportIsolatedUsage`）；仍未接入的是模型目录探测（只 GET /models，不产生 token）。压缩用会话统计差值，若压缩期间发生其他模型调用会被一并算入（当前 SDK 行为不会）。
5. **多客户端并发编辑渠道配置**：已实现「每条命令先从磁盘对齐 + 哈希冲突检测 + 合并写入」，并有双客户端端到端用例（`tests/channel-multiclient-test.mjs`）；仍未经两个真实浏览器的人工并发验证。
6. **渠道界面的验收范围**：`npm run test:channels:browser` 用真实 Chromium 覆盖 20 项断言——渠道分组、禁用/服务商缺失原因、有效/待生效提示、底部渠道、组合命令携带的 revision、用量归属与「未归属」标记、渠道设置页列表与账户状态（ok/unsupported/stale 与真实数值）、`channel_query_account`、带 `expectedConfigRevision` 的 `channel_save`，逐请求记录表（时间/来源/渠道/模型/费用、未知价格标注、计价依据说明），以及**移动端视口**（390×844，触屏）下同样的选择流程。**未**做真实设备/真机人工验收与真实供应商账号下的界面验收。
7. **非中英文语言包的渠道文案**：新增 88 个 key 已按中文顺序填入 8 个语言包以保证一一对应，但暂时使用英文原文作为占位译文（运行时行为与缺 key 回落英文一致）；正式译文待补。
8. **既有认证面加固**（recovery 限频、CSRF、query token、health 信息）：见 §7，需独立排期。
