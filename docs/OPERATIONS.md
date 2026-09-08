# 实施与运维方案

## 1. 边界与基线

本次交付为公开仓库 `fightcool/PI-dev`，不是法羽源码迁移。现有私有业务 checkout、未提交修改、数据库、PM2 生产服务及反向代理均不修改。

初始检查：旧 pi-web-ui 使用 `/root`、8787 端口和 `~/.pi-web`；内存约 3.82 GiB、Swap 2 GiB，已经使用约 651 MiB Swap。Swap 占用不等于当前持续内存抖动，是否抖动要看 `vmstat` 的 si/so 和 PSI。当前系统 Python 是 3.11，已有法羽虚拟环境也是 3.11。旧业务主 checkout 明显落后远端，因此不能作为本次环境交付的默认基线。

所有优化在新 checkout 和新用户服务中完成。旧实例承载当前对话，保留运行，直到用户确认切换。两实例并行只用于过渡，会增加基础内存占用，不是最终节省内存的状态。

## 2. 执行顺序

1. Clone `PI-dev`，确定新实例 `WorkingDirectory` 与 `PI_WEB_CWD` 都指向该 checkout。将运行数据移出 checkout，不复制旧会话。这样文件树、搜索、上下文加载的默认范围落在项目内。用户仍可主动切换 cwd，因此这不是权限限制。
2. 用带 SHA256 校验的 uv 下载 Python 3.10.20；创建项目 `.venv`；依据 `uv.lock` 安装开发工具；不使用生产 venv，不修改 `/usr/bin/python3`。
3. 锁定 Pi、Web UI 和扩展版本，生成 `package-lock.json`；运行 `npm ci`；验证实际包版本、发布包中的前端资源、node-pty。Python 和 Node 依赖均可从锁文件重建。
4. 生成独立 `pi-web-ui-dev.service`，使用 8788、独立 Web/Pi 数据目录和随机 token。默认 loopback、目录 0700、配置 0600、UMask 0077；通过 systemd-analyze 校验后启用。不修改旧服务、反代、防火墙或公网监听。
5. 在云控制台扩容至至少 8 GiB，建议保留现有 CPU 或按负载选择 4 vCPU / 8 GiB。扩容、扣费、停机和重启由用户确认执行；仓库脚本不能增加真实物理内存。
6. 完成下述验收和公开发布检查，提交锁文件、脚本、测试、模板与文档，推送 GitHub；提供实际 commit 与测试结果。

## 3. 资源控制

systemd 用户服务默认设置 `MemoryHigh=1536M`、`MemoryMax=2G`、`TasksMax=256`，Node V8 old-space 上限 1024 MiB。它们限制服务及其子进程，不是整个服务器。MemoryHigh 会触发回收压力，MemoryMax 可能导致服务被 OOM kill；这些是保护措施，不是性能承诺。原生分配、缓冲区和语言服务器不受 V8 old-space 单独约束。

4 GiB 过渡期使用 lean，限制手工并发，不在 Web 会话里执行重量级全仓扫描。8 GiB 后可按实际工作负载调整模板再安装：例如 MemoryHigh 3G、MemoryMax 4G、V8 old-space 2048 MiB，但必须给生产服务和系统预留余量。需要超过限制的构建不应直接提高整机并发，应观察服务 cgroup 内存后再调优。

默认不对业务数据库、Redis 或 PM2 设置新限制，不调 sysctl，不扩大 Swap 掩盖内存不足。最终停止不再使用的旧 Web 实例才会回收重复实例开销。

## 4. 8 GiB 扩容步骤与验收

扩容前记录实例规格、磁盘、IP、网络规则和当前服务状态；通过云平台创建磁盘快照，另行备份数据库和私有 Pi 状态。备份不得进入本公开仓库。确认业务维护窗口和自动恢复方案，再从云控制台选择内存至少 8 GiB 的实例规格。若平台要求关机，使用平台的规范流程，不在当前 AI 对话里自行重启服务器。

扩容后执行：

```bash
free -h
vmstat 1 10
cat /proc/pressure/memory
node scripts/doctor.mjs --require-8g
systemctl --user status pi-web-ui-dev.service --no-pager
npm run smoke
```

8 GiB 规格的 guest `MemTotal` 会扣除保留内存，doctor 用 7.5 GiB 作为操作系统可见容量下限；云控制台规格必须仍为至少 8 GiB。验收正常使用 15 至 30 分钟，没有持续 swap-in/out、OOM 或重复重启，WebSocket 稳定；对比同样项目、同样对话和测试工作负载，不用空闲瞬时读数宣称性能提升。

## 5. 安全接入与切换

先用 SSH 隧道测试新实例，再配置模型授权，发送简短提示并运行一个项目内只读命令，确认模型和工具调用。不得自动复制 `~/.pi/agent`，其中可能包含 OAuth、模型密钥、MCP token、系统提示和私有路径。

如需域名接入，单独安排 TLS 反代变更：目标上游 127.0.0.1:8788，完整转发 Host（`$http_host`），正确升级 `/ws`，保持前端资源与 API 同源，并保留 token 鉴权或可靠的外层身份验证。当前仓库不替用户改 nginx、不生成证书、不开放端口。

确认新入口工作、旧对话停止后，可由操作者排空并停用旧服务 `pi-web-ui.service`。新旧服务不能共用 Web 数据目录；历史记录迁移是独立事项，必须停写后备份并核对格式。本轮不迁移历史、不停旧实例。

用户服务开机自启需要 user manager 常驻；检查 `loginctl show-user "$USER" -p Linger`。若为 no，由管理员明确执行 `loginctl enable-linger "$USER"`。安装脚本只 enable 用户服务，不暗改系统级 linger 设置。

同一 Unix 用户的 Pi 仍能访问该用户其他文件。推荐新服务器使用专用非 root 用户；本机保留当前 root 执行身份以避免擅自迁移授权。NoNewPrivileges 不会把 root 变为普通用户，Pi 是高权限远程命令执行界面，不可裸露公网。

## 6. 更新、回滚与备份

修改本项目配置前备份 `~/.config/pi-dev`、`~/.local/share/pi-dev` 和当前用户 unit，私有备份使用访问控制或加密存储。备份时排空会话并停止新服务，以保持 JSON/会话一致性。备份、恢复和删除私有数据不由脚本自动执行。

更新默认流程：确认新实例空闲，停止新实例，切到已审核的提交，重新运行 bootstrap 和测试，启动新实例，再跑 smoke。bootstrap 在新服务仍活跃时拒绝覆盖 node_modules；它不会停止旧实例。

```bash
node scripts/service.mjs stop
bash scripts/bootstrap.sh
npm test
node scripts/service.mjs install
npm run smoke
```

明确升级依赖时，修改版本清单后执行 `bash scripts/bootstrap.sh --update-lock`，审查两份锁文件差异，再正常 bootstrap 和验收。不要在 Web UI 中自更新破坏仓库锁定版本，也不要全局运行 `npm update`。固定版本不等于永远安全，至少定期运行 `npm audit` 并审核 Node 安全版本，升级通过专门提交完成。

本次安装失败或需要撤回时，只停用新实例：

```bash
node scripts/service.mjs disable
```

旧 8787 实例仍可使用，私有目录不删除。恢复某个版本时，先保全未提交改动，然后使用受审查的旧 commit 建立 checkout；在私有 runtime.json 中明确调整 root/node，重新安装该 checkout 依赖和服务。不要使用 `git reset --hard` 丢弃工作，不把旧 lockfile 与新 node_modules 混用。若目录移动，校验会故意失败，避免静默启动旧路径。

## 7. 发布门禁

只提交本仓库的可重建文件。检查 `git diff --cached`、`npm run check:publish`、`git diff --check`；不要上传 .venv、node_modules、auth.json、models.json、mcp.json、会话、截图中的 token、日志、真实环境配置、数据库、SSH 资料和其他项目源码。脚本的密钥扫描是辅助门禁，不替代人工检查。

本机验证与 GitHub CI 分别记录，未跑完的 CI 不写成通过。8 GiB 扩容、模型授权、域名切换都必须按真实状态登记，不能因为文件已推送就宣布服务器所有工作完成。
