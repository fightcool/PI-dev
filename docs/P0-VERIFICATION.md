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

结论：**不做通用余额平台**。适配器契约 + 三个实现：**DeepSeek 官方**、OpenAI 兼容自建网关、OpenRouter。

**DeepSeek 官方（已真实验收）**——官方范式（来源：DeepSeek API Docs → API Reference → Get User Balance）：

```
GET {base}/user/balance            # base 默认 https://api.deepseek.com
Authorization: Bearer <api key>
200 → { "is_available": bool,
        "balance_infos": [ { "currency": "CNY"|"USD",
                             "total_balance": "110.00",      # 字符串金额
                             "granted_balance": "10.00",     # 未过期赠送
                             "topped_up_balance": "100.00" } ] }   # 充值
```

实现要点（`deepSeekAdapter`）：金额按字符串解析（保留精度）；**多币种分别列出**（`breakdown`），不做无依据相加；主条目优先匹配渠道配置的币种，否则取第一条；`is_available=false`（官方含义：余额不足以继续调用）时查询仍算成功，用 `note` 标注而不是报失败；`balance_infos` 为空或缺 `total_balance` 视为**不可识别**（失败，不把 0 当余额）。

真实验收：2026-09-11 用线上已配置的 deepseek 密钥（服务端读取、不打印）实调官方接口 → `status=ok`、`CNY 81.41`（充值 81.41 / 赠送 0）、`checkedAt` 有值。

**用户可配置的查询模板（`server/dev-con/account-template.ts`）**——把「只能选三个写死适配器」变成可配置：

```jsonc
{ "kind": "template", "url": "{baseUrl}/api/user/self", "method": "GET",
  "apiKeyHeader": "authorization", "apiKeyPrefix": "Bearer ",
  "mapping": { "limit": "data.quota", "used": "data.used_quota", "remaining": "data.quota", "scope": "data.display_name", "available": "is_available" },
  "items": { "path": "balance_infos", "currency": "currency", "total": "total_balance", "granted": "granted_balance", "toppedUp": "topped_up_balance" },
  "unit": "USD", "scale": 500000 }
```

- JSON 路径支持数组下标（`balance_infos[0].total_balance`）；金额接受字符串/数字；数组形态逐项映射为多币种 `breakdown`，不做无依据相加；`available=false` 以 note 标注；**映射取不到字段一律失败**（缺失 ≠ 0）。
- `url`/`body` 支持 `{baseUrl}`（取该服务商在模型目录里的 baseUrl）与 `{apiKey}` 占位。
- 三个内置实现降级为**预设**（随 `channel_state.accountPresets` 下发，界面一键填充后可继续改）——不再是写死的死功能。
- 验证：`tests/unit/account-template.test.ts` 8 例（路径/数组下标、字符串金额、多币种与单位优先、网关 scale、缺字段诚实失败、预设可用）；端到端在真实服务端上用替身端点走完「保存模板 → 查询账户 → 解析出余额/单位/scope」。

**渠道模型白名单**：渠道档案新增 `models: string[]`（provider 内模型 id）；空 = 不限制（向后兼容）。白名单非空时，选择校验拒绝名单外模型（`模型不在该渠道的可用列表内`），选择器只列白名单内的模型——解决「渠道里列出一堆用不到的境外模型」。验证：单测（白名单校验/归一化/空白名单不锁死）+ 端到端（名单外被拒、名单内可绑定）。

其余适配器：渠道必须在 `extra.account` 显式配置 `{ kind, url, unit, scale }` 才启用，否则状态为 `unsupported`（绝不从 Token 反推余额）。所有查询：5s 超时、64KiB 响应上限、`redirect:"manual"` 且 3xx 视为失败、每账户 10s 限频、5min 缓存；失败时保留上次成功结果与时间并标 `stale`（不显示为 0）。

## 7. 入口安全

- **已修复（高）**：`list_models_config` 之前把 `models.json` 的 `apiKey` 原样下发浏览器（浏览器再回传），违反 §4。现在只回 `hasApiKey: boolean`，保存路径对空值理解为「保留已保存的密钥」，因此不再需要密钥往返，也不会因留空而丢 key。
- **已修复（高）**：WS 收到 `null`/字符串/数组帧时旧实现直接在 `msg.type` 上抛错并终止进程（可达的远程重启）。现在在入口丢弃非对象帧，并把同步异常包成 `notice`，单条畸形命令不再影响进程。
- **已加固（认证面复查的廉价项，未扩成认证平台重写）**：
  - `/api/auth/recovery` 与口令登录 POST 加**固定窗口限流**（每桶 10 次/60 秒 → 429 + `Retry-After`；成功即清桶），消除无限次爆破面。桶按 socket 远端地址划分（单用户实例部署在回环 + 反向代理后，实际等同全局窗口，已在代码注释与文档说明）。
  - 恢复码**只以 sha256 落盘**（`webauthn.json` 不再出现明文）；旧版明文条目命中时兼容放行并在消费时迁移为哈希；`recoveryCodes()` 改为「一次性明文返回、已有码拒绝回显」（哈希不可逆）。
  - `/api/health` 的**绝对工作区路径 / PID / 版本**只在「已鉴权」或「直连回环且无 `X-Forwarded-*`」时返回；探针仍可匿名拿 `ok`/`engine`，容器与 CI 探针（直连回环）不受影响。这条与部署工具链（`waitForHealth`）兼容：部署脚本正是直连回环探测。
  - `?token=` 回落已有 `PI_WEB_ALLOW_QUERY_TOKEN=0` 开关，本版补齐**回归用例**（关闭后 query token 在受保护路由被拒，header/cookie 仍可用）。
  - 验证：`tests/unit/webauthn-auth.test.ts` 2 例（哈希落盘、旧明文迁移）；`tests/token-auth-test.mjs` 33 项（新增健康详情收敛 3 项、两类限流 3 项、query token 关闭 3 项）。
- **仍未做（已记录，按 §4 不扩成通用认证平台）**：passkey 会话缺少 CSRF 令牌（同站 cookie 已 `SameSite=Strict`，且状态变更入口都在 WS 升级鉴权之后）；`/api/auth/revoke` 无鉴权且恒返回 200（自撤销语义，无越权效果）。

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

## 9. P4 首个切片：跨渠道/项目/时间的用量历史

按用户指示实施 §8 的 P4 首个切片（范围变更已在基准文档第 2/8 节记录）。只做「持久化 + 只读聚合」，不建长期计费平台：

- **持久化**：`recordUsage()` 是唯一入口（普通请求、重试、子代理、压缩摘要、视觉桥、目标复核/向导都经过它），每条终结用量记录以 append-only JSONL 落到 `<agentDir>/dev-con/usage-history.jsonl`（0600；超过 8 MiB 轮转到 `.1`，只保留一代，读取时两代都读）。崩溃最多丢最后一行；写历史失败绝不影响编码请求。
- **聚合**（纯函数 + 存储分离，`server/dev-con/usage-history.ts`）：按 `channel` / `project`(cwd) / `model` / `source` / `day`(UTC) 分组，输出每组请求数、输入/输出/缓存读写/total、估算费用、**未知价格请求数**、首末时间，以及总计；支持时间窗（含端点），扫描上限 20 万行（超出标记 `truncated`）；损坏行跳过并计数。
- **协议/界面**：`usage_history_query` → `usage_history`（协议版本 17）；用量详情面板新增「用量历史」区：分组按钮 + 时间窗（今天/7 天/30 天/全部）+ 聚合表 + 合计行 + 窗口/不完整/损坏说明。分组键缺名字只显示原值并标未归属；未知价格显示「（n 条未知价格）」而不并入费用。DSH 引擎明确回「不提供逐请求用量历史」，不伪造数据。
- **验证**：单测 8 例（五种分组、时间窗、无归属、未知价格计数、轮转、损坏行、扫描上限、文件权限）；端到端在真实 dist server 上跑两次真实（替身 provider）请求后查询历史，断言按渠道分组得到 `ch-a`/`ch-b` 各 1 条、按项目得到 workdir、按天得到 UTC 日期，且 token/缓存字段逐请求与替身上报一致（input 96 / output 12 / cacheRead 20 / cacheWrite 4）、无价目的模型记为未知价格而不是 0；Chromium 断言历史区渲染、分组切换会按新口径查询并带时间窗下界、未归属行可见。

## 10. P4 候选：系统资源展示（只读）

- **采集**：`server/dev-con/system-resources.ts`。CPU 取 `/proc/stat` 两次采样差值（首次返回 null，界面显示「采样中」而不是伪造数字；无 `/proc` 时降级为仅负载）；内存取 `/proc/meminfo`（无则回落 `os.freemem`，并写 warning）；磁盘用 `statfs`（`used = 总量 − 非特权可用`，界面标注为估算）；应用占用分两栏——**本进程 RSS** 与 **systemd unit 的 cgroup 内存**（`memory.current/max/high`，`max` 语义为「无上限」，读不到返回 null）。
- **诚实性**：每个指标随载荷下发来源标签（`proc-stat` / `proc-meminfo` / `statfs` / `cgroup-v2`），读不到的字段显示「—」；告警（`/proc` 不可读、磁盘不可读、cgroup 不可读）随载荷展示。同一文件系统的两个路径只保留一行。
- **协议/界面**：`list_resources` → `resources`（协议 18，双端同步）；设置面板新增「系统」分组，展示 CPU / 内存 / 本应用 / 主机四张卡与磁盘列表，每 5 秒自动刷新并有手动刷新按钮；DSH 引擎共用同一采集（与引擎无关）。
- **验证**：单测 5 例（`/proc/stat` 聚合与使用率算式、meminfo 字节与 MemFree 回落、cgroup `max` = 无上限、注入 io 的完整快照、`/proc` 不可读时的诚实降级）；Chromium 断言 4 项（面板渲染 CPU/内存/应用/磁盘与来源标签、磁盘标注为估算、手动刷新发出 `list_resources`）；真机实测：4 核 / load 1.28、内存 7.8 GiB 中用 0.9 GiB、应用 RSS 90 MiB、unit 上限 4.0 GiB 当前 339 MiB、磁盘 79.6%。

## 11. P4 运维：存储占用明细与用量历史保留

- **存储明细（只读）**：`server/dev-con/storage-usage.ts` 递归统计实例私有区域（uploads / sessions / subagent-archive / usage-history / 渠道元数据 / plugin 数据）。遍历**有界**（`MAX_FILES=50_000`、`MAX_MS=2_000`，超限即停并标 `truncated`），**不跟随符号链接**（避免 release/依赖链接重复计数），路径缺失标 `missing` 而不是报错。区域按占用降序，并标注「可清理候选 / 用户数据」——**删除动作仍由操作人在服务器上执行**，界面不提供删除按钮。
- **保留策略**：`usage-history.jsonl` 除按大小轮转外，新增按天保留（0/7/30/90/365，写入 `<agentDir>/dev-con/usage-settings.json`）。超期记录在下次写入时按 `PRUNE_INTERVAL_MS=5min` 节流清理：临时文件 + rename 原子替换，**只删确实过期的行，损坏行一律保留**（不因清理丢证据）。0 = 只按大小轮转。
- **协议/界面**：`list_storage` → `storage`（含 areas/totalBytes/retention）与 `set_usage_retention`（协议 19）。设置 →「系统」分组新增存储表与保留选择器；存储遍历**不进 5 秒轮询**（只在打开/手动刷新时执行）。删除类操作不提供。
- **验证**：单测 4 例（目录求和与符号链接、单文件区域、缺失路径、遍历上限与排序）+ 保留 2 例（按天清理与非法值归一化、损坏行保留）；Chromium 断言 4 项（存储表与清理提示、保留策略显示、切换保留发出 `set_usage_retention`、重算发出 `list_storage`）；真机实测：sessions 13.3 MiB / 8 文件、usage-history 0.1 MiB、遍历 18 ms。

## 12. P4 运维：诊断快照与资源告警

- **诊断快照（`server/dev-con/ops-diagnostics.ts`）**：一次给出排查最常用的元数据——运行进程（node/pid/uptime/引擎/**协议版本**）、构建来源（build-info 与 release-source 的提交/版本/构建时间）、实例路径与监听地址、systemd unit 状态（`is-active`/`is-enabled`，`systemctl` 不可用时如实报 `unknown`）、资源与存储快照、渠道计数（含引用失效数）、用量汇总（复用 §7 聚合，不另算一套）、环境摘要与 warnings。
  - **只含元数据**：单测用「合成密钥字符串 + `findSecretMaterial`」双断言保证密钥值/密钥形状字段绝不出现；不包含会话内容、提示词、日志正文。
  - `release.*` 反映磁盘上的 build-info（开发 checkout 可能是上次构建的旧值），`app.*` 始终是当前进程——字段注释里写明了这个区别；界面显示「提交 · 协议 · 引擎 · unit 状态」并附隐私说明，可一键下载 JSON（纯客户端 Blob，服务端不写文件）。
- **资源告警（`server/dev-con/ops-alerts.ts`）**：纯判定函数 + 60 秒周期检查（`unref`，随会话释放）。磁盘/内存/unit 内存使用率达到 **85% 警告、90% 严重**；同一资源 **1 小时冷却**（模块级冷却表跨客户端共享，避免多端刷通知）；**读不到的指标不告警**（磁盘 totalBytes=0、cgroup 上限 null 都不当作 0/满）。开关持久化在 `<agentDir>/dev-con/ops-settings.json`（默认开），可在界面切换。
- **协议/界面**：`list_diagnostics` → `diagnostics`、`set_ops_alerts`（协议 20）；设置 →「系统」新增「运维诊断」区与告警开关。DSH 引擎回最小诊断包并说明不提供渠道/用量元数据。
- **验证**：单测 4 例（诊断包组装与「无密钥」双断言、用量汇总映射、阈值与冷却、缺失指标不告警）；端到端在真实 dist server 上断言诊断包返回、含版本/路径/unit/渠道计数、**合成密钥正文与 `apiKey` 字段都不出现在载荷里**、告警开关与阈值随包下发；Chromium 断言 4 项（生成诊断、摘要含协议与 unit 状态及隐私说明、告警开关发出 `set_ops_alerts`）。

## 13. 真实验收发现的两个问题与修复（2026-09-11）

在真实供应商（DeepSeek 官方 + 自建网关）上做验收时发现两处只有真实链路才暴露的问题：

**① 生成中切换的待生效选择可能被永久丢弃**（A03）
- 现象：在真实运行中点切换 → 回执 `pending` 正确；但本轮结束后 1.5 秒内绑定未落定（仍为原渠道）。
- 原因（源码级）：`agent_end` 触发时 `isStreaming` 仍可能为 true —— SDK 明确说明 agent 只有在 `agent_end` 的**监听器全部结束**后才真正空闲；而 `onConversationSettled` 里有 `isBusy` 早退分支且当时没有重试，于是这个待生效项被丢掉，且不会再有事件来应用它。
- 修复：新增 `settlePendingChannelSwitch()`——在 SDK 真正的空闲边界 `agent_settled`（`_isAgentRunActive=false` 后才发）尝试落定，并带**有界重试**（5 × 700ms），覆盖「工具/排队消息紧接下一轮」的时序；`agent_end` 仍保留一次尝试。
- 覆盖与诚实说明：服务端级 e2e 新增「生成中 pending → 本轮结束 applied」用例（此前只有 service 单测覆盖该语义）；但**该用例在快速替身上无法复现原时序**（把修复整体回退后它依然通过），因此它证明的是「路径可用」，修复的直接证据来自真实链路——修复上线后已按同一真实流程复验（见本节末）。

**② 供应商未上报 usage 时被显示成 0 消耗**（A06/A07）
- 现象：自建网关返回空内容且**不带 usage** → 该请求在归属里记为 `requests:1, total:0`，看起来像「没有消耗」。
- 原因：`normalizeUsageEvent` 无法区分「供应商真的报了 0」与「供应商没报」。
- 修复：逐请求记录新增 `usageKnown`（全 0 且无费用 → `false`），用量历史新增 `unreportedRequests` 计数，界面显示「未报告用量 / （n 条未报告用量）」而不是 0；旧记录缺该字段时按「已上报」处理（不误判历史）。协议 23。

**真实链路复验结果**（修复上线后按同一流程复跑）见 `docs/PM2-PRODUCTION.md` 的升级记录与本节后续更新。

## 复现方式与本次实测结果

```bash
# 根工程单测（含用量口径与治理）
npm test                          # 174 passed / 0 failed

# 应用单测：渠道模型/存储/服务/账户 + 既有回归
npm run test:channels:unit        # 46 passed（channel-* 四个文件 + usage-attribution）
env -u NODE_ENV npm --prefix vendor/pi-web-ui exec vitest run   # 646 passed / 80 files
timeout 1200 npm run test:smoke   # 41/41 通过（含新增 channel-isolation / channel-multiclient）

# 浏览器回归（Chromium，合成数据，无真实模型）
npm run test:performance          # login / synthetic-20/200/1000 全部 passed

# 端到端：真实 dist server + 两个对话 + 两把 key + 本地替身模型端点
npm run build && npm run test:channels
npm run test:channels:multi       # 两个客户端：广播一致/外部冲突可见且可恢复/绑定互不覆盖
npm run test:channels:browser     # Chromium（桌面 + 移动视口）：渠道/用量/资源/存储/诊断 35 项断言
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
6. **渠道界面的验收范围**：`npm run test:channels:browser` 用真实 Chromium 覆盖 35 项断言——渠道分组、禁用/服务商缺失原因、有效/待生效提示、底部渠道、组合命令携带的 revision、用量归属与「未归属」标记、渠道设置页列表与账户状态（ok/unsupported/stale 与真实数值）、`channel_query_account`、带 `expectedConfigRevision` 的 `channel_save`，逐请求记录表（时间/来源/渠道/模型/费用、未知价格标注、计价依据说明），以及**移动端视口**（390×844，触屏）下同样的选择流程。**未**做真实设备/真机人工验收与真实供应商账号下的界面验收。
7. **非中英文语言包的渠道文案**：新增 88 个 key 已按中文顺序填入 8 个语言包以保证一一对应，但暂时使用英文原文作为占位译文（运行时行为与缺 key 回落英文一致）；正式译文待补。
8. **既有认证面加固**（recovery 限频、CSRF、query token、health 信息）：见 §7，需独立排期。
