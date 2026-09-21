# Jev 决策门禁：通用化方案（跨环境）

> 状态：**提案，待确认**。目标是让这套门禁不只活在 PI-dev，而是任何宿主（Claude Code / Codex / Cursor / CI / 别的仓库 / 非 Node 项目）都能用同一份**命题 + 阈值 + 校准数据**。
> 证据来源：官方文档（64 页，2026-09-20 抓取）、社区实现与实测（GitHub/npm/PyPI/HN/V2EX）、Agent Skills 与 MCP 规范。文中每条数字都标了出处。

---

## 1. 社区与官方到底怎么设（先回答"怎么设更好"）

### 1.1 阈值：官方**没有**默认值，但给了明确的**形态**

| 结论 | 原话/数字 | 出处 |
| --- | --- | --- |
| **阈值不是一个数** | "A confidence threshold is not one number. Different actions within the same system should be gated at different levels depending on the consequences of getting it wrong." | `docs.typesafe.ai/confidence.md`（Thresholds scale with risk） |
| 无官方推荐默认 | "The correct threshold values depend on your domain and the performance of the model for your use case. **Start with conservative thresholds, test with your own data, and adjust**." | `confidence.md`（Note） |
| 按判错代价定（明文） | "…Use 0.5 when yes and no are equally easy to act on. **Raise it when acting on a false yes is expensive**… Lower it when missing a true yes is expensive… **Values in the middle can go to a person** rather than either code path." | `primitives/noul.md`（Reading a Noul） |
| **官方 Noul 三态示例带** | `YES = 0.8`、`NO = 0.2`，中间 `send_to_review(...)` | `primitives/noul.md` |
| cookbook 常用带 | `0.30 / 0.70`（uncertain 在中间）；`FOUND, ABSENT = 0.7, 0.35`；`AUTO_ACCEPT = 0.8`；guardrails `review 0.35 / action 0.70`（严格版 action 0.85） | `cookbooks/consistency_noul_cookbook.md`、`semantic_find.md`、`citation_check.md`、`llm_guardrails.md` |
| 官方要求**用带标签数据**定量 | "Set production boundaries **from labeled examples** and from the cost of incorrect decisions and of review."；"**Test thresholds by plotting confidence against accuracy on your data.**" | `cookbooks/consistency_*`、`concepts/how-to-build-with-system-one.md` |
| Noul **没有** confidence | "Noul answers don't carry one."（confidence 只在 Choice/Score 上） | `confidence.md`、`primitives.md` |
| 分批几乎免费 | 13 条问题放一次调用 = **便宜 11.5×、快 9.6×**，答案不变；请求预算 ~32k tokens（≈150k 字符） | `cookbooks/parallel_questions.md` |

### 1.2 社区实测（Jev 2026-09-15 才 early access，只有 5 天，慎用星数）

**先看这条元证据**：`awesome-jev*` 类仓库 09-17~09-20 扎堆创建、数百星、机器人日更、甚至有"送 key"引流；**方法学扎实的项目几乎都是 0–8 星**。→ **star 数与可信度反相关**，下文只采有原始数据与可复核方法的来源。

| 来源 | 关键数字 | 可信度 |
| --- | --- | --- |
| `HackSing/jev-report`（中文 50 条实测） | 阈值分流：`0.70 → 放行 69 条 / 97.1%`；`0.80 → 66 条 / **100.0%**`；`0.90/0.95 → 100%`；三轮答案变化 **0/50**；**最大概率漂移 0.0800**；延迟 p50 0.94s | 中高（原始数据公开） |
| `blakestone-x/jev-mcp`（MCP server + RECIPES） | 一致率：`confidence 0.8–1.0 → 95%`、`0.7–0.8 → 71%`、`<0.6 接近抛硬币`；限流经验：**按 tokens/分钟看**，429 要退避"秒级不是毫秒级"；HTTP 超时 8s、重试预算 20s；并发默认 8（"public endpoint rate-limits above roughly eight"） | 中高 |
| `abhixhek/jevcal`（校准 CLI） | 产品定位就是"**Stop guessing confidence thresholds**：在你的数据上量，挑满足准确率目标的阈值"；警告：**`jev-latest` 会漂，今天调的阈值明天可能失效** | 中高（与我们要做的事重合） |
| `AntonioCoppe/jev-harness` | 并发 8；缓存键 = `sha256(canonical JSON row) + predicate`；129 条判定 ≈ 1s / $0.0009 | 中 |
| `pjrpjr/qingliu`（中文） | 单账号判定 **$0.000032**；10 个账号塞一次调用，一致率 96.2%（无"串味"） | 中高（预注册+双向审计） |
| Rust `Twister915/typesafe-ai` / `SC0d3r/jev-systemone` | 超时 60s / 10s；重试 2 次；退避 250→500ms 起、上限 5–8s；重试状态码 `{408,429,5xx,529}`；尊重 `Retry-After` | 中 |
| `yzfly/awesome-jev-zh`（中文快速上手） | `confidence ≥ 0.85 直接执行 / ≥ 0.60 打标 / else 上抛`；**"光给标签词比给带描述的标签，准确率掉 13.3 个百分点（80.0% → 93.3%，3 轮复现）"** —— 与官方"判据要有定义+示例"完全一致 | 中 |
| V2EX 用户 | 自测成本 ≈ **$0.04/小时**；官方送 $5 额度 | 中低（自述） |

### 1.3 由此得到的**设置基线**（与我们当前配置的差距）

| 项 | 我们当前 | 建议基线 | 依据 |
| --- | --- | --- | --- |
| 阈值带 | **`0.1 / 0.9`（比生态常规宽得多）** | 起步 `0.2 / 0.8`（与官方 Noul 示例一致），必要时 `0.3 / 0.7` | 官方 Noul 示例 + 多个 cookbook |
| 阈值粒度 | 全局一组 | **按命题分别设**（我们的实测：scope 带在 0.4、api/test 在 0.85–0.95，差一个数量级） | 官方"not one number" + 我们 25 条实测 |
| 落地方法 | `tune` 回放 | 保持，并补"confidence×准确率分桶表"与 ECE 口径 | 官方明文 + `classification_using_confidence.md` |
| 模型 id | `typesafe/jev-1.13`（已 pin）✓ | 继续 pin，禁止 `-latest` | 社区实测警告（别名漂移） |
| 超时/重试 | 8s / 无重试 | 超时 8–10s，重试 2 次，退避 250ms→5s，重试 `408/429/5xx/529` + 尊重 `Retry-After` | SDK 默认 + 两个社区实现 |
| 限频 | 1 req/s 串行 | 保留保守限频；批量场景**一次调用塞多条问题**（11.5× 便宜） | 官方并行 cookbook |
| 抖动评估 | `--repeat 3`（σ≤0.032） | 保留；社区做法是 `NUM_SAMPLES=15` 看稳定性 | 官方 consistency cookbook |

> **一句话**：官方不给你数字，但明确要你**用自己的带标签数据**定，并且**按动作/命题分档**；社区收敛出来的实用带是 **0.2–0.35 / 0.7–0.85**，而不是 0.1/0.9。

---

## 2. 通用化的取舍：skill / MCP / 核心库？

### 2.1 三个规范的硬约束（逐条有出处）

**Agent Skills**（`agentskills.io/specification`、`/skill-creation/using-scripts.md`）
- 结构：`SKILL.md`（必需，YAML frontmatter：`name` ≤64 字符小写连字符、`description` ≤1024）+ `scripts/`/`references/`/`assets/`（后三者是**约定**，非强制）。
- 执行机制**由宿主决定**："Supported languages depend on the agent implementation."
- 脚本规范：非交互（**"This is a hard requirement of the agent execution environment"**）、`--help` 自描述、stdout 出数据 / stderr 出诊断、有意义的退出码、幂等、`--dry-run`、输出量可控（宿主常在 10–30K 字符处截断）。
- 依赖：`uvx`/PEP 723、`deno run npm:`、`bun run`、`npx pkg@version`，都要求 pin 版本并把前置条件写进 `SKILL.md`（或用 `compatibility` 字段）。

**MCP**（`modelcontextprotocol.io/specification/2025-06-18`）
- Tools：`name`/`title`/`description`/`inputSchema`(JSON Schema)；结果可 unstructured `content` 或 **structured `structuredContent`**，并可给 `outputSchema`（"Servers **MUST** provide structured results that conform to this schema"）；错误用 `isError`。
- 传输：**stdio**（本地、宿主拉起进程）vs **streamable HTTP**（远端、多客户端）。
- 凭据：规范把授权交给传输层（OAuth 流程有专章），**本地 stdio 的惯例是由宿主通过环境变量/配置注入**。
- 官方还专门有 **MCPB（`.mcpb`）**：zip = 本地 MCP server + `manifest.json` + **自带运行时**，目标是"install it without Node or Python"；配套 `build-mcpb` 官方技能。

**混合是官方认可形态**：MCP 官方文档有一页 **"Build with Agent Skills"**——用 skill 承载"设计决策与知识"，用 MCP server 承载"能力"；`anthropics/skills` 仓库里 `mcp-builder` 技能就是"读知识 → 生成 server"。

### 2.2 结论：**三层，核心只有一个**

```
┌──────────────────────────────────────────────────────────────┐
│ L2 宿主适配（薄）                                             │
│  · MCP server（stdio）→ Claude Code / Codex / Cursor / 其它   │
│  · Agent Skill（SKILL.md + scripts/）→ 教"何时用、怎么设"     │
│  · 宿主内建工具（如 PI-dev 的 jev_check + 状态栏）→ 最深集成  │
├──────────────────────────────────────────────────────────────┤
│ L1 核心 CLI `jev`（跨语言可用、CI 可用、任何 agent 都能 bash）│
│  判定 / 命题注册表 / 阈值 / 缓存 / 限频 / 审计 / 校准 tune      │
├──────────────────────────────────────────────────────────────┤
│ L0 契约（跨语言、与实现无关）                                  │
│  jev-gate.json（配置，含**按命题阈值**）+ corpus.jsonl（校准）  │
│  + 固定退出码 + stdout JSON 形状                               │
└──────────────────────────────────────────────────────────────┘
```

**为什么不选"只做 skill"**：skill 的 `scripts/` 执行机制由宿主决定、语言支持不定，装不了依赖就不能跑；而且它无法常驻（缓存、限频、运行态都要常驻进程）。skill 适合**知识**（命题怎么设、阈值怎么校、失败怎么读），不适合承载**有状态服务**。

**为什么不选"只做 MCP"**：MCP 在需要在宿主里注册才有；CI、脚本、没有 MCP 支持的宿主就用不上；且我们已经在 pi 里有更深的内建集成（状态栏推送），不该退化。MCP 是**分发面最宽**的一层，不是唯一层。

**所以：核心库/CLI 是唯一事实源，MCP 与 Skill 都是薄适配层**（这正是官方 "Build with Agent Skills" + MCPB 的组合形态）。

### 2.3 各层契约（要写进文档并测的）

**L0-① 配置 `jev-gate.json`**（替代现在只支持全局阈值的设置文件）
```jsonc
{
  "version": 1,
  "endpoint": "https://openrouter.ai/api/alpha/decisions",
  "model": "typesafe/jev-1.13",                  // 必须 pin，禁止 -latest
  "credential": { "env": "TYPESAFE_API_KEY" },    // 或宿主引用：{ "providerRef": {...} }；绝不落盘密钥
  "defaults": { "approveAt": 0.8, "blockAt": 0.2 },
  "propositions": {                               // ★ 按命题分别设阈值
    "change_preserves_public_api": { "approveAt": 0.8, "blockAt": 0.35 },
    "test_asserts_behavior":       { "approveAt": 0.9, "blockAt": 0.5 },
    "change_within_task_scope":    { "approveAt": 0.5, "blockAt": 0.3 }
  },
  "runtime": { "timeoutMs": 10000, "maxRetries": 2, "backoffMs": [250, 5000], "minIntervalMs": 250, "cacheTtlMs": 300000 },
  "policy": { "falseApproveIsWorst": true }       // 误放行优先：校准排序口径
}
```

**L0-② 校准语料 `corpus.jsonl`**：保持现状（`{id, label, state, propositions}`），label 由人判；**新增** `propositions` 可多条（一次调用问多条，便宜 11.5×）。

**L0-③ CLI 契约**（任何宿主/CI 都能用）
```
jev check --proposition <id|all> --state-file <path|-> [--json]
jev propositions [--json]
jev status [--json]            # 运行态（进程内）
jev cache [stats|clear] [--json]
jev tune --corpus <path> [--repeat n] [--from-cache] [--json]
退出码：0 通过 / 1 阻断 / 2 转人工 / 3 出错   （tune：0 有建议且无误放行 / 1 仍有误放行 / 2 语料问题 / 3 出错）
stdout：人类可读；--json 时**只有**一个 JSON 对象（诊断走 stderr）
```

**L1 MCP server（stdio）工具面**（薄！只暴露核心已有的能力）
| tool | 入参 | 返回 |
| --- | --- | --- |
| `jev_check` | `state`、`propositions?`、`useCache?` | `structuredContent`: `{outcome, checks, reason, reasonEn, audit}` + 一行 text（宿主都认） |
| `jev_propositions` | — | 命题清单（id + 渲染后的判定文本 + 当前阈值） |
| `jev_status` / `jev_cache` | — | 运行态 / 缓存概览 |
| （可选）`jev_tune` | `corpusPath`、`repeat?` | 报告 + 建议阈值（写操作只读语料；**不自动改配置**） |
| resource | `jev://config`、`jev://corpus` | 只读 |

**L2 Skill（`jev-gate/` SKILL.md + scripts/）**：只放**知识与轻调用** ——
判定该问哪些命题、阈值怎么起步与校准、误放行/误拦怎么读、失败模式（429/超时/缺答一律 review）、
"不要问计数/算术/日期"、以及 `scripts/jev-check.sh`（无 MCP 时的降级路径：直接调 L1 CLI）。

### 2.4 分发

| 渠道 | 产物 | 覆盖宿主 |
| --- | --- | --- |
| npm | `npx jev-gate@x`（pin 版本） | 任何有 Node 的环境、CI |
| **MCPB** | `.mcpb`（自带运行时） | Claude Desktop/Code 等**不需要 Node/Python** 的宿主 |
| Skill | `jev-gate/SKILL.md` + `scripts/` | 任何实现 Agent Skills 标准的宿主（含 pi） |
| 宿主机内建 | 现在的 `jev_check` + 设置面板 + 状态栏 | PI-dev（最深的集成，保留为"参考实现"） |

---

## 3. 里程碑（建议顺序）

| # | 内容 | 产出 | 为什么先做 |
| --- | --- | --- | --- |
| **M1** | **按命题阈值**（把 `defaults` + `propositions[].approveAt/blockAt` 落进现有实现，含迁移与 UI/CLI 显示） | 现有环境即可收益；契约固化为 `jev-gate.json` | 我们自己的实测已证明全局阈值不可用；这也是通用方案的第一个契约 |
| **M2** | **抽出核心包**（`@jev-gate/core` + `jev` CLI，零宿主依赖）：命题注册表可外置、配置/语料格式冻结、退出码冻结 | 独立 npm 包 + 现有 PI-dev 改为依赖它 | 唯一事实源；不先抽核，MCP 与 Skill 会各长一份 |
| **M3** | **MCP server（stdio）** + `outputSchema` | 一个 bin：`jev-gate-mcp` | 分发面最宽的一层 |
| **M4** | **Skill**（含脚本降级路径）+ 文档：设置基线（§1.3）、校准流程、失败模式 | `jev-gate/` 技能目录 | 让宿主"知道何时问、怎么设"，而不是只有一个 API |
| **M5** | **MCPB 打包 + 发布** | `.mcpb` | 免运行时安装 |

## 4. 需要你拍的三件事

1. **核心放哪**：(A) 抽成独立仓库/包（推荐，便于外部环境装）／(B) 先留在 PI-dev 里做成 workspace 包。
2. **第一批适配层做哪个**：MCP（其它宿主立刻可用）／Skill（宿主里"会用"）／两者一起（推荐，但工作量翻倍）。
3. **阈值默认值**：接受 §1.3 的 **0.2/0.8 起步 + 按命题覆盖**（贴近生态与官方示例），还是先保持 0.1/0.9 只做按命题覆盖？

## 5. 已知风险

- **生态只有 5 天**：除官方文档外，社区数字都应在自己数据上复验；本项目已有一套可复用的复验工具（`tune`）。
- **已有同类实现**（`jev-mcp`、`jevcal`）：我们的差异点是「**命题注册表 + 按命题阈值 + 误放行优先的校准回路 + 审计留痕 + 多宿主适配**」，不是"再包一层 API"。M2/M3 前应做一次差异化确认。
- **`jev-latest` 漂移**：配置必须 pin 版本，并记录"该阈值是在哪个 model id 与哪份语料上校准的"（可追溯性）。
- **MCP 的凭据**：stdio 由宿主注入环境变量；HTTP 传输要按规范做授权——**绝不把密钥写进配置文件或日志**（现有实现已有此约束与测试）。
