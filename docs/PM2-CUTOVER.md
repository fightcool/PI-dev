# PM2上线迁移记录

<!-- 🍞 AI Breadcrumb — @COUPLED PM2-PRODUCTION.md, DEV-CON-PROPOSAL.md -->

> **特定迁移的历史记录，不是后续部署计划。** 下文授权、操作顺序和状态仅描述当时事务，不作为今后迁移、重启或整理工作树的授权。正式运行规则见 [PM2-PRODUCTION.md](PM2-PRODUCTION.md)，当前功能开发见 [DEV-CON-PROPOSAL.md](DEV-CON-PROPOSAL.md)。

日期：2026-09-10。用户已特别授权版本切换上线及PM2统一管理。本记录描述已准备的事务；最终执行状态以部署目录 `shared/migrations/status.json` 为准。

## 目标布局

```text
/home/dev/PI-dev/                         主开发checkout（上线后同步新源码）
/home/dev/.local/share/pi-dev/deploy/
  releases/<commit>/                    独立构建的运行版本
  current -> releases/<commit>
  tools/node/                           固定Node22.19.0
  tools/python/                         固定Python3.10.20分发
  tools/python-env/                     uv.lock重建的运行虚拟环境
  tools/uv/                             固定uv工具
  tools/pm2/                            独立锁文件，PM2 6.0.8
  shared/logs/                          PM2输出与错误日志
  shared/pm2/                           此实例独立的PM2_HOME
  shared/migrations/                    切换描述、状态和旧运行配置路径备份
```

私有配置、访问口令、会话及上传继续使用 `~/.config/pi-dev`、`~/.local/share/pi-dev/agent` 与 `web`。不搬迁、不复制凭据，不改变业务工作区路径。运行版本链接独立Python环境，Node解释器不依赖开发checkout。

## 迁移顺序

1. 固定提交归档到release目录，按锁文件安装并完整构建。
2. 在独立候选状态目录和8790端口运行PM2，验证健康、认证、静态资源、WS及SDK首次快照。
3. 安装正式 `pi-dev-pm2.service`，仅由systemd托管PM2 supervisor；正式应用名 `pi-dev-web`，单实例fork，端口8788。
4. 独立的 `pi-dev-cutover` 用户任务对旧UI进行quiesce，等正在运行的对话和队列排空。该任务不属于旧UI cgroup，停止UI不会杀掉迁移。
5. 停止并禁用旧watchdog；停止并禁用旧UI；保留runtime配置的路径元数据备份，再启用PM2 supervisor。
6. 验证新PID、工作区、健康接口、公网前端构建标识，以及匿名WS拒绝。失败恢复旧配置与旧服务并复验。
7. 上线成功后，原开发目录中的已知未提交文件完整保存到Git stash，再切换到新源码并重新安装/构建。文件hash或HEAD发生并行变化时保留现场，状态标为 `deployed_source_pending`。

服务内存规划：Node堆2048MiB，PM2 RSS重启阈值3GiB，用户服务MemoryHigh3GiB/MemoryMax4GiB；为8GiB整机保留余量。`dev` 的linger已启用，开机不依赖SSH登录。

## 状态含义

- `waiting`：等待活动工作结束，旧服务仍在线。
- `switching`：短暂端口交接。
- `deployed`：PM2及公网验证通过，正在整理主源码。
- `complete`：上线及主源码同步均完成。
- `deployed_source_pending`：上线正常；源码存在并行变化或构建问题，未覆盖用户内容。
- `rolled_back`：候选未通过，已恢复旧服务并验证。
- `cancelled`：工作未排空或检查失败，未停止旧服务。
- `recovery_failed`：恢复亦失败，需要查看迁移任务日志。

查询命令：`npm run pm2 -- status`；迁移日志：`journalctl --user -u pi-dev-cutover.service --no-pager`。状态文件只包含提交、PID、阶段和保留stash标识，不包含凭据。
