# PI-dev

独立、可复现的 Pi 开发环境。目标平台为 Linux x86_64（本机 Debian 12），用于远程编码，不包含法羽或其他私有业务源码。

## 环境方案

| 项目 | 约定 |
| --- | --- |
| 工作目录 | 本仓库 checkout，不能是 `/root` |
| Python | 3.10.20，项目 `.venv`，uv 0.12.10 管理 |
| Node / npm | 22.19.0 / 10.9.3，保持部署基线并锁定版本 |
| Pi / Web UI | 0.85.1 / 0.70.0 |
| Web 前端 | 使用锁定的 `vendor/pi-web-ui` 源码构建制品；其运行依赖与 PI-dev 根依赖分别锁定，Pi SDK 统一为 0.85.1 |
| 新实例 | `127.0.0.1:8788`，`pi-web-ui-dev.service` |
| Web 数据 | `~/.local/share/pi-dev/web` |
| Pi 配置及会话 | `~/.local/share/pi-dev/agent` |
| 本机配置及访问口令 | `~/.config/pi-dev/`，不入库 |
| 内存目标 | 云主机至少 8 GiB；当前 4 GiB 仅作低并发过渡 |

没有单独的业务 `frontend/`，因此不在法羽 checkout 执行 npm 命令。完整环境指源清单、锁文件、脚本和可重建配置，不是上传 `.venv`、`node_modules` 或服务器镜像。

## 安装

前置条件：Linux x86_64、Bash、Git、curl、tar、xz、sha256sum、CA 证书；运行服务需 systemd 用户会话。下载需要访问 GitHub、nodejs.org、npm 和 PyPI。不自动安装系统包，不修改代理、全局 Git 或 shell 配置。若 node-pty 无可用预编译文件，需用户安装 Python 3、make、C++ 编译器。

```bash
git clone https://github.com/fightcool/PI-dev.git
cd PI-dev
bash scripts/bootstrap.sh
npm test
.venv/bin/python -m pytest tests/test_environment.py -q
node scripts/service.mjs install
npm run smoke
```

脚本下载校验后的 uv；Node 不匹配时下载官方发行包并校验 SHA256，放在 `.tools/`。Python 使用 `--no-bin`，不创建全局 Python 链接。依赖安装采用 `uv sync --locked` 和 `npm ci`，不会顺便升级锁文件。

若 Node 是脚本下载的，后续终端需临时执行 `export PATH="$PWD/.tools/node-v22.19.0-linux-x64/bin:$PATH"`；服务记录绝对 Node 路径，不依赖登录 shell。

## 访问与模型授权

默认只监听本机且启用随机访问口令。建议通过 SSH 隧道访问，不开放公网端口：

```bash
ssh -N -L 8788:127.0.0.1:8788 YOUR_SSH_HOST
```

在服务器上查看 `~/.config/pi-dev/token` 的内容，在自己的浏览器打开 `http://127.0.0.1:8788/?token=YOUR_TOKEN`。口令只保存在服务器私有目录，勿粘贴到 GitHub、截图或公开聊天。登录链接可能留在浏览器历史中；认证后可去掉查询参数，继续使用 HttpOnly cookie。

新实例不读取旧实例凭证。进入新界面的模型配置，或运行 `node scripts/pi.mjs` 后 `/login`。自定义 provider 格式见 [配置示例](config/models.example.json)。实际配置写到 `~/.local/share/pi-dev/agent/models.json`，真实凭证通过界面或本地私有 auth 文件配置。模型授权完成后发送一个简短提示，才算模型端到端验收完成。

`/api/health` 故意允许未认证访问，但不得返回访问口令；其他页面、API 和 WebSocket 必须认证。不要向不可信用户提供访问权：Pi 可以执行当前系统用户权限下的命令，工作目录隔离不是安全沙箱。

## 日常使用

```bash
npm run doctor
node scripts/service.mjs status
journalctl --user -u pi-web-ui-dev.service -n 80 --no-pager
node scripts/pi.mjs --version
source .venv/bin/activate
```

默认 `lean` 仅加载 `pi-context-prune`，Web UI 本身提供对话及内置子代理工具。完整扩展依赖已经安装，但不会在空闲时全部加载：

```bash
node scripts/configure.mjs --profile=full
node scripts/service.mjs restart
```

`full` 增加 pi-lens、pi-subagents、pi-mcp-adapter、pi-codex-conversion、pi-goal。MCP 外部服务和提供商凭证需要另行配置，不会导入旧配置。恢复低开销模式用 `--profile=lean` 后重启。4 GiB 期间建议一个活动对话、一个构建/测试任务，不并行跑全仓扫描。

PI 0.85.1 与 pi-web-ui 0.70.0 的源码构建制品必须作为一组验证；不要让 UI npm 包重新解析旧版 Pi SDK。

原环境中的 `statusline-pi@1.3.1` 要求 Pi `^0.75.4`，与当前 0.85.1 不兼容，本环境明确排除，不使用 `--legacy-peer-deps`。`qs` 显式覆盖为 6.16.0，以修复安装时审计发现的间接依赖漏洞。

## 交付与运维

- [完整实施、扩容和回滚方案](docs/OPERATIONS.md)
- [本机验收记录](docs/VALIDATION.md)
- [systemd 模板](deploy/pi-web-ui-dev.service.in)
- `npm run check:publish` 检查受跟踪文件是否误含运行数据和常见密钥。
- GitHub Actions 在干净 Linux runner 重建工具链、运行测试及服务冒烟检查。

本仓库公开。真实配置、口令、模型凭证、SSH 私钥、MCP 凭证、会话、上传文件、数据库、日志和业务代码一律不提交。依赖安装会执行第三方生命周期脚本；生产使用前仍需审查供应链和版本安全更新。Python 3.10 临近 2026 年 10 月上游 EOL，本次按要求保留，后续应单独安排兼容性迁移。
