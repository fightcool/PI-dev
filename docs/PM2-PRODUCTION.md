# PM2 生产运行与版本更新

<!-- 🍞 AI Breadcrumb: @COUPLED scripts/pm2.mjs, scripts/lifecycle/pm2-manager.mjs, deploy/pi-dev-pm2.service.in, deploy/ecosystem.config.cjs
     @COUPLED scripts/cutover.mjs, scripts/lifecycle/cutover.mjs, tests/pm2-manager.test.mjs
     @CONTRACT 本文描述生产 manager 与人工编排流程；既有 release CLI 仍用于 shadow。 -->

生产入口采用用户级 `pi-dev-pm2.service` 启动前台 `pm2-runtime`，PM2 管理唯一的 `pi-dev-web` 应用，使用单实例 fork。systemd 负责 PM2 supervisor 的启动与故障恢复，PM2 负责应用重启。会话、PTY 和 WebSocket 状态尚不支持多实例共享，不启用 cluster。

当前部署用户为 `dev`，入口为 `dev.ftai.cc`，应用绑定回环地址的 8788 端口。unit 模板中的 WebAuthn RP ID 与 origin 对应该入口；换域名时需要先审查模板及应用配置。服务与可编辑 checkout 分离，目录边界见 [STRUCTURE.md](STRUCTURE.md)。

## 持久目录与工具

默认 deployment root 为 `$HOME/.local/share/pi-dev/deploy`；当前服务器对应 `/home/dev/.local/share/pi-dev/deploy`。通过 `PI_DEV_DEPLOY_ROOT` 可指定其他专用绝对路径。目录结构如下：

| 路径，相对 deployment root | 用途 |
| --- | --- |
| `releases/<id>/` | 独立安装、构建并验证的版本 |
| `current` | 指向 `releases/` 下版本的符号链接 |
| `tools/node/bin/node` | 稳定 Node 运行入口，由部署编排准备 |
| `tools/python-env/` | 稳定 Python 环境，由部署编排准备 |
| `tools/pm2/` | 独立 PM2 工具安装目录 |
| `shared/pm2/` | 固定 `PM2_HOME`，包含 supervisor PID、socket 等运行状态 |
| `shared/logs/` | PM2 应用输出与错误日志 |
| `shared/migrations/status.json` | 初次迁移编排写入的状态摘要 |

`PI_DEV_CONFIG_DIR` 默认 `$HOME/.config/pi-dev`，必须是已存在的绝对目录。配置、访问令牌、会话、workspace、Agent 数据继续使用既有位置；manager 仅检查配置目录，不读取或复制其中的凭据文件。应用启动时沿用已有 runtime 配置。部署根目录及受管理的 shared 目录不能经过符号链接。

PM2 固定为 **6.0.8**，依赖与锁文件位于 `deploy/pm2/package.json` 和 `deploy/pm2/package-lock.json`。准备工具时，将这两个清单复制到 deployment root 的 `tools/pm2/`，在该目录使用稳定 Node 对应的 npm 执行 `npm ci --omit=dev --no-audit --no-fund`。这一步由部署编排执行，`pm2 install` 不安装 npm 依赖。不要全局安装 PM2，也不要将工具依赖安装到开发 checkout 的根 `node_modules`。

## 管理命令

从包含本实现的仓库或 release 根目录执行：

```bash
npm run pm2 -- --help
npm run pm2 -- status
```

下列命令会改变用户服务状态，应在已授权的安装或维护流程中执行：

```bash
npm run pm2 -- install
npm run pm2 -- start
npm run pm2 -- restart
npm run pm2 -- stop
```

| 动作 | 实际行为 |
| --- | --- |
| `install` | 检查稳定工具及 current 的必要文件，渲染并验证 unit，原子替换用户 unit，再执行 daemon-reload；要求 PM2 unit 已停止 |
| `start` / `restart` | 检查旧 UI service、watchdog service/timer 已停止，拒绝与未受该 unit 管理的现存 PM2 进程竞争，再交给 systemd |
| `stop` | 仅通过 systemd 停止 `pi-dev-pm2.service` |
| `status` | 显示 unit 状态、应用名、PID、状态、重启次数、RSS 字节数、运行毫秒数，以及 current 所链接 build-info 的路径和提交 |

`install` 写入 `$HOME/.config/systemd/user/pi-dev-pm2.service`，不会启动、enable 服务或配置 linger。确认迁移完成并需要开机启动时，由部署编排显式执行 `systemctl --user enable pi-dev-pm2.service`；已有 linger 由主部署流程管理。所有项目与服务操作均使用部署用户，不使用 root。

状态查询先检查 unit；inactive 或 failed 时不会调用 PM2。active 时还检查 supervisor PID 是否存活，再捕获 `jlist` 并仅输出白名单字段，绝不输出原始环境。尚未就绪时会报错，可稍后重试。build-info 描述的是 **current 链接目标**，不能单独证明正在运行的进程已切换到该版本。

本 CLI 不提供 `logs`。应用日志位于 `shared/logs/pm2-out.log`、`shared/logs/pm2-error.log`；如需排查，可由操作人本地查看，分享前人工脱敏。不要粘贴原始 `pm2 jlist`、进程环境或 PM2 状态转储。不要执行另一套 `pm2 startup`、`pm2 resurrect` 或后台 `pm2 start` 来接管生产应用。

## 资源与 unit 行为

当前 8 GiB 服务器使用以下默认值。环境覆盖在 **install 时**验证并写入 unit；仅改变调用 `restart` 时的 shell 环境不会更新已安装的 unit。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_DEV_HEAP_MB` | `2048` | Node 的 `--max-old-space-size`，单位 MiB |
| `PI_DEV_PM2_MAX_MEMORY` | `3G` | PM2 应用内存重启阈值 |
| `PI_DEV_MEMORY_HIGH` | `3G` | supervisor 与所有子进程所在 cgroup 的 MemoryHigh |
| `PI_DEV_MEMORY_MAX` | `4G` | 同一 cgroup 的 MemoryMax |

heap 必须为正整数；其余内存值使用正整数加 `M` 或 `G`。要求 `heap < MemoryHigh <= MemoryMax` 且 `heap < PM2 threshold <= MemoryMax`。PM2 周期性检查应用内存，阈值不是即时硬上限；cgroup 限制覆盖 supervisor 及其全部后代进程。旧 systemd 服务原有的 2G 限制只属于旧服务回退配置。

unit 使用 `Type=simple`、`Restart=on-failure`、`KillMode=control-group`、`TimeoutStopSec=45` 和 `UMask=0077`。前台启动命令使用稳定 Node，运行工具目录中的 `pm2-runtime start current/deploy/ecosystem.config.cjs --only pi-dev-web`。模板路径替换处理空格、百分号、美元符及命令参数引号。

## 初次迁移

初次从 `pi-web-ui-dev.service` 切换到 PM2 的入口是 `scripts/cutover.mjs`，编排实现在 `scripts/lifecycle/cutover.mjs`。由主部署流程准备已验证的 candidate、current、工具、unit 和部署描述文件，再从**独立用户任务**执行迁移，避免停止旧 UI 时同时杀掉迁移进程。

迁移通过旧服务的本地 control socket 执行 quiesce，等待 active conversations 和 pending messages 都归零，再停用旧 UI 与 watchdog，启动并启用 PM2 unit。它沿用原 workspace、数据、Agent 与 token 路径，并将 runtime 配置中的 Node 路径切换为稳定入口；runtime 路径配置有单独备份，不复制令牌或会话。候选 PID、健康与公网入口检查成功后记录结果；切换失败会尝试停止 PM2、恢复旧 runtime 配置和旧服务，并验证恢复。以迁移状态文件的实际结果判断成功，不能只看命令已提交。

## 后续生产版本更新与回退

**既有 `scripts/release.mjs` / `npm run release:check` 仍是 shadow 流程。当前没有受支持的 production release mode。** 不要将生产 deployment root 或私有配置交给该流程执行 release/current/rollback/start/reload 等变更动作；其 shadow 配置和直接 PM2 操作不适用于这里的 supervisor。

后续生产升级由已批准的独立维护编排执行，当前需要人工组织以下步骤：

1. 在未运行的独立 candidate 中准备明确提交的源码、锁定依赖与构建产物，运行相关测试和发布检查。确认 build-info 提交与所选版本一致，稳定工具可用；不要在 current 所指在线版本上重新构建或安装依赖。
2. 记录旧 current 目标，保留该 release 与稳定工具。通过运行实例的 control socket quiesce 并等待 active conversations、pending messages 均为零；忙碌、无法确认或超过等待期限时取消升级，并恢复接收工作。
3. 从服务进程之外的维护任务停止 `pi-dev-pm2.service`，在同一部署目录中创建临时链接并通过一次 rename 原子替换 current，然后通过 manager `start` 启动新版本。已有进程状态没有迁移能力，维护窗口内连接会断开。
4. 核实新 PID、服务健康、build-info 提交、公网前端资源与 WebSocket 鉴权，再恢复接收工作。manager status 只提供观测信息；manager start/restart 本身不做 quiesce、健康验收或回滚。
5. 若新版本未通过验收，停止 PM2 unit，原子恢复旧 current，重新启动并验证旧版本。保留失败版本及脱敏诊断供调查；不要在恢复过程中删除共享数据、配置或稳定工具。

只需重启当前版本时，也应先完成工作排空，再执行 `npm run pm2 -- restart`。初次迁移脚本包含旧 systemd 服务的特定回退逻辑，不能直接当成后续 PM2 到 PM2 的通用升级器。

## 实现与验证

CLI 在 `scripts/pm2.mjs`；参数校验、渲染、systemd 调用与脱敏状态在 `scripts/lifecycle/pm2-manager.mjs`；unit 与单实例应用配置分别在 `deploy/pi-dev-pm2.service.in`、`deploy/ecosystem.config.cjs`。测试使用临时目录和假命令，不读取真实用户配置或操作在线进程。

本次 manager 交付实际通过：

```bash
node --test tests/pm2-manager.test.mjs tests/pm2-entry.test.mjs tests/release.test.mjs
node scripts/pm2.mjs --help
git diff --check
```

上述测试合计 20 项，覆盖安装不启动、模板转义、状态脱敏、竞争 manager 拒绝、资源校验、PM2 ESM 启动入口及 shadow release 回归。在线迁移、候选构建与运行验收由主部署流程另外记录，不能从这些隔离测试推断上线已完成。
