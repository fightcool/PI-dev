# PI-dev

可复现的远程 AI 开发环境。一个仓库管理工具链、定制 pi-web-ui、验证和部署入口；私有配置与会话独立持久化。未来的 `dev-con/` 是旁路管理面，见 [开发提案](docs/DEV-CON-PROPOSAL.md)。

## 从哪里开始

- [目录结构与开发边界](docs/STRUCTURE.md)：各目录的归属、源码与运行数据的区别。
- [安装与运维](docs/OPERATIONS.md)：配置、服务维护和升级。
- [PM2 发布与回滚](docs/PM2-SHADOW.md)：独立 release、候选端口与验证。
- [性能与验收](docs/FOUNDATION-VALIDATION.md)：本轮修改、测量方法及结果。
- [历史环境验收](docs/history/ENVIRONMENT-VALIDATION.md)：早期环境迁移记录，不代表当前部署状态。

## 环境基线

Linux x86_64，非 root 用户。Node 22.19.0 / npm 10.9.3，Python 3.10.20 / uv 0.12.10；Pi SDK 0.85.1、pi-web-ui 0.72.0。依赖分别由根与 vendor 锁文件管理；根不重复安装 npm 版 UI。当前服务器为4 vCPU / 8 GiB，配置容量与实际负载应分别验证。

## 安装和开发

```bash
git clone https://github.com/fightcool/PI-dev.git
cd PI-dev
bash scripts/bootstrap.sh
npm test
npm run typecheck
npm run test:unit
npm run dev
```

bootstrap 下载并校验项目内工具链，使用锁文件安装依赖、构建并生成本机配置。它不会安装系统软件或自动停止在线服务。已经准备好工具链时可用 `npm run setup:dependencies` 和 `npm run build`。

`npm run dev` 使用当前 checkout 的 `.dev/config` 与 `.dev/state`，前端 `http://localhost:5173`，后端 `127.0.0.1:8890`；首次使用需要为这个开发实例单独配置授权。在线8788、候选8790、后续dev-con8791保持分开。远程开发可用SSH隧道转发5173。

```bash
npm run build             # vendor应用及版本信息
npm run typecheck         # 服务端、前端及测试类型
npm test                  # 根工程/配置/服务/发布测试
npm run test:unit         # 应用单元测试
npm run test:smoke        # 自包含协议冒烟
npm run test:performance  # Chromium，合成数据，无真实模型调用
npm run check:publish
```

浏览器测试使用已安装Chromium，找不到时设置 `CHROME_PATH`。测试结果写入忽略的 `.dev/performance/`。构建不会切换在线服务。

## 实例配置与持久化

| 位置 | 默认用途 |
| --- | --- |
| `~/.config/pi-dev/` | runtime配置、访问凭据 |
| `~/.local/share/pi-dev/web/` | UI状态、上传、插件 |
| `~/.local/share/pi-dev/agent/` | Pi配置、模型授权、会话、技能 |
| `~/.config/systemd/user/` | 安装后的用户服务 |

配置支持独立 workspace，程序版本可移动，数据不随release替换。模型配置示例见 [models.example.json](config/models.example.json)。真实凭据不入仓库、构建制品或日志。

Web通过访问口令或已配置的Passkey登录；新浏览器可在页面选择访问口令登录。口令保存在该实例的私有配置目录，由操作人直接在服务器本地获取，不应粘贴到聊天、Issue或公开日志。模型授权完成后需要单独验证一次真实模型调用；健康接口通过不能替代模型可用性验收。

## 运行和交付

```bash
npm run doctor
node scripts/service.mjs install
node scripts/service.mjs status
npm run smoke
```

单个实例选择systemd或PM2管理，不叠加管理同一个进程；PM2使用单实例fork。有状态会话和终端不支持直接切为多进程cluster。服务安装前应在独立版本目录完成构建和验证；开发checkout不要直接作为长期在线release。

根 [Dockerfile](Dockerfile) 与 [compose.yaml](compose.yaml) 复用相同应用构建，显式持久化配置、Web数据、Agent数据和工作区。`docker compose up -d --build` 是创建/更新实例的部署动作，应在确认端口及数据目录后由操作者执行。容器的Python为Debian工具链，不承诺与宿主机uv虚拟环境相同；需要项目专用运行时的workspace应单独配置镜像。

默认 `lean` 只加载pi-context-prune；`full` 增加已锁定扩展。切换profile用 `node scripts/configure.mjs --profile=full`，然后在维护窗口重启所管理的实例。其他Agent的skills/config由后续dev-con适配器管理，这里不自动复制或清理用户目录。

本仓库公开。Pi能执行运行用户权限下的命令，workspace选择不是安全沙箱；公开入口须有认证及正确的WebSocket反代。依赖安装执行第三方生命周期脚本，版本升级需要锁文件差异与回归验证。Python3.10的后续迁移应独立安排。
