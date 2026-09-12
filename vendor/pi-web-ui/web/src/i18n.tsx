/* 🍞 @COUPLED ../locales/*.json（8 个语言包必须与 zh 的 key 顺序一一对应，见 tests/unit/locales.test.ts）
 *   📖 docs/DEV-CON-PROPOSAL.md §6（渠道界面文案）
 *   @CONTRACT 新增 key 要在 zh 与 en 都补，并同步 locales/*.json，否则语言包一致性单测失败。 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EnDictionary } from "./i18n-en";
import { appUrl } from "./base-url";
import { withToken } from "./auth-token";
import { pickLocale } from "./pick-locale.js";

/** Locale code ("zh" / "en" built in; the rest are downloadable packs, see below). */
export type Locale = string;

const STORAGE_KEY = "pi-web-ui:lang";

/* ------------------------------------------------------------------ */
/* zh (default)                                                        */
/* ------------------------------------------------------------------ */

export const zh = {
	/* common */
	docTitle: "pi-web-ui — pi 编码智能体",
	cancel: "取消",
	ok: "确定",
	save: "保存",
	close: "关闭",
	widgetExpand: "点击放大查看完整输出",
	collapsePanel: "收起面板",
	expandPanel: "展开面板",
	dragToResize: "拖拽调整宽度 · 双击复位",
	loading: "加载中…",
	connected: "已连接",
	connecting: "连接中…",
	reconnecting: "重连中…",
	language: "语言",
	langZh: "中文",
	langEn: "English",
	langIt: "Italiano",
	langJa: "日语",
	langKo: "韩语",
	langFr: "法语",
	langDe: "德语",
	langEs: "西班牙语",
	langRu: "俄语",
	langPt: "葡萄牙语",
	githubRepo: "GitHub 仓库（xing-shuyin/pi-web-ui）",
	copy: "复制",

	/* topbar */
	viewSwitch: "视图切换",
	chat: "对话",
	terminal: "终端",
	selectModel: "选择模型",
	availableModels: "可用模型",
	allProviders: "全部",
	providers: "服务商",
	noModels: "暂无可用模型（请先配置 API 密钥）",
	reasoning: "推理",
	vision: "识图",
	refreshModels: "刷新模型列表（保留手填，合并新增）",
	manageModels: "⚙ 管理模型（新增 / 修改）",
	manageModelsTitle: "管理模型",
	thinkingLevel: "思考强度",
	thinking: "思考",
	thinkingChip: "思考：{level}",
	sound: "声音",
	theme: "主题",
	themeDefault: "深色（默认）",
	newChat: "新对话",
	more: "更多",
	newChatTip: "新建对话（每个浏览器独立保存会话）",
	"thinking.off": "关闭",
	"thinking.minimal": "极简",
	"thinking.low": "低",
	"thinking.medium": "中",
	"thinking.high": "高",
	"thinking.xhigh": "极高",
	"thinking.max": "最大",
	thinkingUnsupported: "当前模型不支持该级别，已按模型能力就近生效",

	/* footerbar */
	context: "上下文",
	contextUsage: "上下文用量",
	cumulativeCost: "累计成本",
	tokensShort: "令牌",
	tokenUsageTip: "累计令牌：输入 {input} · 输出 {output} · 总计 {total}",
	singleTurnTokens: "本次令牌：输入 {input} · 输出 {output} · 总计 {total}",
	sessionMessages: "会话消息数",
	messages: "消息",
	pluginStatus: "插件状态",
	engineBadge: "引擎",
	working: "工作中",
	queued: "排队",
	enterPath: "输入路径，Enter 切换",
	cwdTip: "工作目录：{path}（点击切换）",
	cwdGoUp: "上级目录",
	cwdPickCurrent: "选择当前目录",
	cwdChoose: "选择",
	cwdEnter: "进入",
	cwdEmpty: "（空目录）",
	cwdNewFolder: "新建文件夹",
	cwdNewName: "文件夹名称",
	cwdCreate: "创建",
	cwdCancel: "取消",
	cacheHit: "缓存命中",
	cacheHitTip: "缓存读取 {read} · 缓存写入 {write} · 未命中 {miss}（共 {input} 输入 token）",
	tps: "t/s",
	rateTip: "实时生成速率（估算）",

	/* chat input */
	folderRef: "文件夹引用：{path}",
	refOnly: "仅引用：{path}",
	attachContent: "附加内容：{path}",
	attachLines: "附加选中行：{path}（第 {start}-{end} 行）",
	attachImage: "图片：{name}",
	attachFile: "文件：{name}",
	removeAttachment: "移除附件",
	attachHint: "将随下一条消息发送",
	uploadFile: "添加文件（图片/文本/任意文件，也可直接拖入或粘贴截图）",
	dropHereToAttach: "松开以添加文件",
	imageNotSupported: "当前模型不支持识图：图片将交给视觉桥转写（若未配置视觉模型则可能被忽略）",
	imageLoadFailed: "图片读取失败：{name}",
	fileLoadFailed: "文件读取失败：{name}",
	fileTooLarge: "文件过大已跳过（>{size}MB）：{name}",
	foldersNotSupported: "不支持直接拖入文件夹，请展开后选择文件",
	placeholderStreaming: "智能体正在工作中…回车插队发送，或点「排队」等回答结束后发送",
	placeholderIdle: "给 pi 发送消息 — Enter 发送，/ 查看命令",
	placeholderConnecting: "正在连接服务器…",
	stopAgent: "停止智能体",
	stop: "停止",
	bgTasks: "后台任务",
	bgTasksTip: "AI 在后台启动的服务（npm run dev & 等）——可逐个停止或全部关闭，对话结束后仍保留",
	bgTasksEmpty: "暂无后台任务",
	bgTasksDesc: "AI 运行中启动并仍在监听的进程（按监听端口检测）",
	bgTaskPort: "端口",
	bgTaskPid: "PID",
	bgTaskSince: "启动",
	bgTaskStop: "停止",
	bgTaskStopAll: "全部关闭",
	bgTaskRefresh: "刷新",
	bgTaskJustNow: "刚刚",
	bgTaskMinutes: "{n} 分钟前",
	bgTaskHours: "{n} 小时前",
	bgTaskDays: "{n} 天前",
	stopBash: "停止",
	stopBashTip: "停止正在运行的 bash 命令（对话继续）",
	supplement: "排队",
	supplementTip: "加入队列：AI 回答完全结束后才发送（不打断）",
	queueSteerTag: "插队",
	queueFollowTag: "排队",
	queueRemoveTip: "移除此排队消息",
	sendTip: "发送（Enter）",
	quickPhrases: "快捷短语",
	quickPhrasesDesc: "输入框上方的一排常用短语按钮，点击即发送（会带上当前已选的文件附件，不清空输入框草稿）",
	quickPhrasesEnabled: "启用快捷短语",
	quickPhrasesOffHint: "已关闭：输入框上方不再显示快捷短语按钮（已配置的短语保留，可随时重新启用）",
	quickPhrasesPlaceholder: "输入常用短语…（Enter 添加）",
	quickPhrasesAdd: "添加",
	quickPhrasesEmpty: "还没有快捷短语，在下面添加第一条",
	quickPhrasesTip: "点击发送：{text}",
	quickPhrasesMoveUp: "上移",
	quickPhrasesMoveDown: "下移",
	quickPhrasesDelete: "删除该短语",
	quickPhrasesEdit: "编辑该短语",
	quickPhrasesEditPh: "修改短语…（Enter 保存，Esc 取消）",
	quickPhrasesReset: "恢复默认短语",

	/* slash commands */
	slashCommands: "命令",
	slashMenuHint: "↑↓ 选择 · Enter/Tab 补全",
	slashHelpTitle: "pi 命令",
	slashHelpHint: "输入 / 随时打开命令列表",
	slashLoading: "命令列表加载中…（连接服务器后可用）",
	slashBuiltin: "内置",
	slashExtension: "扩展",
	slashPrompt: "模板",
	slashSkill: "技能",
	slashPlugin: "插件",
	slashCopied: "已复制上一条助手回复",
	slashCopyFailed: "复制失败，请手动复制",
	slashCopyEmpty: "还没有可复制的助手回复",

	/* left panel */
	recentProjects: "最近项目",
	runningConversations: "运行的对话",
	subagentBadge: "子代理",
	convErrorBadge: "子代理运行报错：{error}",
	subagentTitle: "子代理 · {title}",
	historySessions: "历史对话",
	openHistory: "历史对话",
	openFiles: "文件列表",
	streaming: "进行中…",
	noHistory: "还没有历史对话",
	current: "当前",
	messageCount: "{n} 条消息",
	tuiTip: "pi 终端（TUI）中的对话",
	deleteProject: "从最近项目移出",
	deleteProjectConfirm: "确认移出",
	deleteSession: "删除该对话记录（不可恢复）",
	deleteSessionConfirm: "确认删除",
	renameSession: "重命名该对话",
	renameSessionPlaceholder: "输入新名称…",
	renameSessionConfirm: "重命名",
	dismissConversation: "从运行列表移出（历史记录保留）",
	dismissConversationConfirm: "确认移出",
	collapseSection: "折叠",
	expandSection: "展开",
	emptyChat: "空对话",

	/* message edit */
	editReask: "编辑重问",
	editReaskTip: "修改此问题，并从这里重新提问（会新建一个分支对话，原对话保留）",
	reaskFromHere: "从此处重新提问",
	editPlaceholder: "修改问题内容…",
	editHint: "⌘/Ctrl+Enter 提交 · Esc 取消",
	editAttachmentHint: "原附件已保留，可粘贴/拖入新图片或文件 · ⌘/Ctrl+Enter 提交 · Esc 取消",

	/* collapsed old messages */
	expandMsg: "展开",
	collapseMsg: "收起",
	toolCalls: "工具调用",
	bashRuns: "终端运行",
	images: "图片",

	/* self-update */
	update: "更新",
	updateTip: "检查并更新 pi-web-ui",
	currentVersion: "当前版本",
	latestVersion: "最新版本",
	checkingUpdate: "检查中…",
	checkUpdate: "检查更新",
	upToDate: "已是最新版本",
	updateAvailable: "发现新版本 v{version}",
	updateJustPublished: "v{version} 刚刚发布，npm 缓存可能尚未同步——若未检测到新版本，请稍后重新检查",
	updateNow: "在终端中更新",
	updateTabTitle: "更新 pi-web-ui",
	updateTerminalHint:
		"点击后会在可见终端中运行 npm i -g pi-web-ui@latest；完成后重启服务生效（pi-web-ui server restart）。",
	updatesAllTitle: "全部组件更新",
	updatesAllBadge: "{n} 个更新",
	updatesAllUpToDate: "全部组件均为最新",
	kindWebUi: "Web 界面",
	kindPiCore: "核心",
	kindPackage: "组件",
	updatesAllRefresh: "重新检查全部",
	updateCheckFailed: "检查失败",
	updateBtn: "更新",
	updateAllBtn: "全部更新",
	updatePkgTabTitle: "更新 {name}",
	updateAllTabTitle: "更新全部组件",

	/* right panel */
	computer: "此电脑",
	rootDir: "根目录",
	noFiles: "暂无文件",
	filesTruncated: "目录过大，列表已截断，仅显示前 2000 项",
	linkFolderTip: "链接文件夹路径到对话",
	attachInlineTip: "附加内容到对话",
	referenceTip: "仅引用路径（AI 按需读取）",
	previewFile: "预览",
	downloadFile: "下载文件",
	copyName: "复制名称",
	copyPath: "复制路径",
	downloadFailed: "下载失败：{error}",
	fileNotFoundShort: "文件不存在",
	pluginMountFailed: "插件 {name} 挂载失败",
	liveOutputOmitted: "…[前 {n} 字符已省略]…\n",
	uploadToFolder: "上传文件到此文件夹",
	uploadToCurrentDir: "上传文件到当前目录",
	openAsProject: "以项目打开",
	protocolMismatch: "页面版本与服务器不一致（应用刚更新过），请刷新页面以恢复全部功能。",

	/* file preview */
	selectLinesHint: "点击选择行；拖拽或 Shift+点击选择范围",
	enableWrap: "开启自动换行",
	disableWrap: "关闭自动换行",
	selectedRange: "已选 {n} 行（第 {start}-{end} 行）",
	fileLines: "{n} 行",
	selectAll: "全选",
	clearSelection: "清除",
	addToChat: "添加到对话",
	addedToChat: "已添加",
	previewTruncated: "⚠ 文件过大，仅预览前 512KB",
	previewLinesTruncated: "… 文件行数过多，仅显示前 {n} 行",
	binaryFile: "🔣 二进制文件，已显示前 4KB 十六进制",
	binaryHexTruncated: "（文件更大，可下载完整文件）",
	previewNotSupported: "该类型文件不支持预览（仅图片 / 视频 / 文本）",
	emptyFile: "（空文件）",
	editFile: "编辑文件",
	exitEditFile: "退出编辑",
	saveFile: "保存文件",
	discardFileChanges: "放弃未保存的修改？",
	fileSaved: "已保存",
	fileEditTruncated: "文件过大，预览不完整，无法编辑",
	showMarkdownSource: "显示 Markdown 原文",
	showMarkdownPreview: "显示 Markdown 预览",
	fullscreen: "全屏",
	exitFullscreen: "退出全屏",
	zoomIn: "放大字号",
	zoomOut: "缩小字号",
	resetZoom: "重置缩放",

	/* dialog */
	pluginRequest: "插件请求",
	modelQuestion: "模型提问",
	modelQuestionCustom: "补充回答（可选）",
	modelQuestionSubmit: "提交回答",
	next: "下一步",
	previous: "上一步",
	questionStep: "第 {cur} / {total} 题",
	optionPreview: "选项预览",
	noOptions: "（无选项）",
	inputPlaceholder: "输入内容",
	questionTimeout: "⏳ 剩余 {s} 秒，超时将自动取消",
	questionTimeoutExpired: "提问已超时，正在恢复对话…",
	modelNoVision: "当前模型 {name} 不支持图片，请切换到支持图片的模型",
	dshSkillsNote: "DSH 引擎使用运行时内置技能（dsh-skill），暂不支持在设置面板启停",
	dshExtensionsNote: "DSH 引擎无 pi 扩展体系，能力由运行时内置（MCP/subagent/goal/plan/skill 等）",
	dshReviewPromptNote: "DSH 无独立审查会话：此指令将随目标轮次附加到系统提示词，供模型在目标轮次中遵守",
	dshVisionHiddenNote: "DSH 引擎直接支持图片输入（所选模型需自带视觉能力），无需视觉桥转写",
	dshNoReviewModel: "DSH 无独立审查模型：目标由模型自判定完成/受阻，轮次上限即自动迭代次数",

	/* sound settings */
	soundHeader: "声音提示",
	enableSound: "启用声音",
	preview: "试听",
	volume: "音量",
	/* desktop / OS (PWA) notifications */
	notifyHeader: "桌面通知",
	notifyEnable: "启用桌面通知（PWA）",
	notifyEnableDesc: "会话完成或需要你输入时，即使切到其他应用也会提醒（需授权，仅页面前台无焦点时触发）。",
	notifyDenied: "通知权限已被拒绝 —— 请在浏览器/系统设置里为本站点开启通知。",
	notifyUnsupported: "此浏览器不支持通知。",
	notifyDoneTitle: "任务完成",
	notifyDoneBody: "会话已完成，等待你的输入。",
	notifyQuestionTitle: "需要你回答",
	notifyQuestionBody: "pi 正在等你回答一个问题。",
	notifyErrorTitle: "出错了",
	notifyErrorBody: "一个会话报告了错误。",
	"sound.question": "问卷弹出",
	"sound.question.desc": "ask_user_question 出现时",
	"sound.done": "回复结束",
	"sound.done.desc": "智能体完成一轮回答时",
	"sound.start": "回复开始",
	"sound.start.desc": "智能体开始新一轮时",
	"sound.error": "出错",
	"sound.error.desc": "出现错误提示时",

	/* pi setup modal */
	setupTitle: "未检测到 pi agent 配置",
	setupDesc:
		"pi-web-ui 需要 pi 的配置目录（~/.pi/agent）和至少一个 API 密钥才能运行智能体。pi 内置了 openai、anthropic、deepseek 等服务商——选一个填密钥即可，全程无需打开终端。",
	installFailed: "✖ pi agent 安装失败：",
	retryInstall: "重试安装",
	skip: "跳过",
	installDone: "✅ pi agent CLI 已安装。选择服务商并填入 API 密钥即可开始对话：",
	cliReadyHint: "✅ 本地已检测到 pi agent，选择服务商并填入 API 密钥即可开始对话：",
	provider: "服务商",
	configured: "已配置",
	providerKeyReady: "该服务商已配置密钥，可直接使用或更换新密钥。",
	apiKey: "API 密钥",
	saving: "保存中…",
	saveAndStart: "保存并开始使用",
	recheck: "重新检测",
	installing: "正在安装 pi agent CLI…",
	autoInstall: "自动安装 pi agent",

	/* messages */
	attachment: "附件",
	plugin: "插件",
	unknown: "未知",
	thinkingWait: "正在思考",
	exitCode: "退出码 {code}",
	cancelled: "已取消",
	truncated: "… 内容过长，当前视图已截断",
	outputTruncated: "… 输出过长，当前视图已截断",
	refOnlyShort: "仅引用",
	folderRefShort: "文件夹 · 仅引用",
	inlineLines: "内联 · {n} 行",
	inlineLinesRange: "行 {start}-{end}",
	image: "🖼 图片",
	bridgedVision: "👁 已转写",
	bridgedVisionDetail: "图片已由视觉桥转写（当前模型不支持识图）",
	folderNotExpanded: "文件夹，未展开内容 —— 智能体会按需浏览目录",
	fileNotExpanded: "文件较大（{size}），未展开内容 —— 智能体会按需读取",
	"role.user": "你",
	"role.assistant": "pi",
	"role.tool": "工具",
	"role.bash": "终端",
	"role.branch": "分支摘要",
	"role.compaction": "上下文已压缩",

	/* welcome / message list */
	directory: "目录",
	waitingResponse: "正在等待模型响应…",
	retryingApi: "大模型 API 出错，正在自动重试（{attempt}/{max}）：{error}",
	retryingApiSoon: "大模型 API 出错，正在自动重试：{error}",
	modelRetryAttempts: "模型报错自动重试次数",
	modelRetryHint:
		"大模型 API 调用出错时自动重试的次数。次数用完后本轮停止并标红，可点「重试」手动再试；设为 0 则失败即停。修改即时生效，无需重载。",
	retryNow: "重试",
	retryLastTip: "手动重试上次失败的模型请求",
	compactingContext: "正在压缩上下文，摘要生成中…",
	compactingReasonManual: "手动触发",
	compactingReasonThreshold: "上下文达到阈值，自动触发",
	compactingReasonOverflow: "上下文溢出，自动触发",
	compactionFrom: "从 {tokens} tokens 压缩",
	compactionKeptHint: "此前历史已折叠为该摘要，上下文中仅保留最近消息",
	backToBottom: "回到底部",
	questionNavTitle: "问题列表",
	searchPlaceholder: "在对话中搜索…",
	searchNoResults: "无结果",
	/* model dropdown filter + global search */
	searchModels: "搜索模型…",
	noModelMatches: "无匹配模型",
	modelUsedCount: "已用 {n} 次",
	searchGlobal: "搜索",
	searchGlobalTip: "全局搜索：对话 / 项目 / 文件（Ctrl+K）",
	gsPlaceholder: "搜索项目、历史对话、工作区文件…",
	gsHint: "输入关键词：搜索历史对话全文（含 AI 回复）、最近项目与当前项目的文件名",
	gsSessions: "对话",
	gsProjects: "项目",
	gsFiles: "文件",
	gsNoResults: "无匹配结果",
	gsSearching: "正在搜索…",
	gsTruncated: "匹配过多，仅显示部分结果",
	gsCurrentProject: "当前",
	gsOpenPreview: "打开文件预览",
	gsNavigate: "选择",
	gsOpen: "打开",
	gsCloseHint: "关闭",
	bgTaskCommand: "命令行",
	searchPrev: "上一个（Shift+Enter）",
	searchNext: "下一个（Enter）",
	searchClose: "关闭（Esc）",
	questionNavTip: "本对话的全部问题，悬浮展开，点击跳转",

	/* 提示词模板（新对话空态推荐卡片） */
	"tpl.title": "提示词模板",
	"tpl.hint": "点击卡片直接填入输入框，✏️ 可编辑或删除 · 也能新增自己的模板",
	"tpl.clickCard": "点击填入输入框",
	"tpl.editTpl": "编辑 / 删除模板",
	"tpl.openPicker": "提示词模板（常用提示词，随时取用）",
	"tpl.pickerTitle": "提示词模板",
	"tpl.pickerHint": "点击卡片直接填入输入框，✏️ 可编辑或删除 · 也能新增自己的模板",
	"tpl.add": "新建模板",
	"tpl.addDesc": "把常用工作流存成模板",
	"tpl.reset": "恢复默认模板",
	"tpl.resetConfirm": "确认恢复默认？",
	"tpl.builtin": "内置",
	"tpl.custom": "自定义",
	"tpl.newTitle": "新建提示词模板",
	"tpl.editTitle": "编辑提示词模板",
	"tpl.fieldIcon": "图标",
	"tpl.fieldTitle": "标题",
	"tpl.fieldTitlePh": "卡片上显示的短标题",
	"tpl.fieldDesc": "说明",
	"tpl.fieldDescPh": "一句话说明，显示在卡片上",
	"tpl.fieldPrompt": "提示词",
	"tpl.fieldPromptPh": "完整提示词 —— 发送给智能体的内容",
	"tpl.required": "标题和提示词不能为空",
	"tpl.save": "保存修改",
	"tpl.fill": "填入输入框",
	"tpl.fillTip": "填入输入框，可再编辑后发送",
	"tpl.sendNow": "直接发送",
	"tpl.sendTip": "立即作为新对话发送",
	"tpl.delete": "删除",
	"tpl.deleteTip": "删除这个自定义模板",
	"tpl.remove": "移出模板库",
	"tpl.removeTip": "把内置模板移出模板库，可在底部「恢复默认模板」找回",
	"tpl.restore": "恢复默认",
	"tpl.restoreTip": "撤掉你的修改，恢复内置默认",

	/* 内置模板：覆盖 https://www.aihero.dev/skills 全部 25 个 skill */
	"tpl.sk.setup": "仓库初始化",
	"tpl.sk.setup.desc": "让仓库了解它的构建与约定",
	"tpl.sk.setup.prompt":
		"请先扫描这个仓库，建立「其他工作流都能用」的基础上下文，输出一份简明报告：\n\n1. 项目类型、技术栈与目录结构\n2. 构建 / 测试 / 运行 / 格式化的具体命令\n3. 代码约定与命名规范\n4. 任务 / issue 的存放位置与格式\n5. 目前已知的坑或遗留问题\n\n先只报告，不修改任何文件。",
	"tpl.sk.ask": "技能导航",
	"tpl.sk.ask.desc": "告诉我该用哪个流程",
	"tpl.sk.ask.prompt":
		"我先描述当前要解决的情况，你先判断最适合的工作流（需求澄清 / 拆解计划 / 测试驱动 / 排错 / 架构 / 审查 / 交接等），说明为什么推荐它、会怎么做，等我确认后按它执行。",
	"tpl.sk.grilldocs": "需求拷问·落档",
	"tpl.sk.grilldocs.desc": "边盘问需求边记录决策",
	"tpl.sk.grilldocs.prompt":
		"动手前，请用拷问的方式向我盘问这个计划（一次一个问题），直到达成共识。同时把过程中的关键术语和已定决策记录下来（例如写入 CONTEXT.md 或 ADR 文件），让后续所有工作都基于同一套「共享语言」。每个问题先给出你的推荐答案。",
	"tpl.sk.tospec": "转规格说明",
	"tpl.sk.tospec.desc": "把讨论结果整理成规格书",
	"tpl.sk.tospec.prompt":
		"请把我们在对话中已经达成的共识，整理成一份结构化的规格说明书：\n\n1. 背景与目标\n2. 明确的目标与非目标\n3. 用户与使用场景\n4. 边界条件与失败场景\n5. 验收标准（怎样算完成）\n6. 接口 / 数据结构概要\n\n先输出规格让我评审，确认后再继续。",
	"tpl.sk.totickets": "拆工单",
	"tpl.sk.totickets.desc": "把规格拆成可构建的小任务",
	"tpl.sk.totickets.prompt":
		"请把这份规格说明拆成一组小工单，供逐个构建：\n\n1. 每个工单足够小、可独立验收\n2. 标注依赖顺序（哪些必须先做）\n3. 每个工单含：做什么、验收标准、涉及文件\n4. 识别出可并行的工单\n\n先输出工单列表，我确认顺序后再执行。",
	"tpl.sk.implement": "规格落地",
	"tpl.sk.implement.desc": "按规格测试优先实现",
	"tpl.sk.implement.prompt":
		"请按这份规格说明实现，测试优先：\n\n1. 先为每个工单写会失败的测试（覆盖正常、边界、错误分支）\n2. 用最小实现让测试通过\n3. 重构并保持测试通过\n4. 逐工单推进，每完成一个简要汇报\n\n最后对照验收标准逐条确认。",
	"tpl.sk.codeview": "代码审查",
	"tpl.sk.codeview.desc": "对照规格与标准审查 diff",
	"tpl.sk.codeview.prompt":
		"请审查最近改动的 diff：\n\n1. 对照规格说明，实现是否完全覆盖、有无偏差\n2. 正确性：边界、空值、并发与时序\n3. 安全：输入校验、注入、敏感信息\n4. 性能与可读性：是否遵循项目约定\n5. 测试：关键路径是否有覆盖\n\n按严重程度分级列出问题，每条给出具体修改建议。",
	"tpl.sk.wayfinder": "大任务地图",
	"tpl.sk.wayfinder.desc": "把大工程画成决策地图",
	"tpl.sk.wayfinder.prompt":
		"这是一个大型任务。请先把它画成一张「决策地图」：\n\n1. 拆出所有需要做出的决策点及其依赖关系\n2. 为每个决策点列出选项、权衡与你的推荐\n3. 标注哪些可以并行推进、哪些必须串行\n4. 输出一份路径规划，我逐项确认后再动手。",
	"tpl.sk.prototype": "快速原型",
	"tpl.sk.prototype.desc": "用一次性代码验证设计假设",
	"tpl.sk.prototype.prompt":
		"请针对这个设计问题写一个最小原型来验证假设：\n\n1. 只验证关键假设，不做完整实现\n2. 用最简单的方式（可硬编码、可牺牲边界情况）\n3. 运行并告诉我结论：假设成立吗？有哪些权衡？\n4. 验证完的原型可以删除，或等确认后再正式实现。",
	"tpl.sk.research": "有据调研",
	"tpl.sk.research.desc": "读一手来源给出带引用的答案",
	"tpl.sk.research.prompt":
		"请调研这个问题，优先读一手来源（官方文档 / 源码 / 规范）：\n\n1. 给出带来源链接的答案\n2. 明确区分：事实、合理推断、仍不确定\n3. 列出主要选项及其权衡\n4. 避免用二手内容拼凑，找不到就直接说没找到。",
	"tpl.sk.arch": "架构体检",
	"tpl.sk.arch.desc": "找出值得重构的模块（报告）",
	"tpl.sk.arch.prompt":
		"对整个代码库做一次架构体检：\n\n1. 找出「深模块被破坏」的迹象：过长的函数与类、明显的重复、命名混乱、隐藏的耦合\n2. 按严重程度与影响范围分级，输出一份可视化改进报告\n3. 对每一项给出最小可行的重构方案与理由\n4. 先报告再动手，重构前确认范围。",
	"tpl.sk.debug": "系统化排错",
	"tpl.sk.debug.desc": "从可复现的失败开始诊断",
	"tpl.sk.debug.prompt":
		"请系统化诊断这个 bug：\n\n1. 先复现，给出可复现的步骤或输入（没有就先造最小复现）\n2. 二分或排除法缩小范围到具体模块\n3. 提出假设，用日志 / 断言 / 最小样例验证，不凭感觉改\n4. 定位根因后解释，再做最小修复\n5. 补回归测试防止复发。",
	"tpl.sk.merge": "解决合并冲突",
	"tpl.sk.merge.desc": "逐个 hunk 完成合并/变基",
	"tpl.sk.merge.prompt":
		"请帮我解决这个合并 / 变基冲突：\n\n1. 逐个冲突 hunk 处理，先读懂双方各自的意图\n2. 选择或合并出保留正确语义的代码，不盲目取一边\n3. 处理完运行测试与构建确认没问题\n4. 最后总结每处冲突的取舍原因。",
	"tpl.sk.triage": "工单分流",
	"tpl.sk.triage.desc": "把原始 issue 整理成可领取的工作",
	"tpl.sk.triage.prompt":
		"请把这些原始 issue / 反馈整理成可执行的工作项：\n\n1. 去重、合并相关的条目\n2. 分类（bug / 功能 / 改进 / 问题）\n3. 按影响与紧急度标优先级\n4. 每个工作项补上：复现信息或期望、验收标准\n\n输出整理后的清单。",
	"tpl.sk.wizard": "设置向导",
	"tpl.sk.wizard.desc": "生成引导人类完成设置的脚本",
	"tpl.sk.wizard.prompt":
		"请为一个需要手动操作的设置流程生成一个引导向导（脚本或文档）：\n\n1. 一步步引导，每步说明为什么\n2. 每步带校验，输错给出可操作的提示\n3. 支持撤销 / 回退到上一步\n4. 结束时做一次自检并给出验证方法。",
	"tpl.sk.grillme": "需求拷问",
	"tpl.sk.grillme.desc": "动手前盘问对齐想法",
	"tpl.sk.grillme.prompt":
		"开始之前，请不遗余力地盘问我这个想法的每一个方面，直到我们达成共识（一次只问一个问题，每个问题先给推荐答案）：\n\n1. 目标与非目标\n2. 用户与场景\n3. 边界与失败模式\n4. 约束与依赖\n5. 验收标准\n\n达成共识后再给实现计划，等确认再写代码。",
	"tpl.sk.handoff": "交接",
	"tpl.sk.handoff.desc": "把长会话写成交接文档",
	"tpl.sk.handoff.prompt":
		"请把当前会话整理成一份交接文档，让另一个 agent / 同事能无缝继续：\n\n1. 背景与目标\n2. 已完成的工作与关键决策（附原因）\n3. 未完成项与下一步\n4. 已知风险与待确认问题\n5. 如何验证当前状态（命令等）\n\n输出为结构化文档。",
	"tpl.sk.questionnaire": "转问卷",
	"tpl.sk.questionnaire.desc": "把开放问题变成可填问卷",
	"tpl.sk.questionnaire.prompt":
		"请把需要别人提供的信息整理成一份可填写的问卷：\n\n1. 每个问题说明背景和用途\n2. 标注必填 / 选填\n3. 给出示例答案降低理解成本\n4. 分组排序，先简单后复杂\n\n输出一份文档，对方可以照着填。",
	"tpl.sk.teach": "持续学习",
	"tpl.sk.teach.desc": "跨多次会话循序渐进学习",
	"tpl.sk.teach.prompt":
		"请按循序渐进的方式教我：\n\n1. 先定学习路径和目标\n2. 一次只讲一小节，讲完给个小练习\n3. 基于上一节的内容递进，主动提问确认理解\n4. 每节结束总结要点\n\n适合跨多次会话推进。",
	"tpl.sk.ww": "说人话",
	"tpl.sk.ww.desc": "用大白话重讲刚才的解释",
	"tpl.sk.ww.prompt":
		"请把刚才的解释用最简单的语言重新讲一遍：\n\n1. 避免术语，必须用时先给一句话定义\n2. 用类比或具体例子说明\n3. 明确指出哪部分仍是猜测 / 不确定\n4. 用最短的话说完核心意思。",
	"tpl.sk.wfa": "写给 agent 的文档",
	"tpl.sk.wfa.desc": "按 agent 易读的原则写文档",
	"tpl.sk.wfa.prompt":
		"请按「写给 agent 阅读」的原则写这份文档 / 说明：\n\n1. 目标与使用场景写在最前\n2. 指令具体、可验证，避免歧义和空话\n3. 给正反例帮助理解\n4. 结构化：标题、步骤、清单\n5. 标注哪些是硬性要求、哪些是可选。",
	"tpl.sk.codesign": "深模块设计",
	"tpl.sk.codesign.desc": "用深模块原则审查与设计",
	"tpl.sk.codesign.prompt":
		"请用「深模块」设计原则审查 / 设计：\n\n1. 识别模块对外暴露的接口是否比内部实现更简单\n2. 找出把复杂度泄漏到外部的模块\n3. 给出每个模块的职责边界与改进方案\n4. 平衡内聚与复用，避免过度抽象\n\n输出审查结论与重构建议。",
	"tpl.sk.domain": "领域建模",
	"tpl.sk.domain.desc": "打磨项目用词并写下来",
	"tpl.sk.domain.prompt":
		"请帮我梳理这个项目的领域语言：\n\n1. 找出核心术语及当前叫法\n2. 识别同词异义 / 异词同义造成的混乱\n3. 统一推荐用词，写进术语表\n4. 说明每个术语的边界（不是什么）\n\n输出一份领域术语表。",
	"tpl.sk.grilling": "拷问流程",
	"tpl.sk.grilling.desc": "用拷问压测一个计划",
	"tpl.sk.grilling.prompt":
		"请对下面这个计划做压力测试（拷问）：\n\n1. 逐项检查假设：如果它是错的会怎样？\n2. 找漏洞：边界、失败模式、依赖、时序\n3. 质疑决策：为什么这样？有没有更简单的路？\n4. 每次只提出一个最尖锐的问题，等我回答\n\n直到这个计划经得起推敲。",
	"tpl.sk.tdd": "测试驱动",
	"tpl.sk.tdd.desc": "红-绿-重构的规则",
	"tpl.sk.tdd.prompt":
		"请用 TDD（红-绿-重构）完成：\n\n1. 先写会失败的测试，覆盖正常路径、边界与错误分支\n2. 用最小实现让测试通过\n3. 重构并保持测试通过\n\n避免三种反模式：与实现耦合的测试、空洞断言（永远为真）、横向切片（只测表面）。每步汇报并运行测试。",

	/* tool call block */
	error: "出错",
	done: "完成",
	running: "执行中…",
	toolQueued: "排队中",
	copyArgs: "复制参数",
	copyMessage: "复制消息",
	copied: "已复制",
	errorOutput: "错误输出",
	output: "输出",
	waitingOutput: "等待输出…",
	toolDoneWaitingModel: "已结束 · 等模型",
	waitingModel: "等待模型响应…",

	/* thinking block */
	thinkingNow: "思考中",
	thinkingPreview: "思考：{preview}",

	/* terminal panel */
	commands: "命令",
	newCommand: "新建命令",
	newTerminal: "新建终端",
	name: "名称",
	command: "命令",
	cwdHint: "（${pwd} = 当前工作目录）",
	noCommands: "还没有命令，点 + 添加一个",
	clickToRun: "点击运行",
	edit: "编辑",
	delete: "删除",
	confirmQ: "确认?",
	builtinTerminal: "内置终端",
	termEmptySub: "点击左侧命令运行，或点右侧 + 新建终端",
	noTerminal: "暂无终端",
	exited: "（已退出{code}）",
	exitBanner: "[进程已退出，退出码 {code}]",
	closeTerminal: "关闭终端",
	renameTerminal: "重命名终端",
	rerun: "重新读取 .pi/commands.json",
	terminalTitle: "终端 {n}",
	aiBashGroup: "终端接管 bash",
	exampleName: "例如：启动开发服务器",
	exampleCommand: "例如：npm run dev",

	/* source control panel */
	scmTab: "Git",
	scmTitle: "源代码管理",
	scmRefreshTip: "重新查询 Git 状态与差异",
	scmCurrentBranch: "当前分支",
	scmUpstreamGone: "上游已删除",
	scmAheadBehind: "↑{ahead} ↓{behind}",
	scmDetached: "分离 HEAD",
	scmSelectBranch: "选择分支…",
	scmRemoteBranches: "远程分支",
	scmStageTip: "暂存 {path}",
	scmUnstageTip: "取消暂存 {path}",
	scmSwitch: "切换",
	scmSwitchBranch: "切换分支",
	scmSwitchBranchTip: "在终端中执行 git checkout {branch}",
	scmPush: "推送",
	scmPushTip: "在终端中执行 git push",
	scmPull: "拉取",
	scmPullTip: "在终端中执行 git pull",
	scmCommit: "提交",
	scmCommitTip: '在终端中执行 git commit -m "…"（仅提交已暂存的更改）',
	scmCommitAll: "全部提交",
	scmCommitAllTip: '在终端中执行 git add -A && git commit -m "…"（暂存全部更改含未跟踪并提交）',
	scmCommitPlaceholder: "输入提交信息…",
	scmChanges: "更改",
	scmHistory: "提交树",
	scmCommitDetail: "提交详情",
	scmSelectCommitHint: "点击左侧提交查看详情",
	scmNoHistory: "暂无提交记录",
	scmNoChanges: "工作区干净，没有更改",
	scmNotGitRepo: "当前目录不是 Git 仓库",
	scmLoading: "查询中…",
	scmConnecting: "等待连接…",
	scmDiff: "差异",
	scmSelectFileHint: "点击左侧文件查看差异",
	scmNoDiff: "（无差异）",
	scmStaged: "已暂存",
	scmUnstaged: "未暂存",
	scmStagedUnstaged: "已暂存 + 未暂存",
	scmUntracked: "未跟踪",
	scmUntrackedNote: "未跟踪文件：需先用 + 暂存，或使用“全部提交”才会包含",
	scmQueryFailed: "Git 查询失败：{error}",
	scmQueryFailedShort: "查询失败",
	pluginCommandFallback: "插件命令",
	scmTooManyFailures: "Git 查询连续失败，请点击刷新重试",
	scmRunsInTerminal: "提交 / 切换分支 / 推送 / 拉取在终端中执行",
	scmViewTerminal: "去终端",

	/* model config modal */
	editProvider: "编辑服务商",
	builtinProviders: "内置服务商",
	hintKeyOnly: "只需填入 API 密钥",
	configuredBadge: "✓ 已配置",
	keyReady: "密钥已就绪",
	replaceKey: "更换密钥",
	replaceKeyTitle: "替换已保存的密钥",
	clearKey: "清空",
	clearKeyTitle: "清除该服务商保存在 auth.json 的密钥，回到未配置状态（环境变量来源的无法在此清除）",
	clearKeyConfirm: "清空 {id} 已保存的密钥？其模型将从列表消失，直到重新配置。",
	cloneProvider: "添加密钥",
	cloning: "添加中",
	cloneProviderTitle: "为该供应商添加第二把密钥（自动复制 baseUrl 与模型列表，可改名后保存）",
	pasteKey: "粘贴 API 密钥…",
	savingKey: "保存中",
	saveKey: "保存密钥",
	addKey: "添加密钥",
	addKeyPlaceholder: "粘贴密钥值…",
	keyNamePh: "名称（可留空，如 备用）",
	providerIdPlaceholder: "供应商 ID",
	baseUrlExamplePh: "baseUrl 链接，如 https://api.opencode.ai/zen/v1 或 http://127.0.0.1:4096",
	saveAllBatch: "一键保存全部（{n}）",
	netDisconnected: "网络连接已断开，请重连后重试",
	advancedEdit: "高级编辑",
	batchCreateProviders: "批量创建供应商（{n}个接口）",
	secondKeyTitle: "为 {api} · {baseUrl} · {n} 个模型添加第二把密钥，只需指定新供应商名字和密钥即可。",
	noBaseUrlShort: "(无 baseUrl)",
	providerNameLabel: "供应商名字",
	providerNameHint: "（新 ID，如 opencode-2）",
	apiKeyLabel: "API 密钥",
	secondKeyPlaceholder: "sk-… 第二把 key",
	batchDesc:
		"该供应商含多种接口（{apis}），已按接口拆分为 {n} 个自定义供应商，分别保存后才能让所有模型（如 muse-spark）都可用。统一填入第二把 API 密钥后一键保存。",
	batchKeyLabel: "统一 API 密钥（将应用到全部 {n} 个供应商）",
	modelsCountShort: "{n} 个模型：",
	noKeyYet: "尚无密钥，添加一把即可用",
	activateKey: "设为当前",
	removeKey: "移除",
	removeKeyConfirm: "确定移除该密钥？移除后需重新配置才能使用。",
	customProviders: "自定义服务商",
	customDesc: "用于 Ollama / vLLM / 兼容 OpenAI 的代理等，写入 pi 的 models.json，保存后热重载、立即生效。",
	noCustomProviders: "还没有自定义服务商",
	modelsCount: "{n} 个模型",
	addProvider: "新增服务商",
	providerId: "服务商 ID",
	providerIdHint: "（必填，如 ollama / my-proxy）",
	displayName: "显示名",
	displayNamePh: "我的代理",
	apiType: "API 类型",
	baseUrlHint: "（OpenAI 兼容端点）",
	apiKeyHint: "sk-…（可留空，用 auth.json 的密钥）",
	apiKeySaved: "已保存（留空保持不变）",
	authHeader: "自动添加 Authorization 请求头",
	modelsTitle: "模型",
	modelIdReq: "模型 ID（必填）",
	text: "文本",
	textImage: "文本+图片",
	contextWindow: "上下文",
	maxOutput: "最大输出",
	removeModel: "移除模型",
	addModel: "添加模型",
	deleteProviderConfirm: "删除服务商 {id} 及其 {n} 个模型？",
	hideProviderTitle: "删除：从列表移除该内置服务商（已保存的密钥会一并清除，之后可在列表底部恢复）",
	hideProviderConfirm:
		"从列表移除 {name}（{id}）？\n它属于 pi 内置服务商，无法真正卸载，只是不再显示在这里；随时可在列表底部「已删除」里恢复。",
	hideProviderConfirmKeys:
		"从列表移除 {name}（{id}），并删除它已保存的 {n} 把密钥？\n删除密钥后该服务商不再可用；随时可在列表底部「已删除」里恢复显示。",
	hiddenProviders: "已删除 {n} 个内置服务商",
	hiddenExpand: "查看",
	hiddenCollapse: "收起",
	restoreProvider: "恢复",
	restoreProviderTitle: "恢复到内置服务商列表（密钥不会自动恢复）",
	allProvidersHidden: "内置服务商已全部删除（隐藏），可在下方恢复。",
	deleteUnconfigured: "删除未配置的 {n} 个",
	hideUnconfiguredConfirm:
		"从列表移除全部未配置的内置服务商（{n} 个）？\n它们都没有保存密钥，也不会影响环境变量配置过的服务商；随时可在列表底部「已删除」里恢复。",
	fetchModels: "自动获取模型列表",
	fetchModelsHint: "从 baseUrl 的 /models 接口自动拉取模型 ID（服务端请求，不受 CORS 限制）",
	fetchingModels: "获取中…",
	fetchModelsOk: "已获取 {n} 个模型",
	fetchModelsEmpty: "接口未返回任何模型",
	fetchModelsErr: "获取失败：{msg}",
	fetchModelsNeedBaseUrl: "请先填写 baseUrl 再获取",

	/* goal / review */
	goalBarTitle: "目标",
	goalBarPlaceholder: "设定一个目标，agent 完成后自动审查…",
	goalBarSet: "开始",
	goalBarClear: "取消",
	goalBarLocked: "锁定：应用到后续所有回合",
	goalBarUnlocked: "仅本回合（改完自动清除）",
	goalBarReviewModel: "审查模型",
	goalBarUseMainModel: "使用主模型",
	goalBarMaxRounds: "最大轮数",
	goalBarMaxRoundsTip: "最大审查重改轮数；0 或不填 = 不限（持续改到通过）",
	goalBarUnlimitedShort: "不限",

	goalBarReviewing: "审查中…",
	goalBarRound: "第 {n} 轮",
	goalBarActive: "目标生效中",
	goalBarPassed: "已通过",
	goalBarFailed: "未通过",
	goalBarStatusPending: "等待生成…",
	goalWizardBtn: "AI 提炼",
	goalWizardTip: "让 AI 通过问卷调研细化需求，收敛为目标",
	goalWizardRunning: "目标调研中",
	goalWizardAnswer: "回答",
	goalWizardCard: "目标调研",

	/* settings modal */
	settings: "设置",
	settingsTitle: "设置",
	settingsDesc:
		"修改立即生效：系统提示词、技能与插件开关会重建当前会话；审查提示词与审查技能只影响后续目标审查（回复进行中则主会话变更自动延迟）。",
	settingsSystemPrompt: "系统提示词",
	settingsPromptHistory: "输入历史",
	settingsPromptHistoryDesc: "用 ↑↓ 在输入框循环历史提问，全局跨对话共享（localStorage）",
	promptHistoryMax: "最大条数",
	promptHistoryMaxHint: "超过上限时最旧的自动丢弃，可设 1–500",
	promptHistoryCharLimit: "限制单条字数",
	promptHistoryCharLimitHint: "开启后超长输入截断后保存，避免大段粘贴占满存储",
	promptHistoryCharLimitPlaceholder: "最大字数（100–20000）",
	promptHistoryClear: "清空历史",
	promptHistoryClearConfirm: "确认清空？",
	promptHistoryCleared: "已清空输入历史",
	promptHistoryCount: "当前 {n} 条",
	promptHistoryEmpty: "暂无历史记录，上/下键暂无可循环内容",
	settingsPromptMode: "模式",
	promptModeAppend: "追加",
	promptModeReplace: "替换",
	promptAppendHint: "追加模式：自定义内容拼接到默认系统提示词末尾（推荐，保留默认行为约束）。",
	promptReplaceHint:
		"替换模式：只替换内置模板的「灵魂提示词」（人物设定段，如 “You are an expert coding assistant…”）；工具列表、Guidelines、文档指引、项目上下文、技能段等自动拼装段仍由系统每次重新生成，不会被替换。切换后输入框显示原本的灵魂提示词，可直接修改；留空则使用内置默认。",
	promptPlaceholder: "输入自定义系统提示词…（失焦后自动应用）",
	// 组合模板（compose）文案：模板里 {{token}} 展开为对应来源；每来源可单独覆盖。
	promptComposeHint:
		"模板里的 {{token}} 在每次对话时展开为对应「来源」的提示词；未覆盖的来源用自动内容（工具列表/项目上下文/技能等永远用最新数据生成）。",
	promptComposeDesc:
		"组合模板：{{token}} 自由排序/删改/穿插自己的话；空 = 默认模板。下面每个来源可单独覆盖（留空 = 自动内容），也可逐块恢复默认。",
	promptTemplateLabel: "组合模板",
	promptSourcesLabel: "各来源（可单独覆盖）",
	promptInsertTokens: "插入段落：",
	promptResetAll: "恢复默认模板并清空所有覆盖",
	promptResetSource: "恢复默认",
	promptAutoBadge: "自动",
	promptOverridePlaceholder: "输入覆盖内容（留空 = 用自动内容）…",
	promptSourceDefaultEmpty: "（该来源当前无自动内容）",
	promptReadonlyBadge: "系统自动生成（只读）",
	promptReadonlyLockedBadge: "自定义覆盖（只读·锁定）",
	promptReadonlyLockedHint: "该来源由系统自动生成，只读；此覆盖不会被设置面板编辑，服务端仍按原样生效。",
	promptReadonlyTitle: "系统自动生成的来源，仅只读展示，不可编辑",
	promptSourceDefaultEditHint: "该来源当前的默认（自动）内容 —— 点击可直接输入覆盖文字",
	promptSourceExpand: "展开全文",
	promptSourceCollapse: "收起",
	promptSourceRefLabel: "默认（自动）内容（可对照 / 复制）",
	promptSourceSeedButton: "填入默认内容，只改一小部分",
	promptSourceSeedTip:
		"把该来源当前的默认内容复制进覆盖框：只想改一小部分时直接改这里。填入后此来源内容固定，不再随每次对话自动重新生成。",
	promptTok_soul: "灵魂提示词",
	promptTok_soul_desc: "agent 人物设定（无 SYSTEM.md 时内置默认）",
	promptTok_tools: "工具列表",
	promptTok_tools_desc: "Available tools（各工具说明，每次自动生成）",
	promptTok_guidelines: "行为准则",
	promptTok_guidelines_desc: "Guidelines：各工具引导 + 通用规则",
	promptTok_pi_docs: "Pi 文档指引",
	promptTok_pi_docs_desc: "指向 pi 包文档的提示段",
	promptTok_append: "追加段",
	promptTok_append_desc: "APPEND_SYSTEM.md 内容；覆盖 = 自定义追加文字",
	promptTok_persona: "Windows 约束",
	promptTok_persona_desc: "Windows persona（仅 win32；超时/PTY/GBK 注意事项）",
	promptTok_terminal: "终端工具引导",
	promptTok_terminal_desc: "持久终端使用引导（「终端工具」开时注入）",
	promptTok_markers: "标记工具引导",
	promptTok_markers_desc: "内置标记工具使用说明（markers 开时注入）",
	promptTok_context: "项目上下文",
	promptTok_context_desc: "<project_context>：AGENTS.md/CLAUDE.md 收集结果",
	promptTok_skills: "技能段",
	promptTok_skills_desc: "<available_skills>：可用技能清单",
	promptTok_cwd: "工作目录行",
	promptTok_cwd_desc: "Current working directory 行",
	settingsViewPrompt: "查看当前完整提示词",
	settingsViewPromptHint:
		"当前会话实际生效的完整系统提示词（含自定义追加/替换内容、项目上下文、技能说明与工具引导），只读。",
	settingsViewPromptEmpty: "会话尚未就绪，暂无系统提示词。",
	settingsViewToolsSchema: "工具 schema",
	settingsViewToolsSchemaHint:
		"发给模型的 function-calling 工具定义（name / description / parameters），与系统提示词正文拼成完整初始上下文，只读。",
	settingsViewToolsSchemaEmpty: "会话尚未就绪，暂无工具 schema。",
	settingsSkills: "技能",
	settingsSkillCountLegend: "已启用 / 已安装",
	settingsSkillDisabledHint: "关闭的技能保留在列表中，但不加入后续模型请求的技能目录；需要时可在这里开启。",
	settingsReview: "目标审查",
	settingsReviewDesc: "为独立的目标审查会话配置额外提示词和技能；不会改变主会话设置。",
	settingsReviewSkills: "审查可用技能",
	reviewPromptPlaceholder: "输入审查自定义提示词…（失焦后自动应用）",
	reviewPromptHint: "这些内容会追加到审查任务中；审查仍会强制要求输出 pass/fail JSON。技能开关仅对审查生效。",
	goalModeEnabled: "启用目标模式",
	goalModeEnabledDesc:
		"目标条 / 目标调研向导 / 审查循环的总开关（默认开）。关闭后目标条隐藏，无法设置目标、启动调研或触发审查。",
	goalModeOffHint: "目标模式已关闭：目标条已隐藏，已有的目标将不再触发审查。",
	settingsVisionBridge: "视觉桥",
	settingsVisionBridgeDesc: "当前模型不支持识图时，把图片交给已配置的视觉模型转写为文字证据，再让模型回答",
	visionBridgeEnabled: "启用视觉桥",
	visionBridgeModel: "转写模型",
	visionBridgeAuto: "自动选择（按顺序）",
	visionBridgeNoModels:
		"未找到已配置的视觉模型：在模型配置里添加任意支持图片的模型（如 qwen-vl、GLM-4V、Gemini）即可自动启用",
	visionBridgeOffHint: "已关闭：图片将原样发送，纯文本模型可能看不到图片内容",
	visionBridgeCurrent: "当前转写模型：{model}",
	visionBridgePromptMode: "转写提示词",
	settingsMarkers: "标记工具",
	settingsMarkersDesc:
		"让 AI 用 [[todo:...]] / [[notify:...]] / [[conv:rename:...]] 内联标记在正文里改状态，无需工具往返。全局关闭则全部停用；分组开关可细粒度控制。",
	markersEnabled: "启用标记工具（全局）",
	markersEnabledDesc: "关闭后 AI 不再收到任何标记引导，解析也跳过（所有标记原文原样保留，不执行）。",
	markersOffHint: "已全局关闭：所有标记停用，AI 不会写标记，也不会触发任务/重命名等副作用。",
	markerGroupTodo: "任务标记 todo",
	markerGroupNotify: "提醒标记 notify",
	markerGroupRename: "重命名标记 conv/rename",
	markerRenameTip: "[[conv:rename:新标题]] 重命名当前对话（标题 ≤80 字；在回复第一条消息末尾根据情况重命名）",
	settingsTerminalTools: "终端工具",
	terminalToolsEnabled: "启用持久终端工具",
	settingsTerminalToolsDesc:
		"让 AI 在交互式程序（REPL/vim）、长驻服务、需要持续观察输出或你要求在可见终端操作时，使用内置终端；普通命令仍走一次性 bash 工具",
	terminalToolsOffHint: "已关闭：AI 无法使用 terminal_* 工具，也不会收到相关使用引导",
	settingsEditTools: "编辑工具",
	editSoftEnabled: "启用编辑工具 edit_soft",
	editSoftEnabledDesc:
		"让 AI 用一个独立、不严格要求缩进的编辑工具：当你的 oldText 与文件缩进/空白不一致（如 JS/JSON）时可避免因缩进差异导致编辑失败。命中后按你给出的 newText 原样写入（缩进即最终缩进）。",
	editSoftOffHint: "已关闭：AI 无法使用 edit_soft 工具，也不会收到相关使用引导",
	settingsQuestionnaire: "问卷提问",
	questionnaireEnabled: "允许模型向我提问（问卷）",
	questionnaireEnabledDesc:
		"开启默认值：模型可用 ask_user_question 弹出可回复的问卷/提问对话框（含选项、多选、自定义输入）。关闭后模型将不再弹出问卷，调用也会直接返回已禁用。",
	questionnaireOffHint: "已关闭：模型不能再向你弹出问卷/提问对话框",
	settingsMessageDisplay: "对话",
	thinkingWrap: "完整显示思考",
	thinkingWrapDesc:
		"开启：思考内容始终完整展开并自动换行（流式推理过程也实时可见）；关闭：折叠成一行摘要，流式中一行实时显示最新文本",
	toolsWrap: "完整显示工具",
	toolsWrapDesc: "开启：工具调用始终完整展开显示参数和输出；关闭：默认折叠，点击展开",
	wideChat: "宽屏聊天列",
	wideChatDesc: "开启：中央列铺满宽度（超宽屏有用）；关闭：保持 860px 上限",
	projectTitle: "标题显示项目名",
	projectTitleDesc:
		"开启：浏览器标签页标题为「项目目录名 — pi-web-ui」，切项目即时更新（多标签页开多个项目时好区分）；关闭：固定显示应用名",
	terminalBashTakeover: "终端接管 bash",
	terminalBashTakeoverDesc:
		"此开关决定 bash 是否覆盖为终端版：关 = 原生 SDK bash（纯进程、不开终端）；开 = 跑进可见终端，且 persist 参数在本开关的基础上决定一次性（false，命令跑完进程退出、输出留档）还是持久（true，shell 状态跨调用保留、静默自动转后台并通知 AI）",
	terminalBashIdleMs: "静默转后台阈值（毫秒）",
	terminalBashIdleMsDesc:
		"持久终端模式下，命令连续无输出达到该时长即不再阻塞等待，转入后台继续运行并通知 AI；0 = 一直等到命令结束（默认 15000）",
	visionBridgePromptPlaceholder: "输入自定义转写提示词…（留空 = 使用内置默认提示词，失焦后自动应用）",
	visionBridgePromptAppendHint: "追加模式：自定义内容拼接到内置转写提示词末尾（推荐，保留默认的逐字转写约束）。",
	visionBridgePromptReplaceHint:
		"替换模式：完全用自定义内容替换内置转写提示词。切换后输入框会显示内置默认提示词，可直接修改；不改动失焦则仍使用默认。",
	uninstallExt: "卸载",
	uninstallConfirm: "确认卸载？",
	uninstallConfirmHint: "再次点击确认，将在终端执行 pi remove",
	uninstallHint: "通过可见终端执行 pi remove 卸载此包，完成后自动刷新列表",
	uninstallTitle: "卸载",
	pluginUpdate: "更新",
	pluginUpdateHint: "从安装来源重新拉取并覆盖安装（保留 config.json 配置），完成后自动重载插件列表",
	pluginMarket: "插件市场",
	updatesManaged: "本实例由部署方管理：更新与插件安装不在此进行",
	pluginCatalogAdd: "添加插件",
	pluginCatalogAddHint: "把第三方插件填进可安装列表（owner/repo 或完整 GitHub 地址）",
	pluginCatalogSource: "来源 owner/repo 或 owner/repo/子目录（必填）",
	pluginCatalogId: "id（可选，默认取仓库/子目录名）",
	pluginCatalogName: "名称（可选）",
	pluginCatalogIcon: "图标 emoji（可选）",
	pluginCatalogDesc: "简介（可选）",
	pluginCatalogAddSubmit: "添加到列表",
	noPluginCatalog: "列表为空 —— 点「添加插件」把第三方插件填进列表",
	pluginInstalled: "已安装",
	pluginCatalogCustom: "自定义",
	pluginInstall: "安装",
	pluginInstallHint: "从来源直接安装到界面插件（在可见终端执行）",
	pluginCatalogRemoveHint: "从列表移除这条自定义插件",
	pluginUninstallHint: "在可见终端执行 pi-web-ui uninstall 卸载此插件（再次点击确认），完成后自动刷新列表",
	settingsExtensions: "插件",
	settingsUiPlugins: "界面插件",
	noUiPlugins: "未安装界面组件（<dataDir>/plugins/）",
	dshPatches: "DSH 用户补丁",
	dshPatchesDesc:
		"启动时按文件名序加载的 Cordis patch（<dataDir>/dsh-patches/*.yml）。新增/修改后点「重扫」重启运行时生效；失败的文件会被跳过并打印到运行时 stderr。",
	dshPatchesRescan: "重扫",
	dshPatchesRescanHint: "重新扫描补丁目录并重启 DSH 运行时使新补丁生效",
	dshPatchesEmpty: "未放置补丁文件",
	dshPatchesPath: "补丁目录：",
	uiPluginNoSource: "手工安装，无来源信息，无法在线更新",
	uiPluginPerms: "能力声明",
	pluginSettingsSave: "保存插件设置",
	pluginSettingsSaving: "保存中…",
	pluginSettingsReset: "恢复默认",
	settingsPresets: "预设",
	settingsSubagentTemplates: "子代理模板",
	settingsSubagentTemplatesDesc:
		"配置子代理预设（角色系统提示词 + 技能/扩展白名单 + 可选模型）。AI 派生子代理时可选用模板（subagent_spawn 的 template 参数），也可不传按默认运行；停用的模板保留在面板但对 AI 不可见。",
	noSubagentTemplates:
		"还没有子代理模板。AI 派生子代理时可选用模板（角色提示词 + 技能/扩展白名单 + 可选模型），也可以不传 template 按默认配置运行。",
	subagentTemplateNew: "新建模板",
	subagentTemplateEdit: "编辑",
	subagentTemplateClosed: "已停用",
	tplDefaultBadge: "默认",
	subagentTemplateOffHint: "关闭的模板保留在面板、可随时重新启用，但 AI 工具查询不到、不能选择",
	subagentTemplateEnable: "启用",
	subagentTemplateDisable: "停用",
	subagentDefaultModelLabel: "子代理默认模型",
	subagentFollowMain: "跟随主对话当前模型",
	subagentDefaultModelHint:
		"所有子代理的兜底模型（模板里指定的模型和 subagent_spawn 的 model 参数优先级更高）；不改主对话模型。",
	subagentNoModels: "暂无可用的模型（需要先配置服务商 API Key）——子代理将跟随主对话模型。",
	tplNamePlaceholder: "模板名（AI 用 subagent_spawn 的 template 参数引用）…",
	tplDescriptionPlaceholder: "简介（AI 据此判断适用场景）…",
	tplDescriptionEnPlaceholder: "英文简介（英文 UI 时 AI 看这个，留空则用中文简介）…",
	tplPromptModeLabel: "系统提示词模式",
	tplModelLabel: "模型（空 = 跟随主对话）",
	tplSystemPromptLabel: "系统提示词",
	tplSystemPromptPlaceholder: "模板角色系统提示词…（append 模式可留空）",
	tplSystemPromptEnPlaceholder: "英文系统提示词…（英文 UI 时生效，留空则用中文）",
	tplWhitelistHint: "白名单：勾选 = 子代理只启用这些；全部不勾 = 跟随主会话设置",
	tplSkillsLabel: "技能白名单",
	tplExtensionsLabel: "扩展白名单",
	tplSave: "保存模板",
	tplCancel: "取消编辑",
	tplDelete: "删除模板",
	tplInherit: "跟随主会话",
	settingsEnabled: "已启用",
	settingsDisabled: "已禁用",
	presetNamePlaceholder: "预设名称…",
	saveAsPreset: "保存为预设",
	applyPreset: "应用",
	deletePreset: "删除预设",
	noSkills: "暂无技能",
	noExtensions: "暂无插件",
	noPresets: "暂无预设（先调整上面的设置，再保存为预设组合）",

	/* app */
	loadingSession: "正在加载会话…",
	loadEarlierMessages: "载入更早的消息（还有 {n} 条）",
	connectingServer: "正在连接 pi-web-ui 服务器…",

	/* 语言包（下载） */
	localePacks: "语言包",
	localeGetMore: "获取更多语言",
	localeInstalled: "已安装",
	localeInstall: "下载",
	localeRemove: "移除",
	localeDownloading: "下载中…",
	localeRemoving: "移除中…",
	localeInstallFailed: "下载失败：{error}",
	localeListFailed: "获取语言包列表失败：{error}",
	localeRemoveHint: "移除后随时可重新下载",

	/* 聊天背景图（壁纸，issue #100） */
	wallpaperTitle: "聊天背景图",
	wallpaperDesc:
		"给整个窗口加一张背景图（左右面板、顶栏、底栏也会透出）：主题自带的图会自动生效，在此填地址则优先用你的；用压暗与模糊保证文字清晰。",
	wallpaperUrlPh: "图片地址（https://…，留空关闭）",
	wallpaperDim: "压暗",
	wallpaperBlur: "模糊",
	wallpaperClear: "清除",
	wallpaperUpload: "上传图片",
	wallpaperUploadFailed: "图片读取失败或过大，请换一张试试",

	/* DEV-CON channels（渠道选择 / 待生效 / 用量归属 / 渠道设置） */
	channelSelect: "选择渠道",
	channelUnbound: "未绑定渠道",
	channelKeyLabel: "凭据",
	channelFollowActiveKey: "跟随服务商当前密钥",
	channelProviderMissing: "服务商未注册",
	channelKeyMissing: "引用的命名凭据已不存在",
	channelDisabled: "渠道已禁用",
	channelNoModels: "该渠道暂无可用模型",
	channelPendingBadge: "待生效",
	channelPendingTip: "已受理，本轮结束后应用（当前请求/工具不受影响）",
	channelEffectiveTip: "当前有效渠道选择：{sel}",
	channelSourceProject: "项目默认",
	channelSourceInstance: "实例默认",
	channelSourceConversation: "对话绑定",
	channelConflict: "渠道配置已被其他端修改，请刷新",
	channelRejected: "渠道切换被拒绝",
	channelRefresh: "刷新渠道状态",
	channelFooter: "渠道",
	channelFooterTip: "当前对话的有效渠道绑定：{sel}",
	channelUnattributed: "未归属",
	// 用量来源标签（§7：来源要能被用户读懂，而不是直接显示英文标识符）。
	usageSourceUser: "用户请求",
	usageSourceRetry: "自动重试",
	usageSourceSubagent: "子代理",
	usageSourceCompaction: "压缩摘要",
	usageSourceVision: "视觉桥",
	usageSourceReview: "目标复核",
	usageSourceWizard: "目标向导",
	usageSourceProbe: "探测",
	usageSourceSystem: "系统",
	// §7 逐请求记录与计价依据（历史缺失归属要诚实说明，未知价格不显示为 0）。
	usageRecentTitle: "最近请求",
	usageColTime: "时间",
	usageCostBasisNote: "估算费用 = SDK 按请求当时模型价目表计算的 USD 金额（非供应商扣费）",
	usageCostBasisTip: "该请求未带价目信息，未知价格按空展示而不是 0",
	usageUnknownPrice: "未知价格",
	usageUnreported: "未报告用量",
	usageHistoryUnreported: "（{n} 条未报告用量）",
	usageHistoryUnattributed: "这些历史用量没有渠道归属（记录早于渠道功能或来自无渠道的运行）",
	usageHistoryTip: "归属随请求记录；缺失时不会用今天的配置推断过去。",
	// P4 首个切片：跨渠道/项目/时间用量历史（只读聚合）。
	usageHistoryTitle: "用量历史（跨渠道 / 项目 / 时间）",
	usageHistoryLoading: "正在读取用量历史…",
	usageHistoryUnavailable: "用量历史不可用",
	usageHistoryEmpty: "该时间窗内没有记录",
	usageHistoryTotals: "合计",
	usageHistoryUnpriced: "（{n} 条未知价格）",
	usageHistoryWindowNote: "按 UTC 切分时间窗；金额为估算（非供应商扣费），未知价格不计入费用",
	usageHistoryTruncated: "记录过多，结果不完整",
	usageHistorySkipped: "跳过 {n} 条损坏记录",
	usageGroup_channel: "按渠道",
	usageGroup_project: "按项目",
	usageGroup_model: "按模型",
	usageGroup_source: "按来源",
	usageGroup_day: "按天",
	usageWindow_today: "今天",
	usageWindow_7d: "7 天",
	usageWindow_30d: "30 天",
	usageWindow_all: "全部",
	// P4 候选：系统资源（只读；读不到显示「—」并标出来源）。
	resourcesTitle: "系统资源",
	// 模型路由规则（设置面板可改；出厂默认见 server/model-routing.ts / docs/MODEL-ROUTING.md）
	modelRoutingTitle: "模型路由规则",
	modelRoutingHint: "官方随时会上/下线路由；这份名册不必改代码或重新发版就能修正。",
	modelRoutingDesc:
		"列在这里的路由不再出现在模型选择器里（历史会话与已绑定渠道仍能解析）。每行一个 id：`provider/id` 只匹配该服务商，裸 id 匹配所有服务商；别名写成「旧id=新id」。模型本身的名字/上下文/价格/思考档位请在「管理模型」里改（写入 agent/models.json）。",
	modelRoutingRetiredLabel: "退役路由（每行一个 id）",
	modelRoutingAliasesLabel: "路由别名（每行 旧id=新id）",
	modelRoutingSave: "保存规则",
	modelRoutingReset: "恢复出厂默认",
	modelRoutingCustomized: "当前：自定义规则",
	modelRoutingFactory: "当前：出厂默认",
	resourcesLoading: "正在采集…",
	resourcesSampling: "采样中…",
	resourcesCpu: "CPU",
	resourcesCores: "{n} 核",
	resourcesMem: "内存",
	resourcesApp: "本应用",
	resourcesHost: "主机",
	resourcesDisks: "磁盘",
	resourcesAvailable: "可用 {v}",
	resourcesHeap: "堆 {used} / {total}",
	resourcesCgroup: "unit 内存 {current} / 上限 {max}",
	resourcesCgroupUnavailable: "unit 内存限制不可读",
	resourcesNoLimit: "无上限",
	resourcesNoDisks: "没有可读的磁盘",
	resourcesFree: "可用 {v}",
	resourcesUptime: "运行 {v}",
	resourcesSampledAt: "采样于 {at}",
	resourcesSourceCpu: "来源：{src}",
	resourcesSourceMem: "来源：{src}",
	resourcesSourceCgroup: "来源：{src}",
	resourcesDiskNote: "来源：{src}（用量 = 总量 − 非特权可用，属估算）",
	settingsSystem: "系统",
	// P4 运维：存储占用明细与用量历史保留（只读遍历；删除动作仍在服务器上人工执行）。
	storageTitle: "存储占用（实例私有数据）",
	storageUnavailable: "存储明细不可用",
	storageArea: "区域",
	storageSize: "占用",
	storageFiles: "文件数",
	storageNote: "说明",
	storageTruncated: "（已达遍历上限，数字不完整）",
	storageNoteUploads: "上传缓存，可清理候选",
	storageNoteHistory: "用量历史，可清理候选（或调小保留天数）",
	storageNoteUserData: "用户数据，不建议清理",
	storageRefresh: "重算存储占用",
	storageRetention: "用量历史保留：",
	storageRetentionOff: "只按大小轮转",
	storageRetentionDays: "保留 {n} 天",
	storageRetentionNote: "当前历史文件 {size}；超期记录在下次写入时清理",
	// P4 运维：诊断包与资源告警（诊断包只含元数据）。
	diagnosticsTitle: "运维诊断",
	diagnosticsGenerate: "生成诊断快照",
	diagnosticsDownload: "下载 JSON",
	diagnosticsUnavailable: "诊断不可用",
	diagnosticsSummary: "提交 {commit} · 协议 v{protocol} · 引擎 {engine} · {units}",
	diagnosticsPrivacy: "诊断包只含元数据（版本/路径/单位状态/资源与用量汇总量）；不含密钥值、会话内容、提示词或日志正文。",
	diagnosticsAlertsOn: "资源告警：已开启",
	diagnosticsAlertsOff: "资源告警：已关闭",
	channelUnknownTip: "该渠道当前不在渠道列表中（可能已删除／改名）；按记录的原渠道 id 展示，不猜测名称",
	usageDetail: "用量详情",
	usageDetailTip: "展开请求/本轮/会话用量与按来源渠道的归属明细",
	usageScopeRequest: "请求",
	usageScopeRun: "本轮",
	usageScopeSession: "会话",
	usageCacheRead: "缓存读",
	usageCacheWrite: "缓存写",
	usageCost: "估算费用",
	usageCostNote: "费用为按当时计价规则的估算，未知价格不计费",
	usageRunId: "运行标识",
	usageAttribution: "按来源 / 渠道",
	usageAttributionEmpty: "暂无按渠道归属的用量记录",
	usageColSource: "来源",
	usageColChannel: "渠道",
	usageColModel: "模型",
	usageColRequests: "请求数",
	usageColInput: "输入",
	usageColOutput: "输出",
	usageColTotal: "合计",
	usageColCost: "费用",
	settingsChannels: "渠道",
	settingsChannelsDesc:
		"渠道 = 服务商 + 协议端点 + 命名凭据 + 账户引用的具名档案；在编码界面用它一次选定渠道/凭据/模型，密钥只在服务端解析。",
	channelListEmpty: "尚未配置渠道（没有渠道时模型下拉保持原样）",
	channelAdd: "新增渠道",
	channelEdit: "编辑",
	channelEditTitle: "编辑渠道",
	channelDisplayName: "显示名",
	channelDisplayNamePh: "例如：主力网关 / 备用 Claude",
	channelProvider: "服务商",
	channelProviderPh: "选择已注册的服务商",
	channelEndpoint: "协议端点",
	channelEndpointPh: "默认 default",
	channelCredentialKey: "命名凭据",
	channelAccountRef: "账户引用",
	channelAccountRefPh: "账户接口的键（留空则用渠道 id）",
	channelAccountKind: "账户接口类型",
	channelAccountKindPh: "例如 openai-gateway / openrouter",
	channelAccountUrl: "账户接口地址",
	channelAccountUnit: "单位",
	channelAccountCredential: "Account credential (optional)",
	channelAccountCredentialPh: "Key name of a separate API key (e.g. OpenRouter provisioning key); blank = the channel's model credential",
	channelAccountScale: "额度换算比例",
	channelAccountScalePh: "默认 1",
	channelAccountHint: "账户接口仅用于余额/配额查询（有界超时、限频）；留空 = 不查询并明确显示「不支持」。",
	channelUrlInvalid: "账户接口地址需为 http(s) URL",
	channelScaleInvalid: "额度换算比例需为正数",
	channelEnabledLabel: "启用渠道",
	channelQueryAccount: "查询账户",
	channelQuerying: "查询中…",
	channelAccountUnsupported: "不支持查询",
	channelAccountOk: "正常",
	channelAccountFailed: "查询失败",
	channelAccountStale: "已过期",
	channelAccountStaleTip: "本次查询失败，以下是上次成功结果（时间是上次成功时间）",
	channelAccountGranted: "赠送",
	channelAccountToppedUp: "充值",
	channelAccountCheckedAt: "查询时间",
	channelAccountBalance: "余额",
	channelAccountQuota: "配额",
	channelAccountKeyQuota: "Used",
	channelInstanceDefault: "实例默认",
	channelProjectDefault: "本项目默认",
	channelDefaultNone: "未设置",
	channelDefaultChannel: "渠道",
	channelDefaultModel: "模型",
	channelSetDefault: "设为默认",
	channelClearDefault: "清除默认",
	channelDefaultsHint: "默认只被尚未发言的对话继承，不会重绑正在运行的对话。",
	channelDeleteConfirm: "删除渠道「{name}」？引用它的默认值与对话绑定会被清理。",
	// 渠道：模型白名单（channel.models，空数组 = 不限）
	channelModels: "模型白名单",
	channelModelsUnrestricted: "不限（列出该服务商全部模型）",
	channelModelsLimited: "限定 {n} 个模型",
	channelModelsSearchPh: "搜索模型 id 或名称",
	channelModelsSelectAll: "全选",
	channelModelsClear: "清空",
	channelModelsSelected: "已选 {n} 个",
	channelModelsNoMatch: "没有匹配的模型",
	channelModelsUnknown: "（不在当前模型列表中）",
	channelModelsHint: "勾选后该渠道只出现选中的模型；一个都不勾 = 不限。按服务商内部 id 保存（如 deepseek-flash）。",
	channelModelsFetch: "获取接口清单",
	channelModelsFetchTip: "按该服务商的 baseUrl 请求 /models，把接口返回的模型并入下方候选（服务端请求，密钥不出服务端）",
	channelModelsFetching: "获取中…",
	channelModelsFetched: "已从 {baseUrl} 获取 {n} 个模型",
	channelModelsFetchFailed: "获取失败：{msg}",
	channelModelsFromApi: "接口",
	channelModelsNoProvider: "该服务商还没有可选模型（先在模型配置里添加）。",
	channelId: "渠道 id",
	channelIdPh: "留空自动生成",
	channelIdLocked: "渠道 id 是绑定键，创建后不可修改（改名请用显示名）。",
	channelIdInvalid: "渠道 id 需为 2–48 位小写字母/数字/连字符",
	// 渠道：账户查询模板（预设一键填充 + 自定义接口与字段映射）
	channelAccountMode: "查询方式",
	channelAccountModeNone: "不查询（界面显示「不支持」）",
	channelAccountModeTemplate: "模板（自定义接口与字段映射）",
	channelAccountModeLegacy: "内置适配器（兼容旧配置）",
	channelAccountPreset: "预设",
	channelAccountPresetPh: "选择预设一键填充",
	channelAccountMethod: "请求方法",
	channelAccountHeader: "鉴权头名",
	channelAccountHeaderPh: "authorization",
	channelAccountPrefix: "鉴权前缀",
	channelAccountPrefixPh: "如 Bearer （留空 = 不加前缀）",
	channelAccountBody: "请求体（JSON，POST 用）",
	channelAccountMapping: "字段映射（JSON）",
	channelAccountItems: "多币种数组映射（JSON）",
	channelAccountJsonPh: "留空 = 不映射",
	channelItemsPathRequired: "多币种数组映射必须给出 path（指向数组的 JSON 路径）",
	channelAccountPlaceholders: "地址与请求体支持 {baseUrl}（服务商地址）与 {apiKey} 占位符；JSON 路径支持 a.b[0].c。",
	channelAccountTemplateHint: "模板只用于余额/配额查询（有界超时、限频、失败保留上次结果）；测试不写配置——先保存，再用行内「查询账户」验证。",
	channelAccountUrlRequired: "模板方式必须填写接口地址（URL）",
	channelTemplateOverwrite: "服务端只回显地址/单位/换算/凭据名，不含已存的字段映射：一旦改动账户配置，将按当前表单整体覆盖。",
	channelJsonInvalid: "{field} 不是合法 JSON：{err}",
	channelJsonNotObject: "{field} 需要是 JSON 对象",
	// 渠道：命令回执与按渠道用量
	channelOpSave: "保存渠道",
	channelOpDelete: "删除渠道",
	channelOpToggle: "切换启用状态",
	channelOpDefault: "设置默认",
	channelCommandOk: "已生效",
	channelUsageTitle: "按渠道用量",
	channelUsageLastUsed: "最近使用",
	channelUsageNoRecords: "该时间窗内没有记录",
	channelConnTitle: "服务商连接",
	channelConnModeNew: "新建服务商",
	channelConnModeExisting: "使用已有服务商",
	channelConnHint: "Claude 系模型走 anthropic-messages（地址填站点根，不要带 /v1）；GPT/Codex 系走 openai-completions 或 openai-responses（地址通常要带 /v1）。",
	channelConnProviderId: "服务商 ID（留空自动生成）",
	channelConnBaseUrl: "请求地址",
	channelConnApi: "协议",
	channelConnApiKey: "密钥",
	channelConnApiKeyKeep: "留空 = 保留已存密钥",
	channelConnApiKeyNew: "必填",
	channelConnAuthHeader: "额外发送 Authorization: Bearer（只认该头的网关需要）",
	channelConnUpdate: "同时更新该服务商的连接",
	channelConnModelsHint: "勾选的模型写入服务商清单，同时作为本渠道的可用模型。",
	channelConnNeedsModels: "新建服务商至少需要一个模型：先「获取接口清单」或手动添加一个 ID。",
	channelModelsAdd: "添加",
	channelModelsAddPh: "手动填模型 ID（如 claude-opus-5）",
	customManagedInChannels: "在「设置 → 渠道」管理",
	customAddInChannels: "新建/修改服务商请到「设置 → 渠道 → 新增渠道 → 服务商连接」：那里会把请求地址、协议、密钥与模型一并写入。",
	channelAccountModeGateway: "网关适配器（one-api / new-api，失败自动退回账单接口）",
	channelAccountUsed: "已用",
	channelBalanceDerived: "(matched from the current model)",
	channelAccountUnknownBalance: "余额未知",
	channelAccountDetailTitle: "渠道账户",
	channelTopUp: "去充值",
	channelAccountTopupUrl: "充值链接（可选）",
	channelAccountTopupUrlPh: "如 {baseUrl}/console/topup",
	channelAccountTopupHint: "显示在「用量详情」标题右侧，点开余额即可直达充值页。",
	channelAccountAutoRefresh: "每 2 分钟自动更新",
	channelAccountRetry: "重试",
	channelAccountRetryHint: "连续 3 次获取失败后已停止自动更新；点「重试」会重新开始自动刷新。",
} as const;

/* ------------------------------------------------------------------ */
/* en                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 英文词典按需加载（见 i18n-en.ts 的 @WHY）。未加载时 `t` 回落中文，绝不崩：
 * 首屏一旦判定语言为 en 就在模块作用域并行预取（与 App chunk 同时下），
 * LanguageProvider 只等它一次，中文用户则永不下载。
 */
let enDict: EnDictionary | undefined;
/** 加载英文词典（幂等）。导出给测试与 main 的提前预取使用。 */
export async function loadEnglish(): Promise<void> {
	if (!enDict) enDict = (await import("./i18n-en")).en;
}
/** 英文是否已就绪（LanguageProvider 用它决定要不要先等）。 */
export function englishReady(): boolean {
	return enDict !== undefined;
}


/* ------------------------------------------------------------------ */
/* context + hook                                                      */
/* ------------------------------------------------------------------ */

export type Translate = (key: keyof typeof zh, vars?: Record<string, string | number>) => string;

/* ------------------------------------------------------------------ */
/* language packs — downloadable, never bundled                          */
/* ------------------------------------------------------------------ */

/** A language pack: translated strings keyed like `zh`, plus display metadata. */
export interface LocalePack {
	code: string;
	/** Shown verbatim in the switcher (never translated). */
	nativeName: string;
	strings: Record<string, string>;
}

export interface LocalePackStatus {
	code: string;
	nativeName: string;
	installed: boolean;
	version: string | null;
}

/** Core locales ship with the bundle (always available, synchronous). */
export const CORE_LOCALES: { code: string; nativeName: string }[] = [
	{ code: "zh", nativeName: "中文" },
	{ code: "en", nativeName: "English" },
];

/** Module-level registry for downloaded packs (populated async at boot). */
const PACK_REGISTRY: Record<string, LocalePack> = {};

/**
 * Register a language pack (downloaded via /api/locales, or third-party).
 * zh/en are built in and rejected here. Returns true when accepted.
 */
export function registerLocale(pack: LocalePack): boolean {
	if (!pack || typeof pack.code !== "string" || !pack.code) return false;
	if (pack.code === "zh" || pack.code === "en") return false;
	if (!pack.strings || typeof pack.strings !== "object") return false;
	PACK_REGISTRY[pack.code] = pack;
	return true;
}

/** Drop a pack from the registry (after DELETE /api/locales/:code). */
export function unregisterLocale(code: string): void {
	delete PACK_REGISTRY[code];
}

/** Short chip label for the topbar (native for zh, uppercase code otherwise). */
export function localeShort(code: string): string {
	return code === "zh" ? "中文" : code.toUpperCase();
}

/** html lang attribute for a locale code. */
function htmlLang(code: string): string {
	if (code === "zh") return "zh-CN";
	if (code === "pt") return "pt-BR";
	return code;
}

async function fetchPackJson<T>(url: string): Promise<T> {
	const res = await fetch(withToken(appUrl(url)));
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return (await res.json()) as T;
}

interface I18nContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: Translate;
	/** Core + registered downloadable packs (native names, never translated). */
	packs: { code: string; nativeName: string }[];
	/** Re-read installed packs from the server (after install/remove).
	 *  Returns the instance default (PI_WEB_LOCALE) when the server names one. */
	reloadPacks: () => Promise<string | null>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** What the previous visit stored, if anything. */
function savedLocale(): string | null {
	try {
		// zh/en always exist; other codes are validated once packs finish loading.
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null; // localStorage unavailable
	}
}

/**
 * The language to start with.
 *
 * This used to be "zh" flat, so a first visit spoke Chinese whatever the
 * browser asked for — and the eight translation packs in this repository were
 * never chosen by anything. Now the browser decides; the instance default
 * (PI_WEB_LOCALE) arrives with the pack list a moment later and only applies
 * if the browser named nothing we speak. See web/src/pick-locale.ts.
 */
function loadLocale(): Locale {
	return pickLocale(savedLocale(), typeof navigator !== "undefined" ? navigator.languages : [], null);
}

export function LanguageProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(loadLocale);
	const [packsTick, setPacksTick] = useState(0);
	/** 英文词典是否已就绪：只有需要 en 的首帧才等它（模块作用域已在并行预取）。 */
	const [dictReady, setDictReady] = useState(locale !== "en" || englishReady());
	const localeRef = useRef(locale);
	localeRef.current = locale;

	const setLocale = useCallback((l: Locale) => {
		setLocaleState(l);
		try {
			localStorage.setItem(STORAGE_KEY, l);
		} catch {
			// ignore storage errors
		}
		// Tell the socket layer (use-chat.ts) to report the new UI language
		// to the server — tool return values / AI prompts follow it (issue #91).
		try {
			window.dispatchEvent(new CustomEvent<string>("pi-web-ui:locale", { detail: l }));
		} catch {
			// non-DOM environment — hello carries the code on next connect
		}
	}, []);

	// 需要英文时先把它取回来再渲染：否则首帧会先显示中文（闪一下）。
	// 预取在模块作用域已随入口启动，所以这里通常立刻 resolve。
	useEffect(() => {
		if (locale !== "en" || englishReady()) {
			setDictReady(true);
			return;
		}
		setDictReady(false);
		let alive = true;
		void loadEnglish().then(() => {
			if (alive) setDictReady(true);
		});
		return () => {
			alive = false;
		};
	}, [locale]);

	const reloadPacks = useCallback(async (): Promise<string | null> => {
		let list: LocalePackStatus[];
		let serverDefault: string | null = null;
		try {
			const data = await fetchPackJson<{ packs: LocalePackStatus[]; defaultLocale?: string | null }>("/api/locales");
			list = data.packs ?? [];
			serverDefault = data.defaultLocale ?? null;
		} catch {
			return null; // server unreachable / old version — core locales keep working
		}
		await Promise.all(
			list
				.filter((p) => p.installed)
				.map(async (p) => {
					try {
						const pack = await fetchPackJson<LocalePack>(`/api/locales/${p.code}`);
						registerLocale({
							code: pack.code || p.code,
							nativeName: pack.nativeName || p.nativeName,
							strings: pack.strings,
						});
					} catch {
						// One pack failed — the rest still load; missing keys fall back to English.
					}
				}),
		);
		setPacksTick((n) => n + 1);
		return serverDefault;
	}, []);

	// Boot: load installed packs, apply the instance default when the browser
	// named nothing we speak, then drop a saved locale whose pack is gone.
	useEffect(() => {
		void reloadPacks().then((serverDefault) => {
			// Nobody has ever chosen here (blank storage counts as nobody): the server
			// may name the language this instance should speak when the browser
			// asks for one we do not have.
			if (!savedLocale()?.trim()) {
				const chosen = pickLocale(null, typeof navigator !== "undefined" ? navigator.languages : [], serverDefault);
				if (chosen !== localeRef.current) {
					localeRef.current = chosen;
					setLocaleState(chosen);
				}
			}
			const cur = localeRef.current;
			if (cur !== "zh" && cur !== "en" && !PACK_REGISTRY[cur]) {
				// The pack is not installed on this server. Fall back the same way a
				// first visit does — not to a fixed language.
				const fallback = pickLocale(null, typeof navigator !== "undefined" ? navigator.languages : [], serverDefault, [
					"zh",
					"en",
				]);
				localeRef.current = fallback;
				setLocaleState(fallback);
				try {
					localStorage.setItem(STORAGE_KEY, fallback);
				} catch {
					// ignore storage errors
				}
			}
		});
	}, [reloadPacks]);

	const packs = useMemo(() => {
		void packsTick;
		return [...CORE_LOCALES, ...Object.values(PACK_REGISTRY).map((p) => ({ code: p.code, nativeName: p.nativeName }))];
	}, [packsTick]);

	const t = useCallback<Translate>(
		(key, vars) => {
			// Pack strings are best-effort: missing keys fall back to English, and
			// English itself falls back to Chinese while its chunk is still loading
			// (i18n-en.ts). Never throws on a missing dictionary.
			let str: string = PACK_REGISTRY[locale]?.strings[key] ?? (locale === "zh" ? zh[key] : (enDict ?? zh)[key]);
			if (vars) {
				for (const [k, v] of Object.entries(vars)) {
					str = str.replaceAll(`{${k}}`, String(v));
				}
			}
			return str;
		},
		[locale, packsTick],
	);

	useEffect(() => {
		document.documentElement.lang = htmlLang(locale);
		// 标题由 App 统一维护（项目名优先，见 App.tsx 的 document.title effect）。
	}, [locale]);

	const value = useMemo(
		() => ({ locale, setLocale, t, packs, reloadPacks }),
		[locale, setLocale, t, packs, reloadPacks],
	);

	// 英文未就绪：给一个不带文案的占位（避免先渲染中文再跳成英文）。
	// 例外：没有异步刷新机会的渲染环境（SSR / renderToStaticMarkup，无 window）不挡——
	// 那里既不会预取、也没有后续 re-render，挡住等于永远只输出占位符；此时用现有词典
	// （中文）渲染是唯一可用的降级。
	if (!dictReady && typeof window !== "undefined") {
		return (
			<div className="boot-wait" role="status" aria-label="Loading">
				…
			</div>
		);
	}
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
	return ctx;
}

/** Convenience: translation function only. */
export function useT(): Translate {
	return useI18n().t;
}
// 入口一旦执行就知道语言（localStorage / navigator，同步）——需要英文就立刻开下载，
// 与 App chunk 的下载并行，等到 LanguageProvider 挂载时通常已经就绪。
if (typeof window !== "undefined" && loadLocale() === "en") void loadEnglish();
