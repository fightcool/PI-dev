# DEV-CON M0 开发与验收（已归档）

> **历史材料，不作为开发依据。** 正文保留当时的判断、建议和验证状态；不得据此恢复旧范围、旧排期或执行部署。当前唯一开发基准为 [DEV-CON-PROPOSAL.md](../../DEV-CON-PROPOSAL.md)。

<!-- 🍞 AI Breadcrumb — @COUPLED dev-con/cli.mjs, dev-con/server.mjs, dev-con/overview.mjs
     @COUPLED docs/DEV-CON-PROPOSAL.md, docs/history/dev-con/assessment.md, tests/dev-con-browser.mjs
     @CONTRACT 路径相对仓库根；正文为历史原型记录。 -->

**当前状态：实现继续暂停。用户已明确Pi为核心、保留Pi/DSH、排除外部原生Agent集成；CC Switch仅作多渠道参考，见[当前架构](architecture-v1.2.md)。本文保留旧M0原型事实，外部Agent占位不代表后续范围；代码与测试尚未提交或作为正式交付。**

本轮从 `c3f845b` 开发，分支 `feature/dev-con-foundation`。交付独立的只读控制台，完成原方案评估并把实施顺序调整为 M0→M1a→M1b→M2–M5。M0 不包含渠道切换、Agent 私有配置读取、Skills/MCP 同步、模型探测或生产服务变更。

## 当前能力

- 密码初始化、登录、12小时会话、注销及 CSRF 校验。
- 仓库项目/UI/SDK 版本声明和控制台实际 Node 版本。
- 主机 CPU、负载、内存与运行时长。
- 固定 `pi-dev-pm2.service`、`pi-web-ui-dev.service`、`dev-con.service` 的用户单元状态；新旧 Pi 管理器同时 active 时明确提示。
- Pi/Claude/Codex/Gemini 能力登记；Pi 标识“仓库包含”，其他标识“未核实”，均不冒充已安装或渠道适配成功。
- 中文桌面与移动界面；刷新失败保留并标记旧快照；注销清理内容并拒绝晚到响应。

状态采集不会运行 Agent CLI、读取用户模型配置、访问渠道 URL 或创建 PM2 daemon。单元 active 只证明 supervisor 状态，不能证明应用 HTTP、WebSocket 或模型健康。前台运行 DEV-CON 时，dev-con.service 未安装是正常状态。

## 实现位置与调用链

| 文件 | 责任 |
| --- | --- |
| `dev-con/cli.mjs` | init/serve、独立配置路径、回环监听、CLI 错误与退出 |
| `dev-con/auth.mjs` | scrypt 密码摘要、会话、登录限流与 CSRF |
| `dev-con/server.mjs` | 固定 HTTP 路由、静态资源、Origin/Host、请求限制及错误边界 |
| `dev-con/overview.mjs` | `createOverviewCollector` / `collectOverview`，元数据和固定服务字段 |
| `dev-con/agents.mjs` | `agentInventory`，能力登记 |
| `dev-con/web/index.html` | 登录及总览语义结构 |
| `dev-con/web/app.js` | 会话、刷新、渲染、注销与请求失效控制 |
| `dev-con/web/style.css` | 桌面/移动布局、状态、焦点和可访问性 |
| `tests/dev-con-*.test.mjs` | 认证、CLI、HTTP、采集的隔离回归 |
| `tests/dev-con-browser.mjs` | Chromium 全模拟网络的用户流程与截屏 |
| `tests/dev-con-integration.mjs` | 真实 HTTP 服务与浏览器联调，服务状态通过替身采集 |

浏览器登录 → `server.mjs` 认证与会话 → `/api/v1/overview` → `overview.mjs` → 仓库 package 元数据/固定 systemctl show → `web/app.js` 文本渲染。根 `npm test` 自动包含新增 `*.test.mjs`，浏览器入口独立运行。

## 开发运行

运行用户必须为非 root。默认配置位于当前 checkout 的 `.dev/dev-con/`，与在线 Pi 配置隔离。初始化和启动的具体参数通过帮助检查：

```bash
npm run dev-con -- --help
npm run dev-con -- init
npm run dev-con -- serve
```

初始化口令在本机终端隐藏输入，要求 12–1024 UTF-8 字节，30秒输入期限；也支持有5秒期限的重定向 stdin。不放进命令参数、环境变量、聊天或 shell 历史。服务默认只监听 `127.0.0.1:8791`。浏览器通过同一 Origin 访问，远程开发可使用 SSH 转发并访问 `http://127.0.0.1:8791`。

如需显式目录、端口或反代 Origin，使用 CLI 帮助中的配置项。指定公网 Origin 并不等于已部署公网服务；HTTPS 场景还需要反代、Secure cookie 和真实域名验收。M0 不安装 systemd unit，不修改 nginx 或正式 PM2。

首期不提供密码修改 API；会话保存在进程内，重启后失效。正式长期部署前需要补齐经过验证的密码轮换/恢复流程及服务安装器。

## 验证方法

```bash
npm run test:dev-con
npm run test:dev-con:browser
npm run test:dev-con:integration
npm test
npm run check:publish
git diff --check
```

API 测试只监听本地随机端口，使用合成密码和临时配置，含请求及整体超时与清理。浏览器测试所有响应在本地模拟，覆盖用户操作与响应竞态；真实 HTTP 契约由 server 测试覆盖。另有 integration 测试将真实 HTTP 服务、采集器与页面连在一起，服务命令使用替身，确认 cookie、登录、刷新、注销及实际 CSP 下的页面运行。浏览器产物保存在忽略目录 `.dev/dev-con-artifacts/`，不提交仓库。

本地截图：[桌面联调](../../../.dev/dev-con-artifacts/integration-desktop.png)、[手机联调](../../../.dev/dev-con-artifacts/integration-mobile.png)。它们是隔离验收产物，其中服务状态为测试模拟，不代表线上状态；其他 checkout 需重新运行测试生成。

本轮没有改应用源码/锁文件，常规应用类型与构建检查按影响范围判断；没有执行在线模型调用、生产重启、正式部署或 GitHub 推送。

## 实际验证记录

暂停前最后一次根 `npm test`：187/187通过；控制台浏览器模拟及真实HTTP联调通过。只读复核另发现多标签页重新登录后，注销重试可能持续使用旧CSRF token；该P2问题按暂停要求保留待处理。未执行最终发布检查、提交或部署，不能将这些测试结果视为全阶段验收完成。

## 变更与自检

本轮新增独立 Node HTTP 控制台、认证、只读采集与静态前端，加入根 npm 入口和测试，更新项目索引与 DEV-CON 方案，新增评估和验收文档。没有新增运行依赖或改动锁文件。

自检范围包括鉴权、Host/Origin、会话/CSRF、请求体限制、敏感字段、固定命令参数、失败降级、前端异步失效、移动布局、代码/文档引用与文件大小。仓库没有 `.ai-pipeline` 或 `pipeline.json`，因此不运行自定义规则注册与信任分层步骤，按通用规则和实际测试验证。
