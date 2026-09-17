# 上下文策略（系统级，一处配置全模型生效）

<!-- 🍞 AI Breadcrumb — @COUPLED vendor/pi-web-ui/server/context-policy.ts, config/context-policy.example.json, docs/PERF-SESSION-LOAD.md §7 -->

本文定义「每轮送进模型的上下文最多到多少就触发压缩」这一条**系统级策略**。它不是按模型逐个配的：模型窗口保持供应商声明的真实值，策略单独决定预算。功能范围仍以 [DEV-CON-PROPOSAL.md](DEV-CON-PROPOSAL.md) 为准。

## 1. 为什么要有这一层

pi 只有一个窗口字段、判据是 `contextTokens > contextWindow - reserveTokens`（SDK `core/compaction/compaction.js:163`），而 `settings.json` 里只有**一份全局** `reserveTokens`。本项目一个进程里跨多个渠道/模型，窗口从 20 万到 105 万不等：一个全局常量要么让 100 万窗口的会话涨到 98 万才压缩（实测真实请求中位 36 万、峰值 106 万，见 [PERF-SESSION-LOAD.md](PERF-SESSION-LOAD.md) §7），要么把 20 万窗口的会话压得过早。

所以把「预算」抽出来成为策略层，**不改** `models.json`（真实窗口保持真实：pi 的「静默溢出」判定依赖它，声明值小于实发 prompt 会把成功响应误判成溢出并重试）。

## 2. 形状与默认值来自业界惯例（Codex 源码）

参考实现是本机安装的 `@openai/codex`（Rust 源码 [openai/codex](https://github.com/openai/codex)，已开源）。对**我们渠道里同样的模型**，它的官方元数据是：

| Codex 的定义（`codex-rs/models-manager/models.json`） | 值 |
| --- | --- |
| `gpt-6-astra` / `gpt-5.6-sol` / `gpt-5.6-terra` … `context_window` | **272,000**（预算窗口） |
| 同族 `max_context_window` | **872,000**（物理上限，日常不参与决策） |
| `codex-rs/models-manager/src/model_info.rs:133` `effective_context_window_percent` | **95** → 有效窗口 = 272000 × 95% = **258,400** |
| `model_info.rs:29-30` | `config.model_auto_compact_token_limit` **可覆盖模型默认值** —— 这就是「系统级一处配置」 |
| `core/src/session/context_window.rs:84,101-108` | 有效窗口 = `context_window × percent / 100`，与上限比较后决定压缩 |

也就是说：**业界对这些模型的实跑有效窗口约 26 万，而不是供应商宣传的 87 万/100 万**。我们此前 `models.json` 里写的 105 万是供应商的 `max`，被直接当成了预算。

## 3. 公式与配置

```
有效窗口 = floor(真实窗口 × effectiveWindowPercent / 100)          # 默认 95，同 Codex
触发点   = min(autoCompactTokenLimit ?? 有效窗口, 有效窗口)         # 绝对上限可再收口
reserveTokens = 真实窗口 − 触发点                                   # 交给 pi 的形状
```

配置文件：**`<agentDir>/context-policy.json`**（只读、按 mtime 热生效，改完不用重启）。示例见 [`config/context-policy.example.json`](../config/context-policy.example.json)：

```jsonc
{
  // 对齐 Codex 对同族模型的实跑预算（272000 × 95%）；null = 只用有效窗口
  "autoCompactTokenLimit": 258400,
  "effectiveWindowPercent": 95,
  // 压缩后保留最近原文的 token；null = 跟随 settings.json 的 compaction.keepRecentTokens(20000)
  "keepRecentTokens": null,
  // 需要「真读长材料」的模型列在这里 → 豁免绝对上限，只按有效窗口。默认空 = 全模型统一
  "exemptModels": [],
  "note": "对齐 Codex（272000 × 95%）"
}
```

| 字段 | 作用 | 缺省 |
| --- | --- | --- |
| `autoCompactTokenLimit` | 压缩触发的绝对 token 上限；`null` = 只用有效窗口 | `null` |
| `effectiveWindowPercent` | 有效窗口占真实窗口的百分比（1–100） | `95` |
| `keepRecentTokens` | 压缩后保留最近多少 token 原文 | `null`（跟随 settings.json） |
| `exemptModels` | 豁免绝对上限的模型（写 `deepseek-flash` 或 `deepseek/deepseek-flash`，大小写不敏感） | `[]`（全模型统一） |
| `note` | 写进日志/诊断，便于回溯当时用的哪版策略 | 无 |

不合法字段回落默认值、坏 JSON 回落默认值——**策略问题不会让服务起不来**。

**显示口径**：底部上下文条的**分母用策略的有效预算**（= 触发点），不是模型物理窗口 —— 这样"条涨满"就等于"即将压缩"，与 Codex 的显示一致（它的分母是 272k 而不是 872k）。物理窗口仍由 `models.json` 拥有，只在本文档里说明。

## 4. 全模型覆盖（同一策略，无需逐模型配）

策略按**每个模型自己的真实窗口**计算，因此天然覆盖所有厂商/所有模型；绝对上限只在「窗口比它大」时收口。当前目录（10 个模型）逐条验算：

| 模型 | 声明窗口 | 有效窗口(95%) | 触发点 | 说明 |
| --- | --- | --- | --- | --- |
| `cctq/gpt-6-astra`、`cctq/gpt-5.6-sol`、`deepseek/deepseek-flash`、`rightcode/gpt-5.6-sol`、`rightcode/gpt-6-astra` | 100–105 万 | 95–99.75 万 | **258,400** | 被绝对上限收口（= Codex 同族实跑预算） |
| `micu_claude/claude-opus-5`、`micu_claude/claude-sonnet-5`、`CCQTCC/claude-opus-5` | 20 万 | 19 万 | **190,000** | 绝对上限不生效（窗口本来就小），与 Claude 档习惯一致 |
| `cctq/gpt-5.3-codex-spark`、`cctq/codex-auto-review` | 未声明 → SDK 默认 128k | 12.16 万 | **121,600** | 未声明窗口的模型同样被接管（SDK `provider-composer.js:72` 默认 128000） |

例外只需要一处：把某个模型写进 `exemptModels`（例如临时需要「一次读进上百万 token 的材料」），它就走完整有效窗口，**不影响其它模型的统一策略**。

## 5. 装到实例上（一条命令）

```bash
# 当前实例的 agent 目录见 deploy 的 runtime.json 的 agentDir（在线实例：~/.local/share/pi-dev/agent）
cp config/context-policy.example.json ~/.local/share/pi-dev/agent/context-policy.json
```

回滚：删除该文件即回到「有效窗口 = 真实窗口 × 95%」。**注意**：`reserveTokens` 由策略换算，`settings.json` 里的 `compaction.reserveTokens` 只在策略无法接管（窗口未知）时兜底。

## 6. 影响与代价（用真实分布算）

近 3 天 1256 轮真实请求：中位 361k、p75 554k、p90 667k、峰值 1059k。

| `autoCompactTokenLimit` | 触发点 | 会触发压缩的轮次 | 峰值被削到 |
| --- | --- | --- | --- |
| `null`（默认，≈ 窗口 × 95%） | 950k–997k | 5% | ≈ 950k |
| 600000 | 600k | 30% | 600k |
| **258400（Codex 同族实跑值）** | 258k | ~60% | 258k |

代价是压缩更频繁：每次压缩是一次额外的模型往返（用量记为 `source=compaction`），且被压掉的旧内容只剩摘要（摘要 + 最近 `keepRecentTokens` 原文仍保留，因此**长链任务连续性不丢**，丢的是原文细节）。收益是每轮 prompt 变小 → 首字与解码更快、成本更低。

**建议**：先用 `258400` 跑一段时间（这是业界对这些模型的实跑值），观察压缩频率与体感；若觉得压缩过密就调到 400000–600000。

## 7. 与 `pi-context-prune` 的区别（为什么那个可以关掉）

本策略决定**何时**压缩；prune 之类的扩展试图决定**压缩哪些内容**。实测 prune 并未把上下文压下来（仍涨到 30–100 万），却会改写前缀、打断供应商的前缀缓存，因此已移除（见 [PERF-SESSION-LOAD.md](PERF-SESSION-LOAD.md) §7.2 第 2 条）。
