# Changelog

> 面向使用者的版本变更记录：升级前先看这里，再决定是否升级。
> 版本号规则：npm 上的版本不带 `v` 前缀（如 `0.70.0`），GitHub 的 tag / Release 带 `v` 前缀（如 `v0.70.0`），两者数字部分一一对应。
> 日期为 npm 发布时间（UTC+8 换算后的日历日）。

格式说明：`Added` 新增功能、`Fixed` 修复、`Changed` 行为/样式变更、`i18n` 多语言相关。
每个版本的内容按"实际合入该版本发布的提交"归档（以 `package.json` 的 version 变更提交为准），
而不是按提交日期聚类——连续快速发布的 patch 版本以此为准最准确。

## [Unreleased]

## [0.72.0] — 2026-09-09

### Added

- 模型报错自动重试次数设置（`retryMaxAttempts`，对话设置）：大模型 API 出错时按次数自动重试；次数用完本轮停止并标红，最后一轮红色报错旁有「重试」按钮（`retry_last`，协议 v15），手动再跑一轮；设为 0 则失败即停。面板值覆盖注入 SDK 默认（含子代理与会话重建）。
- 发布时翻译增量自动公示：`scripts/i18n-diff.mjs`（对比 base tag，统计前端 `zh/en` 与服务端 `pick` 新增/变更的 key）与 `scripts/release-notes.mjs`（拼 GitHub Release 说明，`### i18n` 现场生成；`npm run changelog:i18n` 自动维护本节）；打 tag 推送后 Action 自动创建/更新 Release。

### Fixed

- 多密钥按项目自愈：删除密钥时所有引用该密钥的项目跟随接管密钥（无剩余则解绑）；清空服务商密钥时清掉全部项目的残留引用；切换到不存在的密钥不再种下 stale 引用；切项目自动恢复改为静默 + 不存在即删引用，切项目不再刷屏报错。

### Changed

- 设置「消息显示」改名「对话」（中英 + 8 语言包同步）。

<!-- auto-i18n:start -->
### i18n

- 前端新增 key（4）：`modelRetryAttempts`、`modelRetryHint`、`retryNow`、`retryLastTip`
- 前端中文变更（1）：`settingsMessageDisplay`
- 前端英文变更（1）：`settingsMessageDisplay`
<!-- auto-i18n:end -->

## [0.71.0] — 2026-09-09

### Added

- 全屏壁纸与容器背景变量，新增半透明（translucent）/全透明（transparent）主题。
- 右侧文件列表加"复制名称 / 复制路径"按钮。

### Fixed

- CollapsedMessage：`button` 改 `div`，窄消息区 rail 避让仅桌面生效。

### Changed

- prettier 收尾：`web/src/i18n.tsx` 上游 drift 格式化（post-#102）。

## [0.70.0] — 2026-09-09

### Added

- 全局共享设置：服务端持久化 + 服务端 quick-phrases 种子、quick-seed 标记、动态 marker overlay。
- 输入框快捷短语改为服务端下发种子；超长 notice 自动换行。
- 聊天壁纸设置基础（issue #100，含主题 cyberpunk 壁纸变量与 `wallpaper-settings` 单测；全屏壁纸与容器背景变量见 0.71.0）。
- 终端"运行中"列表只统计存活 PTY（countLive）。

### Fixed

- 语言包 slot 语法与换行转义；条件分支预渲染 segments。

### i18n

- 葡萄牙语 serverStrings 163 条翻译 + 文案润色。

### Changed

- 面板按钮对比度、主题英文名、思考/工具头重排。

## [0.69.0] — 2026-09-08

### Added

- 目标模式总开关：关闭时隐藏目标条，阻断向导与审查。
- `PI_WEB_TABS`（实例提供哪些 tab）与 `PI_WEB_MANAGED`（外部更新的实例）及文档。
- 首次访问语言跟随浏览器，而非固定默认。

### Fixed

- 用户气泡保留单个换行；快捷短语输入后重新聚焦。
- 子代理归属其所属会话（issue #95）。
- E2E 明确上报 zh locale；terminal-smoke 与终端工具默认关对齐。

### Changed

- pt-BR 文案润色；`index.mjs` 参数化查询（#97）。

## [0.68.2] — 2026-09-08

### Added

- 意大利语（it） locale；可下载语言包（核心只带 zh/en）。
- 标准 pi 引擎接入 `ask_user_question` 问卷。
- 文本块与思考块复制按钮。

### Fixed

- 网页终端里 vim 无法输入（提高 Vite 构建 target）。
- Android/Termux 死锁：服务端热路径消除全部 fork。
- pt-BR 字符串润色（markers 描述 + locale 列表报错）。

## [0.68.1] — 2026-09-07

### Added

- 运行轨迹时间线插件：`host.onRunEvent` 轨迹事件通道、harness 式轨迹分析 v2、vis-timeline 专业引擎（vendor 自带）、工具按名着色 + 图例、自绘即时悬浮层。
- 浏览器标题显示项目名。

### Fixed

- webmail：secret 存储失败时不再丢密码。
- 宽屏消息列/输入列按实测滚动条宽精确对齐；重试提示条幅与消息正文列同宽；goalbar 对齐。

## [0.68.0] — 2026-09-07

### Added

- 输入框快捷短语：一键发送 + 设置页管理。

## [0.67.0] — 2026-09-07

### Added

- 系统提示词模板组合（system prompt template composition）+ `edit_soft` 宽松编辑工具。

## [0.66.0] — 2026-09-07

### Added

- Termux（Android）安装指南。
- Mermaid 图表跟随当前主题。

### Fixed

- 同步 pi CLI 探测改为异步后台探测（解决死锁，#79）。
- Mermaid 主题同步与排版规整。

## [0.65.0] — 2026-09-06

### Added

- 插件市场 + fenced-code 渲染插件（mermaid 插件化）。
- 超宽屏聊天列开关。

## [0.64.8] — 2026-09-06

### Fixed

- 后台服务列表过滤桌面软件噪音进程。

## [0.64.7] — 2026-09-06

### Added

- 子代理父子链接树、保留与干净 rpc 绑定。

## [0.64.6] — 2026-09-06

### Added

- 子代理：错误透出、模型选择、`wait-for-all` 工具。

## [0.64.5] — 2026-09-06

### Fixed

- 重启浏览器恢复上次工作目录。
- 目录消失时列表/会话刷新不再崩溃（issue #74）。

## [0.64.4] — 2026-09-06

### Added

- 设置 → 显示：mermaid 图表渲染开关。

### Fixed

- 历史/最近项目遵循 `PI_CODING_AGENT_SESSION_DIR`。

## [0.64.3] — 2026-09-05

### Added

- `pi-web-ui --help` 中英双语（按 LANG 检测，#72）。

## [0.64.2] — 2026-09-05

### Added

- mermaid 代码块渲染为图表。
- 机器浏览模式：`@root` 机器根 + 绝对 wire 路径跨盘符浏览。

### Fixed

- `PI_WEB_TOKEN` 改口令后 cookie 自动刷新/过期，一次 `?token=` 即恢复（issue #71）。
- mermaid 原生 SVG 尺寸、流式路径渲染、取消渲染清理；宽图表可读宽度保持。

## [0.64.1] — 2026-09-05

### Added

- 33 条 notice 的英文 textEn、locale 实时退出横幅与页面标题。

### Fixed

- 移动端发送按钮盖过思考强度底弹层（#70）。
- Windows 下 stale-marker 单测时间戳（pre-1970 mtime 回绕到 2106）。

## [0.64.0] — 2026-09-04

### Added

- 全局提示词历史、目录选择器（含新建文件夹）与 UI 抛光。

## [0.63.4] — 2026-09-04

- 版本重发（随带 `rename` 内置 marker 一行修正），无功能变更。

## [0.63.3] — 2026-09-04

### Added

- PWA 支持与移动端键盘回车换行（#64）；会话结束/需输入时桌面通知（#65）；PWA 资源与通知图标子路径感知（nginx `/pi/` 部署）。
- 历史对话与终端标签 UI 重命名（#63）；`/name` 命令重命名当前会话（#66）。
- 行内 marker 系统：todo/svc/notify/rename，无需工具往返。

### Fixed

- SCM 提交遵循暂存区，并新增"提交全部"。

## [0.63.2] — 2026-09-03

### Fixed

- 主题名跟随界面语言（英文用 nameEn，#61）。
- terminal-smoke 改轮询 shell banner，消除慢 CI 机器抖动。

## [0.63.1] — 2026-09-03

### Fixed

- 左侧栏折叠区块统一样式：折叠后三标题一致、切换不位移、收起按钮垂直居中、标题高亮通栏居中。

## [0.63.0] — 2026-09-03

### Added

- 子代理模板：角色系统提示词（append/replace）+ 技能/扩展白名单，AI 可选用、可停用，内置 6 个默认模板。
- 对话可从运行列表移出（dismiss_conversation）+ pi-subagents 存活检测（WIP）。

### Changed

- 全仓库 prettier（Tab/120）与 oxlint 接入 CI（#57/#58）。
- DSH notice、终端退出横幅、目标状态跟随界面语言（#54 及后续）。

### Fixed

- 插件目录搬迁后坏掉的冒烟测试 fixture（#59）。

## [0.62.1] — 2026-09-03

### Fixed

- SCM 的 `git add/reset` 路径引号闭合（issue #51）。

## [0.62.0] — 2026-09-02

### Added

- 排队消息可删除（✕）；底部栏实时缓存命中率与生成速率。

### Fixed

- `terminal_create` 带 title 下发，服务端不再用中文默认覆盖。

## [0.61.0] — 2026-09-02

### Added

- 内置服务商多密钥管理 + 项目级模型/key 记忆。

## 更早版本

0.62 之前的版本没有逐版归档，以下是发布提交记录中的要点（详见 `git log`）：

- 0.60.0（2026-09-02）：移除 `PORT` 环境变量兼容，仅保留 `PI_WEB_PORT`；修复 `--host` 直启失效。
- 0.59.0（2026-09-01）、0.58.0（2026-08-30）。
- 0.56.1 / 0.55.0 / 0.53.0 / 0.51.0（2026-08-30）。
- 0.50.0 / 0.49.0（2026-08-29）：0.49.0 起移除 Electron 桌面壳，只保留纯 Web。
- 0.48.3 / 0.48.2（2026-08-29）：pi SDK 升到 `^0.84.4`。
- 0.44.1（2026-08-28）。
- 0.35.1（2026-08-27）：编辑重问保留附件（#18）+ 全窗口拖放（#19）。
- 0.29.0（2026-08-23）：全局搜索弹窗（Ctrl+K）+ 消息列表惰性窗口化。

[Unreleased]: https://github.com/xing-shuyin/pi-web-ui/compare/v0.72.0...main
[0.72.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.72.0
[0.71.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.71.0
[0.70.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.70.0
[0.69.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.69.0
[0.68.2]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.68.2
[0.68.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.68.1
[0.68.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.68.0
[0.67.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.67.0
[0.66.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.66.0
[0.65.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.65.0
[0.64.8]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.8
[0.64.7]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.7
[0.64.6]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.6
[0.64.5]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.5
[0.64.4]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.4
[0.64.3]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.3
[0.64.2]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.2
[0.64.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.1
[0.64.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.0
[0.63.4]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.4
[0.63.3]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.3
[0.63.2]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.2
[0.63.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.1
[0.63.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.0
[0.62.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.62.1
[0.62.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.62.0
[0.61.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.61.0
