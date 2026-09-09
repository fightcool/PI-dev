# 系统提示词组成与组合模板（compose）

> 本文档说明 SDK（`@earendil-works/pi-coding-agent`）如何组装最终发给模型的系统提示词，
> 以及 pi-web-ui 的「组合模板」如何让你**自由组合**这些来源、**单独覆盖**其中任意一层。
> 事实源：SDK `dist/core/system-prompt.js`（`buildSystemPrompt`）、`dist/core/resource-loader.js`
> （`discoverSystemPromptFile` / `loadProjectContextFiles` / override 重放）、
> `dist/core/agent-session.js`（`_rebuildSystemPrompt`）、`dist/core/extensions/runner.js`
> （`before_agent_start` 链式替换）；pi-web-ui 侧在 `server/prompt-composer.ts`（纯函数引擎）、
> `server/agent-service.ts`（集成）、`web/src/components/SettingsModal.tsx`（设置 UI）。

## 一、总览：最终提示词的组装顺序

    最终提示词 = 基础提示词(soul) + 工具列表(tools) + 行为准则(guidelines)
              + Pi 文档指引(pi_docs) + 追加段(append) + pi-web-ui 引导
              (persona/terminal/markers) + 项目上下文(context) + 技能段(skills)
              + 工作目录行(cwd)
    主会话启用「组合模板」后，以上每一层都是一个 {{token}}：模板里写哪些 token、
    按什么顺序、穿插什么自己的话，决定最终提示词；每层未覆盖时用**自动内容**
    （工具/上下文/技能等永远由 SDK 用最新数据重新生成）。

## 二、组合模板与来源 token

    token 列表（server/prompt-composer.ts 的 PROMPT_TOKENS，默认顺序即自然拼装顺序）：
        {{soul}}        agent 人物设定（有 SYSTEM.md 时其内容，否则内置默认）
        {{tools}}       Available tools 列表 + “In addition…” 句
        {{guidelines}}  Guidelines：文件探索引导 + 各工具 promptGuidelines + 固定两行
        {{pi_docs}}     Pi documentation 指引（指向已安装 pi 包路径）
        {{append}}      追加段 = APPEND_SYSTEM.md 内容；覆盖 = 自定义追加文字
        {{persona}}     Windows persona（仅 win32）
        {{terminal}}    终端工具使用引导（「终端工具」开关开时）
        {{markers}}     内置标记工具引导（markers 开启时）
        {{context}}     <project_context>（AGENTS.md / CLAUDE.md 收集结果）
        {{skills}}      <available_skills> 技能清单
        {{cwd}}         Current working directory 行
    每层可「单独覆盖」：overrides[token] 有内容时用你的文本替换自动内容；
    留空 = 用自动内容。模板为空 = 默认模板（全部 token 自然顺序），不配置任何
    模板/覆盖时运行完全等同 SDK 默认拼装（零开销，before_agent_start 返回空）。

## 三、各来源自动内容从哪来（buildSystemPrompt 视角）

    基础提示词 base（resource-loader.discoverSystemPromptFile，按优先级）：
        1. 项目级：<cwd>/.pi/SYSTEM.md（受信任时）
        2. 全局级：<agentDir>/SYSTEM.md
        3. 都没有 → undefined → SDK 默认分支拼出内置模板（persona + tools +
           guidelines + pi_docs）
    组合模式下 systemPromptOverride 恒返回 undefined → 强制默认分支（自动段齐全）；
    SYSTEM.md 内容仅在 override 回调里捕获（lastBaseSystemPrompt）作为 {{soul}}
    自动内容，不整体顶替模板。
    项目上下文（loadProjectContextFiles）：候选 AGENTS.override.md > AGENTS.md >
        AGENTS.MD > CLAUDE.md > CLAUDE.MD；全局 agentDir 一份 + cwd 逐级向上，
        包装成 <project_context><project_instructions path="…">…</project_instructions></project_context>。
    技能段：可见技能（disableModelInvocation=false）formatSkillsForPrompt 输出；
        read 工具不可用时省略。pi-web-ui skillsOverride 按禁用集过滤。
    工作目录行：`Current working directory: <正斜杠 cwd>`。
    Pi 包路径（README.md / docs / examples）：随安装位置解析一次
        （require.resolve("@earendil-works/pi-coding-agent/package.json")）。

## 四、引擎（server/prompt-composer.ts，纯函数、浏览器可复用）

    resolveSectionTexts(inputs) → 每 token 的自动内容
    renderPromptTemplate(template, texts, overrides) → {{token}} 替换
        - 覆盖优先：overrides[token] 非空白 → 用之；否则 texts[token]
        - 未知 token 保留原文（UI 可提示 typo）
        - 自动内容为空的 token（如非 win32 的 {{persona}}）展开为空串
    DEFAULT_PROMPT_TEMPLATE / PROMPT_TOKENS 供设置 UI（token 插入、恢复默认）。
    单测：tests/unit/prompt-composer.test.ts。

## 五、运行时集成（server/agent-service.ts）

    每个会话 runtime 注册隐藏内联扩展 <inline:pi-webui-persona>：
        before_agent_start（每个 agent run 前）—
            - 主会话：若配置了模板或任一覆盖，用本次 run 的 systemPromptOptions
              （selectedTools / toolSnippets / promptGuidelines / contextFiles /
              skills 全是当时最新）渲染组合模板，整体替换该 run 的 systemPrompt；
            - 子代理模板 replace：默认分支下把灵魂段换成模板提示词（自动段保留）；
              模板 append 仍走 loader 追加段。
    设置改动无需 reload 即可在下一个 run 生效（逐 run 读取 settingsSvc）；
    session.reload() 仅用于让 loader 侧（默认分支/技能过滤等）同步。
    设置面板预览（settings_state.effectiveSystemPrompt）：用当前会话资源
        走同一渲染函数 —— 与真实 run 一致（只读查看）。

## 六、设置与迁移

    字段（client-state.json / 协议 UiSettingsState）：
        promptTemplate: string           组合模板文本（空 = 默认模板）
        promptOverrides: Record<string,string>   每来源覆盖
    旧存档迁移（getSettings）：customSystemPrompt 非空时 —
        append → 文字成为 {{append}} 覆盖（独立追加块）
        replace → 文字成为 {{soul}} 覆盖
    遗留字段 promptMode/customSystemPrompt 保留在数据结构里（DSH 子系统与旧预设
    共用同一份 client-state 存储，见 dsh-agent-service.ts），主会话 UI 不再使用。
    预设（SettingsPreset）新增捕获 promptTemplate/promptOverrides，应用时旧预设
    缺字段保留当前值。

## 七、设置 UI（SettingsModal → 「系统提示词」页）

    组合模板编辑框（{{token}} 可任意排序/穿插文字；placeholder = 默认模板）
    一键插入 token 的 chips
    每来源覆盖行：token + 说明 + 覆盖输入框（留空 = 自动）
        单来源「恢复默认」按钮（清空该覆盖）
    整体「恢复默认模板并清空所有覆盖」按钮
    「查看当前完整提示词」只读预览 = 组合渲染结果
    文案键：promptTok_<token> / promptTok_<token>_desc（zh/en 同步）

## 八、与子代理模板的关系

    子代理模板保留自身 append/replace 语义（角色化预设）：白名单过滤技能/扩展；
    replace 在无 SYSTEM.md 时把子代理默认分支的灵魂段换成模板提示词；append 追加
    到该子代理的追加段。模板会话不套主会话组合模板（角色由模板定义）。主会话
    组合模板不影响模板派生的子代理。

## 相关源码定位

    - pi-web-ui：server/prompt-composer.ts（token/引擎/默认模板）、
      server/agent-service.ts（override + 内联扩展 + 渲染预览）、
      server/settings-service.ts / client-state.ts（设置持久化与迁移）、
      server/protocol.ts（UiSettingsState 字段）、web/src/components/SettingsModal.tsx
    - SDK：dist/core/system-prompt.js（buildSystemPrompt 默认拼装）、
      dist/core/resource-loader.js（SYSTEM.md / 上下文收集 / override 重放）、
      dist/core/extensions/runner.js（before_agent_start 链式替换）
