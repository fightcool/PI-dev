# 结构、发布与性能整改验收

<!-- 🍞 AI Breadcrumb — @COUPLED DEV-CON-PROPOSAL.md, PM2-PRODUCTION.md -->

> **历史验收记录，不是当前开发计划。** 正文中的“本轮”“未来dev-con”和在线状态均对应下述基线；当前功能以 [DEV-CON-PROPOSAL.md](DEV-CON-PROPOSAL.md) 为准，正式运维以 [PM2-PRODUCTION.md](PM2-PRODUCTION.md) 为准。

日期：2026-09-10（服务器UTC）。基线：`47d3049`。实现分支：`feature/project-foundation`，独立worktree开发，在线 `/home/dev/PI-dev` 服务未停止、重启或切换。

## 已完成的改动

- 保留有来源的 `vendor/pi-web-ui` 与未来独立 `dev-con/` 边界；根README及STRUCTURE统一入口，历史认证/环境验收移入docs/history。
- 用量与策略从每模块三份副本收敛到 `vendor/pi-web-ui/lib/usage`，通过package imports保证源码、编译产物和应用包引用同一实现。
- 根不再安装npm版UI，删除SDK依赖目录手工链接脚本。根锁文件package路径836→518，同一路径的依赖版本未升级。干净安装成功；根与vendor实际node_modules约733MiB/803MiB。
- 根提供依赖安装、开发、构建、类型、单元、协议、性能与发布入口。开发实例使用 `.dev` 与8890后端，在线和候选实例独立。
- 启动固定vendor构建，代码root/workspace/私有state分开；受管理扩展路径随版本迁移。managed模式阻止UI自更新绕过锁文件。
- 发布采用指定提交归档、独立暂存构建、commit出处校验、单实例PM2、原子current与健康失败恢复。清晰限定候选端口，不自动接管在线8788。
- systemd原生重启替代重复watchdog，维护先停止旧timer；资源限额支持校验后的显式覆盖，默认容量不盲目增加。
- 根Docker交付显式匹配/config、/data/web、/data/agent、/workspace卷，并复制包内模块、主题和插件。
- 登录门内动态加载App，修复React反向依赖Markdown的分包问题，高亮样式按需加载；终端、SCM、插件视图和弹窗首次使用再挂载。
- App按职责拆成小模块；MessageList约300行，有界渲染包括折叠摘要与问题导航。删除无调用方的旧LazyMount/lazy-window实现，以行为测试保留测量缓存回归。
- 流式Markdown在分段解析之前采样，连续30次更新只触发一次后续解析，尾部最终内容完整显示。
- 首次快照合并、历史扫描single-flight与失效控制、搜索锚点异步流读取。保留协议版本15及多端同步语义。
- 补齐前一提交遗漏的八种语言技能提示文本；清理lint确认的未使用变量/导入。

## 可比较的性能结果

使用相同 `tests/performance` 脚本分别加载旧在线构建产物与新worktree构建。Chromium、1280×800、CPU降速4倍，每版本每场景5次，全部HTTP/WS由Playwright在本地提供；无模型调用、真实会话或用户浏览器数据。只比较初始化测量，不把旧版本不符合新虚拟化预算的断言当成运行异常。

| 场景 | 旧展示就绪中位数 | 新展示就绪中位数 | 旧DOM元素 | 新DOM元素 | 旧最长任务中位数 | 新最长任务中位数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 登录 | 756ms | 531ms | 25 | 24 | 179ms | 80ms |
| 20条消息 | 2031ms | 2050ms | 1203 | 1100 | 797ms | 933ms |
| 200条消息 | 2565ms | 1939ms | 2501 | 434 | 1083ms | 686ms |
| 1000条消息 | 4759ms | 2208ms | 10901 | 434 | 2312ms | 641ms |

1000条消息DOM减少约96%，展示就绪中位数减少约54%，最长任务中位数减少约72%。20条短会话没有明确提速，最长任务样本有波动。新版本全部20个浏览器场景通过，包含旧消息搜索、前后命中、导航、展开、返回底部，以及终端/插件首次加载。

“展示就绪”包含脚本等待节点及固定稳定窗口，不等于FCP或精确React提交时间；这组数字不能与前轮不同脚本测出的2.84秒直接比较。CPU降速也不是某款手机的实测。仍存在约0.6秒长任务，后续可针对长正文解析优化。

登录JS从原约1.07MB减少为约265KB（未压缩），App/Markdown/xterm不在匿名页面请求集合中；根构建仍对聊天使用的约508KB Markdown chunk报告Vite大小提示，该包不再阻塞登录。

原始数据在忽略目录 `.dev/performance/`：旧版 `2026-09-10T06-38-28-373Z-98040.json`，新版 `2026-09-10T06-46-36-048Z-121243.json`。复现方法：

```bash
BENCH_ITERATIONS=5 npm run test:performance
BENCH_WEB_ROOT=/path/to/baseline/web/dist BENCH_ASSERT=0 BENCH_ITERATIONS=5 npm run test:performance
```

## 验证记录

- 两份锁文件干净安装及完整 `npm run build` 已通过。
- `npm run typecheck` 已通过。
- 根 `npm test`：148/148通过，包含PM2 ESM包装器回归。应用 `npm run test:unit`：68个测试文件、549/549通过。
- `npm --prefix vendor/pi-web-ui run lint`：0警告、0错误；协议单源检查通过。
- `.venv/bin/python -m pytest tests/test_environment.py -q`：1项通过。
- `node scripts/ci-smoke.mjs`：隔离真实服务，健康/工作区/鉴权/3个前端资源/WS升级通过。
- 协议首轮36/38；两个旧测试修正夹具隔离和异步状态等待后，settings/terminal重跑2/2通过，38种协议场景均有通过记录。
- `npm run check:publish`、`git diff --check`通过。
- 独立复核发现production环境可能漏装构建依赖，已显式 `npm ci --include=dev`。

- 多设备会话列表同步及节点接力真实协议测试通过（隔离的本地模型mock）。
- 开发入口实际启动8890和5173，工作区正确，退出后两个端口均释放。
- 实际PM2 6.0.8演练：在临时目录安装PM2，独立PM2_HOME与8790端口，从提交 `ba3796a` 两次完整归档/安装/构建/发布（约68秒、66秒），current正确切换；rollback约3.5秒恢复candidate-one，之后完整smoke通过，临时PM2 daemon已停止。首次演练发现PM2 ESM包装器不修改argv[1]，修正isMain并新增IPC包装器回归后复测成功。

Docker当前主机未安装，未进行真实docker build/up；根compose与vendor独立应用compose均已解析检查，vendor卷和运行路径也已对齐。实际PM2演练的候选release及临时PM2安装已精确清理，保留无凭据的结果汇总。线上服务未切换，因此上述UI优化尚未对当前公网实例生效。首次正式切换仍应在维护窗口确认活动会话、备份和回滚路径。

## 保留的边界

没有实现dev-con的渠道/MCP/技能同步功能，没有复制或清理其他Agent的私有目录。两个依赖根是明确的所有权边界，不为减少目录数量强行合并。agent-service/index/use-chat仍是大文件，本轮仅抽取直接涉及的缓存、搜索、初始化和视图模块；没有借性能整改重写整个SDK接入层。
