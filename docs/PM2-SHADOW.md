# PM2候选发布与回滚

<!-- 🍞 AI Breadcrumb — @COUPLED PM2-PRODUCTION.md, STRUCTURE.md -->

该入口管理独立的候选实例，默认端口8790、名称pi-dev-shadow。它不会自动接管8788正式实例；正式运行规则见 [PM2-PRODUCTION.md](PM2-PRODUCTION.md)。会话/终端驻留进程内，PM2仅使用单实例fork；切换版本会重启候选进程。

## 目录

```text
/srv/pi-dev/
  releases/<id>/                 来自指定提交，经过安装与构建
  current -> releases/<id>       单次rename原子替换
  shared/
    config/                      候选实例私有配置及凭据
    state/web/
    state/agent/
    workspace/                   与代码release独立
    logs/
    pm2/                         此实例独立的PM2_HOME
    previous.json                上个验收成功版本
```

目录必须归非root用户所有。没有 `/srv` 权限时可选择用户拥有的专用绝对路径。PM2应由操作者按锁定运维基线安装，脚本不会自动安装全局PM2或启动其他应用。

## 命令

以下命令只有check是只读，其余按名称执行真实部署动作。先完成源码、测试、提交范围审查，再把完整40位提交SHA作为参数传入。

```bash
PI_DEV_DEPLOY_ROOT=/srv/pi-dev npm run release:check
PI_DEV_DEPLOY_ROOT=/srv/pi-dev node scripts/release.mjs release reviewed-v1 --commit=<FULL_COMMIT_SHA>
PI_DEV_DEPLOY_ROOT=/srv/pi-dev node scripts/release.mjs current reviewed-v1
PI_DEV_DEPLOY_ROOT=/srv/pi-dev node scripts/release.mjs rollback
PI_DEV_DEPLOY_ROOT=/srv/pi-dev node scripts/release.mjs stop
```

其他支持动作：start、reload、delete。它们仅针对配置的应用名称与独立PM2_HOME；不支持操作全部PM2应用的命令。root package的release:check用于只读检查，不等于构建与发布验收。

`PI_DEV_CONFIG_DIR`、`PM2_HOME`若指定，必须是deploy/shared下不同目录。`PI_DEV_SHADOW_PORT`可选择其他未占用的高位端口，但禁止8787、8788和原型预留8791。

## 发布流程

1. 验证所有参数、路径、现有current及版本出处，获得本部署目录的互斥锁。
2. 仅归档明确指定的提交；未提交文件、node_modules、主机虚拟环境及私有状态不会从工作区复制进去。归档不接受符号链接构建输入。
3. 在独立暂存目录执行 `npm run setup:dependencies` 与 `npm run build`，核对build-info的commit，再形成release。
4. 创建或检查独立候选配置；私有数据和workspace保持在shared目录。
5. 原子切换current，并仅启动/重启该PM2进程。
6. 验证进程身份和健康；失败时恢复旧链接和进程，并再次检查恢复结果。首次发布失败则移除current及候选进程。
7. 成功后记录previous，rollback选择最近一次成功切换前的版本，不按目录修改时间猜测。

如果恢复也失败，命令明确报错，需检查候选进程与current。部署进程意外终止留下 `.release-lock` 时，先确认没有部署仍在进行，再由操作者处理锁。脚本不会自动删除历史release或shared数据。

## 验证与转正式运行

根release测试使用临时Git仓库、真实HTTP夹具和隔离进程控制替身验证构建顺序、current切换、失败恢复和状态隔离；它不证明目标机PM2/反代/模型授权已经可用。

真实候选验收还需确认：PM2单实例fork、端口与PID匹配、未认证API/WS拒绝、认证WS就绪、静态页面和终端正常、模型授权单独完成。在线切换前先排空正在生成的会话和PTY任务，再在维护窗口切换所选进程管理器/反代。不能让systemd与PM2同时管理同一个Node进程。
