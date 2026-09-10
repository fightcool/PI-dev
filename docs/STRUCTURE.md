# 项目结构与开发边界

<!-- 🍞 AI Breadcrumb — @COUPLED README.md, docs/DEV-CON-PROPOSAL.md, docs/README.md -->

本文只规定工程结构与运行边界；当前功能范围、架构和验收统一以 [DEV-CON-PROPOSAL.md](DEV-CON-PROPOSAL.md) 为准。

PI-dev 是以 Pi 为核心的个人远程开发环境，保留定制 pi-web-ui 的 Pi/DSH 架构。仓库包含开发环境编排、应用源码，以及暂停开发的 `dev-con/` 只读原型。源码按责任归属；私有配置、会话和上传按实例归属；部署版本按提交归属。

## 目录地图

| 路径 | 维护内容 | 不应放入 |
| --- | --- | --- |
| `scripts/` | 根安装、构建、开发、诊断及发布入口 | 被应用通过包外路径引用的业务模块 |
| `vendor/pi-web-ui/` | 保留来源和上游布局的定制 UI 应用 | 根环境的私有配置或其他 Agent 数据 |
| `vendor/pi-web-ui/lib/usage/` | 用量与策略模块的唯一源码 | 手工维护的构建目录副本 |
| `vendor/pi-web-ui/server/` | SDK 接入、会话、API、WS | 浏览器组件 |
| `vendor/pi-web-ui/web/src/` | UI 与浏览器状态 | 服务端配置写入逻辑 |
| `deploy/` | PI-dev 实例部署模板与配置 | 实际口令、日志、运行状态 |
| `config/` | 不含真实凭据的示例 | live 配置 |
| `tests/` | 根工程链、生命周期、隔离浏览器性能回归 | 真实会话和凭据 |
| `docs/` | 当前开发运维规范、提案、验收记录 | 零散根目录完成说明 |
| `upstream/` | 上游来源和兼容性记录 | 第三份业务实现 |
| `dev-con/` | 暂停开发的只读原型；最终渠道管理优先整合进现有 Web 模块，见当前方案 | 外部原生 Agent 集成、第二套模型/密钥业务实现 |

根 `package.json` 锁定环境扩展；vendor 的 `package.json` 锁定应用依赖。两者各自保留锁文件，避免把独立上游项目变成无法单独构建的目录。根目录不再额外安装 npm 版 pi-web-ui，也不再人工修改 node_modules 内的 SDK 链接。

Node `#usage` / `#governance` package imports 让源码与编译产物引用同一 `lib/usage` 文件，应用 npm 包也包含该目录。新增共享模块优先落在其实际所属的应用内；只有出现多个真实消费方时才创建跨应用 package。

## 根工程入口

- `npm run setup:dependencies`：按两份锁文件安装；拒绝替换共享依赖链接和在线实例依赖。
- `npm run dev`：独立开发实例，前端5173、后端8890，配置和数据在该checkout的 `.dev/`，不继承在线用户配置。
- `npm run build`：构建应用并写入 `vendor/pi-web-ui/dist/build-info.json`。
- `npm run typecheck`：应用双端类型检查。
- `npm test`：根工程及生命周期测试。
- `npm run test:unit`：应用纯逻辑单测。
- `npm run test:smoke`：应用自包含协议冒烟。
- `npm run test:performance`：模拟HTTP/WS的浏览器回归；不接触真实服务或模型。
- `npm run dev-con -- --help`：旧只读原型 CLI，配置位于 checkout 的 `.dev/dev-con/`；仅供复查，见[历史原型记录](history/dev-con/readonly-prototype.md)。
- `npm run test:dev-con` / `npm run test:dev-con:browser` / `npm run test:dev-con:integration`：旧原型验证，不代表当前渠道功能验收。
- `npm run check:publish`：交付文件及常见秘密检查。

开发数据 `.dev/`、依赖、构建输出与Python虚拟环境均不进入Git。测试夹具自行生成配置及测试令牌；测试不能调用 `loadConfig()` 去读取操作人的实际凭据。

## 开发、运行与工作区

这三个位置具有不同生命周期：

1. **开发 checkout** 可以编辑、切分支、重新构建。在线进程不应依赖它持续变化的产物。
2. **release** 是已经构建并验证的版本，用提交标识；升级和回滚切换版本，不替换私有数据。
3. **workspace** 是智能体执行 Git、终端与业务构建的目录，可以独立于应用代码。

既有在线XDG目录可继续使用；不要为了目录整齐将凭据或会话迁入Git。Claude Code、Codex CLI 等外部工具的配置与技能不纳入本系统的管理、同步或迁移。

同一服务仅由一个主要进程管理器管理。systemd适用于当前Linux工作站，PM2使用单实例fork；Docker Compose使用自身重启策略。会话、PTY和WS状态尚未设计为多进程共享，不能直接启用PM2 cluster实现横向扩容。

## 与 dev-con 的衔接

当前功能的唯一开发依据为 [DEV-CON-PROPOSAL.md](DEV-CON-PROPOSAL.md)。架构讨论已合并，不再维护并行方案。`dev-con/` 与8791保留为暂停原型/后续运维预留，其存在不要求当前渠道功能独立部署；具体实现仍暂停。旧原型目录与测试的保留、迁移或移除遵循开发基准，不自动处理。

端口约定：8788在线UI、8790发布候选、8791原型预留、8890开发后端；协议/浏览器测试使用独立空闲端口或完全模拟网络。

## 上游更新

保留 vendor 原有结构与发布文档是为了可对照上游，不代表根仓库会向上游 npm 包发布。PI-dev 的入口以本文件、根README和运维文档为准。更新时记录上游提交和版本，再检查本地下游修改、两端协议、包内imports、构建与性能回归；不能仅替换package版本号。
