# 安装与运维

<!-- 🍞 AI Breadcrumb — @COUPLED PM2-PRODUCTION.md, PM2-SHADOW.md, STRUCTURE.md -->

当前基线是Linux非root用户、4 vCPU / 8 GiB服务器。正式进程管理使用 [PM2-PRODUCTION.md](PM2-PRODUCTION.md)，下文systemd UI命令保留为迁移前及恢复兼容入口。程序源码集中在仓库，配置与会话按实例保存，见 [STRUCTURE.md](STRUCTURE.md)。早期4 GiB迁移记录已归档到 [history/ENVIRONMENT-VALIDATION.md](history/ENVIRONMENT-VALIDATION.md)。

## 安装

前置：Linux x86_64、Bash、Git、curl、tar、xz、sha256sum、CA证书。node-pty无预编译包时需要Python3、make、C++编译器。bootstrap不自动安装系统软件，不修改全局Git、shell或代理配置。

```bash
bash scripts/bootstrap.sh
npm test
npm run typecheck
npm run test:unit
.venv/bin/python -m pytest tests/test_environment.py -q
npm run check:publish
```

工具链保存在 `.tools/` 与 `.venv/`，依赖依据两份npm锁文件及uv.lock重建。不要复制主机node_modules或虚拟环境作为发布制品。`npm run setup:dependencies` 拒绝改动当前在线服务的依赖和指向其他checkout的共享链接。

## 配置与开发实例

默认配置目录 `~/.config/pi-dev`，Web数据与Agent状态在 `~/.local/share/pi-dev/`。可显式设置 `PI_DEV_CONFIG_DIR`、`PI_DEV_STATE_DIR`、`PI_DEV_PORT`、`PI_DEV_CWD`，或使用configure的 `--workspace`、`--state-dir`、`--data-dir`、`--agent-dir`、`--port`、`--profile` 参数。所有实例使用不同的状态目录；8787和运维预留8791不可分配给UI。

`runtime.root`描述可执行代码来源，`workspaceDir`描述智能体工作区。加载配置时使用当前脚本所在的实际代码根，保留workspace和私有状态；旧配置没有workspaceDir时沿用旧root作为工作区。受管理的扩展包路径随代码目录迁移，用户显式添加的包设置保留。

`npm run dev`自动使用checkout内 `.dev/config`、`.dev/state`、8890后端和5173前端。它不会导入线上模型授权。私有配置由操作人在本地管理；测试自行生成夹具，禁止把实际访问口令或会话内容写入日志。

## 旧 UI systemd 兼容维护

```bash
node scripts/service.mjs status
node scripts/service.mjs stop
node scripts/service.mjs install
node scripts/service.mjs start
node scripts/service.mjs restart
node scripts/service.mjs disable
```

这些是实际服务操作，执行前应确认活动任务、维护窗口和所安装版本。install在服务非活动、端口空闲、模板验证成功后才替换用户unit。运行目录和代码根可以分开；不要在在线checkout中替换依赖或构建产物。

原有每10秒执行 `is-active || start` 的watchdog被原生systemd恢复策略替代：异常或正常退出会延时重启，操作人执行stop后保持停止。迁移入口会识别已安装的旧timer/service，先停止/禁用watchdog，再完成维护操作；不会因仓库删除旧模板而忽略主机上已安装的unit。新安装不再部署watchdog。

开机启动需要user manager常驻，操作人可用 `loginctl show-user "$USER" -p Linger` 检查。系统级linger、nginx、证书与防火墙调整由有相应权限的操作者完成。

## 资源规划

服务限制涵盖Node及其子进程；构建、终端、语言服务器也可能计入cgroup。V8 old-space只限制JS堆，不包含全部RSS或子进程。不要用增加内存代替前端性能优化。

以下默认值仅适用于旧 `pi-web-ui-dev.service` 兼容入口：MemoryHigh1536M、MemoryMax2G、Node old-space1024MiB。当前正式PM2资源基线见 [PM2-PRODUCTION.md](PM2-PRODUCTION.md)，不能混用两者的默认值和停止行为。安装时可通过 `PI_DEV_HEAP_MB`、`PI_DEV_MEMORY_HIGH`、`PI_DEV_MEMORY_MAX` 明确覆盖；校验要求 heap < MemoryHigh ≤ MemoryMax。在8GiB机器上，可以按实测工作负载选择 `PI_DEV_HEAP_MB=2048 PI_DEV_MEMORY_HIGH=3G PI_DEV_MEMORY_MAX=4G`，但需预留系统和其他应用空间。重新安装unit后才生效，修改这些变量不会阻止stop/disable等维护操作。验收包括 `vmstat`、cgroup memory.events/PSI、任务并发和持续15–30分钟的交互，不能用瞬时空闲数证明容量充足。

## 发布与回滚

开发checkout和在线版本分离。根 `npm run build` 生成应用及 `dist/build-info.json`，包含提交、应用版本、协议版本和构建时间。启动只接受vendor构建产物，缺失时明确失败，不回退npm版UI。

PM2候选部署使用经过指定的提交归档、独立shared配置与状态、单实例fork、原子current切换及失败恢复，详见 [PM2-SHADOW.md](PM2-SHADOW.md)。它保留8790候选边界，不自动替换8788在线实例。需要长期在线迁移时，先在候选端口验证，再排空任务并由操作者切换；进程重启不能保证生成中会话或PTY零中断。

不要原地执行 `npm update` 或让应用自更新绕过锁文件。依赖升级更新两个实际受影响的清单/锁文件，并重新执行类型、构建、单元、协议和性能验证。

## Docker

根Dockerfile以仓库为上下文，复用锁定依赖安装与根build；复制应用、包内共享模块、主题、插件及所需启动脚本。compose仅将端口绑定到宿主机127.0.0.1，并显式持久化 `/config`、`/data/web`、`/data/agent`、`/workspace`。运行用户为node，bind mount业务工作区时需确保其UID/GID有权限。

容器服务配置保留loopback约束，只有容器入口在验证后将容器内监听设为0.0.0.0。Passkey的RP ID与origin通过部署环境明确设置。容器中的Debian Python用于工具链；宿主机uv虚拟环境不被复制，项目专用Python版本需由工作区镜像补齐。

```bash
docker compose config
docker compose build
docker compose up -d
```

构建与启动是部署动作；目标机器需有Docker。本轮验收记录会明确实际是否执行容器构建，不能用文件存在声称镜像运行通过。

## 备份与公开交付

升级应用版本不能覆盖shared私有数据。备份模型配置、会话、上传及服务unit前，先确认一致性需求和写入状态；恢复使用单独维护流程。旧release的保留/清理需要显式选择，不批量删除用户数据。

公开交付只包含源码、锁文件、模板、示例和测试。`npm run check:publish`辅助检查秘密及运行路径；提交前仍需逐项审查文件范围。运行数据、构建产物、依赖、日志、密钥、实际模型配置和其他业务源码不得进入提交。
