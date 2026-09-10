# 当前服务器验收记录

本记录描述当前服务器 `C202609091757997`、`dev` 用户上的验证事实；公网 nginx/TLS 反代已上线，但不代表已完成模型授权或所有浏览器交互回归。

## 通过

| 检查 | 结果 |
| --- | --- |
| 安装重建 | uv 官方发布包 SHA256 校验；Python 3.10.20 安装在项目 `.tools/python`；`uv sync --locked` 成功 |
| 虚拟环境 | `/home/dev/PI-dev/.venv`；Python 3.10.20；当前服务器 bootstrap 的 uv 阶段通过 |
| Node / npm | 22.19.0 / 10.9.3；执行 `npm ci`，最终安装 606 个包 |
| 直接依赖 | `npm ls --depth=0` 无冲突，8 个直接依赖版本符合清单 |
| 依赖审计 | `npm audit --audit-level=moderate`：0 个已知漏洞；未来数据库更新可能改变结果 |
| Node 测试 | `npm test`：22 项通过，含无效配置拒绝、幂等安装、设置保留、profile 切换、token 保留和运行时安全检查 |
| 终端 | native node-pty 成功启动 Python，确认 cwd 为本项目，Python prefix 为项目 `.venv` |
| systemd | 模板通过 `systemd-analyze --user verify`；`pi-web-ui-dev.service` 已由 `dev` 安装、enable、active/running，工作目录 `/home/dev/PI-dev` |
| 新 Web 实例 | 当前服务器 `127.0.0.1:8788`；健康检查报告 Pi 0.85.1、cwd 正确 |
| 前端 | vendor 源码构建；认证门禁页、HTML、4 个入口资源和 favicon 返回 200 |
| 访问控制 | 前端 shell、favicon 和入口资源在认证前返回 200；受保护 API 返回 401；WebSocket 拒绝未认证连接、接受正确 token；public health 不下发 cookie |
| 本机 smoke | `npm run smoke` 通过：health、cwd、认证、4 个资源、favicon 和 WebSocket upgrade |
| vendor 鉴权回归 | `vendor/pi-web-ui` 的 typecheck、build、`node tests/token-auth-test.mjs` 通过（24/24）；过期 cookie 会清理，认证 shell 保持可加载 |
| 公网反向代理 | `https://dev.ftai.cc` 通过 health、认证和 WebSocket smoke；nginx 配置测试成功并 active |
| TLS 续期 | Certbot timer active；`sudo certbot renew --dry-run` 模拟续期成功 |
| CI 启动脚本 | 本机执行 `node scripts/ci-smoke.mjs` 通过，临时进程按预期退出；随后恢复 systemd 服务 |
| 运行保护 | 服务活跃时 bootstrap 拒绝覆盖依赖目录 |
| 原实例 | 旧 8787 健康检查正常，PID 与修改前一致，没有重启；默认 cwd 仍为 `/root`，按要求保留 |
| dev shadow | `dev` UID 1001；独立 `/srv/pi-dev`、PM2_HOME、配置/会话/日志；8790 loopback；PM2 app `pi-dev-shadow` online；health 返回 Pi 0.85.1、pi-web-ui 0.70.0；smoke 通过；未认证页面 401；doctor 与 Python 3.10.20 pytest 通过 |

阶段 C shadow 依赖审计：PI-dev 根依赖安装无漏洞；vendor/pi-web-ui 独立 `npm ci` 报告 3 个 moderate 漏洞，尚未执行 `npm audit fix`，待锁定上游依赖并单独审查。


## 尚未完成

- **8 GiB 物理内存验收**：当前服务器可见 7.76 GiB、无 swap；`doctor --require-8g` 已通过，仍需持续观察服务压力指标。
- **模型端到端调用**：未导入旧凭证，也未发起付费模型请求；新实例需用户单独授权后验证。
- **公网 DNS/证书**：当前 `dev.ftai.cc` 已由 nginx 反代到本机 8788，HTTPS 和证书续期 dry-run 已验收；后续只需按 timer 观察真实续期日志。
- **浏览器交互完整回归**：已检查 HTTP、资源、鉴权、WebSocket 和原生 PTY，但没有把这些描述为截图验收或所有 UI 控件回归。
- **完整扩展运行回归**：full profile 的配置生成经过测试，但所有扩展的实际模型、MCP、LSP 和多代理工作流仍需对应凭证、工具与真实项目验证。
- **版本迁移**：当前新实例运行 Pi 0.85.1、vendor pi-web-ui 0.70.0；正式切换前不得混用旧实例会话或验证结果。`node-pty` 因系统缺少 make/g++ 无法源码构建，本机使用已验证兼容 Node 22 的 VS Code Server native binary 完成本次运行；全新机器需先安装构建工具。


GitHub Actions 状态以仓库 Actions 页面为准，不能把本机验证替代远端干净 runner 的结果。首次提交不包含任何旧实例 token、模型凭证、业务源码、数据库或会话。
