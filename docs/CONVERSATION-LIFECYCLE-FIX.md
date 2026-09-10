# 会话名额与子代理清理修复记录

<!-- 🍞 AI Breadcrumb — @COUPLED ../vendor/pi-web-ui/docs/conversation-lifecycle.md
     @CONTRACT 独立维护修复与验收记录，不改变DEV-CON渠道开发规划。 -->

基线 `c3f845b`，分支 `fix/conversation-lifecycle`，独立工作树 `/home/dev/PI-dev-worktrees/conversation-lifecycle`。主工作树中的规划文档、原型及未提交修改保持原状。

## 问题与变更

原Pi newChat/switchSession按同项目全部驻留conversation计数，8个即拒绝；完成的第一方子代理留在同一Map，既占名额又使父会话继续保留。回收依赖用户打开再离开，导致正常工作被阻塞。

- Pi/DSH用户新建不再受8个驻留会话硬限制；8为可回收的普通会话缓存目标，忙碌工作保留。
- 空闲且可恢复的普通历史按最久未使用顺序释放；不删除会话文件，不用跨项目空白或子代理对话充当新对话。
- 后台子代理结束后先写完整私有归档，再释放运行时；结果、模板、模型及会话entries可按原runId读取/恢复。
- 首次创建与归档后继续受独立子代理并发预算约束；归档结果不占名额，不阻止用户新建。
- 保护启动、重试、压缩、队列、工具、活PTY、审查/向导、扩展任务/唤醒和祖先；失败保留原运行时。
- 归档按client隔离，恢复父关系核对会话身份，避免普通conversation编号复用造成误挂。

主要新增模块为 `conversation-retention.ts`（策略）、`conversation-maintenance.ts`（生命周期）、`subagent-state.ts`（结果状态）和`subagent-archive.ts`（私有归档）。行为契约见[会话生命周期](../vendor/pi-web-ui/docs/conversation-lifecycle.md)。没有新增运行依赖，未改锁文件或模型配置。

## 实际验证

在独立工作树执行：

| 检查 | 结果 |
| --- | --- |
| `npm test`（根工程） | 168/168通过 |
| `NODE_ENV=test npm --prefix vendor/pi-web-ui test` | 70文件、574/574通过 |
| `npm --prefix vendor/pi-web-ui run typecheck` | 通过 |
| `npm --prefix vendor/pi-web-ui run lint` | 0警告、0错误 |
| `npm --prefix vendor/pi-web-ui run build` | 通过；原有Markdown chunk大小提示仍存在 |
| `node scripts/protocol-smoke.mjs conversation-lifecycle-test conv-cwd-test` | 2/2通过 |
| `node scripts/protocol-smoke.mjs conv-cross-project-test` | 1/1通过 |
| `node scripts/protocol-smoke.mjs switch-session-background-test quiesce-test subagent-template-test` | 3/3通过 |

新增真实SDK/本地模型集成验证：10个用户对话并行时仍可新建、空闲回收和历史重开；12个子代理完成自动归档、原ID继续和查看；8个子代理并行不挡用户新建；失败/取消结果保留；DSH新建与未落盘消息保护。DSH使用入口替身，没有调用真实DSH或模型服务。

首轮应用单测继承 `NODE_ENV=production`，34个原有React测试报`act(...) is not supported in production builds of React`；明确设置test后全量通过。全量测试与编译并行时一次类型检查触及60秒命令时限，单独重跑通过。最初把含内部完整构建的跨项目脚本与其他脚本放同一60秒命令中，断言均通过但外层超时；拆分后各组退出正常。不将超时轮次记作完整通过。

## 自检与生效边界

新模块与新测试均低于300行；原有大型agent-service/subagents文件只做生命周期接线和相关逻辑抽取，未扩展无关重构。核对了归档先于释放、当前查看/忙碌对话保护、失败重试、恢复竞态、模板保持、client隔离和Pi/DSH入口一致性。无自定义pipeline配置，使用通用检查及实际测试。

上线前需明确版本并切换独立release，普通重启旧release不会加载本修复。当前记录不代表线上已经生效；旧版子代理仅在内存，其未持久化内容不会因新版本自动补回。已有主对话中的返回结果与普通Pi历史不受本修复删除。
