# Jev 提交钩子交付与实测记录

<!-- 🍞 AI Breadcrumb — @COUPLED JEV-HOOK.md, ../extensions/jev-gate/index.ts, ../tests/jev/hook-live.mjs -->

本次新增版本化 Pi 扩展及全局安装入口：bash 提交前自动跑现有 Jev CLI，只有 block 拦截；review 和门禁故障告警放行。没有新增 npm 依赖，没有修改 Jev 内核、协议、CLI 或 Jev 前端组件。
工作目录 `/home/dev/jev-hook`，分支 `feat/jev-hook-gate`，基线 `1fe7531`。

## 实际执行的验证

| 层次 | 命令/操作 | 结果与耗时 |
| --- | --- | --- |
| T0 | `node --test tests/jev-hook.test.mjs tests/jev-hook-state.test.mjs` | 首轮 55/55，0.424 秒 |
| T0 | `node --test tests/jev-hook*.test.mjs` | 加入安装与 SDK 通知验证后 56/56；本轮未单独记耗时 |
| T0 | `npm run typecheck` | 三份应用 tsconfig 全部通过，60.50 秒 |
| T0 | `vendor/pi-web-ui/node_modules/.bin/tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --allowJs --skipLibCheck --strict extensions/jev-gate/index.ts` | 扩展入口单独类型检查通过；未单独记耗时 |
| T0 | `vendor/pi-web-ui/node_modules/.bin/oxlint --deny-warnings extensions/jev-gate scripts/install-jev-hook.mjs tests/jev-hook*.test.mjs tests/jev/hook-live.mjs` | 最终 9 个代码文件，0 warning / 0 error，51 毫秒 |
| T1 | `npm test` | 269/269 通过，8.18 秒（测试 runner 7.884 秒） |
| T1 | `npm run check:publish` | PASS；无真实凭据、运行数据或 jsonl 制品 |
| T1 | `git diff --check` | 通过 |
| 定向联网验收 | `PI_CODING_AGENT_DIR=/home/dev/.local/share/pi-dev/agent node tests/jev/hook-live.mjs --live` | 最终成功，使用真实 SDK hook、真实 Jev CLI 和临时 Git 仓库；未单独记耗时 |
| 全局安装 | `PI_CODING_AGENT_DIR=/home/dev/.local/share/pi-dev/agent node scripts/install-jev-hook.mjs install` | 成功，新建全局扩展入口；未修改 settings 或凭据 |
| 全局发现 | `DefaultResourceLoader` 使用真实 agentDir、内存 settings，从 `/tmp` 加载 | `{"globalHookFound":true,"toolCallHook":true,"extensionErrors":0}` |

未运行全量 smoke、渠道 e2e、浏览器 e2e、性能里程碑门禁；由主代理收口。未替所有已经运行的会话重载资源，也未重启生产服务。

## 最终联网验收输出

生成式 Agent 的工具调用由测试替身提供，因此无需另花生成模型费用；**工具执行和 tool_call 拦截是 SDK 的真实路径**，不是手写模拟拦截。
Jev 则使用本机现有命名密钥配置，CLI 自己解析凭据。第二次跑相同破坏样本可命中内核缓存，本次不强制绕缓存。

```text
Jev 提交钩子已启用：仅 block 拦截；review 与故障告警放行。
[1/2] Breaking public export removal → expect block
Jev 已拦截本次提交，请根据判定修复后重新提交：判定项触及拦截阈值（change_preserves_public_api=0.04（独立阈值 0.7/0.15）, test_asserts_behavior=0.11（独立阈值 0.95/0.15）；拦截阈值 0.1（全局；带独立阈值的项已逐项标注））
分数：change_preserves_public_api=0.04，test_asserts_behavior=0.11，change_within_task_scope=0.23
breaking-api: isError=true
Jev 已拦截本次提交，请根据判定修复后重新提交：判定项触及拦截阈值（change_preserves_public_api=0.04（独立阈值 0.7/0.15）, test_asserts_behavior=0.11（独立阈值 0.95/0.15）；拦截阈值 0.1（全局；带独立阈值的项已逐项标注））
分数：change_preserves_public_api=0.04，test_asserts_behavior=0.11，change_within_task_scope=0.23
PASS: block left HEAD unchanged
[2/2] Compatible comment with concrete behavior test → expect allow
Jev 灰区，未拦：判定项未全部达到放行阈值（未达标：change_within_task_scope=0.44（独立阈值 0.5/0.1）；放行阈值 0.9（全局））
分数：change_preserves_public_api=0.96，test_asserts_behavior=0.97，change_within_task_scope=0.44
compatible-comment-and-test: isError=false
[master 3a2a122] compatible-comment-and-test
 2 files changed, 5 insertions(+)
 create mode 100644 api.test.ts

PASS: allowed commit advanced HEAD
```

## 失败与修正记录

1. 首轮离线测试通过，但 oxlint 报 1 个无用正则转义 warning；移除后最终 0 warning。
2. 初版 live harness 依照 SDK 文档从 pi-ai 导入 `getModel`，实际安装包没有该导出，尚未发出 Jev 请求即失败。改用公开 `ModelRuntime.getModel` 后启动成功。
3. 首次真实 live 的破坏 API 用例已成功拦截；正常用例只改注释，被 test 命题误拦，实际输出：

```text
Jev 已拦截本次提交，请根据判定修复后重新提交：判定项触及拦截阈值（test_asserts_behavior=0.08（独立阈值 0.95/0.15）；拦截阈值 0.1（全局））
分数：change_preserves_public_api=0.98，test_asserts_behavior=0.08，change_within_task_scope=0.37
compatible-comment: isError=true
AssertionError: true !== false
```

最终放行样本增加 `assert.equal(greet("Ada"), "Hello Ada")` 具体行为测试。没有改变命题、阈值或判定映射。此结果**不证明所有兼容改动都能放行**；无测试提交的命题适用性应在后续单独处理。

## 自检与交付边界

调用链、失败分支、注册/发现、CLI 退出码校验、截断、敏感输出和文档链接已检查；所有新增代码文件均低于 100 行。
仓库没有 `pipeline.json` / `.ai-pipeline` 配置，本轮跳过对应的项目定制注册/规则自生长步骤，执行通用自检与实际测试。
本文件同时记录变更说明、文件职责、新依赖（无）、检查结果和已知问题。

主要剩余限制：全部命题对无测试改动可能误拦；scope 只有暂存摘要；复杂 shell 漏判；同次 add/commit 告警放行；持久终端隐式 cwd、并发改 index、Git hook 改内容不受控；不拦其他工具/直接终端/脚本提交或 push；没有 Web 浏览器通知外观验收。
关闭、卸载及回滚步骤见 [JEV-HOOK.md](JEV-HOOK.md)。
