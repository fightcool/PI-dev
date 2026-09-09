# 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_WEB_PORT` | `8787` | HTTP 端口 |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区（读/写/终端都以此为根） |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 每客户端持久化 UI 状态（client-state.json，最近项目/工作目录）；对话会话放 SDK 默认目录 `<agentDir>/sessions/--<cwd>--/`（与 pi CLI/TUI 共享同一对话列表） |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB) | inline 附件的内联阈值，超过自动降级为路径引用 |
| `PI_WEB_TOOL_TIMEOUT_MS` | `1200000` (20 分钟) | 单个工具调用最长执行时长，超时看门狗自动 abort 会话（防挂死） |
| `PI_WEB_VISION_TIMEOUT_MS` | `90000` | 视觉桥单次转写（整批图片）超时，防止慢视觉模型拖住 prompt |
| `PI_WEB_STALL_NOTIFY_MS` | `180000` | 模型无进展看门狗：流式运行中 N 毫秒无任何 SDK 事件则发 warning 提示可能失联（不自动 abort——深度思考可合法静默数分钟）；0 = 关闭 |
| `PI_WEB_TERMINAL_IDLE_MS` | `15000` | 终端活力检测：agent 触碰过的终端连续 N 毫秒无输出且该对话正在运行时，自动注入 steer 消息提醒 AI 检查；0 = 关闭 |
| `PI_WEB_UPLOAD_RETENTION_DAYS` | `14` | 上传文件保留天数（`<dataDir>/uploads/`，启动时扫一次 + 每 6 小时一次）；0 = 关闭清理 |
| `PI_WEB_SHELL` | 自动探测 | Windows 终端面板（node-pty）的 shell：默认优先 Git Bash（与 SDK bash 工具一致），可用此变量显式指定（如 `powershell.exe` / `cmd.exe`） |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（auth.json / models.json / skills） |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址。**默认只绑 loopback**（本地个人工具，不暴露到网络）；局域网/容器访问需显式 `0.0.0.0`（docker-compose 已内置） |
| `PI_WEB_ALLOW_ORIGINS` | 空 | 逗号分隔的额外 Origin 白名单（如 `http://localhost:5173` dev 代理、反代场景），用于绕过 WS 的 Origin/Host 同权威校验 |
| `PI_WEB_ALLOW_HOSTS` | 空 | 可选严格模式：设置了才启用，请求 Host 的 hostname 必须在此白名单（逗号分隔） |
| `PI_WEB_TOKEN` | 空 | **可选共享口令鉴权**：设置后所有 HTTP/WS 请求必须携带（`Authorization: Bearer` / `X-PI-Token` 头、`?token=` 参数或 `pi_web_token` cookie 任一匹配；浏览器首次经 `?token=xxx` 进入后存 localStorage 并下发 HttpOnly cookie）；`/api/health` 保持开放供探针，但**绝不因命中 `/api/health` 就反射下发真实 token cookie**（issue #45，仅当请求确实携带有效 token 才 `Set-Cookie`）。**cookie 生命周期（issue #71）**：每次请求携带有效 token 即把 cookie 刷新为当前值；服务端改了口令后，旧 cookie 会在 401 时被自动过期清除，再经一次正确的 `?token=` 进入即永久恢复，**无需清缓存**。前端 `web/src/auth-token.ts` 统一注入；回归：`tests/token-auth-test.mjs`（端口 8975） || `PI_WEB_ENGINE` | `pi` | 智能体引擎：`pi`（SDK 进程内）或 `dsh`（DeepSeek Harness 子进程，见 docs/dsh-engine.md）——重启生效 |
| `PI_WEB_DSH_RUNTIME` | 自动解析 | DSH 运行时树根（含 `@deepseek-ai/dsh-base` 的 node_modules；默认按 本包→execPath 邻近→`npm root -g` 顺序解析，支持全局 `dsh` 嵌套树） |
| `PI_WEB_DSH_DATA_DIR` | `PI_WEB_DATA_DIR` | DSH 专用数据目录（用户 patch 层 `<dir>/dsh-patches/*.yml` 所在；launcher 读） |
| `PI_WEB_DSH_PATCH_DIR` | 空 | 用户 patch 目录的显式覆盖（优先级高于 `PI_WEB_DSH_DATA_DIR` 推导） |
| `PI_WEB_DSH_QUESTION_TIMEOUT_MS` | `600000` (10 分钟) | 模型 ask_user_question 提问桥超时（前端显示倒计时，归零自动取消） |
| `PI_WEB_DSH_SESSION_RETENTION_DAYS` | `90` | dsh 会话 JSONL 保留天数（启动 10s 首清 + 每 24h 幂等清理）；0 = 关闭清理 |
| `PI_WEB_DSH_DEBUG` | 空 | `1` 时把 DSH 运行时 RPC 帧与生命周期事件打到 stderr（诊断用，默认关） |
| `PI_WEB_LOCALE_BASE_URL` | `https://raw.githubusercontent.com/xing-shuyin/pi-web-ui` | 语言包下载根：`locales/<code>.json` 先试 `v<版本>` tag、再回落 `main` 分支；key 缺失自动回落英文，版本错位可容忍；离线可手工把 JSON 放进 `<dataDir>/locales/` |
| `PI_WEB_LOCALE` | 空 | 首访默认语言（fallback，非覆盖）：无显式选择且浏览器语言无可用包时用；不认识的值忽略回英文；设 `zh` 可恢复旧行为（新访客默认中文） |
| `PI_WEB_MANAGED` | 空 | `1`/`true`/`yes`/`on` 时该实例由部署方统一管理：服务端拒绝 `check_update`/`check_updates_all`/`install_pi_agent`/`plugin_catalog_add`，前端隐藏更新徽标/面板与插件市场（服务端拒绝为主，前端仅隐藏）。适用于 Docker/发行版/发布管线等由外部更新软件的场景；不设则行为不变（见 server/managed.ts） |
| `PI_WEB_TABS` | 空 | 逗号分隔的页签白名单（如 `chat,search,settings`）：前端不画被排除页签，服务端拒绝其消息（`terminal_*`/`run_command`、`scm_*`、后台任务、两个搜索），`chat` 永不可关；未知名保留不拒绝；缺省 = 全部页签（见 server/tabs.ts） |
