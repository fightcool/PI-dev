# 终端架构

> 覆盖 PTY 管理、按键编码、输出合并、SCM git 查询、活力检测、终端接管 bash 等。

## 终端管理

- 每个 `Conversation` 一个 `TerminalManager`；agent 可调用 `terminal_create`、`terminal_list`、`terminal_close`、`terminal_input`、`terminal_key`、`terminal_read`，支持命名多终端、增量 cursor、Enter/Tab/方向键及 Ctrl/Alt 组合。PTY 工作目录限制在该对话工作区，最多 16 个**用户**终端，输入/读取有大小与等待上限；终端接管 bash 的 `ai-bash` 终端不计入这 16 个名额（`ensureSpawnAllowed` 只统计 `agentBash=false` 的 live PTY），常驻也不挤占用户配额。
- **所有 spawn 路径统一准入**：`terminal_create`（浏览器/agent）与 `run_command`（命令列表）共用 `validateId`（字母/数字/.-_:/≤80 字符）+ `ensureSpawnAllowed`（新 live PTY 需低于 `MAX_TERMINALS`；已在运行的同名终端原地重启不占新名额；**history 里的已退出终端不保留名额**——满员时重跑已退出终端同样拒绝，堵住"唯一 ID 无限生成 PTY"的洞）；失败统一走 `fail()`（notice + 终端内红色报错 + terminal_exit）。

## terminal_key 按键编码

`encodeTerminalKey(key, modifiers)` 是纯函数（导出，字节级断言在 terminal-smoke-test.mjs）：命名键按名称路由，Ctrl/Alt 组合绝不回退成"Ctrl+首字母"——Ctrl+ArrowUp=`ESC[1;5A`（非 Ctrl+A）、Ctrl+Enter=`ESC[13;5u`（非 Ctrl+E）；方向键/F1–F4/Home/End 带修饰符时用 xterm 修饰序列 `ESC[1;<m>X`，其余命名键用 CSI-u `ESC[<code>;<m>u`，普通字符 Ctrl 映射 A–Z→0x01–0x1A、Shift 大写、Alt 前缀 ESC。

## 输出合并

输出经带 `conversationId` 的 `terminal_output` 推给浏览器；未挂载终端保留 200KB 输出窗口，切回对话时回放。socket 断开不杀 PTY；切换/重连保留状态，对话被释放或服务关闭时才杀掉全部 PTY。

**终端输出微批合并**（`terminals.ts` 的 `queueOut`/`flushPending`，窗口 `OUTPUT_FLUSH_MS=16ms`）：`pty.onData` 每 chunk 先入 `pendingOut` 缓冲再统一 flush 一条 `terminal_output`——构建等场景每秒数百上千个小 chunk 的 WS 帧风暴降 10~50 倍；exit/kill/原地重启先 flush 再发退出事件保证顺序。

## node-pty × Node `--watch` 兼容自愈

`server/patch-node-pty.ts`（必须排在 node-pty 之前 import）：dev 脚本用 `node --watch`，watch 模式会向 node-pty 的 ConPTY worker / console-list agent 的 IPC 通道推 `watch:require`/`watch:import` 消息——node-pty 1.1.0 不识别，导致①每条都 `console.warn('Unexpected ConoutWorkerMessage')` 刷屏；②kill 路径把 watch 消息当 agent 回复，`message.consoleProcessList` 为 undefined 直接 `.forEach` 崩溃。补丁模块在启动时幂等地改写安装副本（仿 spawn-helper chmod 先例）；`terminals.ts` 里另有一层 console.warn 过滤兜底。生产（无 `--watch`）不受影响。

## SCM 源代码管理

`SCMPanel`（视图 `git`）的只读 git 查询走服务端 `server/scm.ts`，用 `execFile("git", …)` 直跑（不经过 shell——无提示符/回显/ANSI/zsh 差异），解析成结构化 JSON。

### 协议

客户端发 `scm_status`（status+branches(含远程,for-each-ref)+numstat）/ `scm_history`（提交图，懒加载——切到「提交树」tab 才查）/ `scm_filediff`（单文件 staged+worktree diff）/ `scm_commit`（hash 白名单校验后 git show），服务端必回一条 `scm_data`（echo reqId + kind，ok/error/notRepo），前端按 reqId 匹配 pending 槽位——每个请求必有且仅有一个响应，UI 不可能卡 loading；sendScm 在 socket 断开时不占槽位不置 busy（防转圈卡死）。路径校验：filediff 的 path 必须 resolve 后仍在工作区内；非 git 仓库返回 ok:true + notRepo:true（面板显示提示而非报错）。15s 超时/maxBuffer 16MB。

### git 目录 watcher

首次 scm_status 时 `git rev-parse --absolute-git-dir` 定位 .git 并 fs.watch（非递归——HEAD/index/packed-refs 都在顶层，覆盖 commit/stage/checkout），事件去抖 600ms 推 `scm_changed` → 前端静默 refresh（外部 CLI/IDE 改仓库实时反映）；setCwd/dispose/notRepo 时 unwatch；watch 失败静默降级为 30s 可见轮询兜底。

### 自动刷新触发器

全部走 silent refresh 不闪 spinner：scm_changed / 终端 tab 里 SCM 生成的 git 写命令 running→exit（标题 `/^git /`）/ 视图激活 / cwd 切换 / 30s 轮询。

### 写操作

仍走可见终端 tab（TerminalPanel 同款 tab 复用逻辑）并切到终端视图：提交/推送/拉取/切换分支（远程分支 `origin/x` → `git checkout -b x origin/x || git checkout x`）/ 单文件暂存（`git add -- <path>`，行 hover 显示 + 按钮）/ 取消暂存（`git reset HEAD -- <path>`，− 按钮），路径经单引号转义。分支下拉本地/远程分组（optgroup，i18n scmRemoteBranches）。

### 历史教训（已废弃的旧实现）

曾用隐藏 PTY + shell 变量拼接 sentinel 切分文本，踩过 xterm writer 覆盖解析器、zsh 提示符无尾换行粘行吞掉 `## main` 状态头、全局队列被流式期间的慢查询阻塞等三个坑。

## 终端活力检测（liveness watchdog）

`terminals.ts` 的 `noteAgentActivity` / `armIdleWatch` + agent-service 的 `notifyTerminalIdle`：agent 工具路径的 terminal_create/input/key 会启动一个「静默纪元」——该终端连续 `PI_WEB_TERMINAL_IDLE_MS`（默认 15s）无输出且**该对话正在流式运行**时，经 onAgentIdle 回调由宿主 `sendUserMessage` 注入一条 steer 提醒唤醒 AI 去检查（等输入/已挂起）。

防骚扰设计：①用户手开的终端永不参与（只有工具包装层调 noteAgentActivity，浏览器路径不调）；②一次性——触发后解除武装，agent 再次触碰才重新计时；③纪元内任何输出/输入都重置倒计时；④退出/关闭即拆钟。系统提示词引导 TERMINAL_TOOLS_GUIDANCE 已告知模型该机制。回归：`tests/terminal-idle-test.mjs`（直接实例化 TerminalManager + 小阈值，零 token 不起 server；win32 未验证）。

## 终端接管 bash（terminal-backed bash）

bash 工具始终覆盖 SDK 内置 bash，并按设置开关 `terminalBash`（默认关）在两种实现间**动态分流**（agent-service 的 `makeAdaptiveBashTool`）：

- **关（默认）**：`makeKillableBashTool` —— 用 SDK 原生 `createBashTool`（纯进程 spawn，**不开终端**），就是覆盖前的行为；`persist` 在此路径无效，`head`/`tail` 对返回行做后处理。
- **开**：`makeTerminalBashTool` —— 命令写进可见终端（单行哨兵技术：`{cmd}; __pi_rc=$?; printf '\n[pi-exit:%s]\n' "$__pi_rc"`，多行脚本经 `$'...'` 转义 eval），等哨兵行拿到**真实退出码**后返回完整输出（`stripAnsi` 清理、截掉回显与新提示符）。此路径下 `persist` 决定终端**生命周期**，`head`/`tail` 决定返回行数。

> 注意：`persist`/`head`/`tail` 始终出现在 bash 工具的参数 schema 里（双实现共用一份），关时 `persist` 被忽略，`head`/`tail` 仍生效。

### 设置开下的 `persist` 语义

- **`persist=false`（默认，一次性）**：每次调用新建终端 `ai-bash-<n>`（`agentBash=true`），命令跑完 shell 用 `exit` 退场（进程结束），终端连同输出保留在 history 供查阅；阻塞到命令结束，不做静默解阻（接近普通 bash 语义）。
- **`persist=true`**：复用持久终端 `ai-bash`——shell 状态（cd/venv/ssh）跨调用保留，支持静默解阻 / `terminal_wait` / `terminal_read` / `terminal_input` / `terminal_key` 观察与交互；适合交互程序（REPL、y/n 安装器）用 `terminal_input`/`terminal_key` 驱动。

`head` / `tail`（1–5000）只返回输出的前/后 N 行，替代 `| head` / `| tail` 管道（管道会缓冲输出、让可见终端全程哑火、还易触发静默解阻）。纯函数 `applyHeadTail(text, head, tail)` 只对真实数据行切片，省略提示行单独包回，head+tail 组合时尾部不会少截一行。

### 尾部限输出管道自动化解 + 快照查询

`makeTerminalBashTool` 会在执行前把模型常写的**尾部限输出/透传管道**（`| tail [-n N|-N]` 不含 `-f`、`| less`、`| more`、`| cat`）拆掉：底层命令直跑（可见终端实时 + 真实退出码），只在返回给模型时按检测到的行数截末尾 N 行；`buildTerminalBashLine` 一并升级为取管道**首命令**的退出码（`${PIPESTATUS:-$?}`，141 归 0，busybox ash/dash 退化为 `$?`）。纯函数 `splitTopLevelPipes` / `detectTrailingLimiter` / `detectStdoutRedirect`（处理 `cmd > log 2>&1 | tail -N`：拆掉 tail 后补一个 `tail -N log` 让模型看到日志尾部）。`| grep`/`| head`/`| awk`/`| sed`/`| sort`/`| uniq` 等真过滤/变换**不拆**（拆掉丢语义或崩出海量未过滤输出），`tail -f/--follow` 也不拆，交 prompt 引导模型不用。terminal_read 的 head/tail/search(+context) 查询由纯函数 `queryTerminalOutput(output, q, running, exitCode)` 实现（带 1-based 行号），终端静默提示回送的最近行数由 `terminalIdleNotifyLines()`（可配 `PI_WEB_TERMINAL_IDLE_LINES`）控制。

### 行为语义（集中在设置开 + `persist=true`）

- ①默认阻塞到命令结束
- ②连续 `terminalBashIdleMs`（默认 15s，0=一直等）无输出 → **静默解阻**：立即返回「仍在后台运行」+ 已有输出，同时注册 `watchOutput` 完成观察器，命令真正结束后由宿主 `notifyTerminalBashDone` 通知 AI（流式中 sendUserMessage steer / 空闲时 sendCustomMessage nextTurn 排队不唤醒）
- ③shell 状态跨调用保留（cd/venv/ssh）
- ④abort_bash 复用同一 kills 集合，abort 时向 PTY 发 Ctrl+C 杀前台进程；一次性终端也随之结束，`ai-bash` 保留

开关经 `makeAdaptiveBashTool` 的 `useTerminal` 闭包每次调用读取 → 即时生效（customTools 固定于 runtime 创建，不能在创建时二选一）；`idleMs`/`defaultPersist` 同理从设置读取。回归：`tests/terminal-bash-test.mjs`（直接实例化 + 小阈值注入 + `persist`/`head`/`tail`/一次性/分流用例，零 token 不起 server；win32 未验证）。

**前端展示与配额**：持久 `ai-bash` 与一次性 `ai-bash-<n>` 都带 `TerminalInfo.agentBash=true`（缺省 false = 用户终端），前端 `TerminalPanel` 把它们从用户终端标签里拆出来，单独归到「终端接管 bash」折叠分组（`term-folder`，可点开/收起）；`ensureSpawnAllowed` 也只按非 agent 终端计数，所以 AI 高频调用 bash 不会顶掉用户能开的终端名额。
## macOS launchd / TCC 问题

macOS 下若服务由 launchd 拉起（`process.ppid === 1`，LaunchAgent/孤儿进程），TCC 会把相机/麦克风权限归因到 node 本身（无 App Bundle、无 Info.plist）而静默拒绝——ffmpeg 取流会卡死在取帧。`terminals.ts` 检测该场景，在客户端首次创建终端时输出提示（改 url/文件源，或在自己已授权的终端里前台运行）。

## Windows shell 解析

`terminals.ts` 的 `resolveShell()` 每次创建终端时解析，优先 bash——`PI_WEB_SHELL` 显式 → `$SHELL` → Git Bash（ProgramFiles）→ busybox 兜底（`~/.pi-web/bin/bash.exe`，`ensure-bash.ts` 无 Git Bash 时自动下载 busybox-w32）→ `$COMSPEC` → powershell。与 SDK bash 工具（Git Bash / PATH 上的 bash）保持一致，避免 PowerShell/bash 混用挂死。