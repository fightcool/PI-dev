# NewAPI 单网关接入

<!-- 🍞 AI Breadcrumb — @COUPLED vendor/pi-web-ui/server/dev-con/gateway-usage.ts,
     vendor/pi-web-ui/server/dev-con/gateway-config.ts, vendor/pi-web-ui/server/model-admin.ts,
     vendor/pi-web-ui/web/src/components/GatewaySettings.tsx, docs/STRUCTURE.md -->

本文件是当前接入方式（**唯一入口**：`https://api.ftai.cc/`）的接口事实与口径依据。它回答三件事：
网关是什么、配置写在哪、用量数字怎么读。核对日期 **2026-09-21**（当日实测，证据见 §3）。

旧的「多渠道」模型（渠道档案 + 凭据引用 + 对话绑定 + 每渠道账户查询）已整体移除，历史结论留在
[docs/history/dev-con/](history/dev-con/README.md)，不作为当前实现依据。

---

## 1. 为什么是单网关

多渠道路径的失败模式（历史上真实发生过，见 [P0-VERIFICATION.md](P0-VERIFICATION.md)）：

- **归属会撒谎**：渠道绑定与实际在跑的模型可以不一致，界面必须靠「用模型反推唯一渠道」才敢显示；
- **同一台网关被登记多次**（不同协议/不同模型子集各一条）→ 同一批模型在选择器里出现两遍、用量归属分裂；
- **两套数字**：本地按 token × 价目表估算 vs 渠道账户适配器报的余额，两者本来就不同源。

单网关接入把这些一次性删掉：**只有一个 baseUrl、一把 Key、一份模型清单**，对用户不存在
「服务商/渠道」这个概念（它只是 `models.json` 里的存储细节，SDK 需要 `providers.<id>` 这个结构）。

## 2. 模型

| 概念                         | 落在哪                                                                | 谁写                                                                  |
| ---------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 网关地址 / 协议 / 模型清单   | `models.json` 的 `providers.<id>`（本实例是 `newapi`）                | 设置 → 网关（`save_gateway`）→ `model-admin.writeModelConfig`         |
| 密钥                         | `provider-keys.json`（多密钥表的当前 active 名）或 `models.json` 内联 | 设置 → 网关（`save_gateway`）→ `model-admin.setProviderApiKey`        |
| 谁是网关                     | 派生，不落盘                                                          | `dev-con/gateway-config.ts#resolveGatewayProviderId`                  |
| 模型目录（选择器里能选什么） | 派生                                                                  | `listModels()` → `filterCatalogToProviders`（只列已配置服务商的模型） |

**谁是网关**的优先级（第一条命中即用，见 `gateway-config.ts`）：① 当前生效模型所属的服务商；
② 唯一的已配置服务商；③ 第一个已配置服务商（`models.json` 键顺序）。一个都没有 → `null`，
界面进「首次配置」形态。**没有**「把网关 id 记在配置文件里」这一层：多一份可写指针就多一处会漂移的真相。

**重复接入**（与网关指向同一站点的其它条目，比较时剥掉 `/v1`、`/api/...` 与尾斜杠）由
`sameGatewayDuplicates` 识别，界面在网关分区里提示 + 一键删除。**不自动删**：配置是用户的东西，
删错要能查。本实例当前就有这个情况——`newapi`（`https://api.ftai.cc/v1`，7 个模型）与遗留的
`ftai`（`https://api.ftai.cc`，3 个模型、无成本表）指向同一台网关，且用的是同一把密钥（实测同值）。

## 3. 接口事实（实测）

2026-09-21 用本实例已配置的密钥对本机网关做的只读探测（密钥只在进程内读取，未打印、未落盘）：

| 请求                                     | 结果                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/status`（公开）                | HTTP 200，含 `display_in_currency=true`、`usd_exchange_rate=7.3`、`quota_per_unit=500000` |
| `GET /v1/dashboard/billing/usage`        | HTTP 200 `{"object":"list","total_usage":0.8175999999999999}`                             |
| 同上 + `?start_date=…&end_date=…`        | **同值**；连 `2020-01-01~2020-02-01` 也是同值 → **日期窗口被忽略**                        |
| `GET /v1/dashboard/billing/subscription` | HTTP 200 `hard_limit_usd = 100000000`（= 1e8 占位值，即**不限额度**）                     |
| `GET /v1/models`                         | HTTP 200，返回网关自己的模型目录                                                          |
| `GET /api/user/self`（控制台）           | HTTP 401 `AUTH_UNAUTHORIZED` —— 模型密钥不能读控制台接口                                  |

单位换算（已按上表反推校准）：

```
used_usd = total_usage / 100 / (display_in_currency ? usd_exchange_rate : 1)
```

校准证据：一次 432 in / 16 out 的 `deepseek-flash` 请求让 `total_usage` 增加 **0.72416**，
而该模型在网关上的计价是 `p*2.0 + c*8.0`（USD/1M）→ **0.000992 USD**；`0.72416 / 0.000992 = 730 = 100 × 7.3`
（该站显示的汇率）。**换算必须读 `/api/status`**：不读汇率会把金额放大 7.3 倍，把「显示本币」当成
「美分」又会放大 100 倍。

## 4. 数字怎么读（两条口径，不得相加）

| 口径         | 来源                                   | 含义                                         | 界面位置                                    |
| ------------ | -------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| **网关自报** | 上述账单接口                           | 网关自己记的账：累计已用 +（可能没有的）额度 | 状态栏「网关」项、用量面板顶部、设置 → 网关 |
| **本地估算** | `lib/usage` + `models.json` 的 cost 表 | 按 token × 价目表算的钱                      | 用量面板「费用」、底栏缓存命中项            |

- **绝不显示为实时计费**：网关账单是**异步**统计的，一次请求打完后 `total_usage` 可能 3–6 秒才变。
- **绝不显示为「近 N 天」**：本部署忽略日期窗口（§3），所以默认口径是**累计**；只有走「不带窗口失败
  → 带窗口成功」的回落路径时才回报 `windowDays`，界面才敢说窗口。
- **不猜余额**：`hard_limit_usd ≥ 1e7` 视为「不限额度」占位值 → `limitUsd/remainingUsd = null`，
  界面只说已用。「没有真实额度」和「额度为 0」是两件事。
- **不自动重试「不是网关」**：直连上游（如 `api.deepseek.com`）没有账单接口，这是**永久**事实，
  服务端用 `unsupported` 标志区分「没有这个能力」与「连不上/超时」（后者才值得重试）。
  状态栏只在**有读数**时占位：常驻的红色项只会让人学会忽略它。
- **刷新节奏**：自动轮询 5 分钟一次且**不带 force**（复用服务端 60s 缓存，多客户端只打一个请求）；
  用户点刷新才 `force=true`。

## 5. 协议与代码

| 层                | 位置                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 传输（有界 JSON） | `server/dev-con/http-json.ts`（单请求、不重试、不跟随重定向、64KiB 上限）                                                                                                                                  |
| 查询实现          | `server/dev-con/gateway-usage.ts`（`GatewayUsageService`，8s 超时、60s 缓存、`unsupported` 分流）                                                                                                          |
| 解析规则          | `server/dev-con/gateway-config.ts`（谁是网关、重复接入、目录收窄；纯函数，单测锁规格）                                                                                                                     |
| 配置读写          | `server/model-admin.ts`（`getGateway` / `saveGateway` / `gatewayUsagePort`）                                                                                                                               |
| 协议              | `server/protocol.ts`（`query_gateway_usage` / `gateway_usage` / `get_gateway` / `gateway` / `save_gateway` / `gateway_saved`）                                                                             |
| 界面              | `web/src/components/GatewaySettings.tsx`（设置 → 网关）、`GatewayUsageBlock.tsx`（展示口径唯一实现）、`web/src/gateway-usage.ts`（金额格式与归属判定）、`web/src/app/use-gateway-usage.ts`（自动刷新节奏） |
| CLI               | `scripts/jev-gate.ts balance`（复用同一个 `GatewayUsageService`，经 `gatewayUsagePort` 读地址与密钥）                                                                                                      |

安全边界：密钥只在服务端解析与使用，永不下发浏览器（`UiGatewayConfig` 只回 `hasApiKey`）；
网关请求全部有界（超时 / 响应体上限 / 拒绝重定向）；模型清单从网关读取是**合并式**的
（只新增不删除），不会把用户手工补的模型抹掉。

## 6. 验证方式

```bash
# 规格单测（换算口径、窗口口径、unsupported 分流、谁是网关、目录收窄）
npm --prefix vendor/pi-web-ui exec vitest run tests/unit/gateway-usage
npm --prefix vendor/pi-web-ui exec vitest run tests/unit/gateway-config
npm --prefix vendor/pi-web-ui exec vitest run tests/unit/gateway-usage-view

# 类型检查（双端 + 测试）
npm run typecheck
```

CLI 侧的同一份读数（需要已经配好网关）：

```bash
npm run jev -- balance          # 人类可读
npm run jev -- balance --json   # 原样回包
```

## 7. 破坏性接口变更（有意为之，仓库主人 override 门禁确认）

单网关接入**主动删除**了多渠道那一整套接口，不是顺手清理。CI 门禁对本次改动的
`change_preserves_public_api` 判 **block（0.05–0.15，阈值 0.7/0.15）——这一票判得对**：
按本仓「文档即接口」的口径，下面每一项都是破坏性变更。此处留档为人工确认的依据。

| 变更                                                                                                                                                                                                                                                             | 类型                    | 为什么 / 替代物                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UiCredentialRef` / `UiChannelSelection` / `UiChannelInfo` / `UiChannelBinding` / `UiChannelPending` / `UiAccountStatus` / `UiChannelBindingView` / `ChannelProviderInput`（`server/protocol.ts`）                                                               | **删除类型**            | 渠道档案与凭据引用的数据形状。网关侧的对应物是 `UiGatewayConfig`（地址 + 协议 + 是否已有密钥 + 模型清单）与 `UiGatewayDuplicate`                               |
| `UiUsageRecord` / `UiUsageAttribution` 的 `channelId` / `credentialKeyName` / `bindingRevision` / `configRevision` 字段                                                                                                                                          | **删字段**              | 归属只到「服务商 + 模型」这一层；历史记录里本来就有 `providerId`，不需要第二套引用                                                                             |
| `UiState.channelBinding` / `UiDiagnostics.channels` / `UiDiagnostics.usage.byChannel`                                                                                                                                                                            | **删字段 / 改名**       | 分别是「当前对话绑定的渠道」「渠道计数」「按渠道用量」；单网关下前者无意义，后两者改名 `providers` / `byProvider`                                              |
| 客户端消息 `list_channels` / `channel_select` / `channel_binding_clear` / `channel_save` / `channel_delete` / `channel_set_default` / `channel_query_account` / `fetch_channel_models`                                                                           | **删除消息**            | 渠道的组合选择、热切换、绑定版本与账户查询。替代物：`get_gateway` / `save_gateway`（配置）与 `query_gateway_usage`（用量）                                     |
| 服务端消息 `channel_state` / `channel_command_result` / `channel_models_result`                                                                                                                                                                                  | **删除消息**            | 对应上面的命令与状态推送。网关配置是**按需读**（`get_gateway`），不进快照                                                                                      |
| `usage_history_query.groupBy` 的 `"channel"`                                                                                                                                                                                                                     | **枚举值删除**          | 换成 `"provider"`（分组键 = 记录里的 `providerId`，解析不到名字就显示原 id）                                                                                   |
| `query_gateway_usage` 新增 `force`；`gateway_usage` 新增 `unsupported`；`UiGatewayUsage.windowDays` 变为可选                                                                                                                                                     | **载荷变更**            | 见 §4：自动轮询走缓存、手动刷新才 force；「没有账单接口」与「连不上」必须分开；窗口缺省 = 累计值（该部署忽略日期窗口）                                         |
| `web/src/channel-account.ts` / `channel-models.ts`、组件 `ChannelForm` / `ChannelRow` / `ChannelSettings` / `ChannelAccountModal` / `ChannelModelWhitelist` / `ModelChannelPicker` / `ChannelDialog` / `ChannelFields` / `ChannelModelMeta` / `ModelConfigModal` | **删除模块**            | 全部是渠道配置与账户查询的界面。替代物：`GatewaySettings` + `GatewayUsageBlock` + `gateway-usage.ts`（展示口径）与 `app/use-gateway-usage.ts`（刷新节奏）      |
| `error-hint` 的 `channelErrorView()` / `channelOfError()`                                                                                                                                                                                                        | **删除导出**            | 替代物 `upstreamErrorView()`（服务商 + 模型 + 人话原因），不再有「报错属于哪个渠道」这一步                                                                     |
| `use-chat` 的 `ChannelApi` 返回值；`ModelThinking` / `ChatInput` 的 `providerKeys` 属性                                                                                                                                                                          | **删除导出 / 删除属性** | 渠道命令 API 与「按命名密钥分层」的模型列表；单网关下选择器是平铺的                                                                                            |
| `ModelAdminService.fetchChannelModels()`                                                                                                                                                                                                                         | **删除方法**            | 渠道表单的「按服务商 + 凭据名探测 /models」；替代物 `refreshProviderModels()`（服务端解析密钥、合并式更新）                                                    |
| `scripts/jev-gate.ts balance` 的输出形状与默认 provider                                                                                                                                                                                                          | **CLI 行为变更**        | 改为复用 `GatewayUsageService`：输出「网关 / 已用 / 额度 / 剩余 / 累计口径」，默认服务商由 `gatewayProviderId()` 决定                                          |
| 149 个 `channel*` 前端文案 key；`channelError*` → `upstreamError*`；`usageGroup_channel` → `usageGroup_provider`；`channelRefresh` → `resourcesRefresh`                                                                                                          | **删除 / 重命名 key**   | 8 个语言包与之同步（`tests/unit/locales.test.ts` 锁 key 集合与顺序）。**第三方语言包若按旧 key 集合制作，会因 key 不匹配被 `validatePack` 拒绝**，需要重新导出 |
| `package.json` 的 `test:channels:unit` / `test:channels` / `test:channels:multi` / `test:channels:failures` / `test:channels:browser`                                                                                                                            | **删除脚本**            | 被删掉的渠道功能与它们一一对应                                                                                                                                 |

消费方范围（为什么不留弃用期）：`server/protocol.ts` 是前后端**同时**发布的 wire 协议（`PROTOCOL_VERSION` 已 35 → 36，
旧标签页会被版本号挡下，而不是静默出错）；`web/src/*` 与 `server/*` 同体发布，不存在跨版本消费者；
被删的 i18n key 只被同体界面消费。**唯一的跨版本残留是语言包**（见上表最后两行）。

## 8. 遗留项

1. **`ftai` 重复登记尚未删除**：界面上会提示（设置 → 网关 → 重复接入），删不删由操作者决定；
   它没有成本表，经它调用的用量在本地估算里是「未知价格」。
2. **账单接口在别的部署上可能不同**：本文件的口径来自 api.ftai.cc 的实测；换网关需要重新核对
   `/api/status` 的 `display_in_currency`、`usd_exchange_rate` 与额度占位值（脚本做法见 §3）。
3. **`total_usage` 的准确定义仍是推断**：本部署忽略窗口、返回累计值，但「累计」是推断出的语义
   （该账号只有 9 月的用量，无法与「本月」区分）。界面因此只说「累计」而不写具体时间范围——
   宁可说得更笼统，也不写一个没被证实的时间口径。
4. **管理类接口未接**：`/api/user/self` 等控制台接口需要系统访问令牌，模型密钥读不到（实测 401）。
   要看额度明细请到网关自己的控制台；本项目只读它公开的账单接口。
