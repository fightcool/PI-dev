# PM2 shadow 发布（当前服务器）

目标主机为当前开发服务器 `C202609091757997`，使用 `dev` 用户；公网入口为
`https://dev.ftai.cc`。PM2 shadow 端口仍仅用于本机过渡验收，不应直接暴露到公网。

阶段 C 首轮只提供 PI-dev 专用的 PM2 ecosystem 和发布检查，不会自动启动进程，也不会操作其他 PM2 应用。

## 当前约束

- 当前 8788 systemd 实例保持不变。
- legacy 8787 实例保持不变。
- 8790 及其他高位端口仅供 shadow 候选使用。
- PM2 app 名称默认是 `pi-dev-shadow`。
- 正式迁移前必须使用专用非 root 用户和独立 `PM2_HOME`。

## 静态检查

```bash
PI_DEV_SHADOW_PORT=8790 npm run release:check
npm test
```

`release:check` 只验证 release 入口、锁文件、配置目录、PM2 ecosystem、app 名称和 shadow 端口。它不会执行 `pm2 start`，也不会改变服务状态。

## 目标目录

正式迁移时使用独立目录，不在正在运行的 checkout 中原地替换依赖：

```text
/srv/pi-dev/
  releases/<release-id>/
  current -> releases/<release-id>
  workspaces/PI-dev/
  shared/config/
  shared/agent/
  shared/web/
  shared/logs/
  pm2/
```

PM2 应以专用用户运行，并使用自己的 `PM2_HOME`。不要用 `sudo pm2`，不要使用 `pm2 restart all` 或 `pm2 kill`。

## 尚未完成

以下动作必须等非 root 用户、独立 release 和 shadow 健康检查实现后再执行：

- `pm2 start` / `reload` 真实应用；
- PM2 开机恢复；
- current 原子切换；
- quiesce 排空；
- rollback；
- 停止现有 systemd 应用。
