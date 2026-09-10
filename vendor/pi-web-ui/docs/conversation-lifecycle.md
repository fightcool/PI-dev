# 会话缓存与子代理归档

<!-- 🍞 AI Breadcrumb — @COUPLED ../server/conversation-retention.ts, ../server/conversation-maintenance.ts, ../server/subagent-archive.ts -->

用户新建对话和打开历史不再受“同项目最多8个已打开对话”的硬限制。8现在是普通会话的空闲缓存目标：超过目标时优先释放最久未使用且可恢复的后台会话，不删除持久历史；正在运行的对话可以暂时超过缓存目标。

## 清理边界

- 当前正在查看的对话保留；普通空闲对话在缓存压力下回收，历史可重新打开。
- 子代理在真正结束且处于后台时自动归档并释放运行时，从运行列表移出。查看中的子代理在离开后再处理，避免打断阅读。
- 生成、启动、提交消息、重试、压缩、工具执行、目标审查、向导、排队消息、接力重载、存活PTY、扩展异步任务或待唤醒记录均阻止清理。
- 有受保护子任务的祖先同样保留。清理从叶子开始，子任务归档失败时父任务也保留，避免孤儿。
- SDK `agent_settled` 和导航/运行列表变化触发异步清理，另每5秒检查终端退出和唤醒状态变化；清理计时器不阻止进程退出。
- 已退出、只保留输出的终端不占运行资源；有活进程的终端不会自动被关闭。

## 子代理结果与继续

运行中子代理仍使用Pi内存会话；完成后，完整session entries、摘要、模型及模板记录保存到私有 `<dataDir>/subagent-archive/<client-hash>/<runId>.json`，再释放扩展、运行时与终端资源。目录0700，文件0600；写入失败时保留原运行时并提示，绝不先丢结果。

- `subagent_get_result(runId)` 可读取归档结果，标注已归档。
- `subagent_steer(runId, message)` 按相同runId及会话内容恢复后继续；归档不会导致重新从空上下文开始。
- `switch_conversation` 也支持按归档runId恢复查看，离开后可再次归档。
- `subagent_list` 返回运行中的任务及最近100个归档结果，更早的结果仍可按runId读取；归档不进入普通用户会话的运行计数。
- 创建和恢复执行采用独立的子代理并发预算（8个），不占用用户新建对话名额。已结束的记录不消耗并发名额。
- 归档按client隔离；恢复父子关系时核对父会话持久身份，避免服务重启后普通conversation编号复用导致误挂。

不自动删除归档文件。原版没有落盘的子代理无法在进程已经退出后凭空恢复；升级前已有结果的保留不能由本次隔离测试推断。普通Pi历史仍在SDK原生会话目录，不迁移。

## Pi与DSH

两条new_chat路径都采用空闲缓存预算。Pi额外处理第一方子代理、扩展唤醒和运行时释放；DSH保留自己的原生日志及恢复方式，回收只处理空闲且没有存活终端、排队任务或目标工作的会话，不重启共享DSH运行时。

## 验证入口

```bash
npm test -- tests/unit/conversation-retention.test.ts tests/unit/conversation-maintenance.test.ts tests/unit/subagents.test.ts tests/unit/wait-subscription-scan.test.ts
npm run build
node tests/conversation-lifecycle-test.mjs
```

以上从vendor/pi-web-ui目录运行。集成测试使用真实Pi SDK和本地模型替身，验证10个并行用户运行时仍可新建、空闲回收与历史重开、12个子代理自动归档、归档后取结果/继续/查看、失败与取消清理；DSH入口用运行时替身验证，不发起真实DSH请求。测试数据全部临时生成，不使用线上会话或模型授权。
