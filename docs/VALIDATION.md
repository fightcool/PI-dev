# 本机验收记录

本记录描述首次部署的已验证事实，不代表已完成云主机扩容或模型授权。

## 通过

| 检查 | 结果 |
| --- | --- |
| 安装重建 | uv 官方发布包 SHA256 校验；Python 3.10.20 安装在项目 `.tools/python`；`uv sync --locked` 成功 |
| 虚拟环境 | `/root/src/PI-dev/.venv`；Python 3.10.20；1 项 pytest 隔离测试通过 |
| Node / npm | 22.19.0 / 10.9.3；执行 `npm ci`，最终安装 606 个包 |
| 直接依赖 | `npm ls --depth=0` 无冲突，8 个直接依赖版本符合清单 |
| 依赖审计 | `npm audit --audit-level=moderate`：0 个已知漏洞；未来数据库更新可能改变结果 |
| Node 测试 | 15 项通过，含无效配置拒绝、幂等安装、设置保留、完整/轻量 profile 切换、token 保留 |
| 终端 | native node-pty 成功启动 Python，确认 cwd 为本项目，Python prefix 为项目 `.venv` |
| systemd | 模板通过 `systemd-analyze --user verify`；用户服务 active/running，工作目录 `/root/src/PI-dev` |
| 新 Web 实例 | `127.0.0.1:8788`，Pi 0.84.4；健康检查 cwd 正确 |
| 前端 | 认证后的 HTML 返回 200，4 个入口资源非空且返回 200 |
| 访问控制 | 未认证页面及 API 返回 401；WebSocket 拒绝未认证连接、接受正确 token；public health 不下发 cookie |
| CI 启动脚本 | 本机执行 `node scripts/ci-smoke.mjs` 通过，临时进程按预期退出；随后恢复 systemd 服务 |
| 运行保护 | 服务活跃时 bootstrap 拒绝覆盖依赖目录 |
| 原实例 | 旧 8787 健康检查正常，PID 与修改前一致，没有重启；默认 cwd 仍为 `/root`，按要求保留 |

新服务一次初始空闲观测的 cgroup 内存约 80 MiB，MemoryHigh 1.5 GiB / MemoryMax 2 GiB，未出现自动重启。该读数不含实际模型会话和后续语言服务器负载，不是内存峰值或性能对比结论。

## 尚未完成

- **8 GiB 物理内存扩容**：本机可见 3.82 GiB。`doctor --require-8g` 返回失败，等待云平台规格调整。
- **模型端到端调用**：未导入旧凭证，也未发起付费模型请求；新实例需用户单独授权后验证。
- **域名/公网切换**：仍是 loopback 8788，通过 SSH 隧道访问；旧服务与反代未变。
- **浏览器交互完整回归**：已检查 HTTP、资源、鉴权、WebSocket 和原生 PTY，但没有把这些描述为截图验收或所有 UI 控件回归。
- **完整扩展运行回归**：full profile 的配置生成经过测试，但所有扩展的实际模型、MCP、LSP 和多代理工作流仍需对应凭证、工具与真实项目验证。

GitHub Actions 状态以仓库 Actions 页面为准，不能把本机验证替代远端干净 runner 的结果。首次提交不包含任何旧实例 token、模型凭证、业务源码、数据库或会话。
