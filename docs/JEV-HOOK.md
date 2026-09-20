# Jev 提交钩子

<!-- 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-gate/index.ts, ../extensions/jev-gate/command.mjs, ../extensions/jev-gate/gate.mjs, ../extensions/jev-gate/state.mjs, ../scripts/install-jev-hook.mjs, ../tests/jev-hook.test.mjs, ../tests/jev-hook-state.test.mjs, ../tests/jev-hook-install.test.mjs, ../tests/jev/hook-live.mjs -->

Jev 在 Pi 的 `tool_call` 钩子里自动检查即将执行的 bash `git commit`。无需模型主动调用 `jev_check`。
**只有有效决策中的 `block` 拦截**：Pi 收到 `{block: true, reason}` 后不执行本次 bash，并把中文理由、分数、生效阈值回给模型修复。
`review` 显示「灰区，未拦」，`approve` 显示通过。没有确认弹窗。

CLI、配置缺失、超时、上游失败、意外退出码、损坏回包、无法计算 diff 都**告警放行**，提示「未完成判定」，不能当作 approve。
有 UI 时走 `ctx.ui.notify`（TUI/RPC）；无 UI 或通知接口失败时走 stderr。加载时也会提示启用状态。

## 源码与调用链

- `extensions/jev-gate/index.ts`：Pi 扩展入口、通知、最外层故障保护。
- `command.mjs`：保守识别字面 shell 命令，不执行解析出的 shell 文本。
- `state.mjs`：用参数数组调用 Git，读取暂存差异、清洗并截断。
- `gate.mjs`：通过 stdin 调用版本内 `vendor/pi-web-ui/scripts/jev-gate.ts check --state-file - --json`。

不传 `--proposition`，因此 CLI 每次从其注册表读取全部命题，从 `$PI_CODING_AGENT_DIR/dev-con/jev-settings.json` 读取配置和逐命题阈值。
扩展没有另存命题名单、阈值或凭据。密钥仍只由 CLI 经现有 ModelAdmin 解析。
退出码契约为 approve=0、block=1、review=2、失败=3；扩展同时检查 JSON outcome、错误字段与有效分数。
生效阈值使用 CLI 的中文 `reason`，不在扩展中重算。
缓存、样本记录及费用口径仍由 [Jev 门禁内核](JEV-DECISION-GATE.md) 负责；CLI 调用不会主动更新在线 Web 服务的内存 Jev 状态栏。

## 安装、升级、关闭和卸载

安装是**自包含**的：脚本把扩展本体**复制**到宿主目录，不改 `settings.json`，也不依赖仓库路径。

```bash
cd /home/dev/jev-hook
PI_CODING_AGENT_DIR=/home/dev/.local/share/pi-dev/agent node scripts/install-jev-hook.mjs install
```

| 装到哪                              | 内容                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `<agentDir>/extensions/jev-gate.ts` | 入口 shim，内容固定为 `export { default } from "../hooks/jev-gate/index.ts"`（**相对**路径）               |
| `<agentDir>/hooks/jev-gate/`        | 扩展本体（`index.ts` / `command.mjs` / `gate.mjs` / `state.mjs`），随 `.managed-by` 标记一起由本安装器管理 |

> **为什么本体在 `hooks/` 而不在 `extensions/`**（`@GOTCHA`，都是实测踩出来的）：
> ① pi 的全局发现规则有两条 —— `extensions/<文件名>.ts` 与 `extensions/<目录名>/index.ts`。
> 把本体放进 `extensions/jev-gate/`，它**自己也会被当成一个扩展**发现，于是同一个钩子加载两次
> （SDK 实测 `extensions.length === 2`）。
> ③ **只靠会话 cwd 找 CLI 不够**：在别的项目里提交时 cwd 不含 `vendor/pi-web-ui`，钩子会找不到 CLI 而**静默放行**（实测：在 `/tmp/<临时仓库>` 提交没被拦）——所以安装时把 checkout 路径写进 `app.json` 兜底。
> ② 第一版入口写的是「re-export 指向仓库里的绝对路径」，结果指向了一个**临时 worktree** —— 那个目录一删，
> 所有会话加载扩展都会报错。现在入口是相对路径 + 本体内联在宿主里，**装完就与仓库位置无关**。

| `<agentDir>/hooks/jev-gate/app.json` | **兜底**：安装时记下的「门禁 CLI 在哪个 checkout」（`vendor/pi-web-ui`）。会话在**别的项目**里提交时（cwd 不含 `vendor/pi-web-ui`）靠它找到 CLI；换兜底 checkout 就在那个 checkout 里重跑 install |

**升级**：`git pull` 后重跑 `install`（会覆盖本体文件；旧版本入口带同一行管理标记，因此能直接升级，不会被当成别人的扩展拒掉）。
**卸载**：

新启动的 Pi 会话自动加载；**已经运行的会话不会自动热更新**。在 Pi TUI 执行 `/reload`，或在 Web 宿主中重新创建会话运行时，才会加载此入口。
`--no-extensions`、宿主的资源过滤或扩展禁用配置仍可阻止加载。以会话启动的「Jev 提交钩子已启用」通知为准。

一键关闭（环境变量必须设在 **Pi 宿主进程**，仅给 bash 子进程设变量无效）：

```bash
JEV_GATE_HOOK=off pi
```

Web 宿主同理在其启动环境设置 `JEV_GATE_HOOK=off`；不需要改 Jev 阈值或删除配置。
恢复时取消此变量并重建宿主运行时。CLI 的门禁总开关 `enabled=false` 也会使调用失败告警放行，但不建议用它替代 hook 的独立关闭开关。

```bash
cd /home/dev/jev-hook
PI_CODING_AGENT_DIR=/home/dev/.local/share/pi-dev/agent node scripts/install-jev-hook.mjs uninstall
```

卸载会删掉入口 shim 与 `<agentDir>/hooks/jev-gate/` 本体；之后 `/reload` 或重建会话运行时。不删配置、缓存、样本或凭据；代码回滚可对本功能提交执行 `git revert <commit>`，应先卸载入口。

## 检查范围与性能

支持 `git commit`、`git -C <path> commit`、多个 `-C`、`--amend`、`command git commit`、`cd <literal> && git commit`，以及常见消息、签名和非交互参数。
能识别 `git -c x=y commit`；仅身份和颜色覆盖可以安全审查，其它 `-c` 覆盖告警放行，以免针对错误仓库下结论。
`git log --grep commit`、`echo "git commit"`、`git commit-tree`、引号中的整段命令、注释、heredoc 都不会误拦。
有变量展开、命令替换、管道、OR、函数/控制结构等复杂 shell 语法时不解析、不拦截。

普通提交用 `git diff --cached`；amend 用 **第一父提交到当前暂存区** 的 diff，包含 HEAD 原有改动；根提交 amend 用空树基线。
目标说明取暂存区 stat 摘要，明确标注没有原始任务目标，因此 scope 判断的上下文有限。
只发 diff 与摘要，不读取整个仓库。关闭 external diff/textconv，敏感文件 patch 整段省略；私钥块、常见 token 形状、长不透明串及敏感赋值做清洗。
清洗是启发式，不能识别所有业务秘密；提交前仍须保证暂存区不含凭据。
清洗后 diff 超过 **24000 字符**截断并在 state 和界面注明；摘要最多 1200 字符。
Git 输出超过 8 MiB 或每个 Git 命令超 10 秒则告警放行；CLI 硬超时 35 秒（内核另有请求超时）。不会把原始进程异常或 stderr 回显。

普通 bash 只进行工具名/开关/字符串检查，没有 Git、磁盘或网络 I/O。提交才启动 CLI；复用内核磁盘缓存。
**端到端还包含 Node/tsx/CLI 启动开销**，不能把模型或缓存本身的毫秒延迟当作 hook 总耗时。

## 验证与边界

```bash
node --test tests/jev-hook*.test.mjs
npm run typecheck
vendor/pi-web-ui/node_modules/.bin/tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --allowJs --skipLibCheck --strict extensions/jev-gate/index.ts
vendor/pi-web-ui/node_modules/.bin/oxlint --deny-warnings extensions/jev-gate scripts/install-jev-hook.mjs tests/jev-hook*.test.mjs tests/jev/hook-live.mjs
npm run check:publish
# 显式联网验收（读取既有命名凭据；生成式 Agent 响应由测试替身提供）：
PI_CODING_AGENT_DIR=/home/dev/.local/share/pi-dev/agent node tests/jev/hook-live.mjs --live
```

离线测试注入假 CLI 结果；暂存内容测试使用临时 Git 仓库；安装测试使用临时 agentDir，验证 SDK 自动发现与 RPC 通知。
live 脚本通过 **真实 Pi SDK AgentSession → tool_call → 原生 bash** 执行，真实调用 Jev，断言 block 不改变 HEAD、review/approve 允许真正提交；结束清理临时目录。

已知边界：

- **无测试改动可能误拦**：当前 CLI 问全部命题。实测纯注释改动 API=0.98，但 test=0.08，低于其 blockAt=0.15，被拦。hook 不擅自改变命题适用性或阈值。
- `git add … && git commit`、提交前还有其它命令、`git commit -a`、路径选择/交互暂存等无法用当前 index 确定最终 diff：显式告警放行。请先单独暂存，再单独提交。
- 这不是 Git pre-commit hook、CI 或安全沙箱。直接终端、`!`/RPC 用户 bash、Python/其他工具提交、脚本/别名、push 已有提交等不会触发此工具钩子。
- 假设 bash 使用 `ctx.cwd`；若宿主替换为有独立 cwd 的持久终端或远程 shell，请用明确的绝对 `git -C`，本实现不能查询那些 shell 的隐式状态。
- 同批并行暂存、外部进程、后续扩展改写命令或 Git pre-commit hook 仍可能在审查后改变内容；暂存区没有跨进程锁定。截断后的未审部分也不构成已通过。
- 全局安装并不重载已有会话，也没有浏览器 UI 像素验证；真实通知显示取决于宿主处理 SDK `notify`。

完整实测输出与首次失败记录见 [本次交付记录](JEV-HOOK-VALIDATION.md)。
