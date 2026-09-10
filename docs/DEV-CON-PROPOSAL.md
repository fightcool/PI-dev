# PI-dev 综合管理台（dev-con）方案（讨论稿）

- 状态：v1.0——关键决策已拍板（见第 8 节），**尚未实施**；实施排期与首批范围待最终确认
- 日期：2026-09-10
- 环境：开发服务器 `C202609091757997`（dev 用户）
- 框架基础：`leika-1:/opt/fayu/ccswitch-web/`（ccswitch-web v2，在其骨架上拓展）

## 0. 定位（一句话）

dev-con 是这个 AI 远程开发环境的**控制平面**：以 ccswitch-web 为主框架打造，
从渠道/供应商管理出发，逐步长成覆盖**多 Agent、Skills、MCP、插件、系统维护**
的综合管理页面，并最终随 PI-dev 项目整体**打包复用**到新环境。

它不是 ccswitch-web 的复刻：渠道管理只是它的第一个模块；它服务的是
"AI 远程开发项目持续演进过程中的配合性需求"——环境里的任何 AI 能力
（模型渠道、Agent、技能、插件、服务）都可查、可配、可切、可恢复。

## 1. 背景与问题

### 1.1 事故引子（2026-09-10）

happy claude 会话全线报 `API Error: 402 You're out of AI credits`。排查结论：

1. Claude Code 渠道指向中转 `https://www.rightapi.ai/cursor`，额度耗尽，
   实测所有模型 402；Codex 同配置在 rightapi.ai（`/codex/v1`），同生源灭；
2. 叠加问题：会话请求的 `claude-opus-5[1m]` 不在渠道可用模型列表（404）；
3. pi agent 走 cctq.ai，虽未同挂，但同样无监控；
4. 恢复靠人工逐个改配置文件，无告警、无快速切换手段。

### 1.2 系统性问题（推广到整个环境）

| 问题 | 说明 |
|---|---|
| 渠道单点、无监控 | 多个 Agent 压同一家中转；额度/可用性靠业务报错才发现 |
| 配置分散 | 渠道、密钥、Skills、MCP、插件散落在各 Agent 自己的目录，互不可见 |
| 同名资产多副本 | 如 `code-review` 等 Skills 同时存在于 `~/.claude/skills`、`~/.agents/skills`、`~/.zcode/skills`、pi agent `skills/`，无同步机制 |
| 服务运维手工化 | `pi-web-ui-dev.service` 曾被停后无人拉起；无统一的服务状态/日志视图 |
| 环境不可携 | 能力长在各账号目录里，换机器靠手工重放，谈不上打包复用 |

## 2. 愿景与约束

- **愿景**：PI-dev 持续开发，直到成为完善的、可打包复用的远程开发环境；
  dev-con 是这套环境的统一入口——环境里有什么（渠道/Agent/技能/插件/服务）、
  状态如何、怎么改，都从这里走。
- **约束**：
  - 遵守仓库工程规范（AGENTS.md）：dev 用户、systemd --user、分支开发、
    `npm test` / `npm run smoke`、凭据不落仓库与日志；
  - 不动 pi-web-ui 上游包及其发布流程；dev-con 是旁路管理面，不在模型请求
    关键路径上；
  - 框架层尽量沿用 ccswitch-web 的成熟设计与交互（省事），但结构上必须为
    "多模块持续生长"留好扩展点。

## 3. 现状盘点

### 3.1 渠道消费方（Agent）与配置位置

| Agent | 用途 | 渠道配置位置 | 当前渠道 |
|---|---|---|---|
| Claude Code | 终端编码代理 | `~/.claude/settings.json`（env 段） | rightapi.ai/cursor（402 中） |
| happy claude | 手机/远程遥控 Claude Code | 跟随 `~/.claude/settings.json` | 同上 |
| Codex CLI | OpenAI 系编码代理 | `~/.codex/config.toml` + `auth.json` | rightapi.ai/codex/v1 |
| pi agent（pi-web-ui，对外 dev.ftai.cc） | Web 编码代理 | agentDir：`models.json`、`provider-keys.json`、`models-store.json` | cctq.ai、deepseek |
| （后续）其他 Agent | — | 经 Agent 适配器规范接入（见 4.2） | — |

### 3.2 能力资产（Skills / MCP / 插件）现状

| 资产 | 位置 | 问题 |
|---|---|---|
| Skills | `~/.claude/skills`、`~/.agents/skills`、`~/.zcode/skills`、pi agentDir `skills/` | 多处副本、无版本、无同步 |
| MCP | `~/.claude.json`（mcpServers）、`~/.codex/config.toml`（mcp_servers.*）、pi / zcode 各自配置 | 各家格式不同，无统一视图（ccswitch-web v2 已支持 claude/codex 两家） |
| 插件/扩展 | `~/.claude/plugins`（marketplace）、PI-dev `package.json`（pi 扩展：pi-lens、pi-subagents 等，经 PROFILES 管理）、zcode plugins 缓存 | 分散管理，pi 扩展与仓库依赖耦合 |
| 提示词 | `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md` 等 | ccswitch-web v2 已有编辑能力 |

### 3.3 参考实现能力（ccswitch-web v2，作为框架层起点）

- 口令登录（会话 cookie、防爆破锁定）+ 单页管理界面（侧栏导航 + 卡片布局）；
- 供应商档案：增删改/复制/排序/导入导出；一键切换原子写入 live 配置，
  写前自动备份（每目标 10 份）+ 恢复；
- 连通性/模型列表检测、余额查询；MCP 管理（claude/codex）；提示词编辑；
- 首次启动自动从 live 配置导入当前渠道；写入目标与 CC Switch 桌面版兼容。

### 3.4 差距（要长出来的部分）

1. 渠道模块不认识 pi agent；无定时探测/历史可用性/告警（余额端点对 new-api
   类中转无效，需"探测即监控"）；无模型单价展示；
2. 无 Agent 抽象：新增一个 Agent（未来必然）就要重写一遍；
3. 无 Skills/MCP/插件/提示词的跨 Agent 统一管理与同步；
4. 无系统维护视图（服务、日志、nginx/证书、资源、备份）；
5. 部署形态需并入本仓库工程链（dev 用户、systemd --user、npm test）。

## 4. 总体设计

### 4.1 分层架构

```text
┌──────────────────────────────────────────────────────────┐
│ dev-con（127.0.0.1:8791，dev 用户 systemd --user）      │
│                                                          │
│  框架层（源自 ccswitch-web）：认证/会话/布局/卡片组件/      │
│  原子写+备份/恢复/探测客户端/脱敏工具/审计日志              │
│                                                          │
│  模块层（注册式，可插拔）：                                │
│   A 渠道与模型   B Agent 管理   C Skills   D MCP          │
│   E 插件/扩展    F 提示词        G 系统维护                │
│                                                          │
│  适配器层：Agent 适配器（claude/codex/pi/…按规范注册）      │
└──────────────────────────────────────────────────────────┘
      │ 写配置（快照+原子写）        │ 定时探测           │ systemctl --user
      ▼                            ▼                    ▼
  各 Agent 配置文件              各渠道 API          pi-web-ui-dev 等服务
```

关键机制：**模块注册表 + Agent 适配器规范**。框架层只提供登录、布局、
配置写入、备份、探测、审计等公共能力；每个功能模块和每个 Agent 都以注册
方式接入，新增 Agent = 新增一个适配器文件，不改框架。

### 4.2 Agent 适配器规范（扩展性核心）

每个 Agent 适配器声明（一个清单对象）：

```jsonc
{
  "id": "claude",
  "name": "Claude Code",
  "channel": {                       // 渠道模块用：读写哪里、什么格式
    "read": "…", "apply": "…",       // 检测当前渠道 / 应用新渠道
    "protocols": ["anthropic"],
    "restart": null                  // 切换后是否需重启某服务
  },
  "skills": ["~/.claude/skills"],    // Skills 模块用：目录列表
  "mcp": { "format": "claude-json", "path": "~/.claude.json" },
  "plugins": ["~/.claude/plugins"],
  "prompts": ["~/.claude/CLAUDE.md"],
  "service": null                    // 关联 systemd --user 单元（pi 有，claude 无）
}
```

内置首批适配器（按决策 8.4 全量预留）：`claude`（含 happy 跟随）、`codex`、
`gemini`（本机暂未安装，先建档案结构与预设）、`pi`（读写
`provider-keys.json` / `models.json`，切换后提示一键重启 `pi-web-ui-dev.service`）。
后续 Agent 按规范新增适配器文件即可，不改框架。

### 4.3 模块规划

**A 渠道与模型（ccswitch 核心，v0.1 方案全部保留）**

- 统一渠道模型：`{baseUrl, protocol(anthropic/openai-responses/openai-completions),
  keys[](多把命名密钥), modelCatalog, pricing($/M), tags, enabled}`；
- 按消费方一键切换（写前备份、可回滚），切换后按适配器声明联动重启；
- 定时探测：渠道×模型最小请求（`max_tokens ≤ 8`，默认 10 分钟），分类
  `200/401/402(额度尽)/404(模型名不存在)/超时`，SQLite 保留 30 天；
- 状态页对齐 rightapi 公开页信息密度：模型单价 + 24h 可用性柱状条 + 延迟徽章；
- 与 CC Switch live 文件兼容，两边混用不冲突。

**B Agent 管理**

- Agent 清单：已装 Agent、版本、关联服务、当前渠道×模型映射（哪只在用哪家）；
- 单 Agent 操作：打开配置、切换渠道、重启关联服务；
- 为"未来多种 Agent"提供接入面板（适配器注册状态、缺失项提示）。

**C Skills**

- 跨目录扫描（`~/.claude/skills`、`~/.agents/skills`、`~/.zcode/skills`、pi agentDir），
  按技能名聚合视图：每个技能存在于哪些 Agent、内容是否一致（hash 比对）；
- 操作：查看（SKILL.md 渲染）、同步到其他 Agent、删除、（后续）从市场/仓库安装。

**D MCP**

- 统一各 Agent 的 MCP 服务器视图（沿用并扩展 ccswitch-web v2 的 claude/codex
  实现，补 pi / zcode 格式）；
- 操作：增删改（各格式适配写入）、启停标记、连通性检测。

**E 插件/扩展**

- claude 插件（marketplace 列表）、pi 扩展（PI-dev `package.json` 依赖 +
  PROFILES 对应关系）的只读盘点 + 提示性操作（如"把某扩展加入 lean/full profile"）；
- 写操作涉及仓库依赖变更的，生成建议命令而非直接改（避免绕开仓库测试流程）。

**F 提示词**

- 各 Agent 的 CLAUDE.md / AGENTS.md 等提示词文件的查看与编辑
  （沿用 ccswitch-web v2 能力，扩展到 pi 等）。

**G 系统维护**

- 服务管理：systemd --user 单元列表（pi-web-ui-dev、dev-con 自身、后续…），
  状态/启动/停止/重启 + journalctl 最近日志查看（脱敏）；
- 环境健康：磁盘/内存/负载、关键端口监听（8788/8791）、dev.ftai.cc 探活；
  nginx vhost 与证书有效期（只读展示）；
- 工程链入口：触发 `npm test` / `npm run smoke` / `npm run doctor` 并回显结果；
- 备份中心：配置备份（各适配器写入产生）统一列表与恢复；
- 审计日志：所有状态变更操作（谁、何时、改了什么）落盘可查。

### 4.4 安全模型（对齐 AGENTS.md）

- 仅监听 `127.0.0.1`；dev 用户 systemd --user，加固项对齐
  `pi-web-ui-dev.service.in`（`NoNewPrivileges`、`UMask=0077`、`MemoryMax`、`Restart=on-failure`）；
- 口令登录（HttpOnly/SameSite=Strict/12h TTL + 防爆破锁定）；
- **权限分级**：读操作直接放行；写配置（渠道/技能/MCP/提示词）需登录 + 二次确认；
  **服务重启类**操作仅限 systemd --user 范围（dev 用户权限天然可达，无 root）；
  **root 级事务（nginx/cert/系统包）本期只读展示**，变更仍走人工 SSH 流程——
  管理台不持有 sudo 能力；
- 密钥红线：API 响应与 UI 脱敏（前 6 后 4）；日志/审计/备份文件 0600；
  仓库与文档不落真实凭据；脱敏写入测试用例（断言响应快照无明文）；
- 对外暴露方式见决策记录 8（nginx 反代 + 子域名 + 口令）。

### 4.5 数据与目录

```text
仓库内：dev-con/            # 服务端 + 静态页 + 测试 + systemd 单元模板
~/.config/dev-con/          # 运行配置（端口、口令哈希）、渠道档案（0600）
~/.local/state/dev-con/     # 探测历史 SQLite、配置备份、审计日志
```

## 5. API 草案（/api/v1，按模块分组）

```text
POST /api/v1/auth/login | logout | passwd
GET  /api/v1/overview                    # 总览：渠道健康 + 服务状态 + Agent 映射

# A 渠道
GET  /api/v1/channels                    GET /api/v1/channels/history?id=&hours=
POST /api/v1/channels/save | delete | test
POST /api/v1/switch                      # {agent, channelId, model?, keyName?}

# B Agent
GET  /api/v1/agents                      POST /api/v1/agents/restart   # {agent:"pi"}

# C Skills
GET  /api/v1/skills                      POST /api/v1/skills/sync | delete

# D MCP / E 插件 / F 提示词
GET  /api/v1/mcp                         POST /api/v1/mcp/save | delete
GET  /api/v1/plugins                     GET|POST /api/v1/prompts

# G 系统维护
GET  /api/v1/services                    POST /api/v1/services/action  # start|stop|restart
GET  /api/v1/services/logs?unit=&lines=  GET /api/v1/system/health
POST /api/v1/tasks/run                   # npm test / smoke / doctor
GET  /api/v1/backups                     POST /api/v1/backups/restore
GET  /api/v1/audit
```

## 6. 技术选型与部署

- **框架来源**：直接以 ccswitch-web v2 为骨架（认证、布局、卡片页、原子写+备份、
  探测客户端照搬其成熟实现），在此基础上模块化重构。
- **语言（已拍板）**：**Node.js 22、零/极少依赖**，落在仓库 `dev-con/`，
  并入 `npm test`（node --test）/ configure / bootstrap 工程链；
  ccswitch-web v2 的框架实现作为移植蓝本对照。
- 端口：`127.0.0.1:8791`（8788 = pi-web-ui；8787 仓库约定禁用；8790 留 PM2 shadow；
  8791 已确认空闲）。
- 对外暴露（已拍板）：nginx 反代 + 独立子域名 + 访问口令；子域名命名与
  DNS/certbot 变更需在实施前单独确认（涉及 root 操作）。
- systemd --user 单元：`dev-con.service`，模板参照 `deploy/pi-web-ui-dev.service.in`。

## 7. 分期实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 框架落位 + 渠道模块**（事故响应） | 移植 ccswitch-web 框架层（认证/布局/备份/原子写）；渠道 CRUD + claude/codex/pi 三适配器一键切换 + 手动探测 + 备份恢复 + 审计日志 | 模拟 rightapi 402：管理台发现异常，3 次点击内完成全部消费方切换；`npm test` 覆盖适配器读写往返 |
| **M2 监控** | 定时探测器 + SQLite 历史 + 24h 可用性条与单价展示 + pi 服务联动重启 | 停掉主渠道后 10 分钟内状态页变红并留时间线 |
| **M3 能力资产** | Agent 清单页 + Skills 跨目录聚合/同步 + MCP 统一管理（补 pi/zcode）+ 提示词编辑扩展 | `code-review` 技能四处副本在一屏内可见并可一键同步 |
| **M4 系统维护** | 服务管理 + 日志查看 + 环境健康 + 工程链任务 + 备份中心 + 审计页 | 停掉 pi-web-ui 后在管理台发现并一键拉起（呼应本次事故） |
| **M5 打包复用** | 并入 configure/bootstrap/doctor/smoke：新机器一条链路装出完整环境含 dev-con；环境快照导出/导入 | 在干净机器上按 README 从零复刻整个环境 |

## 8. 决策记录（2026-09-10 已拍板）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 语言与代码载体 | **Node.js**：移植 ccswitch-web 框架进仓库，并入 `npm test` 工程链 |
| 2 | 对外暴露 | **nginx 反代 + 独立子域名 + 访问口令**（子域名命名与 DNS/certbot 操作实施前单独确认） |
| 3 | 故障接管策略 | **只做"告警 + 一键切换"**，不允许自动改配置 |
| 4 | 网关模式 | **不做网关**。ccswitch 本身自带渠道管理能力，直接在管理页接入即可；常见 Agent 参照 ccswitch 的做法**全部预留适配器**（claude / codex / gemini / pi，后续按同一规范扩展） |
| 5 | 命名 | **dev-con**（文档与代码目录统一使用该名） |

另有两点按建议默认执行，如无异议不再单独讨论：

- root 级运维（nginx/证书/系统包）本期**仅只读展示**，变更走人工流程；
- pi 适配器切换后的服务重启采用"提示 + 一键重启"（不静默自动重启）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 框架移植引入回归 | M1 先原样移植框架并补测试，再动模块；ccswitch-web 原实现留档对照 |
| 探测消耗渠道额度 | `max_tokens ≤ 8` + 低频；按次计费渠道可单独关闭自动探测 |
| 写坏各 Agent 配置 | 原子写 + 每目标备份 10 份 + 恢复页；适配器读写往返进 `npm test` |
| pi SDK 升级改 provider 格式 | 适配器只触碰稳定字段；升级流程挂 `npm run smoke` 验证 |
| 管理台自身成为攻击面 | 仅回环监听 + 口令 + 权限分级 + 审计；不持有 sudo；密钥全程脱敏 |
| 范围膨胀（综合管理台天然贪大） | 严格按 M1→M5 交付；每个模块先只读盘点、后写操作 |
