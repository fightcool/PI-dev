# issue #91 v2 — 服务端第三语言（翻译表）交接任务书

> 给接管的 AI 看的。目标：让服务端字符串支持中英之外的第三语言（种子语言：日语 `ja`），
> 加语言 = 往语言包填表。用户已定方向：英文默认、跟随 UI locale、缺 key 回英文。

## 0. 背景与已定决策

- issue #91：服务端 tool 描述/返回/提示词硬编码中文，UI 语言切换管不到。
- v1（已合入工作树）：`server/i18n.ts`（`resolveServerLang`/`pick`/`bilingual`，中英内联），
  `hello.locale`/`set_locale` 上报语言，`client-state.json` 持久化，tool definition 双语内联、
  per-call 返回 `pick`、notice 走 `text`+`textEn`。切到非中文 UI 即英文。
- v2（本任务）：`pick` 加 key + 翻译表，其他语言查表、缺表/缺 key 回英文。
  **不要**改 v1 已定行为（zh 走内联中文、en 走内联英文）。

## 1. 核心机制（必须精确遵守）

`server/i18n.ts`（已实现，有单测 `tests/unit/server-i18n.test.ts`）：

```ts
pick(lang, zh, en, key?, vars?)
```

- `lang`：归一化 UI 代码（`resolveServerLang`：zh-CN→zh、pt-BR→pt，空→en）。
  类型 `ServerLang = string`（v1 的 `"zh"|"en"` 已放宽）。
- `zh`：中文内联，`lang==="zh"` 时直接返回，**无视 key/vars**。
- `en`：英文内联，查表 miss 时的回退。
- `key`：全局唯一翻译 key，格式 `<模块>.<slug>`（如 `subagents.list.empty`）。
- `vars`（第 5 参数）：插值变量。**翻译表的值是静态字符串**，动态部分用 `{表达式}` 占位，
  `表达式` = 调用点英文原文 `${...}` 里的**原样文本**（含 `p.template`、`r.error` 这种成员链，
  也含 `(err as Error).message`、`Math.round(x/1000)` 这种复杂式——一律照抄，不许改名/简化）。
  空白归一：key 和表值里的占位名都要把空白序列（空格/换行/Tab）压成单个空格后再比对
  （实现侧 `formatTable` 用 `split(`{${k}}`)` 精确匹配，所以归一必须两侧一致）。
- `formatTable`：只替换 vars 里有的槽；表中多余的 `{x}` 原样保留；`null/undefined` 填成空串。
- `bilingual(en, zh)`：tool definition 专用，**静态双语、无 key**（会话创建时烘焙，模型看英文无碍），不动。
- `getServerBlock(lang, key, zhLines, enLines)`：多行块（guidance 数组等），表里存 `\n` 拼接的一行。

加载链（已实现，有单测 `tests/unit/locales-server.test.ts`）：

- `locales/<code>.json` 包文件新增可选 `serverStrings` 节（`{key: 译文}`），与 `strings` 同文件、
  一次下载全带走；`validatePack` 校验（非字符串值拒绝，空串忽略）。
- 服务端启动 + 包安装/删除时经 `loadServerStrings(dataDir)` / `unloadServerStrings(code)` 注册
  （见 `server/index.ts`）。缺 key 自动回英文，所以**部分翻译可安全上线**。
- `locales/*.json` 不在 `npm run format:check` 路径内，保持 2 空格原格式，**不要跑 prettier --write**。

## 2. 已完成（工作树现状，全部过检时）

- 基建：`server/i18n.ts`（注册表+`pick` key/vars+`formatTable`+`getServerBlock`+`extractServerStrings`）、
  `server/locales.ts`（`validatePack` serverStrings+`loadServerStrings`/`unloadServerStrings`）、
  `server/index.ts`（启动加载+安装/删除钩子+`DispatchSession.getLang(): string`）、
  单测（`server-i18n.test.ts` 13 项、`locales-server.test.ts` 含表注册/卸载）。
- key 迁移：约 160 个 `pick` 全补第 4 参数 key（25 个文件，无行为变化——无表时全回英文）。
- vars 补全：model-admin/plugins/plugin-catalog/plugin-updater/update-check/files 等已齐；
  **剩余以 `node tests/scratch/vars-ast.cjs` 输出为准**（约 78 处，主要是 subagents/dsh/goal/markers/todo/terminals；
  该脚本用 TS AST 精确定位：无第 5 参数 + 含 `${}` 的 key，附行号和占位表达式）。
- 日语种子已入库 54 条（JSON 原样存 `${}`，合并时机械转换，见 §5）：
  `tests/scratch/ja-batch-editsoft-goal.json`（29：editsoft 11 + goal 18）、
  `tests/scratch/ja-batch-misc.json`（25：models 9 + plugins 6 + scm 3 + plugincatalog 2 + pluginupdate 1 + updatecheck 1 + files 3）。

## 3. 剩余工作（按顺序做）

### 3.1 vars 补全（代码改动）

跑 `node tests/scratch/vars-ast.cjs`，对每个输出的 key，在其 pick 后追加第 5 参数：

```ts
// 改前
pick(lang, `剩${n}个`, `${n} left`, "k.items.left")
// 改后（占位名 = 英文原文 ${} 内原样文本，空白归一为空格）
pick(lang, `剩${n}个`, `${n} left`, "k.items.left", { n })
```

- 只取**英文（第 3）参数**里的顶层 `${}`（zh 参数的不管，zh 走内联不用表）。
- 占位表达式含换行时压成单空格；多占位全列；重复占位去重。
- 嵌套反引号/三元（如 `goal.wizard.question.card`）**不 hoist**，外层整个表达式原样做 key
 （内层 `${}` 随外层求值一起生效，表值里只出现外层 `{...}`）。
- Tab 缩进；每改完一个文件跑 `npx tsc --noEmit -p tsconfig.server.json`；
  全部改完跑 `npx prettier --write` 仅改动的文件（**别碰 locales/**）。

### 3.2 块转换（5 处代码改动，需读对应函数现状再下手）

| # | 位置 | 做法 |
|---|------|------|
| 1 | `server/markers/builtins/todo.ts` 的 `getTodoGuidance(lang)` | 改查表：`getServerBlock(lang, "markers.todo.guidance", TODO_GUIDANCE_ZH, TODO_GUIDANCE_EN)`，无表回退现有中英分支 |
| 2 | `rename.ts` 的 `getRenameGuidance(lang)` | 同上，key `markers.rename.guidance` |
| 3 | `notify.ts` 的 `getNotifyGuidance(lang)` | 同上，key `markers.notify.guidance` |
| 4 | `server/vision-bridge.ts` 的 `getVisionSystemPrompt(lang)` | 同上，key `vision.system`（中英常量保留做回退） |
| 5 | `server/prompt-composer.ts` 的 soul 选择（`resolveSectionTexts` 里 `lang==="zh"` 用中文分支处） | 加：非 zh 且表有 `prompt.soul` 则用表值；否则走现有中英逻辑 |

### 3.3 日语翻译缺口（共约 109 条，见 §4 翻译规范）

| 组 | key 数量 | key 前缀/清单 |
|---|----------|---------------|
| T1-subagents | 18 | `subagents.`：spawn.template.unavailable、spawn.started、get.not.found、get.running、get.done、steer.injected、list.empty、stop.requested、wait.collected、wait.aborted、wait.timeout、templates.empty、templates.list、verdict.error、verdict.canceled、verdict.error.detail、verdict.aborted、wait.pending |
| T1-dsh | 25 | `dsh.`：tool.missing.name、tool.unknown.plugin、conv.default.title、round.ended.abnormally、prompt.context.full、prompt.context.short、prompt.continue、attach.image.save.failed、attach.upload.saved、attach.upload.save.failed、attach.image.ref、attach.file.large、attach.file.ref.fallback、attach.file.ref、attach.generic、goal.blocked、survey.cancelled、survey.timeout、engine.no.cli、provider.deepseek.official、provider.probing.unsupported、provider.custom.unsupported、provider.clone.unsupported、prompt.context.edit.reask；`dsh.sessions.`：sessions.untitled |
| T2-terminals | 15 | `terminals.`：not.found.exited、bash.open.failed、bash.limiter.note、bash.aborted、bash.timeout、bash.background.running、create.failed、create.done、close.not.found、close.done、input.sent、key.sent、read.not.found、wait.not.found、wait.no.pending |
| T2-vision | 7 | `vision.`：system.prompt、transcribe.single、transcribe.batch、model.not.found、model.unavailable、model.terminated、transcript.empty |
| C-markers | 25 | `markers.todo.` 17 个（list.empty、new.requires.subject、new.created、set.invalid.id、set.invalid.status、set.task.missing、set.completed.no.pending、set.completed.no.inprogress、set.updated、remove.invalid.id、remove.task.missing、remove.deleted、dep.invalid.id、dep.task.missing、dep.invalid.dependencies、dep.blocks.updated、unknown.operation）；`markers.rename.` 6 个（unknown.operation、requires.title、title.too.long、not.supported、renamed.to、rename.failed）；`markers.notify.` 2 个（requires.message、notified） |
| C-其他 | 14 | `markers.service.` 3 个（guidance.frame、execution.failed、describe.empty）；`prompt.` 9 个（guidelines.bash.powershell、guidelines.bash.basic、guidelines.be.concise、guidelines.show.paths、guidelines.title、skills.intro.specialized、skills.intro.use.read、skills.intro.resolve.path、context.title）；`agent.` 2 个（subagent.template.unavailable、subagent.stop.user） |
| 块表 | 5 | `markers.todo.guidance`、`markers.rename.guidance`、`markers.notify.guidance`、`vision.system`、`prompt.soul`（值是 `\n` 拼接的整块；guidance 数组原文在各 `get*Guidance` 的 `_EN` 常量里，vision 在 `SYSTEM_PROMPT`，soul 在 `BUILTIN_SOUL`） |

英文源从代码里各 key 所在 pick 的第 3 参数读（行号用 `tests/scratch/vars-ast.cjs` 或 grep 查）。
译完存 `tests/scratch/ja-batch-<组名>.json`（格式同已入库的两份）。

### 3.4 合并进包 + 验证

1. 用 `tests/scratch/merge-server-strings.mjs` 合并（它校验 key 必须在 `server/` 存在、值非空；
   合并前先给它加上 `${X}`→`{X}` 机械转换 + 空白归一，转换规则见 §4.3）。
2. `node -e "JSON.parse(...)"` 校验包可解析；`npx vitest run tests/unit/locales.test.ts`
   （key 对齐只管 `strings`，`serverStrings` 不影响，但要确认没碰坏 `strings`）。
3. 全量：`npx tsc --noEmit -p tsconfig.server.json`、`npx tsc --noEmit -p web/tsconfig.json`、
   `npx vitest run`、`npm run test:smoke`、`npm run format:check`、`npm run lint`。
4. e2e：起服务，浏览器切日语（或 WS 发 `set_locale: ja`），确认以前中文/英文的 tool 返回变成日语；
   删一个 key 后确认回落英文。
5. 文档：本文件任务完成项打勾；`AGENTS.md` 的 v2 约定段已写（§5），若有出入同步改。

## 4. 翻译规范（给翻译者，含 AI）

1. **以英文原文为源**（pick 第 3 参数），不要看中文。
2. 语气：技术、中性 plain 体（说明句用说明体，指令用命令形，跟随原文）。
3. `${X}` 一字不动地改写成 `{X}`（X 含复杂表达式、`as`、三元、嵌套反引号也原样保留；
   嵌套 case 外层整个照抄，内层不动）。`\n` 保留（JSON 转义）。工具名/模型名/路径/命令名不动。
4. 空白归一：占位符内的换行/多空格压成单个空格（与 §3.1 代码侧一致）。
5. key 原样照抄；术语统一：template→テンプレート、subagent→サブエージェント、
   running list→実行中リスト、polling→ポーリング、steer→方向転換、workspace→ワークスペース、
   whitelist→ホワイトリスト、terminal→ターミナル、transcribe→書き起こし、
   vision bridge→ビジョンブリッジ、provider→プロバイダー、model→モデル、plugin→プラグイン、
   task→タスク、prompt→プロンプト、goal（目标）→目標。
6. 输出 JSON `{key: 译文}`（key 排序），存 `tests/scratch/ja-batch-<组>.json`。

## 5. 脚本与文件索引

- `tests/scratch/vars-ast.cjs`：AST 精确定位缺 vars 的 key（行号+占位表达式）。注意它把注释里的
  示例也算上（`server/i18n.ts` 的 `k.items.left` 是文档示例，不用改）。
- `tests/scratch/check-vars.cjs`、`count-interp.cjs`：早期正则版，已被 AST 版取代，仅备查。
- `tests/scratch/merge-server-strings.mjs`：合并脚本（用前先补 §3.4-1 的 `${}`→`{}` 转换+归一）。
- `tests/scratch/ja-batch-editsoft-goal.json`（29）、`ja-batch-misc.json`（25）：已入库译文。
- `server/i18n.ts` 头注释：机制契约（改机制先改注释）。

## 6. 已知坑（别再踩）

- 子代理（subagent_*）可能在长时间运行后被清理且报告丢失：**派翻译/迁移类任务后要轮询收报告，
  拿到 JSON 先落盘**（本次 T1/C 两组翻译就是这么丢的）。优先自己动手做关键路径。
- `locales/*.json` 不在 format 路径内：保持 2 空格，**禁用 prettier --write**。
- Git Bash 里 perl 单引号插值 + `s///` replacement 的 `.` 是字面量（不是拼接），JSON 操作一律用 node。
- 工作树里有他人在途改动（compaction 条幅、run-trace、serialize 1 行等），`git status` 先看，
  只动自己名下文件；改前对相关文件跑 `npx tsc` 留基线。
- `protocol.ts` 保持纯类型（`check-protocol-sync.mjs` 守护）；改协议要双端 bump `PROTOCOL_VERSION`。
- Don’t break v1：zh/en 内联是回退底线，任何重构先跑全量单测（`npx vitest run`，目前 459+13 项全绿基线）。
