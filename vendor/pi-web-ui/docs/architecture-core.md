# 核心架构

> 改代码前必读。本文档覆盖快照驱动、协议单源、安全边界、主题切换、多对话并发等全局架构决策。

## 快照驱动

- **服务端是唯一事实源**：每次 SDK 事件后节流 60ms 推快照（`UiState`），浏览器只按快照渲染。重连只需重发 `get_state`。
- **增量快照（协议 v2）**：持久化消息内容不可变 + 对象引用稳定，`emitSnapshotNow` 用 O(n) 指针等同性遍历检测追加式增长——能追加则发 `snapshot_delta`（轻字段 + `appended` 尾部，baseRev 链），中途变更/截断/切会话/强制 resync 回落全量 `snapshot`。前端 reducer 按 rev 链合并，缺口触发防抖 `get_state`；背压下 delta 与 snapshot 同样可丢弃，丢包靠 rev 链断裂自愈。`get_state` 恒返全量。回归：`snapshot-delta-test`。**测试适配**：等「动作后快照」的测试必须同时接受 snapshot_delta（参照 conv-cwd/vision-bridge 的 rev 链合并写法）；连接后的首个快照恒为全量。
- **WS permessage-deflate**：WebSocketServer 开启压缩（threshold 16KB），大会话多 MB snapshot 线上传输降数倍；小消息（notice/心跳）不压省 CPU。
- **多标签页序列化共享**：emit 把同一消息对象发给客户端的所有 socket，index.ts 用 WeakMap 按对象身份缓存 stringify 结果——N 个标签页共享一次序列化，新 snapshot 即新对象自动失效。
- 序列化时**对象引用稳定**：`uiMessageCache` + 消息数组签名比对，消息没变就不重建数组，前端 `React.memo` 因此能跳过整条消息——**不要**破坏这个缓存（stable id、引用复用）。
- `UiState` 携带 `thinkingLevel`（当前生效）和 `availableThinkingLevels`（当前模型实际支持的级别，SDK 会把集合外的请求静默就近钳制——UI 只能启用这些，否则用户点"低/中"看起来"改不了"）。

### `message_delta` 实时增量通道

`message_update` 事件 → 只对**活动对话**推 `message_delta`（`conversationId` + 每对话单调 `seq` + `messageId = stream-<ts>`（与 `serializeStreamingMessage` 的稳定 id 一致）+ 实时 usage + 剥离 `partial` 后的 thinking/text delta）。它**不经 snapshot 通道**——`send()` 背压只丢 snapshot，增量永远可达，大会话不再因背压停更。前端 `applyMessageDelta`（`web/src/message-delta.ts` 纯函数、不可变——StrictMode 双调 reducer 会把原地 mutation 加倍）patch `streamingMessage` + `stats.tokens`；seq 缺口触发防抖 `get_state` 重同步；snapshot 权威收敛。

同时：delta 活跃期（1.5s 内有增量）snapshot 降为**事件驱动检查点**——agent_end / tool_execution_end 立即 flush，其余事件走 2s 兜底定时器（增量负责流畅度、快照只做边界校准）。单测：`tests/unit/message-delta.test.ts`。

### `tool_delta` 同协议

也带 `conversationId` + `seq`，与 message_delta 共享同一每对话单调序列（`conv.deltaSeq`）；前端按对话 Map 追踪 seq，仅活动对话缺口触发重同步（后台对话切回时 snapshot 收敛）。

### 协议版本协商

`hello` 可带 `protocolVersion`，`ready` 回带服务端版本；前端比对不一致时显示持久刷新横幅（应用原地更新后「界面新的/WS 旧的」混跑防护）。常量在 server/ 与 web/ 各一份 protocol-version.ts，`check:protocol` 校验两份一致——改协议时必须同步 bump。

## 协议单源（types.ts 是 re-export shim，不再手工同步）

`server/protocol.ts` 是唯一事实源；`web/src/types.ts` 用 `export type * from "../../server/protocol"` 全量再导出（纯类型，构建时擦除），前端本地类型（FileContent/FileListing/ToolStatus）附在 shim 下方。

新增/修改任何消息：只改 `protocol.ts`，然后在 `server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch 各加一个分支。注意 protocol.ts 必须保持**纯类型导出**（不能加 const/function 等运行时代码，否则破坏 type-only 前提）；`npm run check:protocol` 守护这两个不变量。

## 安全边界

- **默认只绑 loopback**（`PI_WEB_HOST`，默认 `127.0.0.1`）：本地个人工具不暴露到网络；局域网/容器需显式 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置，Docker 端口映射才能工作）。
- **WS 升级做 Origin/Host 同权威校验**（`server/index.ts` 的 `originAllowed`，`WebSocketServer({ noServer: true })` + 手动 `handleUpgrade`）：Origin 存在时其 hostname+**有效端口**必须与请求 Host 一致（浏览器里 `example-host:8445` 与 `example-host:9443` 是不同源）；非浏览器客户端（无 Origin）放行；`PI_WEB_ALLOW_ORIGINS` 白名单绕过（dev:server 已内置 `http://localhost:5173,http://127.0.0.1:5173`，反代场景自配）；`PI_WEB_ALLOW_HOSTS` 可选严格 hostname 白名单。**不要**加回「本地任意端口放行」——那正是提案要修的洞。
- **quiesce 准入控制**（`AgentService.quiesce/unquiesce`）：进入排空后**拒绝一切新工作**——新 prompt（native slash 命令例外，纯配置无 token）、new_chat、edit_message fork、switch_session、goal wizard；存量运行继续跑完。已知 clientId 仍可 attach 看存量（发 notice 提示），**全新客户端 attach 抛 `QuiesceRejectedError` → index.ts 以 4403 关 WS**，浏览器重连循环在 unquiesce 后自动恢复。
- **控制 socket**（`server/control-socket.ts`）：CLI 的 `server status|quiesce|unquiesce` 经本地 mode-0600 unix socket / Windows 命名管道（`\\.\pipe\pi-web-ui-<port>`）与运行中进程通信，`status` 报告真实 socket 数（`noteSocketOpen/Close`，index.ts 维护）、active/pending 计数、quiesce 状态；无鉴权 HTTP 端点。
- **provider headers 不下发浏览器**（`models_config` 不再携带 `headers` 字段，可能含 Authorization/API key）：`saveModelConfig` 保存时若 config 无 headers 则保留旧值（`prevHeaders`）。`UiProviderConfig.headers` 已从 protocol.ts / types.ts 删除，前端没有任何地方编辑 headers（仅 apiKey 经独立消息 `set_provider_api_key` 走浏览器）。
- **内置服务商多密钥（不复制模型列表 + 纯名字通信）**：一个内置服务商（如 opencode/openai）可同时持有**多把 API key**，存于 `<agentDir>/provider-keys.json`（`{ <providerId>: { activeKeyName, keys:[{name,apiKey}] } }`），**模型目录始终复用该服务商的默认系统目录**，绝不复制进 models.json（`clone_provider` 只保留给程序化/测试路径，UI 已改为多密钥管理）。**安全**：前端**永远只拿到钥匙的**名字**（`ProviderKeyInfo={name,active}`），**原始 key 值 / 掩码片段（masked）一律不出服务端**——key 值只在添加时经 WS 上传一次落盘（同 auth.json）；`activate_provider_key`/`remove_provider_key` 都**按名字**寻址，服务端解析存储值。协议：`list_provider_keys` / `add_provider_key`（`{provider, apiKey, name?}`，名字自动去重）/ `activate_provider_key` / `remove_provider_key`，服务端回 `provider_keys`。**activeKey 与 auth.json + 运行时 override 同步**（`applyActiveKey`），切 key 后 `pushModels` 重推该服务商模型。前端模型下拉对多 key 服务商在左侧「供应商」栏**按 key 拆成多个条目**（供应商名在上、key 名在下，如 opencode 下 key1/key2 各一条，不拼接 `opencode-key2name`），**选中某 key 条目即只显示该服务商模型一次，点模型即切换激活 key** 再选模型——无需静态副本、始终最新；单 key 服务商仍显示普通单一条目。
- **token 反射防护**（issue #45）：`PI_WEB_TOKEN` 鉴权中间件里，`/api/health` 保持开放供探针，但 `Set-Cookie` 只在请求确实携带有效 token（`tokenOk(req)`）时才下发——匿名命中 `/api/health` 绝不反射真实 token cookie。回归：`tests/token-auth-test.mjs` 的「health does NOT leak pi_web_token」检查。
- **dev 兼容**：vite :5173 代理 /ws 到 :8788 时 Origin(:5173) ≠ Host(:8788)，靠 `PI_WEB_ALLOW_ORIGINS`（dev:server 内置）放行，勿删。

## 主题切换

- **机制**：`web/src/styles.css` 是**唯一布局文件**（含默认深色调色板的 `:root` CSS 变量，含 `--bg/--accent` 基础色与 `--tooltip-bg/--code-bg/--notice-*` 等派生色）；主题文件是**纯 `:root` 调色板覆盖**（只写变量值，0 行布局代码）。选主题时前端注入 `<link id="theme-stylesheet" href="/themes/<id>.css">`，因 link 追加在打包的 styles.css 之后，其 `:root` 变量在层叠中胜出（`web/src/theme.ts` 的 `applyTheme`，localStorage 键 `pi-web-ui:theme`，`main.tsx` 首帧前应用防闪烁）。**改布局只改 styles.css，永不碰主题文件**。
- **服务端**：`GET /api/themes` 列主题（`server/themes.ts` 的 `listThemes`），`GET /themes/:id.css` 发文件（`resolveThemeFile`，用户目录优先）。id 必须匹配 `ID_RE`（`^[A-Za-z0-9_-]+$`）防路径穿越。两个路由在 `server/index.ts` 注册于 SPA catch-all 之前（否则被吞返回 index.html）。dev 模式 Vite 需在 `web/vite.config.ts` 代理 `/themes`（已加）。
- **主题来源**：内置 `<pkgRoot>/themes/*.css`（随 npm 包分发，`package.json` files 白名单含 `themes/`）；用户自定义直接往 `<dataDir>/themes/` 丢 CSS 文件即可（id 冲突时用户覆盖内置）。`pkgRoot` 经 `resolvePkgRoot()` 向上找含 package.json 的祖先解析，dev(server/) 与 prod(dist/server/) 均正确。
- **浅色主题**：`themes/white.css`（显示名「白色」：纯白底 + GitHub 蓝强调）与 `themes/md-preview.css`（显示名「紫晕」）+ `themes/cyberpunk.css`（赛博朋克）+ `themes/dazzle.css`（炫彩）均由根目录脚本 `make-light-theme.mjs` 从 `styles.css` 的 `:root` 变量清单生成**纯调色板文件**（生成器读 styles.css 解析全部变量名，主题只覆盖差异值，输出完整 `:root` + 可选非布局 tail：white 带 `.hljs` 浅色高亮覆盖、md-preview 带 body 渐变 + chrome 透明）。styles.css 新增变量后重跑 `node make-light-theme.mjs` 即自动同步进所有内置主题（新变量默认用深色值）。
- **主题显示名**：css 首行 `/* theme-name: 中文名 */` 即为下拉里的显示名（`listThemes` 读文件头 300 字节解析），缺省回退文件 id——文件名必须是 ASCII（id 校验 `ID_RE`），中文靠这个标记。第二行可选 `/* theme-name-en: English Name */`（英文 UI 用，无则回退中文名）；两行都由 `make-light-theme.mjs` 生成，手改主题文件头会被下次重跑覆盖——改英文名要改生成器。
- **面板收起/展开按钮对照色（issue #100）**：`.panel-collapse-btn` resting 态即带底色 + 边框（与窄屏顶栏 `.panel-toggle` 同级），前景/底/边框走专用 `--control-fg/--control-bg/--control-border`（默认取正文次级色而非 `--text-faint`），展开条 `.panel-rail` 加宽到 26px、图标套「药丸」底——在浅色/自定义主题下也不再隐形。主题可独立覆盖这三个变量；浅色默认值在生成器的 `LIGHT_DERIVED` 里。
- **聊天背景图/壁纸（issue #100）**：`--bg-image: none`（主题可写成 `url(...)` 自带一张）+ `--bg-image-dim`（`--bg` 压暗不透明度，默认 0.78）+ `--bg-image-blur`。`body.has-wallpaper` 时 `.messages-wrap::before` 放图（cover 居中 + 模糊）/`::after` 压暗，`.messages` 提 z-index 1 从卡片间隙透出；无壁纸时两层 `display:none`。用户自定义地址存浏览器 localStorage（`pi-web-ui:wallpaper`，`web/src/wallpaper.ts`：URL 白名单 http(s)/blob/data:image/站内相对路径，内联变量覆盖主题，`useWallpaperEffect` 在 App 顶层应用并监听主题切换重算）， UI 在设置 → 消息显示（地址框失焦/回车提交，压暗/模糊滑杆即时预览；也可点「上传图片」选本地文件——复用粘贴图片管线等比缩 ≤1568px + 重编码为 data: URL 存 localStorage，上传失败/过大时行内提示；data: 图不回填输入框，下方缩略图即表示生效中，清除按钮同时清掉地址与预览）。
- **终端跟随主题**：xterm 画布经 `web/src/theme.ts` 的 `buildTermTheme()` 读 `--term-*` 变量，主题切换时 `TermXterm.tsx` 监听 `pi-web-ui:theme-change` 事件用 `term.options.theme` 热更新画布；CSS 容器 `.term-main` / `.term-xterm .xterm-viewport` 用 `var(--term-bg)`，与画布自动融合。styles.css 改动后重跑 `node make-light-theme.mjs` 重新生成。
- **回归**：`theme-test.mjs`（端口 8937，隔离 data-dir）：列表/内置/用户主题、注入 link、浅色生效、刷新持久、用户主题可应用、回默认移除 link。

## 多对话并发

- 每客户端 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**：`new_chat` 新建 runtime + 新 session 文件（旧对话继续在后台跑，不中断）；`switch_conversation` 只换 `activeId`（不碰其他 runtime）；`runtime`/`session` 访问器指向当前活动对话。**对话按项目归属**：`conv.cwd` 即所属项目，每个项目各自的活动对话互不干扰。
- **`set_cwd` 不再重建当前对话**——改为切到目标项目自己的对话（该项目最近活动的那个；没有则新建一个并恢复该项目最近的持久会话）。
- **「运行的对话」列表生命周期**（每个对话 `listed` / `promptedSinceActive` / `lastActiveAt` 三字段）：
  - 入列：活动对话**正在流式输出时**被挤到后台（new_chat / switch_conversation / set_cwd，**跨项目切换同样入列**）→ `listed=true`；
  - 留在列表：后台跑完不移出（用户可能还没看结果）；**还有存活 PTY 的对话也留在列表**（终端里可能有仍在跑的任务），但**已退出、仅保留输出的终端不阻止移出**——AI 结束且终端全部跑完后切走，`removeConversation` 顺带 `killAll()` 关闭残留终端并从列表消失（`openTerminals` 传 `terminals.countLive()`，只统计存活 PTY）；
  - 移出：打开它（切为活动）→ 没有继续对话（期间没发过 prompt）→ 切走时 `displaceActive()` 返回它，`removeConversation` 释放 runtime（会话已持久化，历史列表仍可恢复）。
- 上限 `MAX_OPEN_CONVERSATIONS = 8` **按项目计**，超出时 new_chat 发 warning notice。
- 所有对话共享**一个 ModelRuntime**（首个对话创建时播种，`makeRuntimeFactory` 传入复用）——顶栏换模型对全部对话生效。**消息序列化缓存（msgIds/uiMessageCache/签名）按对话隔离**：两个对话可能产生相同的 (role, timestamp) 键，共享会串号。
- **项目切换记住 {模型, key}**：`client-state` 持久化 `projectModels`（cwd→"provider/id"）与 `projectProviderKeys`（cwd→provider→keyName）。**选模型即刻保存**（`setModel` → `rememberProjectModel`，不等一次问答——SDK 只有存在 assistant 消息后才把 `model_change` 落盘，否则新对话选完模型就切走会丢）；**切换项目/会话时恢复**（`restoreProjectModelForCwd` + `restoreProjectProviderKeysForCwd` 于 set_cwd / switch_conversation / switch_session / ClientSession.create），新对话也会套上该项目上次的 {模型, key}。模型/密钥被删时恢复静默跳过。
- `snapshot` 带 `conversationId`；`conversations`（ServerMessage）推**全部项目已入列的对话**（前端按 `cwd` 分组显示，当前项目不显示组标题）+ `activeId`（activeId 可能未入列，如刚 new_chat 还没跑过）；`switch_conversation`（ClientMessage）**可跨项目切换**——切到其他项目的对话时同步切换工作区，补齐 `set_cwd` 的副作用（文件树/会话历史/项目顺序/命令目录/onCwdChanged 钩子）。
- `switch_session`（恢复持久会话）会为目标会话创建独立 runtime，再按上述生命周期把当前对话移到后台；若目标会话已在运行列表中则直接复用其 conversation，绝不因打开历史记录中断当前生成。回归测试：`tests/switch-session-background-test.mjs`。`edit_message` 在**当前**对话内 fork；`dispose` 遍历销毁全部对话；attachSink 重连时补推 conversations。
- 前端：左栏「运行的对话」区（≥1 个时显示，活跃高亮、流式绿点），MessageList 以 conversationId 为 key 强制切换重挂载。

## 其他桥接

### 工具结束实时状态（`tool_status`）

服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。bash 工具的 details 不带 exitCode（成功时返回 truncation 信息，失败时错误文本含 `Command exited with code N`），服务端从错误文本正则提取；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。前端 `toolStatuses` Map 在 toolResult 落盘（snapshot prune）后清除，回落到权威的 toolResult 状态。

### 工具挂死看门狗

每个 `tool_execution_start` 都会为 toolCallId arm 一个 `TOOL_WATCHDOG_TIMEOUT_MS`（默认 20 分钟，环境变量 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒）覆盖）的 timer——超时仍在跑就 `session.abort()`（杀进程树）+ warning notice，`tool_execution_end` / `removeConversation` / `dispose` 都会清掉对应 timer。恢复重建 + 重绑会话（同一 conv 记录，UI 不掉线）；看门狗超时也走同一 `interruptRun`。**只停止运行，不碰后台服务**——那些由「后台任务」面板单独管理。

### 后台任务列表

bash 工具执行前后各拍一次监听快照（`snapshotListeningPorts`，Windows netstat / POSIX lsof），diff 出的新增 LISTENING 进程记入 `bgServers`（端口→pid→since→name，name 经 `lookupProcessName` tasklist/ps 尽力获取），启动后 notice 提示「可在顶栏「后台任务」里单独停止或全部关闭」；**列表按客户端持久**（ClientSession 字段，非对话级）——对话结束/切换/断线重连都不消失（attachSink 重推 `bg_servers`），只有任务被停或进程自行退出才移除（30s 定时器 `refreshBgServers` 重新对端口快照，port+pid 都匹配才算还活着，静默剔除死项）。

**误报过滤**（`BgServerTracker.filterAgentSpawned`）：端口 diff 只是候选，还需通过 `shouldTrackBackgroundServer` 判定才记入——① 进程名命中黑名单 `NON_AGENT_PROCESS_NAMES`（WeChat/QQ/Telegram 等桌面软件）直接跳过；② 一次 PowerShell CIM / `ps -Ao pid=,ppid=` 批量拉全量父子映射，沿父链回溯：撞上服务器进程（`process.pid`）或本次 diff 出的其他新 pid（bash 留下的中间层）→ 记录；完整回溯到系统根（pid 0/1）未命中 → 桌面软件自启（如自己开的 Chrome，父链是 explorer），跳过；断链（父已退出/reparent）→ 保守记录。**Chrome 不进黑名单**：Playwright 等由 AI 拉起的浏览器父链能回溯到服务器进程，与用户自开的 Chrome（父链 explorer）区分开。

协议：`bg_servers`（ServerMessage，推送全量列表）/ `kill_background_server`（按端口停单个）/ `kill_background_servers`（全部关闭，`killAllBackgroundServers` 对每个 pid `killPidTree`，Windows `taskkill /F /T`）/ `list_bg_servers`（面板打开时请求刷新）；前端 `BgTasksModal`（每个任务行「停止」+ 底部「全部关闭」「刷新」，空列表有占位文案）。

### 只停止 bash 命令（对话继续）

bash 工具卡片运行中显示「停止」→ 发 `{ type: "abort_bash" }` → `ClientSession.abortBash()`。服务端用 **killable bash 工具**（`makeKillableBashTool`，经 `customTools` 按 name 覆盖 SDK 内置 bash）：执行时把自己的 AbortController 注册进客户端级 `bashKills` 集合，abort 只杀这些 controller → bash 子进程进程树被杀（工具抛 "Command aborted"，被 agent-loop 捕获成工具错误结果）→ **agent run 与对话继续**；与 SDK `session.abortBash()`（只对扩展 `executeBash` 路径有效，agent 工具路径无效）不同，这里对对话中的 bash 工具调用真实生效。

命令被中止时 SDK 会把**终止前已输出的内容拼接进工具错误结果**（AI 能看到输出 + "Command aborted"）；随后 `abortBash()` 再 `sendUserMessage` 注入「用户手动停止」提示，让 AI 明确知道是用户手动而非失败。

### 独立宽松编辑工具 edit_soft（不覆盖内置 edit）

内置 `edit` 要求 oldText 与文件恰好匹配（含缩进/空白）。对缩进非语法意义的语言（如 JS/JSON），模型给出的 oldText 常与文件差几个空格/制表符而导致编辑失败。pi-web-ui 经 `customTools` 注入一个**不覆盖**内置 `edit` 的独立工具 `edit_soft`（`server/edit-soft-tool.ts`）：先用精确子串匹配，失败后按「逐行核心（trim）序列一致」做宽松匹配（忽略行首/行尾空白差异），命中后**整行原样写入 newText**（缩进即最终缩进）。仅唯一匹配才写，重叠 edit 报错，并参与同一个 per-file 变异队列（`withFileMutationQueue`）。

开关设置 `editSoftEnabled`（默认关）：关闭时该工具从活跃集移除（`applyToolGating` 经 `setActiveToolsByName`，与终端工具同一机制），不会出现在 Available tools 段。DSH 引擎无该工具，设置面板隐藏「编辑工具」分区。

### 扩展 UI 桥

扩展的 `setWidget/setStatus/notify/select/confirm/input` → `widgets/statuses/notice/dialog` 消息；对话框经 `dialog_response` 回传，Esc 视为取消。`Dialog.tsx`（扩展对话框）与 `DshQuestionDialog.tsx`（DSH 模型提问桥）的正文/选项/详情/预览都走 `Markdown(rawHtml)` 富渲染（markdown + 原始 HTML 混排，模型自选、信任模型；默认 `rawHtml=false` 的聊天正文渲染不受影响），可选项 `preview` 展示「选项预览」框。

`snapshot` 里 `streamingMessage` 是进行中的消息（60ms 粒度流式），`messages` 是已落盘的。
